/**
 * Fixtures for the disc-cache tests: a synthetic multi-piece disc, a store that behaves like
 * the OPFS worker's, and an endpoint that answers byte ranges.
 *
 * The disc is **three pieces with a short last one** (piece size 8, 20 bytes), because the last
 * piece is where an off-by-one in the range arithmetic lives -- the real disc has one too
 * (1,459,978,240 bytes is not a multiple of 16 MiB) -- and a single-piece fixture cannot show
 * it. The digests are real (`node:crypto`), so a test that says a piece was verified is not
 * testing a fake hash.
 *
 * `FakeDiscServer` is deliberately able to misbehave in each of the ways the module must
 * refuse: ignore the range and answer `200`, answer an HTML page, send a `Content-Range` for
 * other bytes, send more bytes than asked for, or send bytes that do not hash to the manifest.
 */

import { createHash } from 'node:crypto';
import type {
  DiscManifestDocument,
  DiscRequest,
  DiscResponseLike,
  DiscStore,
} from '../../../src/spike/disc-cache.js';

/** SHA-1 of some bytes, lowercase hex: the disc's own identity. */
export function sha1Of(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export interface DiscFixture {
  readonly bytes: Uint8Array;
  readonly chunkSizeBytes: number;
  /** The document `scripts/phase0/disc_chunks.py` would write for these bytes. */
  readonly document: DiscManifestDocument;
}

/**
 * A deterministic synthetic disc of `chunkCount` pieces, the last one short.
 *
 * The bytes are a fixed pattern rather than random so that a failure is reproducible, and so
 * that a corrupted piece is a *different* pattern rather than a different random draw.
 */
export function discFixture(chunkCount = 3, chunkSizeBytes = 8): DiscFixture {
  const lastPiece = Math.max(1, Math.floor(chunkSizeBytes / 2));
  const sizeBytes = (chunkCount - 1) * chunkSizeBytes + lastPiece;
  const bytes = new Uint8Array(sizeBytes);
  for (let index = 0; index < sizeBytes; index++) bytes[index] = (index * 37 + 11) % 251;
  const chunks: string[] = [];
  for (let offset = 0; offset < sizeBytes; offset += chunkSizeBytes) {
    const piece = bytes.subarray(offset, Math.min(offset + chunkSizeBytes, sizeBytes));
    chunks.push(createHash('sha256').update(piece).digest('hex'));
  }
  return {
    bytes,
    chunkSizeBytes,
    document: { size_bytes: sizeBytes, chunk_size_bytes: chunkSizeBytes, sha1: sha1Of(bytes), chunks },
  };
}

/**
 * An in-memory `DiscStore`.
 *
 * It enforces the one rule the interface states -- an append must land at the current end of
 * the file -- so a module that writes out of order fails here the way the worker's single
 * `createSyncAccessHandle()` would fail in the browser, and it records every truncation so a
 * test can assert *where* the file was cut rather than only that it was.
 */
export class FakeDiscStore implements DiscStore {
  private bytes = new Uint8Array(0);
  readonly truncations: number[] = [];
  removed = false;

  /** Test-only: what is stored, without going through the interface. */
  get stored(): Uint8Array {
    return this.bytes;
  }

  /** Test-only: put bytes in the file as if a previous download had left them there. */
  seed(bytes: Uint8Array): void {
    this.bytes = bytes.slice();
  }

  async length(): Promise<number> {
    return this.bytes.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.slice(offset, offset + length);
  }

  async append(offset: number, bytes: Uint8Array): Promise<void> {
    if (offset !== this.bytes.length) {
      throw new Error(`append at ${offset} but the file is ${this.bytes.length} bytes`);
    }
    const next = new Uint8Array(offset + bytes.length);
    next.set(this.bytes);
    next.set(bytes, offset);
    this.bytes = next;
  }

  async truncate(bytes: number): Promise<void> {
    this.truncations.push(bytes);
    this.bytes = this.bytes.slice(0, bytes);
  }

  async file(): Promise<File> {
    return new File([this.bytes.slice()], 'melee-ntsc102.iso', { type: 'application/octet-stream' });
  }

  async remove(): Promise<void> {
    this.removed = true;
    this.bytes = new Uint8Array(0);
  }
}

export interface RangeRequest {
  readonly url: string;
  readonly range: string;
}

/**
 * An endpoint that answers byte ranges, and can be told to answer wrongly.
 *
 * `requests` records the `Range` header of every piece request in order: "the resume asked for
 * exactly the missing bytes" is asserted by reading that list, not by trusting the result.
 */
export class FakeDiscServer {
  readonly requests: RangeRequest[] = [];
  /** Answer `200` with the whole disc: the range was ignored. */
  ignoreRange = false;
  /** Answer `206` with a page: something intercepted the request. */
  htmlPage = false;
  /** Replace the `Content-Range` header. */
  contentRange: string | null = null;
  /** Send this many junk bytes on top of the requested range. */
  extraBytes = 0;
  /** Pieces to serve with one flipped byte. */
  readonly corrupt = new Set<number>();
  /** Held before the answer to one piece, so a test can abort a download mid-request. */
  gate: Promise<void> | null = null;
  gatePiece: number | null = null;
  /** Make the request itself fail. */
  failure: Error | null = null;
  manifestStatus = 200;
  manifestContentType = 'application/json';
  /** Replace the manifest body, e.g. with a page or with an invalid document. */
  manifestBody: string | null = null;

  constructor(
    private readonly fixture: DiscFixture,
    private readonly manifestUrl = '/phase0/disc-chunks',
    private readonly discUrl = '/phase0/disc',
  ) {}

  /** The piece requests, i.e. how many times the disc itself was asked for. */
  get pieceRequests(): RangeRequest[] {
    return this.requests.filter((request) => request.url === this.discUrl);
  }

  readonly fetch = async (url: string, request: DiscRequest): Promise<DiscResponseLike> => {
    if (this.failure) throw this.failure;
    if (url === this.manifestUrl) return this.manifestResponse();
    if (url !== this.discUrl) throw new Error(`unexpected request for ${url}`);
    const range = request.headers['Range'] ?? '';
    this.requests.push({ url, range });
    if (this.ignoreRange) {
      return response(200, { 'content-type': 'application/octet-stream' }, this.fixture.bytes);
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`the module sent an unparseable range: ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const index = Math.floor(start / this.fixture.chunkSizeBytes);
    if (this.gate && this.gatePiece === index) await this.gate;
    if (request.signal?.aborted) {
      throw new DOMException('the request was aborted', 'AbortError');
    }
    const piece = this.fixture.bytes.slice(start, end + 1);
    if (this.corrupt.has(index)) piece[0] = (piece[0] ?? 0) ^ 0xff;
    if (this.htmlPage) {
      const page = new TextEncoder().encode('<html>sign in</html>');
      return response(206, { 'content-type': 'text/html; charset=utf-8' }, page);
    }
    const body = new Uint8Array(piece.length + this.extraBytes);
    body.set(piece);
    return response(
      206,
      {
        'content-type': 'application/octet-stream',
        'content-range': this.contentRange ?? `bytes ${start}-${end}/${this.fixture.bytes.length}`,
      },
      body,
    );
  };

  private manifestResponse(): DiscResponseLike {
    const body = this.manifestBody ?? JSON.stringify(this.fixture.document);
    return response(
      this.manifestStatus,
      { 'content-type': this.manifestContentType },
      new TextEncoder().encode(body),
    );
  }
}

function response(status: number, headers: Record<string, string>, bytes: Uint8Array): DiscResponseLike {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => {
      const out = new ArrayBuffer(bytes.length);
      new Uint8Array(out).set(bytes);
      return out;
    },
  };
}

export interface StoreFactory {
  readonly stores: Map<string, FakeDiscStore>;
  readonly create: (identity: string) => DiscStore;
  readonly for: (identity: string) => FakeDiscStore;
}

/** A store factory that hands out one store per identity, and remembers them. */
export function storeFactory(): StoreFactory {
  const stores = new Map<string, FakeDiscStore>();
  const create = (identity: string): DiscStore => {
    const existing = stores.get(identity);
    if (existing) return existing;
    const store = new FakeDiscStore();
    stores.set(identity, store);
    return store;
  };
  return {
    stores,
    create,
    // `for` hands out the same store the module will be given, and creates it if the module
    // has not asked yet: a test seeds a partial file *before* the download starts.
    for: (identity: string) => create(identity) as FakeDiscStore,
  };
}

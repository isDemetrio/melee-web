import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * The spike page in Chromium, against a disc this test serves itself.
 *
 * Two kinds of run are asserted here. One hands the file selector a synthetic image and proves the
 * WORKERFS path still works. The others exercise the disc cache of PR 4
 * (`docs/PHASE0_DEPLOY_PLAN.md` section 5) end to end in a real browser: the download button, the
 * resume after an interruption, the refusal of a corrupt piece, the deletion, and finally a run
 * that takes its disc out of OPFS and says so in its result JSON.
 *
 * Why the pieces are served rather than read from a file: no CI runner has the operator's ISO and
 * none ever will (`docs/AGENT_RULES.md` rule 1). A manifest and a byte-range endpoint are all the
 * page asks for, so the test can be the Function that serves them -- `functions/phase0/disc.ts` is
 * the real one -- and the assertions are about what the page does with the bytes, not about where
 * they came from.
 */

/**
 * The synthetic disc: four pieces of 16 KiB, the last one 2000 bytes.
 *
 * The shape is the point. A single piece cannot show a resume -- the plan's own fixture was too
 * small for that (`docs/PHASE0_DEPLOY_PLAN.md` section 5, PR 4) -- and a disc whose last piece is
 * full size cannot show that the last `Range` is the short one. The header at offset 0 is left
 * zeroed exactly as the single-piece fixture below is, so the core fails at the DOL for the same
 * reason in both: an OPFS run must reach the failure `docs/PROGRESS.md` records and not another
 * one. Everything after the header is pseudo-random, so no two pieces hash alike and a piece
 * served in the wrong slot cannot pass unnoticed.
 */
const CHUNK_BYTES = 16 * 1024;
const PIECE_BYTES = [CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 2000];
const DISC_BYTES = PIECE_BYTES.reduce((total, bytes) => total + bytes, 0);
const HEADER_BYTES = 0x440;

function syntheticDisc(): Buffer {
  const disc = Buffer.alloc(DISC_BYTES);
  disc.write('GALE01', 0, 'ascii');
  let state = 1;
  for (let offset = HEADER_BYTES; offset < DISC_BYTES; offset += 1) {
    state = (state * 48271) % 2147483647;
    disc[offset] = state & 0xff;
  }
  return disc;
}

function pieces(disc: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  for (const bytes of PIECE_BYTES) {
    result.push(disc.subarray(offset, offset + bytes));
    offset += bytes;
  }
  return result;
}

/** The manifest document `scripts/phase0/disc_chunks.py` would publish for this disc. */
function manifest(disc: Buffer): string {
  return JSON.stringify({
    size_bytes: DISC_BYTES,
    chunk_size_bytes: CHUNK_BYTES,
    sha1: createHash('sha1').update(disc).digest('hex'),
    chunks: pieces(disc).map((piece) => createHash('sha256').update(piece).digest('hex')),
  });
}

/** The endpoints, as this test controls them: what was asked for, and what goes wrong. */
interface DiscServer {
  /** Every `Range` header the page has sent, in order. */
  readonly ranges: string[];
  /** 1-based piece number answered with `500`, or `null` for none. */
  failPiece: number | null;
  /** 1-based piece number answered with one flipped byte, or `null` for none. */
  corruptPiece: number | null;
}

/** A fresh, healthy server: every piece served correctly. */
function discServer(): DiscServer {
  return { ranges: [], failPiece: null, corruptPiece: null };
}

/**
 * Serve the manifest and the disc with byte ranges, the way `functions/phase0/disc.ts` does.
 *
 * Both requests are made by the page, not by the OPFS worker -- the worker only writes bytes it is
 * handed -- so `page.route` sees them. A request that is not a well-formed range is answered `416`
 * rather than with the whole disc: a `200` here would be a different test, and `disc-cache.ts`
 * refuses it on purpose.
 */
async function serveDisc(page: Page, disc: Buffer, server: DiscServer): Promise<void> {
  await page.route('**/phase0/disc-chunks', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: manifest(disc),
  }));
  await page.route('**/phase0/disc', async (route) => {
    const range = route.request().headers()['range'] ?? '';
    server.ranges.push(range);
    const bounds = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!bounds) {
      await route.fulfill({ status: 416 });
      return;
    }
    const start = Number(bounds[1]);
    const end = Number(bounds[2]);
    const piece = Math.floor(start / CHUNK_BYTES) + 1;
    if (piece === server.failPiece) {
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'the piece is not here' });
      return;
    }
    const body = Buffer.from(disc.subarray(start, end + 1));
    if (piece === server.corruptPiece) body.writeUInt8(body.readUInt8(0) ^ 0xff, 0);
    await route.fulfill({
      status: 206,
      contentType: 'application/octet-stream',
      headers: { 'content-range': `bytes ${start}-${end}/${DISC_BYTES}` },
      body,
    });
  });
}

/** The four `Range` headers one complete download of the fixture must produce, in order. */
const ALL_RANGES = [
  'bytes=0-16383',
  'bytes=16384-32767',
  'bytes=32768-49151',
  'bytes=49152-51151',
];

/** Clear the progress line, so the next assertion is about the next download and not the last. */
async function clearProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const progress = document.getElementById('disc-progress');
    if (progress) progress.textContent = '';
  });
}

test('web core reads a WORKERFS File and rejects a synthetic disc', async ({ page }) => {
  await page.goto('/spike.html?nosizecheck&frames=1');
  const buffer = Buffer.alloc(0x440);
  buffer.write('GALE01');
  await page.locator('#iso').setInputFiles({ name: 'synthetic.iso', mimeType: 'application/octet-stream', buffer });
  await page.locator('#run').click();
  await expect(page.locator('#core')).toContainText('core loaded');
  await expect(page.locator('#status')).toHaveText('exit 1');
  await expect(page.locator('#log')).toContainText('FATAL: cannot read full Melee DOL');
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await expect(page.locator('#download')).toBeVisible();
  // The run ended before its first retrace: no beat, and nothing left behind as an unfinished run.
  await expect(page.locator('#heartbeat')).toHaveText('heartbeat: none yet');
  expect(await page.evaluate(() => localStorage.getItem('melee-spike-heartbeat'))).toBeNull();
});

test('a run that never reported is shown on the next load', async ({ page }) => {
  await page.goto('/spike.html');
  await page.evaluate(() => localStorage.setItem('melee-spike-heartbeat', JSON.stringify({
    schema: 'melee-spike-heartbeat/1', startedAt: '2026-10-02T17:00:00.000Z', frames: 2400, canvas: true, core: 'abc',
    last: { frame: 1395, frameAtMs: 31000, atMs: 31000, source: 'retrace', render: null },
    receivedAt: '2026-10-02T17:00:31.000Z', logTail: ['scene: major 02 minor 02 (frame 1395)'] })));
  await page.reload();
  await expect(page.locator('#heartbeat')).toContainText('never reported: last heartbeat frame 1395');
  await expect(page.locator('#heartbeat')).toContainText('scene: major 02 minor 02 (frame 1395)');
  await expect(page.locator('#partial')).toBeVisible();
});

test('the download button fills OPFS piece by piece, and a complete cache is not downloaded again', async ({ page }) => {
  const disc = syntheticDisc();
  const server = discServer();
  await serveDisc(page, disc, server);
  await page.goto('/spike.html?nosizecheck');

  // Nothing is stored yet, and the page says so before anything is clicked.
  await expect(page.locator('#disc-status')).toContainText('no verified disc');

  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');
  await expect(page.locator('#disc-progress')).toContainText('as melee-ntsc102.iso');

  // One request per piece, in order, the last one short: the whole disc, and no more than it.
  expect(server.ranges).toEqual(ALL_RANGES);
  await expect(page.locator('#disc-status')).toContainText('verified,');

  // A complete cache is verified and then used: not one piece is fetched a second time.
  server.ranges.length = 0;
  await clearProgress(page);
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');
  expect(server.ranges).toEqual([]);
});

test('an interrupted download resumes at the last verified piece, with an exact Range', async ({ page }) => {
  const disc = syntheticDisc();
  const server = discServer();
  await serveDisc(page, disc, server);
  await page.goto('/spike.html?nosizecheck');

  // The third piece fails: two pieces are written and flushed, and the download stops there.
  server.failPiece = 3;
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('failed');
  expect(server.ranges).toEqual(ALL_RANGES.slice(0, 3));
  // Half a disc is not a disc: the cache reports nothing verified, and the run would fall back
  // to the selector rather than mount a truncated image.
  await expect(page.locator('#disc-status')).toContainText('no verified disc');

  server.failPiece = null;
  server.ranges.length = 0;
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');

  // The two stored pieces are re-read and re-hashed from OPFS, not fetched again: the resume
  // starts exactly at the byte the interruption left it at.
  expect(server.ranges).toEqual(['bytes=32768-49151', 'bytes=49152-51151']);
});

test('a piece whose bytes do not hash to the manifest is refused before it is written', async ({ page }) => {
  const disc = syntheticDisc();
  const server = discServer();
  await serveDisc(page, disc, server);
  await page.goto('/spike.html?nosizecheck');

  server.corruptPiece = 2;
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('failed');
  await expect(page.locator('#disc-progress')).toContainText('hashes to');

  server.corruptPiece = null;
  server.ranges.length = 0;
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');

  // The corrupt piece was never written: the second attempt asks for it again, from its own
  // offset, and the verified piece before it is not fetched again either.
  expect(server.ranges).toEqual(['bytes=16384-32767', 'bytes=32768-49151', 'bytes=49152-51151']);
});

test('the delete button removes the cached bytes, so the next download starts at zero', async ({ page }) => {
  const disc = syntheticDisc();
  const server = discServer();
  await serveDisc(page, disc, server);
  await page.goto('/spike.html?nosizecheck');

  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');
  await expect(page.locator('#disc-status')).toContainText('verified,');

  await page.locator('#delete-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('deleted');
  await expect(page.locator('#disc-status')).toContainText('no verified disc');

  // Deleted means gone from OPFS, not forgotten by the page: the download starts over.
  server.ranges.length = 0;
  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');
  expect(server.ranges).toEqual(ALL_RANGES);
});

test('a run takes its disc out of OPFS and reports disc_source=opfs', async ({ page }) => {
  const disc = syntheticDisc();
  const server = discServer();
  await serveDisc(page, disc, server);
  await page.goto('/spike.html?nosizecheck&frames=1');

  await page.locator('#fetch-disc').click();
  await expect(page.locator('#disc-progress')).toContainText('complete');

  // No file is chosen: the only disc this page can run is the cached one.
  await page.locator('#run').click();
  await expect(page.locator('#core')).toContainText('core loaded');
  await expect(page.locator('#status')).toHaveText('exit 1');
  await expect(page.locator('#log')).toContainText('FATAL: cannot read full Melee DOL');
  await expect(page.locator('#download')).toBeVisible();

  const result = await page.evaluate(async () => {
    const link = document.getElementById('download') as HTMLAnchorElement | null;
    if (!link) return null;
    const response = await fetch(link.href);
    return JSON.parse(await response.text()) as {
      disc_source?: string; iso_bytes?: number; exit_code?: number;
    };
  });
  expect(result?.disc_source).toBe('opfs');
  expect(result?.iso_bytes).toBe(DISC_BYTES);
  expect(result?.exit_code).toBe(1);
  // The disc came from the cache, and the cache came from the endpoint, not from the selector.
  expect(server.ranges).toEqual(ALL_RANGES);
});

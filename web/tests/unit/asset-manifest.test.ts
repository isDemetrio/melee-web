/**
 * The manifest client: what the shell refuses to trust.
 *
 * `scripts/make_manifest.py` refuses to *write* a wrong manifest; this module refuses to
 * *read* one, and the two sides have to agree on the format. Each rejection below is a case
 * the generator's schema also rejects, and each one is here because the alternative is worse
 * than a failure: an unknown group is loaded by nothing, a `stored` that is not the hash gives
 * two names to one file, and a size that is not checked cannot catch a truncated download.
 */

import { describe, expect, it } from 'vitest';
import {
  MANIFEST_VERSION,
  ManifestError,
  assetsInGroup,
  findAsset,
  loadManifest,
  parseManifest,
} from '../../src/assets/manifest.js';
import { entryDocument, fakeBucket, manifestDocument, sha256Of } from './fakes/assetFixtures.js';

const text = (value: string) => new TextEncoder().encode(value);
const BYTES = text('melee');
const MANIFEST_URL = 'https://assets.example/manifest.json';
const PATH = 'files/audio/bgm/01.mus';

/** A document with one valid entry, as a starting point for a single broken field. */
function documentWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return manifestDocument([entryDocument(BYTES, overrides)]);
}

describe('parseManifest', () => {
  it('accepts a document the generator writes, and reads back what it says', () => {
    const manifest = parseManifest(documentWith({}));

    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.baseUrl).toBe('https://assets.example/');
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.path).toBe(PATH);
    expect(manifest.entries[0]?.sha256).toBe(sha256Of(BYTES));
    expect(manifest.entries[0]?.size).toBe(BYTES.length);
    expect(manifest.entries[0]?.group).toBe('music');
    expect(manifest.entries[0]?.encoding).toBe('identity');
  });

  it('refuses a version it cannot read instead of guessing at it', () => {
    expect(() => parseManifest({ ...documentWith({}), version: '2' })).toThrow(/version 2/);
    expect(() => parseManifest({ ...documentWith({}), version: '' })).toThrow(ManifestError);
  });

  it('refuses a document that is not an object with an entries array', () => {
    expect(() => parseManifest([])).toThrow(/must be a JSON object/);
    expect(() => parseManifest(null)).toThrow(/must be a JSON object/);
    expect(() => parseManifest('{}')).toThrow(/must be a JSON object/);
    expect(() => parseManifest({ ...documentWith({}), entries: {} })).toThrow(/entries must be an array/);
    expect(() => parseManifest({ ...documentWith({}), baseUrl: '' })).toThrow(/baseUrl/);
  });

  it('refuses a stored name that is not the hash it claims to be', () => {
    // Two names for one file lets the cache hold two copies; one name for two files lets an
    // asset silently replace another.
    const other = sha256Of(text('something else'));
    expect(() => parseManifest(documentWith({ stored: `${other}.bin` }))).toThrow(/does not match sha256/);
    expect(() => parseManifest(documentWith({ stored: `${PATH}` }))).toThrow(/not a content hash/);
    expect(() => parseManifest(documentWith({ stored: '../escape.bin' }))).toThrow(/not a content hash/);
  });

  it('refuses a sha256 that is not lowercase hex', () => {
    const upper = sha256Of(BYTES).toUpperCase();
    expect(() => parseManifest(documentWith({ sha256: upper }))).toThrow(/not a lowercase hex SHA-256/);
    expect(() => parseManifest(documentWith({ sha256: 'abc' }))).toThrow(/not a lowercase hex SHA-256/);
  });

  it('refuses a size that is not a non-negative integer', () => {
    expect(() => parseManifest(documentWith({ size: -1 }))).toThrow(/size must be a non-negative integer/);
    expect(() => parseManifest(documentWith({ size: 1.5 }))).toThrow(/size must be a non-negative integer/);
    expect(() => parseManifest(documentWith({ size: '12' }))).toThrow(/size must be a non-negative integer/);
    // And it names the file it refused, so the operator can find it in the generator's output.
    expect(() => parseManifest(documentWith({ size: -1 }))).toThrow(new RegExp(PATH));
  });

  it('refuses a group nothing would ever load', () => {
    expect(() => parseManifest(documentWith({ group: 'stage' }))).toThrow(/unknown asset group/);
    expect(() => parseManifest(documentWith({ group: 'characters:fox' }))).toThrow(/unknown asset group/);
    expect(() => parseManifest(documentWith({ group: '' }))).toThrow(/group/);
  });

  it('accepts every group the generator\u2019s schema allows', () => {
    // The schema's pattern is ^(boot|menu|music|movies|other|character:.+|stage:.+)$
    // (scripts/manifest_schema.json). A group this side rejects is an asset that never loads.
    for (const group of [
      'boot',
      'menu',
      'music',
      'movies',
      'other',
      'character:fox',
      'stage:final_destination',
    ]) {
      expect(parseManifest(documentWith({ group })).entries[0]?.group).toBe(group);
    }
  });

  it('refuses an encoding that is neither gzip nor identity', () => {
    expect(() => parseManifest(documentWith({ encoding: 'br' }))).toThrow(/gzip or identity/);
    expect(() => parseManifest(documentWith({ encoding: undefined }))).toThrow(/gzip or identity/);
  });

  it('refuses two entries that claim the same path', () => {
    const first = entryDocument(BYTES);
    const second = entryDocument(text('other'));
    expect(() => parseManifest(manifestDocument([first, second]))).toThrow(/duplicate path/);
  });

  it('ignores a key it does not use, at the root and in an entry', () => {
    // A later manifest version may add a key this shell does not read, and the version field is
    // what stops a document this shell cannot understand.
    const manifest = parseManifest({
      ...manifestDocument([entryDocument(BYTES, { future: true })]),
      extra: 'ignored',
    });

    expect(manifest.entries[0]).not.toHaveProperty('future');
  });
});

describe('loadManifest', () => {
  it('reads and validates a manifest from the network', async () => {
    const bucket = fakeBucket();
    bucket.serve(MANIFEST_URL, text(JSON.stringify(manifestDocument([entryDocument(BYTES)]))));

    const manifest = await loadManifest(bucket.fetch, MANIFEST_URL);

    expect(bucket.urls).toEqual([MANIFEST_URL]);
    expect(manifest.entries).toHaveLength(1);
  });

  it('reports a 404 as an error, not as a shell with no game', async () => {
    const bucket = fakeBucket();
    bucket.refuse(MANIFEST_URL, 404);

    await expect(loadManifest(bucket.fetch, MANIFEST_URL)).rejects.toThrow(ManifestError);
    await expect(loadManifest(bucket.fetch, MANIFEST_URL)).rejects.toThrow(/status 404/);
  });

  it('reports a transport failure and a body that is not JSON', async () => {
    const bucket = fakeBucket();
    bucket.breakWith(MANIFEST_URL, new TypeError('Failed to fetch'));
    await expect(loadManifest(bucket.fetch, MANIFEST_URL)).rejects.toThrow(/Failed to fetch/);

    bucket.serve(MANIFEST_URL, text('<html>not json</html>'));
    await expect(loadManifest(bucket.fetch, MANIFEST_URL)).rejects.toThrow(/not valid JSON/);
  });
});

describe('lookups', () => {
  it('finds an entry by its manifest path, and only by its exact path', () => {
    const manifest = parseManifest(documentWith({}));

    expect(findAsset(manifest, PATH)?.sha256).toBe(sha256Of(BYTES));
    expect(findAsset(manifest, PATH.toUpperCase())).toBeNull();
    expect(findAsset(manifest, 'files/nothing')).toBeNull();
  });

  it('lists one group in manifest order', () => {
    const manifest = parseManifest(
      manifestDocument([
        entryDocument(BYTES, { path: 'files/boot/opening.mov', group: 'boot' }),
        entryDocument(text('other'), { path: 'files/audio/bgm/01.mus', group: 'music' }),
        entryDocument(text('third'), { path: 'files/audio/bgm/02.mus', group: 'music' }),
      ]),
    );

    expect(assetsInGroup(manifest, 'music').map((entry) => entry.path)).toEqual([
      'files/audio/bgm/01.mus',
      'files/audio/bgm/02.mus',
    ]);
    expect(assetsInGroup(manifest, 'boot').map((entry) => entry.path)).toEqual([
      'files/boot/opening.mov',
    ]);
    expect(assetsInGroup(manifest, 'movies')).toEqual([]);
  });
});

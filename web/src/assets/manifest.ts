/**
 * The asset manifest: what exists, and what it must hash to.
 *
 * `scripts/make_manifest.py` writes this document and validates it against
 * `scripts/manifest_schema.json`. This module reads it and validates it again, because the
 * two sides have different jobs: the script's job is to refuse to publish a wrong manifest,
 * and the client's job is to refuse to *trust* one. The manifest arrives over the network
 * from a bucket, and every field it carries is load-bearing:
 *
 *  - `sha256` is the identity of the bytes, and the client hashes what it downloads against
 *    it before the bytes reach the simulation. A wrong hash here is a wrong game.
 *  - `stored` is the bucket key, and it is also the file name in the cache. It must be the
 *    hash plus `.bin`; the client refuses a manifest where it is not, because a mismatch
 *    would mean two names for one file, or one name for two.
 *  - `size` bounds what the client will accept and detects a truncated cache file.
 *  - `encoding` decides whether the bytes are decoded after arrival. `gzip` here means the
 *    bucket object holds a gzip member, which is not the same thing as a `Content-Encoding`
 *    the transport already removed.
 *
 * Unknown extra keys are ignored on purpose: a later manifest version may add one, and a
 * client that cannot read a key it does not use has no reason to fail. The `version` field
 * is checked, so a document this client cannot understand is refused by version rather than
 * by accident.
 */

import type { AssetEntry, AssetGroup, AssetManifest } from '../types.js';
import type { AssetFetch } from './cache.js';

/** The manifest version this client reads. */
export const MANIFEST_VERSION = '1';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STORED_PATTERN = /^[0-9a-f]{64}\.bin$/;
/** The same set of groups `scripts/manifest_schema.json` allows and `AssetGroup` names. */
const GROUP_PATTERN = /^(boot|menu|music|movies|other|character:.+|stage:.+)$/;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`${what} must be a non-empty string`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): AssetEntry {
  if (!isObject(value)) throw new ManifestError(`entries[${index}] must be an object`);
  const path = requireString(value.path, `entries[${index}].path`);
  const sha256 = requireString(value.sha256, `entries[${index}].sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ManifestError(`${path}: sha256 is not a lowercase hex SHA-256: ${sha256}`);
  }
  const stored = requireString(value.stored, `entries[${index}].stored`);
  if (!STORED_PATTERN.test(stored)) {
    throw new ManifestError(`${path}: stored is not a content hash and .bin: ${stored}`);
  }
  if (stored !== `${sha256}.bin`) {
    // Two names for one file means the cache can hold two copies and the manifest can point
    // at the wrong one; one name for two files means an asset silently replaces another.
    throw new ManifestError(`${path}: stored ${stored} does not match sha256 ${sha256}`);
  }
  const size = value.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new ManifestError(`${path}: size must be a non-negative integer`);
  }
  const group = requireString(value.group, `${path}.group`);
  if (!GROUP_PATTERN.test(group)) {
    // The group is what a lazy loader keys on (`AssetGroup`, web/src/types.ts). An unknown
    // one would be loaded by nothing, or by everything, silently.
    throw new ManifestError(`${path}: unknown asset group: ${group}`);
  }
  const encoding = value.encoding;
  if (encoding !== 'gzip' && encoding !== 'identity') {
    throw new ManifestError(`${path}: encoding must be gzip or identity`);
  }
  return { path, sha256, size, group: group as AssetGroup, stored, encoding };
}

/** Validate a parsed manifest document. Throws `ManifestError` naming the first problem. */
export function parseManifest(value: unknown): AssetManifest {
  if (!isObject(value)) throw new ManifestError('manifest must be a JSON object');
  const version = requireString(value.version, 'version');
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `manifest version ${version} is not ${MANIFEST_VERSION}: this shell cannot read it`,
    );
  }
  const generatedAt = requireString(value.generatedAt, 'generatedAt');
  const baseUrl = requireString(value.baseUrl, 'baseUrl');
  if (!Array.isArray(value.entries)) throw new ManifestError('entries must be an array');
  const entries = value.entries.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new ManifestError(`duplicate path in manifest: ${entry.path}`);
    seen.add(entry.path);
  }
  return { version, generatedAt, baseUrl, entries };
}

/**
 * Fetch and validate the manifest.
 *
 * A non-2xx answer is an error and not an empty asset set: an empty set would look like a
 * shell with no game, which is a much harder thing to diagnose than a 404.
 */
export async function loadManifest(
  fetcher: AssetFetch,
  url: string,
): Promise<AssetManifest> {
  let response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new ManifestError(`Fetching ${url} failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new ManifestError(`Fetching ${url} failed with status ${response.status}`);
  }
  const text = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${url} is not valid JSON: ${(error as Error).message}`);
  }
  return parseManifest(parsed);
}

/** The entry for one path, or null. Paths are the manifest's own, case-sensitive. */
export function findAsset(manifest: AssetManifest, path: string): AssetEntry | null {
  return manifest.entries.find((entry) => entry.path === path) ?? null;
}

/** Every entry in one group, in manifest order. */
export function assetsInGroup(manifest: AssetManifest, group: AssetGroup): readonly AssetEntry[] {
  return manifest.entries.filter((entry) => entry.group === group);
}

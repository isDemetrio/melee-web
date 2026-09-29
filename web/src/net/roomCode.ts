import type { RoomCode } from '../types.js';

/**
 * Room codes are read aloud and typed on phone keyboards, so the alphabet excludes
 * characters that are visually ambiguous in the fonts people actually use:
 * I and 1, O and 0, and also L (which reads as 1 or I in several UI fonts) and S/5.
 *
 * 28 symbols over 4 positions is 614,656 codes, far more than this project needs,
 * and no code is ever guessed by a stranger because the site itself is behind
 * Cloudflare Access.
 */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
export const ROOM_CODE_LENGTH = 4;

const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/**
 * Normalise operator input into a code, or return null when it cannot be one.
 * Accepts lowercase, spaces and dashes because people type "ab-cd" or "a b c d".
 */
export function normaliseRoomCode(raw: string): RoomCode | null {
  const cleaned = raw.toUpperCase().replace(/[\s\-_]/g, '');
  if (!CODE_RE.test(cleaned)) return null;
  return cleaned;
}

export function isValidRoomCode(raw: string): boolean {
  return CODE_RE.test(raw);
}

/**
 * Random code. `randomValues` is injectable so tests can pin the output.
 * Rejection sampling keeps the distribution uniform: 256 is not a multiple of 28,
 * so a plain modulo would bias the first four symbols.
 */
export function generateRoomCode(randomValues: (n: number) => Uint8Array = defaultRandom): RoomCode {
  const limit = Math.floor(256 / ROOM_ALPHABET.length) * ROOM_ALPHABET.length;
  let out = '';
  while (out.length < ROOM_CODE_LENGTH) {
    const bytes = randomValues(ROOM_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      if (out.length === ROOM_CODE_LENGTH) break;
    }
  }
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  normaliseRoomCode,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../../src/net/roomCode.js';

describe('room codes', () => {
  it('excludes the characters people confuse when reading a code aloud', () => {
    for (const forbidden of ['I', 'O', 'L', 'S', '1', '0', '5']) {
      expect(ROOM_ALPHABET).not.toContain(forbidden);
    }
  });

  it('accepts what a human types and normalises it', () => {
    expect(normaliseRoomCode('ab-cd')).toBe('ABCD');
    expect(normaliseRoomCode(' a b c d ')).toBe('ABCD');
    expect(normaliseRoomCode('aBcD')).toBe('ABCD');
  });

  it('rejects codes containing excluded characters or the wrong length', () => {
    expect(normaliseRoomCode('ABCI')).toBeNull();
    expect(normaliseRoomCode('ABC')).toBeNull();
    expect(normaliseRoomCode('ABCDE')).toBeNull();
    expect(normaliseRoomCode('')).toBeNull();
    expect(isValidRoomCode('ABCD')).toBe(true);
    expect(isValidRoomCode('ABCDE')).toBe(false);
  });

  it('generates codes from the allowed alphabet only', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it('rejects biased bytes instead of folding them with a modulo', () => {
    // 256 is not a multiple of 28, so bytes >= 252 must be skipped. A naive modulo
    // would bias the first four alphabet symbols; this pins the rejection path.
    const biased = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
    let call = 0;
    const code = generateRoomCode(() => {
      call += 1;
      return call === 1 ? biased : new Uint8Array([0, 1, 2, 3]);
    });
    expect(code).toBe(ROOM_ALPHABET.slice(0, 4));
  });
});

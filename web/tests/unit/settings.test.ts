import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  memoryStorage,
  migrate,
  normaliseSettings,
  saveSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
} from '../../src/ui/settings.js';

describe('settings', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const saved = saveSettings(storage, { ...DEFAULT_SETTINGS, nickname: 'Fabri', volume: 0.3 });
    const loaded = loadSettings(storage);
    expect(loaded).toEqual(saved);
    expect(loaded.nickname).toBe('Fabri');
  });

  it('returns defaults when storage is empty', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range values instead of trusting storage', () => {
    const storage = memoryStorage({
      [SETTINGS_KEY]: JSON.stringify({
        version: SETTINGS_VERSION,
        volume: 4,
        inputDelayFrames: 99,
        internalScale: 0,
        touchOverlayOpacity: -3,
      }),
    });
    const loaded = loadSettings(storage);
    expect(loaded.volume).toBe(1);
    expect(loaded.inputDelayFrames).toBe(4);
    expect(loaded.internalScale).toBe(1);
    expect(loaded.touchOverlayOpacity).toBe(0.15);
  });

  it('ignores wrong types rather than coercing them', () => {
    const loaded = normaliseSettings({ volume: 'loud', widescreen: 'yes', nickname: 42 });
    expect(loaded.volume).toBe(DEFAULT_SETTINGS.volume);
    expect(loaded.widescreen).toBe(DEFAULT_SETTINGS.widescreen);
    expect(loaded.nickname).toBe('');
  });

  it('truncates an absurd nickname instead of refusing it', () => {
    expect(normaliseSettings({ nickname: 'x'.repeat(500) }).nickname).toHaveLength(24);
  });

  it('migrates v1 to v2 without losing the player choices it knows about', () => {
    // v1 had no musicVolume (music followed the master volume) and no stick deadzone.
    const upgraded = migrate({ version: 1, volume: 0.4, inputDelayFrames: 3, widescreen: true });
    expect(upgraded.version).toBe(SETTINGS_VERSION);
    expect(upgraded.musicVolume).toBe(0.4);
    expect(upgraded.inputDelayFrames).toBe(3);
    expect(upgraded.widescreen).toBe(true);
    expect(upgraded.controlStickDeadzone).toBe(DEFAULT_SETTINGS.controlStickDeadzone);
  });

  it('treats a payload with no version as v1', () => {
    expect(migrate({ volume: 0.5 }).musicVolume).toBe(0.5);
  });

  it('keeps the corrupt payload for diagnosis and falls back to defaults', () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: '{not json' });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(storage.getItem(`${SETTINGS_KEY}.corrupt`)).toBe('{not json');
    expect(storage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it('never throws when storage itself throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(hostile, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

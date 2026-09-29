/**
 * Typed, versioned settings backed by localStorage.
 *
 * Two rules shape this module:
 *  1. Reading settings must never throw. A corrupt or hand-edited localStorage value
 *     falls back to defaults rather than breaking the boot screen.
 *  2. Schema changes must migrate, not reset. Losing a player's controller mapping
 *     because a field was added is the kind of bug that makes people stop using a tool.
 */

export const SETTINGS_KEY = 'melee-web.settings';
export const SETTINGS_VERSION = 2;

export interface Settings {
  readonly version: number;
  readonly nickname: string;
  readonly volume: number;
  readonly musicVolume: number;
  readonly inputDelayFrames: number;
  readonly widescreen: boolean;
  readonly internalScale: number;
  readonly touchOverlayOpacity: number;
  readonly showPerformance: boolean;
  readonly controlStickDeadzone: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  nickname: '',
  volume: 0.8,
  musicVolume: 0.6,
  // Slippi's default is 2 frames; the specification keeps the range 1..4 (docs/SPEC_PIANO.md §3.4).
  inputDelayFrames: 2,
  widescreen: false,
  internalScale: 1,
  touchOverlayOpacity: 0.5,
  showPerformance: false,
  controlStickDeadzone: 0.25,
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const clamp = (value: number, low: number, high: number): number =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Coerce an arbitrary parsed value into valid settings. Every field is bounded here, so
 * no later code has to defend against, say, an input delay of 4000 frames.
 */
export function normaliseSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const input = raw as Record<string, unknown>;

  return {
    version: SETTINGS_VERSION,
    nickname: asString(input.nickname, DEFAULT_SETTINGS.nickname).slice(0, 24),
    volume: clamp(asNumber(input.volume, DEFAULT_SETTINGS.volume), 0, 1),
    musicVolume: clamp(asNumber(input.musicVolume, DEFAULT_SETTINGS.musicVolume), 0, 1),
    inputDelayFrames: Math.round(
      clamp(asNumber(input.inputDelayFrames, DEFAULT_SETTINGS.inputDelayFrames), 1, 4),
    ),
    widescreen: asBoolean(input.widescreen, DEFAULT_SETTINGS.widescreen),
    internalScale: Math.round(clamp(asNumber(input.internalScale, DEFAULT_SETTINGS.internalScale), 1, 4)),
    touchOverlayOpacity: clamp(
      asNumber(input.touchOverlayOpacity, DEFAULT_SETTINGS.touchOverlayOpacity),
      0.15,
      1,
    ),
    showPerformance: asBoolean(input.showPerformance, DEFAULT_SETTINGS.showPerformance),
    controlStickDeadzone: clamp(
      asNumber(input.controlStickDeadzone, DEFAULT_SETTINGS.controlStickDeadzone),
      0,
      0.9,
    ),
  };
}

/**
 * Migrate a stored payload to the current schema.
 *
 * v1 had no `musicVolume` (music used the master volume) and no
 * `controlStickDeadzone`. Both are derived rather than defaulted so a player's
 * existing feel is preserved.
 */
export function migrate(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const input = raw as Record<string, unknown>;
  const version = asNumber(input.version, 1);

  if (version >= SETTINGS_VERSION) return normaliseSettings(input);

  const upgraded: Record<string, unknown> = { ...input, version: SETTINGS_VERSION };
  if (version < 2) {
    upgraded.musicVolume = input.musicVolume ?? input.volume ?? DEFAULT_SETTINGS.musicVolume;
    upgraded.controlStickDeadzone = input.controlStickDeadzone ?? DEFAULT_SETTINGS.controlStickDeadzone;
  }
  return normaliseSettings(upgraded);
}

export function loadSettings(storage: StorageLike): Settings {
  let stored: string | null = null;
  try {
    stored = storage.getItem(SETTINGS_KEY);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (stored === null) return DEFAULT_SETTINGS;

  try {
    return migrate(JSON.parse(stored));
  } catch {
    // Corrupt JSON: keep the bad payload for diagnosis, then use defaults.
    try {
      storage.setItem(`${SETTINGS_KEY}.corrupt`, stored);
      storage.removeItem(SETTINGS_KEY);
    } catch {
      // Storage may be full or unavailable; defaults are still correct.
    }
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(storage: StorageLike, settings: Settings): Settings {
  const normalised = normaliseSettings(settings);
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalised));
  } catch {
    // Private browsing with storage disabled: the session still works, it just does
    // not persist. Never throw from a settings write.
  }
  return normalised;
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

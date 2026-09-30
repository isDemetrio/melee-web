/**
 * Capability detection.
 *
 * The specification is explicit (docs/SPEC_PIANO.md §1.3): there is no WebGL2 fallback
 * in v1.0. A device that cannot run the game must be told so clearly and immediately,
 * instead of being handed a broken canvas. That makes this module a gate, not a nicety:
 * `report.usable` decides whether the "Gioca" button does anything at all.
 *
 * Everything here is a pure function of an injected environment, so the whole matrix can
 * be tested in Node without a browser.
 */

export interface CapabilityReport {
  /** `navigator.gpu` exists and an adapter can be requested. */
  readonly webgpu: boolean;
  /** COOP/COEP are in effect, which is a precondition for SharedArrayBuffer. */
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly audioWorklet: boolean;
  /** Origin Private File System, where extracted disc files are cached. */
  readonly opfs: boolean;
  /** Shared-memory WebAssembly, i.e. `-pthread` builds. */
  readonly wasmThreads: boolean;
  /** The exception-handling proposal, needed for `-fwasm-exceptions`. */
  readonly wasmExceptions: boolean;
  readonly gamepad: boolean;
  readonly wakeLock: boolean;
  /** Human-readable names of the capabilities v1.0 requires that are missing. */
  readonly missing: readonly string[];
  /** False when at least one required capability is missing. */
  readonly usable: boolean;
}

export interface CapabilitySources {
  readonly crossOriginIsolated: boolean;
  readonly hasNavigatorGpu: boolean;
  readonly requestAdapter: (() => Promise<unknown>) | null;
  readonly sharedArrayBuffer: boolean;
  readonly audioWorklet: boolean;
  readonly storageGetDirectory: (() => Promise<unknown>) | null;
  readonly webAssemblyValidate: ((bytes: readonly number[]) => boolean) | null;
  readonly gamepad: boolean;
  readonly wakeLock: boolean;
}

/**
 * Hand-encoded WebAssembly modules, used to probe proposal support with
 * `WebAssembly.validate` rather than by trusting a user-agent string.
 *
 * Threads: a memory with the shared flag set (limits flags 0x03) validates only when the
 * threads proposal is implemented. Section 5 (memory), payload length 4, one memory,
 * flags 0x03, min 1 page, max 2 pages.
 *
 * Exceptions: a module with one empty function type (section 1) and one tag (section 13,
 * attribute 0x00, type index 0) validates only when exception handling is implemented.
 */
export const SHARED_MEMORY_PROBE: readonly number[] = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x05, 0x04, 0x01, 0x03, 0x01, 0x02, // memory: 1, shared, min 1, max 2
];

export const EXCEPTIONS_PROBE: readonly number[] = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
  0x0d, 0x03, 0x01, 0x00, 0x00, // tag: attribute 0, type 0
];

export function defaultSources(): CapabilitySources {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const gpu = nav && 'gpu' in nav ? (nav.gpu as { requestAdapter(): Promise<unknown> }) : undefined;
  const storage =
    nav && 'storage' in nav
      ? (nav.storage as { getDirectory?: () => Promise<unknown> })
      : undefined;

  return {
    crossOriginIsolated: typeof globalThis.crossOriginIsolated === 'boolean'
      ? globalThis.crossOriginIsolated
      : false,
    hasNavigatorGpu: gpu !== undefined,
    requestAdapter: gpu ? () => gpu.requestAdapter() : null,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    audioWorklet: typeof AudioWorkletNode === 'function' && typeof AudioContext === 'function',
    storageGetDirectory: storage?.getDirectory ? () => storage.getDirectory!() : null,
    webAssemblyValidate:
      typeof WebAssembly === 'object' && typeof WebAssembly.validate === 'function'
        ? (bytes: readonly number[]) => WebAssembly.validate(new Uint8Array(bytes))
        : null,
    gamepad: nav !== null && 'getGamepads' in nav,
    wakeLock: nav !== null && 'wakeLock' in nav,
  };
}

function probe(sources: CapabilitySources, bytes: readonly number[]): boolean {
  if (!sources.webAssemblyValidate) return false;
  try {
    return sources.webAssemblyValidate(bytes);
  } catch {
    return false;
  }
}

/**
 * Detect everything. `requestAdapter` is awaited because `navigator.gpu` existing does
 * not mean a usable adapter exists: a browser without a WebGPU-capable GPU driver
 * exposes the object and returns null from `requestAdapter()`.
 */
export async function detectCapabilities(
  sources: CapabilitySources = defaultSources(),
): Promise<CapabilityReport> {
  let webgpu = false;
  if (sources.hasNavigatorGpu && sources.requestAdapter) {
    try {
      webgpu = (await sources.requestAdapter()) !== null;
    } catch {
      webgpu = false;
    }
  }

  const report: Omit<CapabilityReport, 'missing' | 'usable'> = {
    webgpu,
    crossOriginIsolated: sources.crossOriginIsolated,
    sharedArrayBuffer: sources.sharedArrayBuffer,
    audioWorklet: sources.audioWorklet,
    opfs: sources.storageGetDirectory !== null,
    wasmThreads: probe(sources, SHARED_MEMORY_PROBE),
    wasmExceptions: probe(sources, EXCEPTIONS_PROBE),
    gamepad: sources.gamepad,
    wakeLock: sources.wakeLock,
  };

  const missing: string[] = [];
  if (!report.webgpu) missing.push('WebGPU');
  if (!report.crossOriginIsolated) missing.push('cross-origin isolation (COOP/COEP headers)');
  if (!report.sharedArrayBuffer) missing.push('SharedArrayBuffer');
  if (!report.wasmThreads) missing.push('WebAssembly threads');
  if (!report.wasmExceptions) missing.push('WebAssembly exception handling');
  if (!report.opfs) missing.push('OPFS (Origin Private File System)');

  return { ...report, missing, usable: missing.length === 0 };
}

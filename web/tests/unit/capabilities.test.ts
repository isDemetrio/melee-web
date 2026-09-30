import { describe, expect, it } from 'vitest';
import {
  detectCapabilities,
  defaultSources,
  EXCEPTIONS_PROBE,
  SHARED_MEMORY_PROBE,
  type CapabilitySources,
} from '../../src/platform/capabilities.js';

/** A device that satisfies every v1.0 requirement. */
function capableSources(overrides: Partial<CapabilitySources> = {}): CapabilitySources {
  return {
    crossOriginIsolated: true,
    hasNavigatorGpu: true,
    requestAdapter: async () => ({ name: 'fake adapter' }),
    sharedArrayBuffer: true,
    audioWorklet: true,
    storageGetDirectory: async () => ({}),
    webAssemblyValidate: (bytes) => bytes.length > 0,
    gamepad: true,
    wakeLock: true,
    ...overrides,
  };
}

describe('capability detection', () => {
  it('reports a fully capable device as usable with nothing missing', async () => {
    const report = await detectCapabilities(capableSources());
    expect(report.usable).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.webgpu).toBe(true);
  });

  it('treats a present navigator.gpu with no adapter as no WebGPU', async () => {
    // A browser can expose navigator.gpu and still return null from requestAdapter on a
    // machine with no usable GPU driver. Trusting the object alone would ship a broken canvas.
    const report = await detectCapabilities(capableSources({ requestAdapter: async () => null }));
    expect(report.webgpu).toBe(false);
    expect(report.usable).toBe(false);
    expect(report.missing).toContain('WebGPU');
  });

  it('treats a throwing requestAdapter as no WebGPU instead of propagating', async () => {
    const report = await detectCapabilities(
      capableSources({
        requestAdapter: async () => {
          throw new Error('GPU process crashed');
        },
      }),
    );
    expect(report.webgpu).toBe(false);
  });

  it('names every missing requirement, not just the first', async () => {
    const report = await detectCapabilities(
      capableSources({
        crossOriginIsolated: false,
        sharedArrayBuffer: false,
        webAssemblyValidate: () => false,
        storageGetDirectory: null,
      }),
    );
    expect(report.usable).toBe(false);
    expect(report.missing).toEqual([
      'cross-origin isolation (COOP/COEP headers)',
      'SharedArrayBuffer',
      'WebAssembly threads',
      'WebAssembly exception handling',
      'OPFS (Origin Private File System)',
    ]);
  });

  it('does not require a gamepad or wake lock to consider the device usable', async () => {
    const report = await detectCapabilities(capableSources({ gamepad: false, wakeLock: false }));
    expect(report.usable).toBe(true);
    expect(report.gamepad).toBe(false);
  });

  it('survives a WebAssembly.validate that throws', async () => {
    const report = await detectCapabilities(
      capableSources({
        webAssemblyValidate: () => {
          throw new Error('validate exploded');
        },
      }),
    );
    expect(report.wasmThreads).toBe(false);
    expect(report.wasmExceptions).toBe(false);
  });

  it('ships probe modules with the correct structure', () => {
    // Both probes must start with the wasm magic and version, otherwise the test would
    // pass for the wrong reason (an invalid module fails to validate everywhere).
    for (const probe of [SHARED_MEMORY_PROBE, EXCEPTIONS_PROBE]) {
      expect([...probe.slice(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    }
    expect(SHARED_MEMORY_PROBE[8]).toBe(0x05); // memory section
    expect(EXCEPTIONS_PROBE[14]).toBe(0x0d); // tag section
  });

  it('reports nothing supported when there is no WebAssembly at all', async () => {
    const report = await detectCapabilities(capableSources({ webAssemblyValidate: null }));
    expect(report.wasmThreads).toBe(false);
    expect(report.wasmExceptions).toBe(false);
  });

  it('builds default sources without a browser', () => {
    // In Node there is no navigator, no SharedArrayBuffer guarantee and no AudioWorkletNode;
    // this must produce a report of "nothing available" rather than throwing.
    const sources = defaultSources();
    expect(sources.hasNavigatorGpu).toBe(false);
    expect(sources.requestAdapter).toBeNull();
    expect(sources.storageGetDirectory).toBeNull();
  });
});

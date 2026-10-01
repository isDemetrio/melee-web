// The browser half of the WebGPU probe, in a worker.
//
// WHY A WORKER. Runs 36909581289, 36910340139 and 36911030437 all created the device on the page's
// main thread, and all three lost it at the first task boundary after GPU work: the readback of a
// texture the page had just cleared came back [0,0,0,0], `device.lost` reported "destroyed: Device
// was destroyed." and the canvas configure then threw "A valid external Instance reference no longer
// exists.". Run 36911030437's timeline puts the death at about 62 ms, ~47 ms into the first await,
// with the adapter, device and readback buffer rooted in `window.__gpu` and the page painting four
// animation frames (`visibility: visible` both times) — so neither collection nor an idle page is
// the cause.
//
// The realm was what was left, and the evidence for it is in this repository: `web/tests/spike/
// render.spec.ts` and `web/src/spike/gpu.ts` do exactly this readback in CI, in a worker, in the
// same browser with the same two launch flags, and get the colour back (runs 36892349174,
// 36896537472, 36898914442, 36901465493). The renderer runs in a worker too, so this is also the
// realm the probe's answer has to hold in.
//
// THE ZEROS WERE THIS HARNESS, NOT THE BROWSER (run 36912403273). In the worker the readback still
// came back [0,0,0,0], and the cause was not the GPU: this file copied the whole 4x4 texture with
// `bytesPerRow: 256` into a 256-byte buffer — four rows need 256 * 3 + 16 = 784 bytes — and WebGPU
// rejects that copy with a validation error, which does not throw. The buffer stayed
// zero-initialised and the probe read a plausible [0,0,0,0] off it, indistinguishable from a GPU
// that ran the clear and returned nothing. Three things follow, all below: the copy is now the one
// `gpu.ts`'s `readPixel` makes and CI returns the colour from (one pixel, `bytesPerRow: 256`, a
// 256-byte buffer); a validation error is reported instead of being read as a GPU result
// (`uncapturederror`); and a buffer round trip that touches neither texture nor canvas runs first, so
// "the device is dead" and "the copy is wrong" cannot be confused again.
//
// THE REALM IS NOT WHAT KILLS THE DEVICE (run 36920684654). With the readback fixed, the worker
// returned [255,0,0,255] from a texture cleared to red — the answer the probe exists for — and lost
// the device 0.8 ms after the canvas was configured and cleared (11.6 ms in the full-build
// configuration), with `onSubmittedWorkDone` rejecting "A valid external Instance reference no longer
// exists". That is the failure `render.spec.ts` records as "THE GAP", reproduced in the realm the
// renderer runs in: the canvas frame's commit ends the device, not the realm it is committed from.
// So the canvas is configured, cleared and submitted here, its commit is recorded as a measurement
// (`canvas_commit`), and its pixel is left to a real device. The texture readback is the same backend
// path with only the canvas commit removed, and that is what the check requires.

const TIMEOUT_MS = 20000;

const result = {
  realm: globalThis.constructor?.name ?? 'unknown',
  timeline: [],
  adapter: null,
  device: null,
  round_trip: null,
  readback: null,
  canvas: null,
  canvas_commit: null,
  errors: [],
  device_lost: null,
  error: null,
};

const loadedMs = performance.now();
const mark = (event) => result.timeline.push(`${(performance.now() - loadedMs).toFixed(1)}ms ${event}`);

/** Every await here is bounded: a harness that hangs answers nothing, and this one must answer. */
const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not answer within ${TIMEOUT_MS} ms`)), TIMEOUT_MS),
    ),
  ]);

/**
 * Round-trip four known bytes through a buffer: writeBuffer, then mapAsync. Touches neither the
 * texture nor the canvas, so it separates "the device is dead" from "the copy is wrong".
 */
async function roundTrip(device) {
  const expected = [1, 2, 3, 4];
  const buffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  self.__gpu.buffers.push(buffer);
  device.queue.writeBuffer(buffer, 0, new Uint8Array(expected));
  await withTimeout(buffer.mapAsync(GPUMapMode.READ), 'mapAsync (round trip)');
  const bytes = Array.from(new Uint8Array(buffer.getMappedRange().slice(0, 4)));
  buffer.unmap();
  return JSON.stringify(bytes) === JSON.stringify(expected) ? 'ok' : `wrong bytes ${JSON.stringify(bytes)}`;
}

/** Clear a 4x4 texture to `colour` and read its far corner back off the GPU. */
async function clearAndRead(device, colour) {
  const size = 4;
  const texture = device.createTexture({
    size: [size, size],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  self.__gpu.buffers.push(buffer);
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: texture.createView(), clearValue: colour, loadOp: 'clear', storeOp: 'store' },
    ],
  });
  pass.end();
  // One pixel at the far corner, `bytesPerRow: 256`, a 256-byte buffer: exactly the copy
  // `web/src/spike/gpu.ts` makes in `readPixel` and CI returns the colour from. Copying all four
  // rows into this buffer is the rejected copy the header describes, and it reads back as zeros.
  encoder.copyTextureToBuffer(
    { texture, origin: [size - 1, size - 1] },
    { buffer, bytesPerRow: 256 },
    [1, 1],
  );
  device.queue.submit([encoder.finish()]);
  await withTimeout(buffer.mapAsync(GPUMapMode.READ), 'mapAsync');
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0, 4));
  const pixel = [bytes[0], bytes[1], bytes[2], bytes[3]];
  buffer.unmap();
  return pixel;
}

self.onmessage = async (event) => {
  try {
    if (typeof navigator.gpu === 'undefined') {
      result.adapter = 'no navigator.gpu';
    } else {
      // The fallback adapter is asked for explicitly: the CI runner renders in software.
      const adapter =
        (await withTimeout(navigator.gpu.requestAdapter(), 'requestAdapter')) ??
        (await withTimeout(
          navigator.gpu.requestAdapter({ forceFallbackAdapter: true }),
          'requestAdapter (fallback)',
        ));
      if (!adapter) {
        result.adapter = 'null (no adapter, hardware or fallback)';
      } else {
        result.adapter = adapter.info
          ? `${adapter.info.vendor ?? '?'} ${adapter.info.architecture ?? '?'}`
          : 'present';
        const device = await withTimeout(adapter.requestDevice(), 'requestDevice');
        // Rooted for the worker's lifetime, as `web/src/spike/gpu.ts` does.
        self.__gpu = { adapter, device, buffers: [] };
        result.device = device !== null && device !== undefined;
        // WebGPU reports a rejected command as a validation error, and a validation error neither
        // throws nor stops the run: without this listener a rejected copy is read as an answer.
        device.addEventListener('uncapturederror', (event) => {
          result.errors.push(event.error.message);
          mark(`uncaptured error: ${event.error.message}`);
        });
        device.lost.then((info) => {
          result.device_lost = `${info.reason}: ${info.message}`;
          mark(`device lost: ${info.reason}: ${info.message}`);
        });
        mark('device acquired');

        result.round_trip = await withTimeout(roundTrip(device), 'the buffer round trip');
        mark(`buffer round trip: ${result.round_trip}`);

        result.readback = await withTimeout(clearAndRead(device, { r: 1, g: 0, b: 0, a: 1 }), 'the texture readback');
        mark(`texture readback: ${JSON.stringify(result.readback)}`);

        // The path the renderer actually needs: a canvas configured for WebGPU, cleared, submitted.
        // The pixel is not read back -- see the header -- and the commit is recorded instead.
        const canvas = event.data?.canvas;
        if (!canvas) {
          result.canvas = 'no canvas was transferred';
        } else {
          const context = canvas.getContext('webgpu');
          context.configure({
            device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'opaque',
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 1, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          pass.end();
          device.queue.submit([encoder.finish()]);
          // Set before the await: the three calls above are the answer, and the await below is the
          // canvas frame's commit, which is where CI's Chromium loses the device.
          result.canvas = 'configured and cleared';
          mark('canvas configured and cleared');
          try {
            await withTimeout(device.queue.onSubmittedWorkDone(), 'onSubmittedWorkDone');
            result.canvas_commit = 'the device survived the canvas commit';
          } catch (error) {
            result.canvas_commit = `the device did not survive the canvas commit: ${error}`;
          }
          mark(result.canvas_commit);
        }
      }
    }
  } catch (error) {
    result.error = String(error);
    mark(`error: ${error}`);
  }

  // One turn of the event loop, so that a `device.lost` that fired during the run is in the answer.
  await new Promise((resolve) => setTimeout(resolve, 100));
  self.postMessage(result);
};

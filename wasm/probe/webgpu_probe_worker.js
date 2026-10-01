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
// The realm is what is left, and the evidence for it is in this repository: `web/tests/spike/
// render.spec.ts` and `web/src/spike/gpu.ts` do exactly this readback in CI, in a worker, in the
// same browser with the same two launch flags, and get the colour back (runs 36892349174,
// 36896537472, 36898914442, 36901465493). The renderer runs in a worker too, so this is also the
// realm the probe's answer has to hold in.
//
// What the worker cannot do here is read a canvas pixel back: `gpu.ts` records that the device does
// not survive the end of the first task that takes a canvas texture (run 36898914442, "THE GAP" in
// render.spec.ts), so the canvas is configured and cleared and its pixel is left to a real device.
// The texture readback below is the same backend path with only the canvas commit removed.

const TIMEOUT_MS = 20000;

const result = {
  realm: globalThis.constructor?.name ?? 'unknown',
  timeline: [],
  adapter: null,
  device: null,
  readback: null,
  canvas: null,
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

/** Clear a 4x4 texture to `colour` and read pixel (0, 0) back off the GPU. */
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
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: texture.createView(), clearValue: colour, loadOp: 'clear', storeOp: 'store' },
    ],
  });
  pass.end();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [size, size]);
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
        self.__gpu = { adapter, device };
        result.device = device !== null && device !== undefined;
        device.lost.then((info) => {
          result.device_lost = `${info.reason}: ${info.message}`;
          mark(`device lost: ${info.reason}: ${info.message}`);
        });
        mark('device acquired');

        result.readback = await withTimeout(clearAndRead(device, { r: 1, g: 0, b: 0, a: 1 }), 'the texture readback');
        mark(`texture readback: ${JSON.stringify(result.readback)}`);

        // The path the renderer actually needs: a canvas configured for WebGPU, cleared. The pixel
        // is not read back — see the header.
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
          await withTimeout(device.queue.onSubmittedWorkDone(), 'onSubmittedWorkDone');
          result.canvas = 'configured and cleared';
          mark('canvas configured and cleared');
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

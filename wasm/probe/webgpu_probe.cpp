// WebGPU toolchain probe.
//
// docs/RENDERER_MAP.md makes a WebGPU backend the first implementation priority of the renderer,
// and that plan rests on assumptions that are cheap to check and expensive to assume:
//
//   1. `--use-port=emdawnwebgpu` on the pinned Emscripten (EMSDK_VERSION, 4.0.23) compiles and
//      links a translation unit that includes <webgpu/webgpu.h> and calls into it. Dawn's own
//      README puts the built-in remote port at Emscripten 4.0.10+, so this should hold -- "should"
//      is what this probe replaces.
//   2. The browser this repository's CI can actually run -- headless Chromium with software
//      rendering -- exposes WebGPU at all. `web/src/platform/capabilities.ts` already makes WebGPU
//      a gate for the whole application, and a renderer whose tests cannot run in CI is a renderer
//      this repository cannot verify, whatever its code does on a desktop.
//   3. (added 2026-10-01) Whether the port can ADOPT a device acquired in JavaScript. This is the
//      open half of `docs/OPEN_QUESTIONS.md` Q10(b): the simulation is one synchronous `callMain`
//      and Asyncify is ruled out for it (`docs/AGENT_RULES.md`), so `requestAdapter` and
//      `requestDevice` -- which resolve only after the event loop turns -- have to happen in
//      JavaScript before the module runs. `wasm/render/gx_webgpu.cpp` therefore reaches the device
//      through `EM_JS`. The alternative is for C++ to own the device, which needs the port to
//      import the one JavaScript already acquired.
//
//      The pinned port does declare that import, and this half measures it. Evidence, read out of
//      the package Emscripten 4.0.23 downloads (`tools/ports/emdawnwebgpu.py` pins
//      `emdawnwebgpu_pkg-v20251002.162335`, SHA-512 `ed15672c...b0fb0`, verified against the
//      downloaded archive):
//
//        webgpu/include/webgpu/webgpu.h:2265   WGPU_EXPORT WGPUDevice emscripten_webgpu_get_device(void);
//        webgpu/src/library_webgpu.js:647-660  emscripten_webgpu_get_device asserts
//                                              `Module['preinitializedWebGPUDevice']` and imports it
//                                              through `WebGPU.importJsDevice`, which registers that
//                                              exact JavaScript object and its queue.
//
//      What the source does not say is whether the imported device is usable from C++ in this
//      build, and that is what the probe answers: a device acquired by the page before the module
//      is instantiated, adopted here, queried, and used to create a texture and write a pixel into
//      it. The API carries a deprecation note in the pinned source
//      (`TODO(crbug.com/374150686): Remove this once it has been fully deprecated in users`), so the
//      answer is recorded as "this exists and works in the pinned toolchain", not as "this is the
//      port's recommended long-term interface".
//
// The C++ side proves the first: one instance, created and released. It deliberately does not
// request an adapter -- that is asynchronous and would say more about the probe's callback plumbing
// than about the toolchain -- so the second half of the check lives in JavaScript, in
// webgpu_probe.html, where `navigator.gpu` is the real thing and not a binding. The page acquires
// the device and hands it over in the module's arguments, which is exactly the order the real
// backend needs.
//
// Nothing here is game-derived and nothing here ships: the file exists to answer those questions
// once, in CI, with an exit code.

#include <cstdio>

#include <webgpu/webgpu.h>

namespace {

// The adopted device, used the way a backend would: the queue, the limits, a texture, a pixel.
// Every line is printed, because the CI check reads the lines and a missing line is an answer too.
void adopt_device() {
  WGPUDevice device = emscripten_webgpu_get_device();
  if (device == nullptr) {
    std::printf("adopt: no device: emscripten_webgpu_get_device returned null\n");
    return;
  }
  std::printf("adopt: device adopted\n");

  WGPUQueue queue = wgpuDeviceGetQueue(device);
  if (queue == nullptr) {
    std::printf("adopt: queue missing\n");
    return;
  }
  std::printf("adopt: queue ok\n");

  WGPULimits limits = WGPU_LIMITS_INIT;
  const WGPUStatus status = wgpuDeviceGetLimits(device, &limits);
  std::printf("adopt: limits %s, maxTextureDimension2D %u\n",
              status == WGPUStatus_Success ? "read" : "refused",
              status == WGPUStatus_Success ? limits.maxTextureDimension2D : 0u);

  WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
  descriptor.usage = WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding;
  descriptor.dimension = WGPUTextureDimension_2D;
  descriptor.size = WGPUExtent3D{1, 1, 1};
  descriptor.format = WGPUTextureFormat_RGBA8Unorm;
  descriptor.mipLevelCount = 1;
  descriptor.sampleCount = 1;
  WGPUTexture texture = wgpuDeviceCreateTexture(device, &descriptor);
  if (texture == nullptr) {
    std::printf("adopt: the adopted device created no texture\n");
    return;
  }

  const unsigned char red[4] = {255, 0, 0, 255};
  WGPUTexelCopyTextureInfo destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
  destination.texture = texture;
  destination.aspect = WGPUTextureAspect_All;
  WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
  layout.bytesPerRow = 4;
  layout.rowsPerImage = 1;
  const WGPUExtent3D write_size = WGPUExtent3D{1, 1, 1};
  wgpuQueueWriteTexture(queue, &destination, red, sizeof(red), &layout, &write_size);
  wgpuTextureRelease(texture);
  std::printf("adopt: wrote 4 bytes into a texture the adopted device created\n");
}

}  // namespace

int main() {
  WGPUInstance instance = wgpuCreateInstance(nullptr);
  if (instance == nullptr) {
    std::printf("cxx: wgpuCreateInstance returned null\n");
    return 1;
  }
  std::printf("cxx: instance created\n");
  wgpuInstanceRelease(instance);
  std::printf("cxx: instance released, toolchain ok\n");

  adopt_device();
  return 0;
}

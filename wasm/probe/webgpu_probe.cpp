// WebGPU toolchain probe.
//
// docs/RENDERER_MAP.md makes a WebGPU backend the first implementation priority of the renderer,
// and that plan rests on two assumptions that are cheap to check and expensive to assume:
//
//   1. `--use-port=emdawnwebgpu` on the pinned Emscripten (EMSDK_VERSION, 4.0.23) compiles and
//      links a translation unit that includes <webgpu/webgpu.h> and calls into it. Dawn's own
//      README puts the built-in remote port at Emscripten 4.0.10+, so this should hold — "should"
//      is what this probe replaces.
//   2. The browser this repository's CI can actually run — headless Chromium with software
//      rendering — exposes WebGPU at all. `web/src/platform/capabilities.ts` already makes WebGPU
//      a gate for the whole application, and a renderer whose tests cannot run in CI is a renderer
//      this repository cannot verify, whatever its code does on a desktop.
//
// The C++ side proves the first: one instance, created and released. It deliberately does not
// request an adapter — that is asynchronous and would say more about the probe's callback plumbing
// than about the toolchain — so the second half of the check lives in JavaScript, in
// webgpu_probe.html, where `navigator.gpu` is the real thing and not a binding.
//
// Nothing here is game-derived and nothing here ships: the file exists to answer those two
// questions once, in CI, with an exit code.

#include <cstdio>

#include <webgpu/webgpu.h>

int main() {
  WGPUInstance instance = wgpuCreateInstance(nullptr);
  if (instance == nullptr) {
    std::printf("cxx: wgpuCreateInstance returned null\n");
    return 1;
  }
  std::printf("cxx: instance created\n");
  wgpuInstanceRelease(instance);
  std::printf("cxx: instance released, toolchain ok\n");
  return 0;
}

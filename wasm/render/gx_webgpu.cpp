// WebGPU baseline geometry and ordered EFB copies (RENDERER_MAP priorities 1-2).
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What it does. A persistent EFB texture (gx::EFB_WIDTH x gx::EFB_HEIGHT) and the canvas. Each
// EfbCopy is replayed in frame order, the way GX executes it: an XFB copy first copies the EFB's
// source rectangle to the canvas, then a copy with `clear` set clears the EFB to its clear colour.
// So the colour a frame clears to is on screen from the NEXT XFB copy on, as on the console. A colour
// copy to RAM is kept as a texture that draws sampling its address read (gxw_copy, as upstream).
//
// Geometry is drawn with WGSL generated per draw state by gx_wgsl.cpp -- the TEV, texture coordinate
// generation, colour channels, alpha test and fog -- then GX's blend state (gxw_draw). Lighting and
// indirect texturing remain open (gx_wgsl.cpp says what each falls back to). Clears cover the whole
// EFB; half-scale, Y scale, gamma, copy formats and depth copies remain open (priorities 2-5).
//
// The XFB target is the canvas's current texture, or -- when Module.gxWebgpu.xfb is set -- a plain
// offscreen texture, which is how CI reads the backend's output back without committing a canvas
// frame (web/src/spike/gpu.ts says why).
//
// Where the GPU objects live. The adapter, device and canvas context are JavaScript objects acquired
// by the worker before the simulation starts (web/src/spike/gpu.ts) and reached here through
// Module.gxWebgpu. C++ cannot acquire them itself: requestAdapter/requestDevice resolve only after
// the event loop turns, the simulation is one synchronous callMain, and Asyncify is ruled out for
// the simulation path (docs/AGENT_RULES.md). Calling the browser's WebGPU directly also keeps this
// step independent of --use-port=emdawnwebgpu, which the toolchain probe (PR #47) has not yet proven.
//
// Degrade, never crash. No Module.gxWebgpu, no device, or any exception from the JavaScript side
// means no backend: gx_webgpu_attach returns 0, or the backend detaches itself from the decoder, and
// the simulation runs exactly as it does headless. Every JavaScript call below catches everything;
// WebGPU validation errors do not throw at all, they are collected by gpu.ts.
#include "gx_core.h"
#include "gx_wgsl.h"
#include "headless.h"
#include "ppc.h"
#include <cstdint>
#include <cstdlib>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <climits>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <emscripten/emscripten.h>

// The two JavaScript halves stay at file scope, where Emscripten's EM_JS examples put them: the macro
// emits extern "C" declarations and a marker the linker has to see.

// gxw_draw reads each pipeline's WGSL out of WASM memory.
EM_JS_DEPS(gxw_wgsl, "$UTF8ToString");

// Creates the EFB texture. 1 when there is a device to render with, 0 when there is not.
// `max_rows` is the uniform block a shader declares (gxw::MAX_ROWS float4 rows).
EM_JS(int, gxw_open, (int width, int height, int max_rows), {
  const gpu = Module["gxWebgpu"];
  if (!gpu || !gpu.device || (!gpu.context && !gpu.xfb)) return 0;
  // Draws per batch are bounded by the uniform arena; the vertex and index arenas' first sizes
  // grow by doubling.
  const UNIFORM_ARENA = 2 << 20, VERTEX_ARENA_INITIAL = 1 << 20, INDEX_ARENA_INITIAL = 256 << 10;
  try {
    gpu.efb = gpu.device.createTexture({
      size: [width, height], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    gpu.depth = gpu.device.createTexture({size: [width, height], format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT});
    gpu.white = gpu.device.createTexture({size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    gpu.device.queue.writeTexture({texture: gpu.white}, new Uint8Array([255,255,255,255]), {}, [1,1]);
    gpu.slots = [];
    const entries = [{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,
      buffer:{type:"uniform",hasDynamicOffset:true}}];
    for (let i=0;i<8;i++) {
      entries.push({binding:1+2*i,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float"}});
      entries.push({binding:2+2*i,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}});
    }
    gpu.textureLayout = gpu.device.createBindGroupLayout({entries});
    gpu.pipelineLayout = gpu.device.createPipelineLayout({bindGroupLayouts:[gpu.textureLayout]});
    gpu.pipelines = new Map();
    gpu.shaders = new Map();
    gpu.samplers = new Map();
    // Views have no destroy(): one per persistent texture, made here or when its texture is.
    gpu.efbView = gpu.efb.createView();
    gpu.depthView = gpu.depth.createView();
    gpu.whiteEntry = {id:0, texture:gpu.white, view:gpu.white.createView()};
    // Draw resources are persistent (gxw_bind, gxw_draw). Uniforms, vertices and indices are
    // arenas: each draw of a batch appends its data at its own offset to a staging copy, and the
    // batch writes them with one writeBuffer each just before its single submit (gpu.flush).
    // A draw's uniforms are the rows its shader reads (draw_segment's `u`, gxw::uniform_rows), at an
    // aligned offset; every binding is the whole block a shader declares, which may run past the
    // draw's own rows into the next draw's (never read) but never past the arena.
    gpu.uniformAlign = (gpu.device.limits && gpu.device.limits.minUniformBufferOffsetAlignment) || 256;
    gpu.uniformBinding = max_rows*16;
    gpu.uniforms = gpu.device.createBuffer({size:UNIFORM_ARENA,
      usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    gpu.uniformStaging = new Uint8Array(UNIFORM_ARENA);
    gpu.uniformWords = new Uint32Array(gpu.uniformStaging.buffer);
    gpu.vertexBuffer = gpu.device.createBuffer({size:VERTEX_ARENA_INITIAL,
      usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    gpu.vertexStaging = new Uint8Array(VERTEX_ARENA_INITIAL);
    gpu.indexBuffer = gpu.device.createBuffer({size:INDEX_ARENA_INITIAL,
      usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    gpu.indexStaging = new Uint8Array(INDEX_ARENA_INITIAL);
    gpu.texturePool = new Map(); gpu.texturePoolBytes = 0; gpu.evicted = [];
    gpu.bindGroups = new Map();
    gpu.drawSerial = 0;
    // The batch: one command encoder holding every draw, clear and copy since the last submit,
    // and one render pass across consecutive draws. Through 8305929 each draw had its own encoder,
    // pass and submit, and 3 writeBuffers: ~15 WebGPU calls per draw, ~900 draws per frame, and
    // on the iPhone (WebKit) every call is a message to the GPU process. createCommandEncoder
    // failing there is that message failing to send (RemoteDeviceProxy::createCommandEncoder).
    // A batch is submitted at each XFB copy (the end of a GX frame, so one per frame), at the end
    // of submit_frame, and early when an arena is full.
    //
    // batchSerial names the open batch (or the next one, when none is open): a pooled texture
    // whose `batch` is batchSerial may be named by the unsubmitted encoder and is not evicted
    // (gxw_bind). Buffers are replaced only between batches (gxw_draw), so never under an open one.
    gpu.batch = null; gpu.batchSerial = 1; gpu.batchSubmits = 0;
    // EFB copies to textures (gxw_copy), by guest destination address, and the replaced or dropped
    // copy textures that wait for the submit of the batch that may still name them.
    gpu.efbCopies = new Map(); gpu.copySerial = 0; gpu.copyGarbage = [];
    gpu.openBatch = () => gpu.batch || (gpu.batch = {encoder:gpu.device.createCommandEncoder(),
      pass:null, state:null, vertexBytes:0, indexBytes:0, uniformBytes:0, lastUniform:-1, lastRows:0});
    gpu.endPass = (b) => { if (b.pass) { b.pass.end(); b.pass = null; b.state = null; } };
    gpu.flush = () => {
      const b = gpu.batch;
      if (!b) return;
      gpu.batch = null; gpu.batchSerial++;
      gpu.endPass(b);
      const q = gpu.device.queue;
      if (b.vertexBytes) q.writeBuffer(gpu.vertexBuffer,0,gpu.vertexStaging,0,b.vertexBytes);
      if (b.indexBytes) q.writeBuffer(gpu.indexBuffer,0,gpu.indexStaging,0,b.indexBytes);
      if (b.uniformBytes) q.writeBuffer(gpu.uniforms,0,gpu.uniformStaging,0,b.uniformBytes);
      q.submit([b.encoder.finish()]);
      gpu.batchSubmits++;
      for (const t of gpu.copyGarbage) t.destroy();
      gpu.copyGarbage = [];
    };
    gpu.backendDevice = gpu.device;
    return 1;
  } catch (error) {
    gpu.recordFailure("open", error); gpu.failure = "open: " + error;
    return 0;
  }
});

// One EfbCopy: the copy half (EFB source rectangle to the canvas, or to a texture), then the clear
// half, recorded into the batch after the draws before it. An XFB copy submits the batch: the canvas
// texture it wrote is presented once the worker's task ends or transfers it. 1 on success.
//
// A copy to a texture (`copy_to`, the guest destination address; 0 for none) is upstream's
// execute_copy (gx_d3d12.cpp): the EFB rectangle is kept on the GPU, in a texture that a draw
// naming that address samples instead of guest RAM (gxw_bind), which this backend never writes. The
// texture is the EFB's own pixels at full size: the copy format is not converted and a half-scale
// copy is not downscaled, as upstream (normalised texture coordinates sample the same picture). This
// is how the game's render-to-texture reaches the TEV -- the fighters' shadows projected onto the
// stage are such a copy -- and without it those stages read whatever RAM held.
EM_JS(int, gxw_copy, (int src_x, int src_y, int src_w, int src_h, int to_xfb, int clear, int argb, int clear_z, int copy_to), {
  const gpu = Module["gxWebgpu"];
  const EFB_COPY_LIMIT = 64;
  try {
    const batch = gpu.openBatch();
    gpu.endPass(batch);
    const encoder = batch.encoder;
    if (copy_to) {
      const w = Math.min(src_w, gpu.efb.width - src_x), h = Math.min(src_h, gpu.efb.height - src_y);
      let e = gpu.efbCopies.get(copy_to);
      if (e) gpu.efbCopies.delete(copy_to);
      if (w > 0 && h > 0) {
        // A texture of another size is replaced; one the open batch may name is destroyed only
        // after that batch is submitted (gpu.flush).
        if (e && (e.texture.width !== w || e.texture.height !== h)) { gpu.copyGarbage.push(e.texture); e = null; }
        if (!e) {
          const texture = gpu.device.createTexture({size:[w,h],format:gpu.format,
            usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
          e = {id:-(++gpu.copySerial), texture, view:texture.createView()};
        }
        encoder.copyTextureToTexture({texture:gpu.efb, origin:[src_x, src_y]}, {texture:e.texture}, [w, h]);
        gpu.efbCopies.set(copy_to, e);
        if (gpu.efbCopies.size > EFB_COPY_LIMIT) {
          const [oldest, old] = gpu.efbCopies.entries().next().value;
          gpu.efbCopies.delete(oldest); gpu.copyGarbage.push(old.texture);
        }
        gpu.efbCopyTextures = (gpu.efbCopyTextures | 0) + 1;
      } else if (e) gpu.copyGarbage.push(e.texture);
    }
    if (to_xfb) {
      const target = gpu.xfb ? gpu.xfb : gpu.context.getCurrentTexture();
      let w = src_w, h = src_h;
      if (src_x + w > gpu.efb.width) w = gpu.efb.width - src_x;
      if (src_y + h > gpu.efb.height) h = gpu.efb.height - src_y;
      if (w > target.width) w = target.width;
      if (h > target.height) h = target.height;
      if (w > 0 && h > 0) {
        encoder.copyTextureToTexture({ texture: gpu.efb, origin: [src_x, src_y] }, { texture: target }, [w, h]);
      }
    }
    if (clear) {
      const c = argb >>> 0;
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: gpu.efbView, loadOp: "clear", storeOp: "store",
        clearValue: { r: ((c >>> 16) & 255) / 255, g: ((c >>> 8) & 255) / 255, b: (c & 255) / 255, a: (c >>> 24) / 255 },
      }], depthStencilAttachment: {view: gpu.depthView, depthLoadOp: "clear",
        depthStoreOp: "store", depthClearValue: 1 - (clear_z >>> 0) / 16777215} });
      pass.end();
      gpu.lastClearArgb = c;
    }
    if (to_xfb) gpu.flush();
    gpu.backendCopies = (gpu.backendCopies | 0) + 1;
    if (gpu.device !== gpu.backendDevice) gpu.backendDevice = null;
    return 1;
  } catch (error) {
    gpu.recordFailure("copy", error); gpu.failure = "copy: " + error;
    return 0;
  }
});

// Samplers are cached. They have no destroy(), so a fresh one per slot per draw (8 per
// draw, unused slots included) was released only by garbage collection, whose timing nothing
// here controls; createSampler is the call that failed on the iPhone after 81 copies (7296478).
// The descriptor is a pure function of mode0 bits 0-7 and mode1 bits 0-15, which is the key, so
// a hit is the sampler a miss would create. Bounded: past SAMPLER_CACHE_LIMIT distinct
// keys the oldest is dropped (to garbage collection). render.spec.ts's sampler count is the misses.
//
// Textures are cached by content. `content` is the id upload_textures gives one immutable
// TextureSnapshot decoded one way (format, TLUT format, size, levels); it never names anything
// else, and the C++ side holds the snapshot for as long as this pool holds its texture, so the
// pixels a hit returns are the pixels a miss would upload. No guest address or hash is trusted.
// Until 9b08acf the pool was keyed by slot and shape and every level was decoded and rewritten
// for every draw: 117 MB of writeTexture per in-match frame, ~1,880 draws (docs/PROGRESS.md).
// A miss returns 2 and upload_textures writes the levels (gxw_upload); a hit returns 1 and
// nothing is written. Queue operations run in order, so the first upload precedes every draw
// that uses it. https://www.w3.org/TR/webgpu/#queue-timeline
//
// Bounded by count and bytes, least recently used first, with limits far above what a match was
// measured to use (<=154 textures, 6.2 MiB per frame; 481 contents, 28 MB in 2400 frames). An
// evicted texture is destroyed, which already-submitted draws survive
// (https://www.w3.org/TR/webgpu/#texture-destruction), and its content id is queued for
// upload_textures, which then forgets the snapshot (gxw_evicted): the id is never reused, so a
// cached bind group naming it is never hit again. Textures the open batch may name -- the draw
// being bound and every draw recorded since the last submit -- are never evicted: such a batch
// may exceed the budget rather than destroy what its unsubmitted encoder uses (WebGPU would
// reject the whole submit). Pool order is least recently used first, so they are its tail.
//
// `copy_addr` names an EFB copy instead (gxw_copy): its texture is bound, or white when there is none
// at that address (the copy was dropped, or had no pixels).
EM_JS(int, gxw_bind, (int slot, int content, int width, int height, int levels, int mode0, int mode1, int copy_addr), {
  const gpu = Module["gxWebgpu"];
  const SAMPLER_CACHE_LIMIT = 256;
  const TEXTURE_POOL_LIMIT = 1024, TEXTURE_POOL_BYTES = 64 << 20;
  try {
    const minf = (mode0 >>> 5) & 7, mip = minf & 3;
    const lo = (mode1 & 255) / 16, hi = mip ? ((mode1 >>> 8) & 255) / 16 : 0;
    // WebGPU rejects inverted clamps; do not silently approximate invalid D3D state.
    if (lo > hi) throw new Error("inverted texture LOD clamps");
    const key = (mode0 & 255) | ((mode1 & 65535) << 8);
    let sampler = gpu.samplers.get(key);
    if (!sampler) {
      const wrap = ["clamp-to-edge","repeat","mirror-repeat","repeat"];
      sampler = gpu.device.createSampler({addressModeU:wrap[mode0&3],addressModeV:wrap[(mode0>>>2)&3],
        magFilter:(mode0&16)?"linear":"nearest", minFilter:(minf&4)?"linear":"nearest",
        mipmapFilter:mip===2?"linear":"nearest",lodMinClamp:lo,lodMaxClamp:hi});
      if (gpu.samplers.size >= SAMPLER_CACHE_LIMIT) gpu.samplers.delete(gpu.samplers.keys().next().value);
      gpu.samplers.set(key, sampler);
    }
    if (copy_addr) {
      const e = gpu.efbCopies.get(copy_addr);
      gpu.slots[slot] = {entry:e || gpu.whiteEntry, sampler, key};
      gpu.efbCopyBinds = (gpu.efbCopyBinds | 0) + 1;
      return 1;
    }
    if (!content) { gpu.slots[slot] = {entry:gpu.whiteEntry, sampler, key}; return 1; }
    let entry = gpu.texturePool.get(content), fresh = false;
    if (entry) gpu.texturePool.delete(content);
    else {
      let size = 0;
      for (let l = 0; l < levels; l++) size += Math.max(1, width >> l) * Math.max(1, height >> l) * 4;
      for (const [oldContent, old] of gpu.texturePool) {
        if (gpu.texturePool.size < TEXTURE_POOL_LIMIT && gpu.texturePoolBytes + size <= TEXTURE_POOL_BYTES) break;
        // Named by the open batch, whose encoder is not submitted yet: so is everything after it.
        if (old.batch === gpu.batchSerial) break;
        gpu.texturePool.delete(oldContent); gpu.texturePoolBytes -= old.size; old.texture.destroy();
        gpu.evicted.push(oldContent);
      }
      const texture = gpu.device.createTexture({size:[width,height],mipLevelCount:levels,
        format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      entry = {id:content, texture, view:texture.createView(), size};
      gpu.texturePoolBytes += size;
      fresh = true;
    }
    entry.batch = gpu.batchSerial;
    gpu.texturePool.set(content, entry);
    gpu.slots[slot] = {entry, sampler, key};
    return fresh ? 2 : 1;
  } catch(error) { gpu.recordFailure("texture", error); gpu.failure = "texture: " + error; return 0; }
});

// One level of the texture gxw_bind just made for `slot`. queue.writeTexture copies the WASM
// bytes before this call returns. 1 on success.
EM_JS(int, gxw_upload, (int slot, int level, int width, int height, const void* rgba, int bytes), {
  const gpu = Module["gxWebgpu"];
  try {
    gpu.device.queue.writeTexture({texture:gpu.slots[slot].entry.texture,mipLevel:level},
      HEAPU8.subarray(rgba,rgba+bytes),{bytesPerRow:width*4,rowsPerImage:height},[width,height]);
    gpu.textureUploads = (gpu.textureUploads | 0) + 1;
    return 1;
  } catch(error) { gpu.recordFailure("texture", error); gpu.failure = "texture: " + error; return 0; }
});

// The next content id gxw_bind evicted, oldest first; 0 when there is none.
EM_JS(int, gxw_evicted, (), {
  const gpu = Module["gxWebgpu"]; return gpu.evicted.length ? gpu.evicted.shift() : 0;
});

EM_JS(int, gxw_texture_count, (), {
  const gpu = Module["gxWebgpu"]; return gpu && gpu.texturePool ? gpu.texturePool.size + 1 : 0;
});

// Explicit float4 rows: no dependency on an unverified C++/WGSL struct ABI.
//
// Nothing here is created per draw. A draw is recorded into the open batch (gxw_open): its
// uniforms, vertices and indices are appended to the batch's arenas -- uniforms at a dynamic
// offset, vertices and indices through baseVertex and firstIndex -- so no draw of a batch
// overwrites another's data, and the batch writes each arena once before its submit. The queue
// orders those writes after the submits before them, so the next batch may reuse the arenas from
// offset 0, as for the pooled textures above.
//
// Bind groups have no destroy() and were the next call to fail on the iPhone (one per draw:
// 22,514 in 2400 frames, first createBindGroup failure at 6755 ms). Their descriptor is the fixed
// layout, the persistent uniform buffer, and per slot a pooled texture's view and a cached
// sampler, so the content id and sampler key of the eight slots are the key: a hit is the bind
// group a miss would create. Bounded like the samplers, least recently used dropped (to garbage
// collection): 1024, above the 817 distinct keys of a measured 2400-frame run (<=164 per frame),
// where 256 missed 2383 times. The pipeline key keeps only the bits the pipeline descriptor reads.
//
// The shader is gx_wgsl.cpp's, generated in C++ once per shader uid: `shader` names it, and `code`
// is its WGSL the first time that uid is drawn (0 afterwards). The TEV, texgen, colour channels,
// alpha test and fog are in it; what stays here is the pipeline state around it.
//
// Blending. `bp` is the draw's BP register file. Until this was read, no pipeline had blend state,
// so every fragment was written: a quad whose vertex alpha the blend makes faint was drawn opaque.
// It follows Dolphin's VideoCommon (BlendingState::Generate), as does upstream's gx_d3d12.cpp:
//   - BLENDMODE (0x41): blend enable, factors, subtract (dst - src, factors ignored), colour and
//     alpha update. Without an alpha channel in the EFB (ZCOMPARE pixel format other than
//     RGBA6_Z24) destination alpha reads as 1 and alpha is not written.
// Not here: logic ops (no WebGPU equivalent; a draw with only the logic op enabled is a plain
// write), dither, destination constant alpha (0x42), and early depth (ZCOMPARE bit 6: GX tests and
// writes depth before the alpha test, so a discarded fragment still writes depth there).
//
// Each pipeline is labelled with its key, which is what WebGPU validation messages name, and what
// tools that replay these calls read the draw's state from.
EM_JS(int, gxw_draw, (const void* vertices, int vertex_bytes, const void* indices, int count,
                     const float* constants, int rows, const float* raster, int lines, int cull, int zmode,
                     const uint32_t* bp, int shader, const char* code), {
  const gpu = Module["gxWebgpu"];
  const BIND_GROUP_CACHE_LIMIT = 1024, ARENA_GROWTH_LIMIT = 16 << 20;
  // Draws recorded (heartbeat.ts reports it).
  gpu.drawSerial++;
  // The page's heartbeat (web/src/spike/heartbeat.ts): a frame that draws slowly still beats.
  const beat = Module["heartbeat"];
  if (beat) beat(-1);
  try {
    const d = gpu.device;
    const r = HEAPF32.slice(raster >> 2, (raster >> 2) + 10);
    zmode &= 31;
    if (code) gpu.shaders.set(shader, d.createShaderModule({label:"gx shader " + shader, code:UTF8ToString(code)}));
    const blendmode = HEAPU32[(bp >> 2) + 0x41];
    const efbAlpha = (HEAPU32[(bp >> 2) + 0x43] & 7) === 1 ? 1 : 0;   // RGBA6_Z24
    // Enable, colour/alpha update, and -- only when blending -- the factors and subtract.
    const blendBits = blendmode & 1 ? blendmode & 0xFF9 : blendmode & 0x18;
    const key = [lines,cull,zmode,blendBits,efbAlpha,shader].join(":");
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      const module = gpu.shaders.get(shader);
      if (!module) throw new Error("no WGSL for shader " + shader);
      // GX source and destination factors, in BLENDMODE order.
      const src = ["zero","one","dst","one-minus-dst","src-alpha","one-minus-src-alpha","dst-alpha","one-minus-dst-alpha"];
      const dst = ["zero","one","src","one-minus-src","src-alpha","one-minus-src-alpha","dst-alpha","one-minus-dst-alpha"];
      const noDstAlpha = (f) => efbAlpha ? f : f === "dst-alpha" ? "one" : f === "one-minus-dst-alpha" ? "zero" : f;
      let blend;
      if (blendBits & 1) {
        const c = blendBits & 0x800 ? {srcFactor:"one",dstFactor:"one",operation:"reverse-subtract"}
          : {srcFactor:noDstAlpha(src[(blendBits >>> 8) & 7]),dstFactor:noDstAlpha(dst[(blendBits >>> 5) & 7]),operation:"add"};
        blend = {color:c, alpha:c};
      }
      // GPUColorWrite: RED|GREEN|BLUE = 7, ALPHA = 8.
      const writeMask = (blendBits & 8 ? 7 : 0) | (blendBits & 16 && efbAlpha ? 8 : 0);
      const attributes = [
        {shaderLocation:0,offset:0,format:"float32x3"},
        {shaderLocation:1,offset:12,format:"float32x3"},
        {shaderLocation:2,offset:24,format:"unorm8x4"},
        {shaderLocation:3,offset:28,format:"unorm8x4"}];
      for (let i=0;i<8;i++) attributes.push({shaderLocation:4+i,offset:32+8*i,format:"float32x2"});
      for (let i=0;i<3;i++) attributes.push({shaderLocation:12+i,offset:96+4*i,format:"uint8x4"});
      // 15 attributes, 108-byte stride: within WebGPU's baseline 16 / 2048 limits.
      pipeline = d.createRenderPipeline({label:key,layout:gpu.pipelineLayout,
        vertex:{module,entryPoint:"vs",buffers:[{arrayStride:108,attributes}]},
        fragment:{module,entryPoint:"fs",targets:[blend ? {format:gpu.format,blend,writeMask} : {format:gpu.format,writeMask}]},
        primitive:{topology:lines ? "line-list":"triangle-list",frontFace:"cw",cullMode:["none","back","front","back"][cull]},
        depthStencil:{format:"depth32float",depthWriteEnabled:!!((zmode&1)&&(zmode&16)),
          depthCompare:(zmode&1) ? ["never","greater","equal","greater-equal","less","not-equal","less-equal","always"][(zmode>>1)&7]:"always"}});
      gpu.pipelines.set(key,pipeline);
    }
    // Room in the batch's arenas, or submit the batch first: a batch is flushed, never
    // overwritten. Textures already bound for this draw were marked with the batch just
    // submitted; they move to the next one, which this draw opens. The arena that overflowed
    // grows (up to ARENA_GROWTH_LIMIT), so that the next frame fits in one batch again.
    const indexBytes = count*4, uniformBytes = Math.ceil(rows*16/gpu.uniformAlign)*gpu.uniformAlign;
    let batch = gpu.batch, vertexNeed = vertex_bytes, indexNeed = indexBytes;
    if (batch && (batch.uniformBytes + gpu.uniformBinding > gpu.uniforms.size ||
        batch.vertexBytes + vertex_bytes > gpu.vertexBuffer.size || batch.indexBytes + indexBytes > gpu.indexBuffer.size)) {
      const v = batch.vertexBytes + vertex_bytes, i = batch.indexBytes + indexBytes;
      if (v > gpu.vertexBuffer.size && v <= ARENA_GROWTH_LIMIT) vertexNeed = v;
      if (i > gpu.indexBuffer.size && i <= ARENA_GROWTH_LIMIT) indexNeed = i;
      gpu.flush();
      for (const s of gpu.slots) s.entry.batch = gpu.batchSerial;
      batch = null;
    }
    // Arenas grow by doubling, only while no batch is open: the replaced buffer is named by
    // submitted work alone, which survives destroy(). https://www.w3.org/TR/webgpu/#buffer-destruction
    // A single draw larger than the limit still gets an arena that holds it.
    const grow = (name,staging,size,usage) => {
      const old = gpu[name];
      if (old.size >= size) return;
      const bytes = Math.max(size,2*old.size);
      gpu[name] = d.createBuffer({size:bytes,usage:usage|GPUBufferUsage.COPY_DST});
      gpu[staging] = new Uint8Array(bytes);
      old.destroy();
    };
    if (!batch) {
      grow("vertexBuffer","vertexStaging",vertexNeed,GPUBufferUsage.VERTEX);
      grow("indexBuffer","indexStaging",indexNeed,GPUBufferUsage.INDEX);
    }
    const groupKey = gpu.slots.map(s => s.entry.id + "/" + s.key).join(",");
    let group = gpu.bindGroups.get(groupKey);
    if (group) gpu.bindGroups.delete(groupKey);
    else {
      const entries = [{binding:0,resource:{buffer:gpu.uniforms,size:gpu.uniformBinding}}];
      for (let i=0;i<8;i++) {
        entries.push({binding:1+2*i,resource:gpu.slots[i].entry.view});
        entries.push({binding:2+2*i,resource:gpu.slots[i].sampler});
      }
      group = d.createBindGroup({layout:gpu.textureLayout,entries});
      if (gpu.bindGroups.size >= BIND_GROUP_CACHE_LIMIT) gpu.bindGroups.delete(gpu.bindGroups.keys().next().value);
    }
    gpu.bindGroups.set(groupKey,group);
    batch = gpu.openBatch();
    if (!batch.pass) {
      batch.pass = batch.encoder.beginRenderPass({colorAttachments:[{view:gpu.efbView,loadOp:"load",storeOp:"store"}],
        depthStencilAttachment:{view:gpu.depthView,depthLoadOp:"load",depthStoreOp:"store"}});
      // A pass starts with no state: everything below is set again in a new one.
      batch.state = {pipeline:null,group:null,offset:-1,near:NaN,far:NaN,scissor:""};
      batch.pass.setVertexBuffer(0,gpu.vertexBuffer); batch.pass.setIndexBuffer(gpu.indexBuffer,"uint32");
    }
    const pass = batch.pass, state = batch.state;
    // Consecutive segments of one GX draw have the same constants: they share one slot.
    const words = gpu.uniformWords, base = constants >> 2, n = rows*4;
    let offset = batch.lastUniform, same = offset >= 0 && batch.lastRows === rows;
    for (let i = 0, at = offset >> 2; same && i < n; i++) same = words[at+i] === HEAPU32[base+i];
    if (!same) {
      offset = batch.uniformBytes;
      gpu.uniformStaging.set(HEAPU8.subarray(constants,constants+rows*16),offset);
      batch.uniformBytes += uniformBytes; batch.lastUniform = offset; batch.lastRows = rows;
    }
    const baseVertex = batch.vertexBytes/108, firstIndex = batch.indexBytes/4;
    gpu.vertexStaging.set(HEAPU8.subarray(vertices,vertices+vertex_bytes),batch.vertexBytes);
    gpu.indexStaging.set(HEAPU8.subarray(indices,indices+indexBytes),batch.indexBytes);
    batch.vertexBytes += vertex_bytes; batch.indexBytes += indexBytes;
    // Redundant state is not sent again: on WebKit each call is an IPC message.
    if (state.pipeline !== pipeline) { pass.setPipeline(pipeline); state.pipeline = pipeline; }
    if (state.group !== group || state.offset !== offset) {
      pass.setBindGroup(0,group,[offset]); state.group = group; state.offset = offset;
    }
    if (state.near !== r[4] || state.far !== r[5]) {
      pass.setViewport(0,0,gpu.efb.width,gpu.efb.height,r[4],r[5]); state.near = r[4]; state.far = r[5];
    }
    const scissor = r[6] + "," + r[7] + "," + r[8] + "," + r[9];
    if (state.scissor !== scissor) { pass.setScissorRect(r[6],r[7],r[8],r[9]); state.scissor = scissor; }
    pass.drawIndexed(count,1,firstIndex,baseVertex);
    return 1;
  } catch(error) {
    gpu.recordFailure("draw", error); gpu.failure = "draw: " + error; return 0;
  }
});

// Submits the open batch, if any: the end of a frame. 1 on success.
EM_JS(int, gxw_flush, (), {
  const gpu = Module["gxWebgpu"];
  try { gpu.flush(); return 1; }
  catch(error) { gpu.recordFailure("submit", error); gpu.failure = "submit: " + error; return 0; }
});

EM_JS(int, gxw_pipeline_count, (), {
  const gpu = Module["gxWebgpu"]; return gpu && gpu.pipelines ? gpu.pipelines.size : 0;
});

namespace {
static_assert(sizeof(gx::Vertex) == 108 && offsetof(gx::Vertex, nrm) == 12 &&
              offsetof(gx::Vertex, col0) == 24 && offsetof(gx::Vertex, col1) == 28 &&
              offsetof(gx::Vertex, uv) == 32 && offsetof(gx::Vertex, posmtx) == 96 &&
              offsetof(gx::Vertex, texmtx) == 97, "WebGPU packed vertex layout");

// What each pooled texture holds: one immutable snapshot, decoded one way. The key's pointer is
// pinned by `snapshot` for as long as the entry exists, so it cannot be freed and reused for other
// bytes while gxw_bind's pool may still hit on its id. Entries leave when the pool evicts the
// texture (gxw_evicted), so this map is bounded by the pool.
struct ContentKey {
  const gx::TextureSnapshot* snapshot;
  uint32_t width, height, format, tlut_format, levels;
  bool operator==(const ContentKey& o) const {
    return snapshot==o.snapshot && width==o.width && height==o.height && format==o.format &&
           tlut_format==o.tlut_format && levels==o.levels;
  }
};
struct ContentKeyHash {
  size_t operator()(const ContentKey& k) const {
    size_t h=std::hash<const void*>()(k.snapshot);
    for (uint32_t v : {k.width,k.height,k.format,k.tlut_format,k.levels}) h=h*1000003u ^ v;
    return h;
  }
};
struct Content { int id; std::shared_ptr<const gx::TextureSnapshot> snapshot; };
std::unordered_map<ContentKey, Content, ContentKeyHash> g_contents;
std::unordered_map<int, ContentKey> g_content_keys;
int g_next_content = 0;
// Guest addresses an EFB copy has written a texture to (gxw_copy). A draw whose texture is at one of
// them samples that copy, not the bytes in RAM. As upstream's efb_copies_ the set is keyed by address
// alone, so it holds as many entries as the game has copy destinations.
std::unordered_set<uint32_t> g_efb_copy_addrs;

// All source reads are from TextureSnapshot, never host::ram/guest addresses. A snapshot already
// in the pool is neither decoded nor uploaded again (gxw_bind).
bool upload_textures(const gx::DrawCall& dc) {
  std::vector<uint8_t> rgba;
  for (int slot=0; slot<8; ++slot) {
    const auto& t=dc.textures[slot];
    if (!t.used) {
      if (!gxw_bind(slot,0,0,0,1,0,0,0)) return false;
      continue;
    }
    if (g_efb_copy_addrs.count(t.addr)) {
      if (!gxw_bind(slot,0,0,0,1,t.mode0,t.mode1,int(t.addr))) return false;
      continue;
    }
    const bool supported=t.format<=6 || t.format==8 || t.format==9 || t.format==10 || t.format==14;
    const size_t palette_bytes=t.format==8?32:t.format==9?512:t.format==10?32768:0;
    if (!supported || !t.data || !t.width || !t.height || t.width>1024 || t.height>1024 ||
        t.mip_levels!=gx::texture_mip_count(t.width,t.height,t.mip_levels) ||
        t.data->image.size()<gx::texture_chain_bytes(t.width,t.height,t.format,t.mip_levels) ||
        t.data->palette.size()<palette_bytes) {
      std::fprintf(stderr,"webgpu: invalid/unsupported texture snapshot in slot %d\n",slot);
      return false;
    }
    const ContentKey key{t.data.get(),t.width,t.height,t.format,t.tlut_format,t.mip_levels};
    auto found=g_contents.find(key);
    if (found==g_contents.end()) {
      if (g_next_content==INT32_MAX) { std::fprintf(stderr,"webgpu: texture content ids exhausted\n"); return false; }
      found=g_contents.emplace(key,Content{++g_next_content,t.data}).first;
      g_content_keys.emplace(found->second.id,key);
    }
    const int content=found->second.id;
    const int bound=gxw_bind(slot,content,t.width,t.height,t.mip_levels,t.mode0,t.mode1,0);
    if (!bound) return false;
    // Only a miss evicts, and never this draw's textures, so `content` is not among these.
    for (int gone; (gone=gxw_evicted());) {
      const auto k=g_content_keys.find(gone);
      if (k==g_content_keys.end()) { std::fprintf(stderr,"webgpu: pool evicted unknown content %d\n",gone); return false; }
      g_contents.erase(k->second);
      g_content_keys.erase(k);
    }
    if (bound==1) continue;
    uint32_t w=t.width,h=t.height; size_t offset=0;
    for (uint32_t level=0;level<t.mip_levels;++level) {
      gx::decode_texture(t.data->image.data()+offset,w,h,t.format,t.data->palette.data(),t.tlut_format,rgba);
      if (!gxw_upload(slot,level,w,h,rgba.data(),rgba.size())) return false;
      offset+=gx::texture_level_bytes(w,h,t.format);
      w=std::max(1u,w/2); h=std::max(1u,h/2);
    }
  }
  return true;
}

// The shaders gxw_draw has been given: gx_wgsl.cpp's uid of the draw state each was generated from,
// and the id gxw_draw knows it by. A uid is generated and its WGSL handed over once; every later
// draw with the same uid names the id alone. Bounded by the shader state the game uses (the
// pipelines map in gxw_draw holds as many), like the pipelines themselves.
std::unordered_map<gxw::ShaderUid, int, gxw::ShaderUidHash> g_shaders;

// Baseline projection/viewport rules transcribed from gx_shader.cpp:671-748 and
// gx_d3d12.cpp:1809-1826. No guest memory or live GX registers are read here.
bool draw_segment(const gx::Frame& frame, const gx::DrawCall& dc, const gx::DrawSegment& segment) {
  std::vector<uint32_t> indices;
  const auto topology = gx::append_segment_indices(indices, segment.primitive, segment.vertex_count, 0);
  if (topology == gx::DrawTopology::Unsupported) {
    std::fprintf(stderr, "webgpu: unsupported primitive 0x%x skipped\n", segment.primitive); return true;
  }
  if (indices.empty()) return true;
  if (segment.first_vertex > frame.vertices.size() || segment.vertex_count > frame.vertices.size()-segment.first_vertex) return false;
  float vp[6], proj[6];
  std::memcpy(vp, dc.xf_regs+0x1A, sizeof vp); std::memcpy(proj, dc.xf_regs+0x20, sizeof proj);
  if (!std::isfinite(vp[0]) || !std::isfinite(vp[1]) || vp[0] == 0 || vp[1] == 0) return true;
  float u[gxw::MAX_ROWS][4] = {};
  u[0][0]=proj[0]; u[1][1]=proj[2]; u[2][2]=proj[4]; u[2][3]=proj[5];
  if (dc.xf_regs[0x26] == 0) { u[0][2]=proj[1]; u[1][2]=proj[3]; u[3][2]=-1; }
  else { u[0][3]=proj[1]; u[1][3]=proj[3]; u[3][3]=1; }
  if (vp[0]<0) for (float& f:u[0]) f=-f;
  if (vp[1]>0) for (float& f:u[1]) f=-f;
  u[4][2]=(0.5f-7.0f/12.0f)/vp[0]; u[4][3]=(0.5f-7.0f/12.0f)/vp[1];
  u[5][0]=vp[0]; u[5][1]=vp[1]; u[5][2]=1/vp[0]; u[5][3]=1/vp[1];
  std::memcpy(u+6,dc.posMatrices,sizeof dc.posMatrices);
  for (int i=0;i<32;i++) std::memcpy(u[70+i],dc.normalMatrices+3*i,12);
  float x=vp[3]-vp[0]-342, y=vp[4]+vp[1]-342, w=2*vp[0], h=-2*vp[1];
  if(w<0){x+=w;w=-w;} if(h<0){y+=h;h=-h;}
  w=std::max(w,1.0f); h=std::max(h,1.0f);
  u[102][0]=w/gx::EFB_WIDTH; u[102][1]=h/gx::EFB_HEIGHT;
  u[102][2]=(2*x+w)/gx::EFB_WIDTH-1; u[102][3]=1-(2*y+h)/gx::EFB_HEIGHT;
  float r[10]={x,y,w,h,std::clamp(1-vp[5]/16777216.0f,0.0f,1.0f),std::clamp(1-(vp[5]-vp[2])/16777216.0f,0.0f,1.0f)};
  if(r[5]<r[4]) std::swap(r[4],r[5]);
  const auto tl=dc.bp.reg[gx::BP_SCISSORTL], br=dc.bp.reg[gx::BP_SCISSORBR], so=dc.bp.reg[gx::BP_SCISSOROFFSET];
  int xo=gx::bits(so,0,10)*2, yo=gx::bits(so,10,10)*2;
  int l=std::clamp(int(gx::bits(tl,12,12))-xo,0,gx::EFB_WIDTH), t=std::clamp(int(gx::bits(tl,0,12))-yo,0,gx::EFB_HEIGHT);
  int right=std::clamp(int(gx::bits(br,12,12))-xo+1,0,gx::EFB_WIDTH), bottom=std::clamp(int(gx::bits(br,0,12))-yo+1,0,gx::EFB_HEIGHT);
  if(right<=l || bottom<=t) return true;
  r[6]=l;r[7]=t;r[8]=right-l;r[9]=bottom-t;
  for (int i=0;i<8;++i) {
    const auto& t=dc.textures[i];
    u[103+i/4][i%4]=t.used ? float(gx::sbits(t.mode0,9,8))/32.0f : 0;
  }
  // The alpha test's two 8-bit references (the comparisons are in the shader).
  const uint32_t alpha_compare=dc.bp.alpha_test();
  u[105][0]=float(gx::bits(alpha_compare,0,8)); u[105][1]=float(gx::bits(alpha_compare,8,8));
  gxw::fill_tev_rows(dc,u);
  const gxw::ShaderUid uid=gxw::make_uid(dc);
  auto shader=g_shaders.find(uid);
  std::string code;
  if (shader==g_shaders.end()) {
    shader=g_shaders.emplace(uid,int(g_shaders.size())+1).first;
    code=gxw::generate_wgsl(uid);
  }
  if (!upload_textures(dc)) return false;
  return gxw_draw(frame.vertices.data()+segment.first_vertex,segment.vertex_count*sizeof(gx::Vertex),indices.data(),indices.size(),
                  &u[0][0],gxw::uniform_rows(uid),r,topology==gx::DrawTopology::Lines,dc.bp.cullmode(),dc.bp.zmode(),
                  dc.bp.reg,shader->second,code.empty() ? nullptr : code.c_str());
}


class WebGpuBackend final : public gx::Backend {
 public:
  void submit_frame(const gx::Frame& frame) override {
    for (const gx::FrameCommand& command : frame.commands) {
      if (command.kind == gx::FrameCommand::Draw) {
        const auto& dc = frame.draws[command.index];
        bool ok = true;
        if (dc.segment_count) {
          if (dc.first_segment > frame.segments.size() || dc.segment_count > frame.segments.size()-dc.first_segment) ok=false;
          else for (uint32_t i=0; i<dc.segment_count && ok; ++i) ok=draw_segment(frame,dc,frame.segments[dc.first_segment+i]);
        } else ok=draw_segment(frame,dc,{dc.first_vertex,dc.vertex_count,dc.primitive});
        if (!ok) { host::gx_set_backend(nullptr); return; }
        continue;
      }
      const gx::EfbCopy& c = frame.copies[command.index];
      // A colour copy to RAM becomes a texture (gxw_copy); depth copies are not kept.
      const bool to_texture = !c.to_xfb && !c.is_depth && c.dest_addr;
      if (to_texture) g_efb_copy_addrs.insert(c.dest_addr);
      if (!gxw_copy(int(c.src_x), int(c.src_y), int(c.src_w), int(c.src_h), c.to_xfb, c.clear,
                    int(c.clear_color), int(c.clear_z), to_texture ? int(c.dest_addr) : 0)) {
        // The device is unusable: stop recording frames altogether, back to exactly headless.
        // Return at once; the decoder clears `frame` when this call returns.
        host::gx_set_backend(nullptr);
        return;
      }
      if (c.to_xfb) ++presented_;
    }
    // A frame ends at its XFB copy, which has submitted already; this submits anything after it.
    if (!gxw_flush()) host::gx_set_backend(nullptr);
  }
  void presentation_stats(uint32_t* frames, uint32_t* pipelines, uint32_t* textures) const override {
    if (frames) *frames = presented_;
    if (pipelines) *pipelines = gxw_pipeline_count();
    if (textures) *textures = gxw_texture_count(); // the texture pool plus the white fallback
  }

 private:
  uint32_t presented_ = 0;
};

WebGpuBackend* g_webgpu = nullptr;

}  // namespace

// Called by the worker before callMain, once Module.gxWebgpu is set or deliberately left unset.
// 1 when the backend is attached to the decoder; 0 leaves the module exactly headless.
extern "C" EMSCRIPTEN_KEEPALIVE int gx_webgpu_attach() {
  if (g_webgpu) return 1;
  if (!gxw_open(gx::EFB_WIDTH, gx::EFB_HEIGHT, gxw::MAX_ROWS)) return 0;
  g_webgpu = new WebGpuBackend();
  host::gx_set_backend(g_webgpu);
  return 1;
}

// Frames presented so far (XFB copies that reached the canvas); 0 without a backend.
extern "C" EMSCRIPTEN_KEEPALIVE int gx_webgpu_presented() {
  uint32_t frames = 0;
  if (g_webgpu) g_webgpu->presentation_stats(&frames, nullptr, nullptr);
  return int(frames);
}

// Synthetic tiled GX bytes, deliberately independent of decode_texture's implementation.
// Every format gives a non-white sample; palettes are part of the immutable snapshot.
//
// Like the decoder's TextureSnapshotCache, the same bytes come back as the same snapshot, unless
// `fresh` asks for a new one (geometry 39: a new snapshot of unchanged bytes is a new content).
//
// `alpha3` >= 0 makes the RGB5A3 texels magenta with that 3-bit alpha (0 is fully transparent)
// instead of opaque magenta: the geometry 40-44 probes of the alpha test and blending.
static gx::TextureRef fixture_texture(uint32_t format, bool changed=false, bool mips=false, bool pattern=false, bool fresh=false,
                                      int alpha3=-1) {
  gx::TextureRef t; t.used=true; t.addr=0x1000; t.width=8; t.height=8;
  t.format=format; t.tlut_format=1; t.mip_levels=mips?4:1;
  static std::unordered_map<uint32_t, std::shared_ptr<const gx::TextureSnapshot>> made;
  const uint32_t id=format | uint32_t(changed)<<8 | uint32_t(mips)<<9 | uint32_t(pattern)<<10 | uint32_t(alpha3+1)<<11;
  if (!fresh) if (const auto found=made.find(id); found!=made.end()) { t.data=found->second; if(mips) { t.mode0=1u<<5; t.mode1=(16u<<8)|16u; } return t; }
  auto data=std::make_shared<gx::TextureSnapshot>();
  const size_t palette_bytes=format==8?32:format==9?512:format==10?32768:0;
  data->palette.resize(palette_bytes);
  for(size_t i=0;i<palette_bytes;i+=2) { data->palette[i]=changed?0xF8:0x07; data->palette[i+1]=changed?0:0xE0; }
  uint32_t w=8,h=8;
  for(uint32_t level=0;level<t.mip_levels;++level) {
    const size_t base=data->image.size(), bytes=gx::texture_level_bytes(w,h,format);
    data->image.resize(base+bytes);
    auto* p=data->image.data()+base;
    for(size_t i=0;i<bytes;++i) {
      if(format==0) p[i]=0x88;
      if(format==1) p[i]=128;
      if(format==2) p[i]=0xA8;
      if(format==3) p[i]=(i%2)?128:192;
      if(format==4) p[i]=(i%2)?0xE0:0x07;
      if(format==5) p[i]=alpha3<0 ? ((i%2)?0x1F:0xFC) : ((i%2)?0x0F:uint8_t(alpha3<<4 | 0x0F)); // 0aaaRRRRGGGGBBBB
      if(format==6) {
        // 4x4 tiles: AR plane followed by GB plane.
        const size_t k=i%64;
        p[i]=k<32 ? ((k%2)?((changed || (pattern && (i/64)%2))?32:128):192) : ((k%2)?32:(level?192:64));
      }
      if(format==14) {
        // Four CMPR subblocks: red and blue endpoints, all selectors = 2.
        const uint8_t block[8]={0xF8,0,0,0x1F,0xAA,0xAA,0xAA,0xAA}; p[i]=block[i%8];
      }
    }
    w=std::max(1u,w/2);h=std::max(1u,h/2);
  }
  data->hash=0; // deliberately identical: backend must not trust a hash/address alone
  t.data=data;
  if (!fresh) made[id]=data;
  if(mips) { t.mode0=1u<<5; t.mode1=(16u<<8)|16u; } // force mip 1
  return t;
}

// The spike's render test (web/tests/spike/render.spec.ts). No CI runner has the disc
// (docs/AGENT_RULES.md rule 1), so the game never reaches its first GX command there; this feeds
// the real FIFO decoder the BP writes a frame ends with instead -- source rectangle 640x480, clear
// colour `argb`, then `copies` XFB copies with clear -- through host::gx_write, exactly as the
// guest's write-gather pipe would. Never call it in a module that will run the game: the XFB copy
// reads guest RAM (the default HUD capture), so a module that has not booted gets zeroed RAM here,
// which the decoder reads as "no match, no menu".
extern "C" EMSCRIPTEN_KEEPALIVE int gx_webgpu_selftest(uint32_t argb, int copies, int geometry) {
  if (!host::ram) host::ram = static_cast<uint8_t*>(std::calloc(ppc::RAM_SIZE + 64, 1));
  if (!host::ram) return -1;
  const auto bp = [](uint32_t value) { host::gx_write(0x61, 1); host::gx_write(value, 4); };
  bp(0x49000000u);                                            // EFB_TL 0,0
  bp(0x4A000000u | (479u << 10) | 639u);                      // EFB_BR: 640x480
  bp(0x4F000000u | ((argb >> 24) & 0xFF) << 8 | ((argb >> 16) & 0xFF));   // CLEAR_AR
  bp(0x50000000u | ((argb >> 8) & 0xFF) << 8 | (argb & 0xFF));            // CLEAR_GB
  if (geometry) bp(0x51FFFFFFu); // far depth for reversed GREATER test
  for (int i = 0; i < copies; ++i) bp(0x52004800u);           // copy to XFB, then clear
  if (geometry && g_webgpu) {
    // Synthetic recorded data: the same Vertex/DrawCall/DrawSegment ABI consumed from GX.
    // Keep the FIFO copy/clear coverage above; this fixture intentionally bypasses decoding.
    gx::Frame frame;
    gx::DrawCall dc{};
    dc.primitive=geometry==5 ? 0xB8 : 0x90; dc.vertex_count=3;
    dc.components=gx::VB_HAS_COL0 | gx::VB_HAS_COL1 | gx::VB_HAS_NRM0 | gx::VB_HAS_UV0;
    const float vp[6]={320,-240,16777216,662,582,16777216};
    const float proj[6]={1,0,1,0,1,0};
    std::memcpy(dc.xf_regs+0x1A,vp,sizeof vp); std::memcpy(dc.xf_regs+0x20,proj,sizeof proj);
    dc.xf_regs[0x26]=1;
    // Nonzero matrix index and translation: reading position directly misses the probe.
    dc.posMatrices[12]=1; dc.posMatrices[15]=0.5f; dc.posMatrices[17]=1; dc.posMatrices[22]=1;
    dc.normalMatrices[9]=1; dc.normalMatrices[13]=1; dc.normalMatrices[17]=1;
    // Matrix 60, GX_IDENTITY: the texture matrix of texgen 0 (each vertex names it, as the decoder
    // does when the stream carries no index).
    dc.posMatrices[240]=1; dc.posMatrices[245]=1; dc.posMatrices[250]=1;
    dc.bp.reg[gx::BP_SCISSORBR]=(639u<<12)|479u;
    dc.bp.reg[gx::BP_ZMODE]=1|2|16; // GX LESS -> reversed GREATER, writes enabled.
    // What GXInit leaves, which a zeroed BP is not: the alpha test passes (ALWAYS and ALWAYS; zero
    // is NEVER), colour and alpha are written, no blending. The EFB keeps alpha (RGBA6_Z24), so the
    // probes above read back the alpha they draw.
    dc.bp.reg[gx::BP_ALPHACOMPARE]=(7u<<16)|(7u<<19);
    dc.bp.reg[gx::BP_BLENDMODE]=8|16;
    dc.bp.reg[gx::BP_ZCOMPARE]=1;
    // And what a draw of a textured, vertex-coloured triangle sets on top of it: one texgen (TEX0
    // through the identity matrix), one colour channel taking the vertex colour, one TEV stage
    // MODULATE (GXSetTevOp: colour TEXC x RASC, alpha TEXA x RASA) of texture 0 and channel 0, and
    // the identity swap tables. A zeroed TEV is a stage whose output is the PREV register: black.
    dc.bp.reg[gx::BP_GENMODE]=1 | 1u<<4;
    dc.xf_regs[0x09]=1; dc.xf_regs[0x0E]=1; dc.xf_regs[0x10]=1;
    dc.xf_regs[0x3F]=1; dc.xf_regs[0x40]=5u<<7;
    dc.bp.reg[gx::BP_TEV_COLOR_ENV]=15 | 10u<<4 | 8u<<8 | 15u<<12 | 1u<<19;
    dc.bp.reg[gx::BP_TEV_ALPHA_ENV]=7u<<4 | 5u<<7 | 4u<<10 | 7u<<13 | 1u<<19;
    dc.bp.reg[gx::BP_TREF]=1u<<6;
    for (int i=0;i<8;i+=2) { dc.bp.reg[gx::BP_TEV_KSEL+i]=1u<<2; dc.bp.reg[gx::BP_TEV_KSEL+i+1]=2 | 3u<<2; }
    // Alpha test and blending, on a magenta RGB5A3 texture (fixture_texture's `alpha3`). Every
    // expected pixel differs from opaque magenta, which is what a backend ignoring alpha draws.
    //   40: alpha 0, test GREATER 0 -> discarded: the clear colour.
    //   41: alpha 0, blend SRC_ALPHA / INV_SRC_ALPHA -> the clear colour.
    //   42: as 41, but the nearest layer (1) has alpha 146 -> one blend of magenta over the clear.
    //   43: alpha 146, test GREATER 200 -> discarded: the reference is read, not assumed to be 0.
    //   44: opaque magenta with colour update off (alpha update only) -> the clear colour.
    if (geometry==40) dc.bp.reg[gx::BP_ALPHACOMPARE]=(4u<<16)|(7u<<19);
    if (geometry==41 || geometry==42) dc.bp.reg[gx::BP_BLENDMODE]=1|8|16|(5u<<5)|(4u<<8);
    if (geometry==43) dc.bp.reg[gx::BP_ALPHACOMPARE]=(4u<<16)|(7u<<19)|200u;
    if (geometry==44) dc.bp.reg[gx::BP_BLENDMODE]=16;
    if (geometry==2) dc.bp.reg[gx::BP_SCISSORBR]=(159u<<12)|479u;
    if (geometry==3) dc.bp.reg[gx::BP_GENMODE]|=2u<<14; // front cull (clockwise triangle)
    // The TEV (gx_wgsl.cpp), each probe on a state the backend ignored before it, so a shader of
    // vertex colour x texture 0 draws something else (wasm/render/pixel_pipeline_check.mjs):
    //   45: the in-match name tag's plate: no texture, colour KONST K0 (242,89,89), alpha the C0
    //       register (128), blended SRC_ALPHA / INV_SRC_ALPHA over the clear colour.
    //   46: the name tag's glyphs: KONST K0 x an I8 texture (128), alpha A0 (255) x TEXA, unblended.
    //   47: two stages. Stage 0 writes C1 = 2 * C0 - lerp(TEXC, RASC, 96) unclamped, with the ras
    //       swap table 1 (BGRA) and alpha TEXA x (1 - 128/255); stage 1 compares per component
    //       (KONST K1 > TEXC ? RASC : 0) + C1 and (C1.a > TEXA ? RASA : 0) + 223, clamped, to PREV.
    //       Its negative intermediate, the swap, the scale, the subtraction's +127 and the compares
    //       all change the pixel.
    //   48: MODULATE, then linear fog of constant density 0.5 (A = 0, C = -0.5, perspective):
    //       halfway to the fog colour. The sign of C is bit 19, as in Dolphin's FogParam3; reading it
    //       from bit 20 (the projection bit), as upstream's gx_shader.cpp does, gives C = +0.5 and no
    //       fog.
    if (geometry==45) {
      dc.bp.reg[gx::BP_TEV_COLOR_ENV]=14 | 15u<<4 | 15u<<8 | 15u<<12 | 1u<<19;
      dc.bp.reg[gx::BP_TEV_ALPHA_ENV]=1u<<4 | 7u<<7 | 7u<<10 | 7u<<13 | 1u<<19;
      dc.bp.reg[gx::BP_TREF]=7u<<7;                                    // no texture, no channel
      dc.bp.reg[gx::BP_TEV_KSEL]|=12u<<4;                              // K0.rgb
      dc.bp.reg[gx::BP_BLENDMODE]=1|8|16|(5u<<5)|(4u<<8);
    }
    if (geometry==46) {
      dc.bp.reg[gx::BP_TEV_COLOR_ENV]=15 | 8u<<4 | 14u<<8 | 15u<<12 | 1u<<19;
      dc.bp.reg[gx::BP_TEV_ALPHA_ENV]=7u<<4 | 4u<<7 | 1u<<10 | 7u<<13 | 1u<<19;
      dc.bp.reg[gx::BP_TEV_KSEL]|=12u<<4;
    }
    if (geometry==45 || geometry==46) {
      const int32_t k0[4]={242,89,89,0}, c0[4]={0,0,0,geometry==45 ? 128 : 255};
      std::memcpy(dc.tev_kcolors[0],k0,sizeof k0); std::memcpy(dc.tev_colors[1],c0,sizeof c0);
    }
    if (geometry==47) {
      dc.bp.reg[gx::BP_GENMODE]|=1u<<10;                               // two stages
      dc.bp.reg[gx::BP_TEV_COLOR_ENV]=2 | 14u<<4 | 10u<<8 | 8u<<12 | 1u<<18 | 1u<<20 | 2u<<22;
      dc.bp.reg[gx::BP_TEV_ALPHA_ENV]=1 | 7u<<4 | 6u<<7 | 7u<<10 | 4u<<13 | 1u<<19 | 2u<<22;
      dc.bp.reg[gx::BP_TEV_COLOR_ENV+2]=4 | 10u<<4 | 8u<<8 | 14u<<12 | 3u<<16 | 1u<<19 | 3u<<20;
      dc.bp.reg[gx::BP_TEV_ALPHA_ENV+2]=6u<<4 | 5u<<7 | 4u<<10 | 2u<<13 | 3u<<16 | 1u<<19 | 3u<<20;
      dc.bp.reg[gx::BP_TREF]=1u<<6 | 1u<<18;                           // stage 1: texture 0 too
      // Stage 0: KONST 96 (5), alpha 128 (4); stage 1: K1.rgb (13), alpha 223 (1). Swap table 1 BGRA.
      dc.bp.reg[gx::BP_TEV_KSEL]|=5u<<4 | 4u<<9 | 13u<<14 | 1u<<19;
      dc.bp.reg[gx::BP_TEV_KSEL+2]=2 | 1u<<2; dc.bp.reg[gx::BP_TEV_KSEL+3]=3u<<2;
      const int32_t c0[4]={10,20,30,40}, k1[4]={200,50,40,0};
      std::memcpy(dc.tev_colors[1],c0,sizeof c0); std::memcpy(dc.tev_kcolors[1],k1,sizeof k1);
    }
    if (geometry==48) {
      dc.bp.reg[gx::BP_FOGPARAM0]=0;                                   // A = 0
      dc.bp.reg[gx::BP_FOGBMAGNITUDE]=1u<<23; dc.bp.reg[gx::BP_FOGBEXPONENT]=23;
      dc.bp.reg[gx::BP_FOGPARAM3]=2u<<21 | 1u<<19 | 126u<<11;          // linear, perspective, C = -0.5
      dc.bp.reg[gx::BP_FOGCOLOR]=0x28F050;
    }
    const float xy[3][2]={{-0.9f,-0.6f},{-0.5f,0.6f},{-0.1f,-0.6f}};
    // 49: the generator's grammar, not its values. 48 draws, each with pseudo-random TEV stages,
    // orders, swap tables, konstant selections, alpha test, fog, colour channels, texgens and vertex
    // components; each call continues the sequence (`repeats` covers more states). WebGPU rejects a
    // shader that does not compile, and the error fails the check; the pixel is not asserted.
    if (geometry==49) {
      static uint32_t seed=0x2545F491u;
      auto next=[]() { seed=seed*1664525u+1013904223u; return seed>>8; };
      dc.textures[0]=fixture_texture(6);
      for(auto& t:dc.textures) t=dc.textures[0];
      for(int k=0;k<48;k++) {
        gx::DrawCall r=dc;
        const uint32_t stages=1+next()%16;
        r.bp.reg[gx::BP_GENMODE]=1 | 1u<<4 | (stages-1)<<10;
        for(uint32_t i=0;i<stages;i++) { r.bp.reg[gx::BP_TEV_COLOR_ENV+2*i]=next(); r.bp.reg[gx::BP_TEV_ALPHA_ENV+2*i]=next(); }
        for(int i=0;i<8;i++) { r.bp.reg[gx::BP_TREF+i]=next(); r.bp.reg[gx::BP_TEV_KSEL+i]=next(); }
        r.bp.reg[gx::BP_ALPHACOMPARE]=next();
        r.bp.reg[gx::BP_FOGPARAM3]=next(); r.bp.reg[gx::BP_FOGRANGE]=next()&0x7FF;
        r.bp.reg[gx::BP_FOGPARAM0]=next(); r.bp.reg[gx::BP_FOGBMAGNITUDE]=next(); r.bp.reg[gx::BP_FOGBEXPONENT]=next()&31;
        r.xf_regs[0x09]=next()%3;
        for(int i=0x0E;i<=0x11;i++) r.xf_regs[i]=next()&0x7FFF;
        r.xf_regs[0x3F]=next()%9; r.xf_regs[0x12]=next()&1;
        for(int i=0;i<8;i++) { r.xf_regs[0x40+i]=next()&0x3FFFF; r.xf_regs[0x50+i]=next()&0x13F; }
        r.components=next()&(gx::VB_HAS_COL0 | gx::VB_HAS_COL1 | gx::VB_HAS_NRM0 | 0xFFu*gx::VB_HAS_UV0 | 0x1FEu);
        for(auto& c:r.tev_colors) for(auto& v:c) v=int32_t(next()%2048)-1024;
        for(auto& c:r.tev_kcolors) for(auto& v:c) v=int32_t(next()%256);
        r.first_vertex=frame.vertices.size(); r.first_segment=frame.segments.size(); r.segment_count=1;
        for(int i=0;i<3;i++) {
          gx::Vertex v{}; v.pos[0]=xy[i][0]; v.pos[1]=xy[i][1]; v.pos[2]=-0.3f; v.posmtx=3; v.nrm[2]=1;
          for(auto& c:v.col0) c=uint8_t(next());
          for(auto& c:v.col1) c=uint8_t(next());
          for(auto& uv:v.uv) { uv[0]=0.5f; uv[1]=0.5f; }
          for(auto& m:v.texmtx) m=60;
          frame.vertices.push_back(v);
        }
        frame.segments.push_back({r.first_vertex,3,r.primitive});
        frame.draws.push_back(r); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
      }
    }
    // 50: an EFB copy to a texture (gxw_copy). A green triangle; a 4x4 copy from inside it to guest
    // address 0x100000, with a clear; then the triangle again, white, textured from that address.
    // The probe reads the copied green. A backend that samples guest RAM there draws the snapshot
    // that address's TextureRef carries instead: the RGBA8 fixture, (128,64,32,192).
    if (geometry==50) {
      for(int pass=0;pass<2;pass++) {
        gx::DrawCall r=dc;
        if (pass==1) {
          r.textures[0]=fixture_texture(6); r.textures[0].addr=0x100000; r.textures[0].width=4; r.textures[0].height=4;
          const gx::EfbCopy copy{0x100000,0,318,238,4,4,6,false,true,false,false,false,argb,0xFFFFFF,1.0f};
          frame.copies.push_back(copy); frame.commands.push_back({gx::FrameCommand::Copy,uint32_t(frame.copies.size()-1)});
        }
        r.first_vertex=frame.vertices.size(); r.first_segment=frame.segments.size(); r.segment_count=1;
        for(int i=0;i<3;i++) {
          gx::Vertex v{}; v.pos[0]=xy[i][0]; v.pos[1]=xy[i][1]; v.pos[2]=-0.3f; v.posmtx=3; v.nrm[2]=1; v.texmtx[0]=60;
          v.col0[0]=pass ? 255 : 0; v.col0[1]=255; v.col0[2]=pass ? 255 : 0; v.col0[3]=255; v.col1[3]=255;
          v.uv[0][0]=0.5f; v.uv[0][1]=0.5f;
          frame.vertices.push_back(v);
        }
        frame.segments.push_back({r.first_vertex,3,r.primitive});
        frame.draws.push_back(r); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
      }
    }
    // 51: Dolphin's near-plane tolerance (gx_wgsl.cpp). A green triangle whose clip z is the next
    // float after w (1 + 2^-23): scaled by 1 - 1e-7 it lands on the plane and is drawn; unscaled,
    // WebGPU clips it and the probe reads the clear colour. The game's shadow backdrop quad is such a
    // primitive (1.8e-8 beyond the plane).
    if (geometry==51) {
      dc.first_vertex=frame.vertices.size(); dc.first_segment=frame.segments.size(); dc.segment_count=1;
      for(int i=0;i<3;i++) {
        gx::Vertex v{}; v.pos[0]=xy[i][0]; v.pos[1]=xy[i][1]; v.pos[2]=-std::nextafter(1.0f,2.0f); v.posmtx=3; v.texmtx[0]=60;
        v.col0[1]=255; v.col0[3]=255; v.col1[3]=255;
        frame.vertices.push_back(v);
      }
      frame.segments.push_back({dc.first_vertex,3,dc.primitive});
      frame.draws.push_back(dc); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
    }
    for(int layer=0;layer<(geometry==49 || geometry==50 || geometry==51 ? 0 : 3);layer++) {
      if (geometry>=10) {
        static const uint32_t formats[]={0,1,2,3,4,5,6,8,9,10,14};
        const bool alpha_probe=geometry>=40 && geometry<=44;
        const uint32_t format=alpha_probe?5:geometry<=20?formats[geometry-10]:geometry==32?8:geometry==46?1:6;
        const int alpha3=!alpha_probe || geometry==44 ? -1 : geometry==43 || (geometry==42 && layer==1) ? 4 : 0;
        // geometry 39: geometry 16's texture, as a new snapshot every time (the pool evicts).
        const auto texture=fixture_texture(format,layer==1 && (geometry==31 || geometry==32),geometry==33,
                                           geometry>=34 && geometry<=38,geometry==39,alpha3);
        // All eight bindings get the texture, though the fixtures' TEV stages read map 0 only.
        for(auto& t:dc.textures) {
          t=texture;
          if(geometry==35) t.mode0=1; // repeat
          if(geometry==36) t.mode0=2; // mirror
          if(geometry==37) t.mode0=16 | (4u<<5); // linear min/mag, no mip
          if(geometry==38) t.mode0=layer==1 ? 1 : 0; // clamp, repeat, clamp: two sampler keys
          if(geometry==45) t=gx::TextureRef{};       // untextured
        }
      }
      dc.first_vertex=frame.vertices.size(); dc.first_segment=frame.segments.size(); dc.segment_count=1;
      // geometry 6: layer 1 pads its triangle with 24,000 degenerate ones, past the first size of
      // both arenas (gxw_open: 1 MiB of vertices, 256 KiB of indices), so the batch holding layer
      // 0 is submitted and both arenas grow in the middle of the frame.
      const int vertices=geometry==6 && layer==1 ? 3+3*24000 : 3;
      for(int i=0;i<vertices;i++) {
        const int k=i<3 ? i : 0;
        gx::Vertex v{}; v.pos[0]=xy[k][0]; v.pos[1]=xy[k][1];
        v.pos[2]=layer==1 ? -0.8f : -0.3f; v.posmtx=3; v.nrm[2]=1;
        v.col0[layer]=255; v.col0[3]=255; v.col1[3]=255; v.texmtx[0]=60;
        if(geometry>=10) {
          for(auto& c:v.col0) c=geometry==30?128:255;
          if(geometry==47) { v.col0[0]=200; v.col0[1]=100; v.col0[2]=50; }
          v.uv[0][0]=((geometry>=34 && geometry<=36) || geometry==38)?1.25f:0.5f; v.uv[0][1]=0.5f;
        }
        frame.vertices.push_back(v);
      }
      if (geometry==45) dc.tev_colors[1][3]=layer==1 ? 128 : 0;      // one blend: the nearest layer
      frame.segments.push_back({dc.first_vertex,uint32_t(vertices),dc.primitive});
      frame.draws.push_back(dc); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
    }
    gx::EfbCopy copy{}; copy.src_w=640; copy.src_h=480; copy.to_xfb=true;
    frame.copies.push_back(copy); frame.commands.push_back({gx::FrameCommand::Copy,uint32_t(frame.copies.size()-1)});
    g_webgpu->submit_frame(frame);
  }
  return gx_webgpu_presented();
}

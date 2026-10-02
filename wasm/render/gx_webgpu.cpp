// WebGPU baseline geometry and ordered EFB copies (RENDERER_MAP priorities 1-2).
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What it does. A persistent EFB texture (gx::EFB_WIDTH x gx::EFB_HEIGHT) and the canvas. Each
// EfbCopy is replayed in frame order, the way GX executes it: an XFB copy first copies the EFB's
// source rectangle to the canvas, then a copy with `clear` set clears the EFB to its clear colour.
// So the colour a frame clears to is on screen from the NEXT XFB copy on, as on the console.
//
// Geometry uses a baseline shader with snapshot texture-0 MODULATE.
// Lighting, texgen and full TEV remain open. Clears cover the whole EFB;
// half-scale, Y scale, gamma and copy formats remain open (priorities 2-5).
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
#include <unordered_map>
#include <emscripten/emscripten.h>

// The two JavaScript halves stay at file scope, where Emscripten's EM_JS examples put them: the macro
// emits extern "C" declarations and a marker the linker has to see.

// Creates the EFB texture. 1 when there is a device to render with, 0 when there is not.
EM_JS(int, gxw_open, (int width, int height), {
  const gpu = Module["gxWebgpu"];
  if (!gpu || !gpu.device || (!gpu.context && !gpu.xfb)) return 0;
  // Draws per batch, bounded by the uniform arena (UNIFORM_SLOTS x uniformStride bytes), and the
  // vertex and index arenas' first sizes (they grow by doubling).
  const UNIFORM_SLOTS = 1024, VERTEX_ARENA_INITIAL = 1 << 20, INDEX_ARENA_INITIAL = 256 << 10;
  try {
    gpu.uniformSlotLimit = UNIFORM_SLOTS;
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
    gpu.samplers = new Map();
    // Views have no destroy(): one per persistent texture, made here or when its texture is.
    gpu.efbView = gpu.efb.createView();
    gpu.depthView = gpu.depth.createView();
    gpu.whiteEntry = {id:0, texture:gpu.white, view:gpu.white.createView()};
    // Draw resources are persistent (gxw_bind, gxw_draw). Uniforms, vertices and indices are
    // arenas: each draw of a batch appends its data at its own offset to a staging copy, and the
    // batch writes them with one writeBuffer each just before its single submit (gpu.flush).
    const align = (gpu.device.limits && gpu.device.limits.minUniformBufferOffsetAlignment) || 256;
    gpu.uniformStride = Math.ceil(105*16/align)*align;
    gpu.uniforms = gpu.device.createBuffer({size:UNIFORM_SLOTS*gpu.uniformStride,
      usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    gpu.uniformStaging = new Uint8Array(UNIFORM_SLOTS*gpu.uniformStride);
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
    gpu.openBatch = () => gpu.batch || (gpu.batch = {encoder:gpu.device.createCommandEncoder(),
      pass:null, state:null, vertexBytes:0, indexBytes:0, uniformSlots:0});
    gpu.endPass = (b) => { if (b.pass) { b.pass.end(); b.pass = null; b.state = null; } };
    gpu.flush = () => {
      const b = gpu.batch;
      if (!b) return;
      gpu.batch = null; gpu.batchSerial++;
      gpu.endPass(b);
      const q = gpu.device.queue;
      if (b.vertexBytes) q.writeBuffer(gpu.vertexBuffer,0,gpu.vertexStaging,0,b.vertexBytes);
      if (b.indexBytes) q.writeBuffer(gpu.indexBuffer,0,gpu.indexStaging,0,b.indexBytes);
      if (b.uniformSlots) q.writeBuffer(gpu.uniforms,0,gpu.uniformStaging,0,b.uniformSlots*gpu.uniformStride);
      q.submit([b.encoder.finish()]);
      gpu.batchSubmits++;
    };
    gpu.backendDevice = gpu.device;
    return 1;
  } catch (error) {
    gpu.recordFailure("open", error); gpu.failure = "open: " + error;
    return 0;
  }
});

// One EfbCopy: the XFB half (EFB source rectangle to the canvas), then the clear half, recorded
// into the batch after the draws before it. An XFB copy submits the batch: the canvas texture it
// wrote is presented once the worker's task ends or transfers it. 1 on success.
EM_JS(int, gxw_copy, (int src_x, int src_y, int src_w, int src_h, int to_xfb, int clear, int argb, int clear_z), {
  const gpu = Module["gxWebgpu"];
  try {
    const batch = gpu.openBatch();
    gpu.endPass(batch);
    const encoder = batch.encoder;
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
EM_JS(int, gxw_bind, (int slot, int content, int width, int height, int levels, int mode0, int mode1), {
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
EM_JS(int, gxw_draw, (const void* vertices, int vertex_bytes, const void* indices, int count,
                     const float* constants, const float* raster, int lines, int cull, int zmode, int components), {
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
    components &= 1024 | 8192 | 16384; zmode &= 31;
    const key = [lines,cull,zmode,components].join(":");
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      const attributes = [
        {shaderLocation:0,offset:0,format:"float32x3"},
        {shaderLocation:1,offset:12,format:"float32x3"},
        {shaderLocation:2,offset:24,format:"unorm8x4"},
        {shaderLocation:3,offset:28,format:"unorm8x4"}];
      for (let i=0;i<8;i++) attributes.push({shaderLocation:4+i,offset:32+8*i,format:"float32x2"});
      for (let i=0;i<3;i++) attributes.push({shaderLocation:12+i,offset:96+4*i,format:"uint8x4"});
      // 15 attributes, 108-byte stride: within WebGPU's baseline 16 / 2048 limits.
      const code = `
struct Constants { rows: array<vec4f, 105> }
@group(0) @binding(0) var<uniform> u: Constants;
${Array.from({length:8}, (_,n) => `@group(0) @binding(${1+2*n}) var tex${n}: texture_2d<f32>;
@group(0) @binding(${2+2*n}) var samp${n}: sampler;`).join("\n")}
struct Out { @builtin(position) pos: vec4f, @location(0) color: vec4f,
  @location(1) normal: vec3f, @location(2) color1: vec4f, @location(3) uv: vec2f, @location(4) clip: vec4f }
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) color: vec4f, @location(3) color1: vec4f, @location(4) uv: vec2f,
  @location(12) indices: vec4u) -> Out {
  let m = indices.x;
  let raw = vec4f(position,1);
  let p = vec4f(dot(u.rows[6+m],raw),dot(u.rows[7+m],raw),dot(u.rows[8+m],raw),1);
  var clip = vec4f(dot(u.rows[0],p),dot(u.rows[1],p),dot(u.rows[2],p),dot(u.rows[3],p));
  clip.z = -clip.z;
  clip = vec4f(clip.xy * sign(u.rows[4].zw * vec2f(-1,1)) + clip.w * u.rows[4].zw, clip.zw);
  if (clip.w == 1) { clip = vec4f(round(clip.xy * u.rows[5].xy) * u.rows[5].zw,clip.zw); }
  let originalClip = clip;
  // Emulate the D3D viewport in clip space, allowing viewports outside the EFB.
  clip = vec4f(clip.xy * u.rows[102].xy + clip.w * u.rows[102].zw,clip.zw);
  var o: Out;
  o.pos = clip; o.clip = originalClip;
  o.color = ${components & 8192 ? "color" : "vec4f(1)"};
  o.color1 = ${components & 16384 ? "color1" : "o.color"};
  o.normal = vec3f(0);
  ${components & 1024 ? `let n = select(m,m-32u,m>=32u);
  o.normal = normalize(vec3f(dot(u.rows[70+n].xyz,normal),dot(u.rows[71+n].xyz,normal),dot(u.rows[72+n].xyz,normal)));` : ""}
  o.uv = uv;
  return o;
}
@fragment fn fs(i: Out) -> @location(0) vec4f {
  let color = i.color * textureSampleBias(tex0,samp0,i.uv,u.rows[103].x);
  if (any(abs(i.clip.xy) > vec2f(i.clip.w))) { discard; }
  return color;
}`;
      const shader = d.createShaderModule({code});
      pipeline = d.createRenderPipeline({layout:gpu.pipelineLayout,
        vertex:{module:shader,entryPoint:"vs",buffers:[{arrayStride:108,attributes}]},
        fragment:{module:shader,entryPoint:"fs",targets:[{format:gpu.format}]},
        primitive:{topology:lines ? "line-list":"triangle-list",frontFace:"cw",cullMode:["none","back","front","back"][cull]},
        depthStencil:{format:"depth32float",depthWriteEnabled:!!((zmode&1)&&(zmode&16)),
          depthCompare:(zmode&1) ? ["never","greater","equal","greater-equal","less","not-equal","less-equal","always"][(zmode>>1)&7]:"always"}});
      gpu.pipelines.set(key,pipeline);
    }
    // Room in the batch's arenas, or submit the batch first: a batch is flushed, never
    // overwritten. Textures already bound for this draw were marked with the batch just
    // submitted; they move to the next one, which this draw opens. The arena that overflowed
    // grows (up to ARENA_GROWTH_LIMIT), so that the next frame fits in one batch again.
    const indexBytes = count*4, stride = gpu.uniformStride;
    let batch = gpu.batch, vertexNeed = vertex_bytes, indexNeed = indexBytes;
    if (batch && (batch.uniformSlots >= gpu.uniformSlotLimit ||
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
      const entries = [{binding:0,resource:{buffer:gpu.uniforms,size:105*16}}];
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
    const words = gpu.uniformWords, base = constants >> 2, n = 105*4;
    let offset = (batch.uniformSlots - 1)*stride, same = batch.uniformSlots > 0;
    for (let i = 0, at = offset >> 2; same && i < n; i++) same = words[at+i] === HEAPU32[base+i];
    if (!same) {
      offset = batch.uniformSlots*stride;
      gpu.uniformStaging.set(HEAPU8.subarray(constants,constants+105*16),offset);
      batch.uniformSlots++;
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

// All source reads are from TextureSnapshot, never host::ram/guest addresses. A snapshot already
// in the pool is neither decoded nor uploaded again (gxw_bind).
bool upload_textures(const gx::DrawCall& dc) {
  std::vector<uint8_t> rgba;
  for (int slot=0; slot<8; ++slot) {
    const auto& t=dc.textures[slot];
    if (!t.used) {
      if (!gxw_bind(slot,0,0,0,1,0,0)) return false;
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
    const int bound=gxw_bind(slot,content,t.width,t.height,t.mip_levels,t.mode0,t.mode1);
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
  float u[105][4] = {};
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
  if (!upload_textures(dc)) return false;
  return gxw_draw(frame.vertices.data()+segment.first_vertex,segment.vertex_count*sizeof(gx::Vertex),indices.data(),indices.size(),
                  &u[0][0],r,topology==gx::DrawTopology::Lines,dc.bp.cullmode(),dc.bp.zmode(),dc.components);
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
      if (!gxw_copy(int(c.src_x), int(c.src_y), int(c.src_w), int(c.src_h), c.to_xfb, c.clear,
                    int(c.clear_color), int(c.clear_z))) {
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
  if (!gxw_open(gx::EFB_WIDTH, gx::EFB_HEIGHT)) return 0;
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
static gx::TextureRef fixture_texture(uint32_t format, bool changed=false, bool mips=false, bool pattern=false, bool fresh=false) {
  gx::TextureRef t; t.used=true; t.addr=0x1000; t.width=8; t.height=8;
  t.format=format; t.tlut_format=1; t.mip_levels=mips?4:1;
  static std::unordered_map<uint32_t, std::shared_ptr<const gx::TextureSnapshot>> made;
  const uint32_t id=format | uint32_t(changed)<<8 | uint32_t(mips)<<9 | uint32_t(pattern)<<10;
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
      if(format==5) p[i]=(i%2)?0x1F:0xFC;
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
    dc.primitive=geometry==5 ? 0xB8 : 0x90; dc.vertex_count=3; dc.components=gx::VB_HAS_COL0 | gx::VB_HAS_COL1 | gx::VB_HAS_NRM0;
    const float vp[6]={320,-240,16777216,662,582,16777216};
    const float proj[6]={1,0,1,0,1,0};
    std::memcpy(dc.xf_regs+0x1A,vp,sizeof vp); std::memcpy(dc.xf_regs+0x20,proj,sizeof proj);
    dc.xf_regs[0x26]=1;
    // Nonzero matrix index and translation: reading position directly misses the probe.
    dc.posMatrices[12]=1; dc.posMatrices[15]=0.5f; dc.posMatrices[17]=1; dc.posMatrices[22]=1;
    dc.normalMatrices[9]=1; dc.normalMatrices[13]=1; dc.normalMatrices[17]=1;
    dc.bp.reg[gx::BP_SCISSORBR]=(639u<<12)|479u;
    dc.bp.reg[gx::BP_ZMODE]=1|2|16; // GX LESS -> reversed GREATER, writes enabled.
    if (geometry==2) dc.bp.reg[gx::BP_SCISSORBR]=(159u<<12)|479u;
    if (geometry==3) dc.bp.reg[gx::BP_GENMODE]=2u<<14; // front cull (clockwise triangle)
    const float xy[3][2]={{-0.9f,-0.6f},{-0.5f,0.6f},{-0.1f,-0.6f}};
    for(int layer=0;layer<3;layer++) {
      if (geometry>=10) {
        static const uint32_t formats[]={0,1,2,3,4,5,6,8,9,10,14};
        const uint32_t format=geometry<=20?formats[geometry-10]:geometry==32?8:6;
        // geometry 39: geometry 16's texture, as a new snapshot every time (the pool evicts).
        const auto texture=fixture_texture(format,layer==1 && (geometry==31 || geometry==32),geometry==33,
                                           geometry>=34 && geometry<=38,geometry==39);
        // Exercise all eight bindings even though the intentionally limited shader uses slot 0.
        for(auto& t:dc.textures) {
          t=texture;
          if(geometry==35) t.mode0=1; // repeat
          if(geometry==36) t.mode0=2; // mirror
          if(geometry==37) t.mode0=16 | (4u<<5); // linear min/mag, no mip
          if(geometry==38) t.mode0=layer==1 ? 1 : 0; // clamp, repeat, clamp: two sampler keys
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
        v.col0[layer]=255; v.col0[3]=255; v.col1[3]=255;
        if(geometry>=10) {
          for(auto& c:v.col0) c=geometry==30?128:255;
          v.uv[0][0]=((geometry>=34 && geometry<=36) || geometry==38)?1.25f:0.5f; v.uv[0][1]=0.5f;
        }
        frame.vertices.push_back(v);
      }
      frame.segments.push_back({dc.first_vertex,uint32_t(vertices),dc.primitive});
      frame.draws.push_back(dc); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
    }
    gx::EfbCopy copy{}; copy.src_w=640; copy.src_h=480; copy.to_xfb=true;
    frame.copies.push_back(copy); frame.commands.push_back({gx::FrameCommand::Copy,0});
    g_webgpu->submit_frame(frame);
  }
  return gx_webgpu_presented();
}

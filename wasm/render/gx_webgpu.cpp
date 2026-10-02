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
#include <cmath>
#include <emscripten/emscripten.h>

// The two JavaScript halves stay at file scope, where Emscripten's EM_JS examples put them: the macro
// emits extern "C" declarations and a marker the linker has to see.

// Creates the EFB texture. 1 when there is a device to render with, 0 when there is not.
EM_JS(int, gxw_open, (int width, int height), {
  const gpu = Module["gxWebgpu"];
  if (!gpu || !gpu.device || (!gpu.context && !gpu.xfb)) return 0;
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
    const entries = [{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}];
    for (let i=0;i<8;i++) {
      entries.push({binding:1+2*i,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float"}});
      entries.push({binding:2+2*i,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}});
    }
    gpu.textureLayout = gpu.device.createBindGroupLayout({entries});
    gpu.pipelineLayout = gpu.device.createPipelineLayout({bindGroupLayouts:[gpu.textureLayout]});
    gpu.pipelines = new Map();
    gpu.samplers = new Map();
    gpu.backendDevice = gpu.device;
    return 1;
  } catch (error) {
    gpu.recordFailure("open", error); gpu.failure = "open: " + error;
    return 0;
  }
});

// One EfbCopy: the XFB half (EFB source rectangle to the canvas), then the clear half. 1 on success.
EM_JS(int, gxw_copy, (int src_x, int src_y, int src_w, int src_h, int to_xfb, int clear, int argb, int clear_z), {
  const gpu = Module["gxWebgpu"];
  try {
    const encoder = gpu.device.createCommandEncoder();
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
        view: gpu.efb.createView(), loadOp: "clear", storeOp: "store",
        clearValue: { r: ((c >>> 16) & 255) / 255, g: ((c >>> 8) & 255) / 255, b: (c & 255) / 255, a: (c >>> 24) / 255 },
      }], depthStencilAttachment: {view: gpu.depth.createView(), depthLoadOp: "clear",
        depthStoreOp: "store", depthClearValue: 1 - (clear_z >>> 0) / 16777215} });
      pass.end();
      gpu.lastClearArgb = c;
    }
    gpu.device.queue.submit([encoder.finish()]);
    gpu.backendCopies = (gpu.backendCopies | 0) + 1;
    if (gpu.device !== gpu.backendDevice) gpu.backendDevice = null;
    return 1;
  } catch (error) {
    gpu.recordFailure("copy", error); gpu.failure = "copy: " + error;
    return 0;
  }
});

// Re-upload immutable snapshots per segment: no address/hash cache can return stale pixels.
// queue.writeTexture copies the WASM bytes before this call returns.
//
// Samplers are cached instead. They have no destroy(), so a fresh one per slot per draw (8 per
// draw, unused slots included) was released only by garbage collection, whose timing nothing
// here controls; createSampler is the call that failed on the iPhone after 81 copies (7296478).
// The descriptor is a pure function of mode0 bits 0-7 and mode1 bits 0-15, which is the key, so
// a hit is the sampler a miss would create. Bounded: past SAMPLER_CACHE_LIMIT distinct
// keys the oldest is dropped (to garbage collection). render.spec.ts's sampler count is the misses.
EM_JS(int, gxw_texture, (int slot, int width, int height, int levels, int level,
                       const void* rgba, int bytes, int mode0, int mode1), {
  const gpu = Module["gxWebgpu"];
  const SAMPLER_CACHE_LIMIT = 256;
  try {
    if (level === 0) {
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
      const texture = width ? gpu.device.createTexture({size:[width,height],mipLevelCount:levels,
        format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}) : gpu.white;
      gpu.slots[slot] = {texture,sampler};
    }
    if (width) gpu.device.queue.writeTexture({texture:gpu.slots[slot].texture,mipLevel:level},
      HEAPU8.subarray(rgba,rgba+bytes),{bytesPerRow:width*4,rowsPerImage:height},[width,height]);
    return 1;
  } catch(error) { gpu.recordFailure("texture", error); gpu.failure = "texture: " + error; return 0; }
});

// Destroy after submission, including error paths. WebGPU retains allocations needed by
// previously submitted work. Waiting for a JS completion callback retains every draw's resources
// for the entire synchronous callMain (measured by render.spec.ts).
// https://www.w3.org/TR/webgpu/#texture-destruction
EM_JS(void, gxw_retire_textures, (), {
  const gpu = Module["gxWebgpu"];
  const textures = gpu.slots.map(s => s.texture).filter(t => t !== gpu.white);
  gpu.slots = [];
  textures.forEach(t => t.destroy());
});

// Explicit float4 rows: no dependency on an unverified C++/WGSL struct ABI.
EM_JS(int, gxw_draw, (const void* vertices, int vertex_bytes, const void* indices, int count,
                     const float* constants, const float* raster, int lines, int cull, int zmode, int components), {
  const gpu = Module["gxWebgpu"];
  const buffers = [];
  try {
    const d = gpu.device;
    const r = HEAPF32.slice(raster >> 2, (raster >> 2) + 10);
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
    const upload = (ptr,size,usage) => {
      const b = d.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});
      buffers.push(b); d.queue.writeBuffer(b,0,HEAPU8,ptr,size); return b;
    };
    const vb = upload(vertices,vertex_bytes,GPUBufferUsage.VERTEX);
    const ib = upload(indices,count*4,GPUBufferUsage.INDEX);
    const ub = upload(constants,105*16,GPUBufferUsage.UNIFORM);
    const entries = [{binding:0,resource:{buffer:ub}}];
    for (let i=0;i<8;i++) {
      entries.push({binding:1+2*i,resource:gpu.slots[i].texture.createView()});
      entries.push({binding:2+2*i,resource:gpu.slots[i].sampler});
    }
    const group = d.createBindGroup({layout:gpu.textureLayout,entries});
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginRenderPass({colorAttachments:[{view:gpu.efb.createView(),loadOp:"load",storeOp:"store"}],
      depthStencilAttachment:{view:gpu.depth.createView(),depthLoadOp:"load",depthStoreOp:"store"}});
    pass.setPipeline(pipeline); pass.setBindGroup(0,group);
    pass.setViewport(0,0,gpu.efb.width,gpu.efb.height,r[4],r[5]);
    pass.setScissorRect(r[6],r[7],r[8],r[9]);
    pass.setVertexBuffer(0,vb); pass.setIndexBuffer(ib,"uint32"); pass.drawIndexed(count); pass.end();
    d.queue.submit([encoder.finish()]);
    // No future submissions use these buffers. destroy() permits the driver to reclaim them
    // after its queued work, without waiting for callMain to yield to a JS promise callback.
    // https://www.w3.org/TR/webgpu/#buffer-destruction
    buffers.forEach(b => b.destroy());
    return 1;
  } catch(error) {
    gpu.recordFailure("draw", error); buffers.forEach(b => b.destroy()); gpu.failure = "draw: " + error; return 0;
  }
});

EM_JS(int, gxw_pipeline_count, (), {
  const gpu = Module["gxWebgpu"]; return gpu && gpu.pipelines ? gpu.pipelines.size : 0;
});

namespace {
static_assert(sizeof(gx::Vertex) == 108 && offsetof(gx::Vertex, nrm) == 12 &&
              offsetof(gx::Vertex, col0) == 24 && offsetof(gx::Vertex, col1) == 28 &&
              offsetof(gx::Vertex, uv) == 32 && offsetof(gx::Vertex, posmtx) == 96 &&
              offsetof(gx::Vertex, texmtx) == 97, "WebGPU packed vertex layout");

// All source reads are from TextureSnapshot, never host::ram/guest addresses.
bool upload_textures(const gx::DrawCall& dc) {
  std::vector<uint8_t> rgba;
  for (int slot=0; slot<8; ++slot) {
    const auto& t=dc.textures[slot];
    if (!t.used) {
      if (!gxw_texture(slot,0,0,1,0,nullptr,0,0,0)) return false;
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
    uint32_t w=t.width,h=t.height; size_t offset=0;
    for (uint32_t level=0;level<t.mip_levels;++level) {
      gx::decode_texture(t.data->image.data()+offset,w,h,t.format,t.data->palette.data(),t.tlut_format,rgba);
      if (!gxw_texture(slot,w,h,t.mip_levels,level,rgba.data(),rgba.size(),t.mode0,t.mode1)) return false;
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
  if (!upload_textures(dc)) { gxw_retire_textures(); return false; }
  const bool ok = gxw_draw(frame.vertices.data()+segment.first_vertex,segment.vertex_count*sizeof(gx::Vertex),indices.data(),indices.size(),
                  &u[0][0],r,topology==gx::DrawTopology::Lines,dc.bp.cullmode(),dc.bp.zmode(),dc.components);
  gxw_retire_textures();
  return ok;
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
  }
  void presentation_stats(uint32_t* frames, uint32_t* pipelines, uint32_t* textures) const override {
    if (frames) *frames = presented_;
    if (pipelines) *pipelines = gxw_pipeline_count();
    if (textures) *textures = 1; // only the persistent white fallback; draw textures retire after submission
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
static gx::TextureRef fixture_texture(uint32_t format, bool changed=false, bool mips=false, bool pattern=false) {
  gx::TextureRef t; t.used=true; t.addr=0x1000; t.width=8; t.height=8;
  t.format=format; t.tlut_format=1; t.mip_levels=mips?4:1;
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
        const auto texture=fixture_texture(format,layer==1 && (geometry==31 || geometry==32),geometry==33,geometry>=34);
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
      for(int i=0;i<3;i++) {
        gx::Vertex v{}; v.pos[0]=xy[i][0]; v.pos[1]=xy[i][1];
        v.pos[2]=layer==1 ? -0.8f : -0.3f; v.posmtx=3; v.nrm[2]=1;
        v.col0[layer]=255; v.col0[3]=255; v.col1[3]=255;
        if(geometry>=10) {
          for(auto& c:v.col0) c=geometry==30?128:255;
          v.uv[0][0]=((geometry>=34 && geometry<=36) || geometry==38)?1.25f:0.5f; v.uv[0][1]=0.5f;
        }
        frame.vertices.push_back(v);
      }
      frame.segments.push_back({dc.first_vertex,3,dc.primitive});
      frame.draws.push_back(dc); frame.commands.push_back({gx::FrameCommand::Draw,uint32_t(frame.draws.size()-1)});
    }
    gx::EfbCopy copy{}; copy.src_w=640; copy.src_h=480; copy.to_xfb=true;
    frame.copies.push_back(copy); frame.commands.push_back({gx::FrameCommand::Copy,0});
    g_webgpu->submit_frame(frame);
  }
  return gx_webgpu_presented();
}

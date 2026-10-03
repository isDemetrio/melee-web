// WGSL for one GX draw. A transcription of upstream's HLSL generator (gx_shader.cpp, itself ported
// from Dolphin's VideoCommon), for the WebGPU backend in gx_webgpu.cpp.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What is transcribed, and from where:
//   - The TEV (generate_pixel_shader, gx_shader.cpp:394-597): every stage's colour and alpha
//     combiner on signed integers -- the four inputs of each, bias, add/subtract, scale, clamp or the
//     11-bit range, the eight compare modes, the four output registers and the overflow wrap
//     (CHK_O_U8) -- the ras and texture swap tables, the konstant selections, and each stage's
//     texture map and texture coordinate. Shifts stay shifts: an arithmetic `>>` floors where a
//     division would truncate, and the lerp biases (+128, +127) are upstream's.
//   - The alpha test (gx_shader.cpp:590-598) on the TEV's integer alpha, and fog (:599-614).
//   - Texture coordinate generation (generate_vertex_shader, gx_shader.cpp:256-307): source row,
//     input form, regular / emboss / colour texgens, ST or STQ projection, the dual post-transform
//     with its normalisation; and the projective divide of the pixel shader (:443-446).
//   - Colour channels without lights (gen_lighting, gx_shader.cpp:102-153): the material colour from
//     the vertex or from the XF register, per channel and separately for alpha.
//
// What is not, and what happens instead (each is stated where it is generated):
//   - Lighting. A channel with lighting enabled is given its material colour, which is what the
//     channel computes when its lights add up to full intensity. The lit draws measured in the menus
//     and in a match all have a white material, so this is the colour the backend drew before. The
//     lights themselves are PR #70's (render/webgpu-lighting).
//   - Indirect texturing (no draw in the measured menu and match frames uses an indirect stage), and
//     the texture coordinate scale registers (SU_SSIZE): coordinates are sampled normalised, which is
//     what GX does when it sets that scale to the texture's size itself.
//   - Z textures (ZTEX), the zfreeze slope and dither.
#include "gx_wgsl.h"
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <tuple>

namespace gxw {
namespace {

using gx::bits;

struct Code {
  std::string s;
  void w(const char* fmt, ...) {
    char buf[1024];
    va_list ap; va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    s += buf;
  }
};

// ShaderUid word positions.
enum : int {
  U_COMPONENTS = 0, U_NUMCHANS = 1, U_CHANS = 2 /* color0, color1, alpha0, alpha1 */, U_NUMTEXGENS = 6,
  U_DUALTEX = 7, U_TEXGEN = 8 /* 8 */, U_POSTINFO = 16 /* 8 */, U_STAGES = 24, U_COLOR_ENV = 25 /* 16 */,
  U_ALPHA_ENV = 41 /* 16 */, U_TREF = 57 /* 8 */, U_KSEL = 65 /* 8 */, U_ALPHA_OPS = 73, U_FOG = 74,
};
static_assert(U_FOG < int(std::tuple_size<decltype(ShaderUid::w)>::value), "uid words");

// Accessors on a uid, in BPMemory's terms.
struct Uid {
  const ShaderUid& u;
  uint32_t color_env(int n) const { return u.w[U_COLOR_ENV + n]; }
  uint32_t alpha_env(int n) const { return u.w[U_ALPHA_ENV + n]; }
  uint32_t tref(int i) const { return u.w[U_TREF + i]; }
  uint32_t ksel(int i) const { return u.w[U_KSEL + i]; }
  int order_texmap(int n) const { return bits(tref(n / 2), (n & 1) ? 12 : 0, 3); }
  int order_texcoord(int n) const { return bits(tref(n / 2), (n & 1) ? 15 : 3, 3); }
  int order_enable(int n) const { return bits(tref(n / 2), (n & 1) ? 18 : 6, 1); }
  int order_colorchan(int n) const { return bits(tref(n / 2), (n & 1) ? 19 : 7, 3); }
  int swap1(int i) const { return bits(ksel(i), 0, 2); }
  int swap2(int i) const { return bits(ksel(i), 2, 2); }
  int ksel_kc(int n) const { return bits(ksel(n / 2), (n & 1) ? 14 : 4, 5); }
  int ksel_ka(int n) const { return bits(ksel(n / 2), (n & 1) ? 19 : 9, 5); }
};

// Konstant selections (kselC / kselA, gx_shader.cpp:320-335). k0-k3 are the K registers.
const char* const kselC[] = {
  "vec3i(255)", "vec3i(223)", "vec3i(191)", "vec3i(159)", "vec3i(128)", "vec3i(96)", "vec3i(64)", "vec3i(32)",
  "vec3i(0)", "vec3i(0)", "vec3i(0)", "vec3i(0)",
  "k0.rgb", "k1.rgb", "k2.rgb", "k3.rgb", "k0.rrr", "k1.rrr", "k2.rrr", "k3.rrr",
  "k0.ggg", "k1.ggg", "k2.ggg", "k3.ggg", "k0.bbb", "k1.bbb", "k2.bbb", "k3.bbb",
  "k0.aaa", "k1.aaa", "k2.aaa", "k3.aaa",
};
const char* const kselA[] = {
  "255", "223", "191", "159", "128", "96", "64", "32", "0", "0", "0", "0", "0", "0", "0", "0",
  "k0.r", "k1.r", "k2.r", "k3.r", "k0.g", "k1.g", "k2.g", "k3.g",
  "k0.b", "k1.b", "k2.b", "k3.b", "k0.a", "k1.a", "k2.a", "k3.a",
};
const char* const cInput[] = {"prev.rgb", "prev.aaa", "c0.rgb", "c0.aaa", "c1.rgb", "c1.aaa", "c2.rgb", "c2.aaa",
                              "tex_t.rgb", "tex_t.aaa", "ras_t.rgb", "ras_t.aaa", "vec3i(255)", "vec3i(128)",
                              "konst_t.rgb", "vec3i(0)"};
const char* const aInput[] = {"prev.a", "c0.a", "c1.a", "c2.a", "tex_t.a", "ras_t.a", "konst_t.a", "0"};
const int aInputSource[] = {1, 3, 5, 7, 9, 11, 14, 15};
// Ras colours by TEV order channel: 0 COLOR0A0, 1 COLOR1A1; 5 and 6 are the indirect bump alpha,
// which is 0 without indirect stages; the rest are zero.
const char* const rasTable[] = {"col0", "col1", "vec4i(0)", "vec4i(0)", "vec4i(0)", "vec4i(0)", "vec4i(0)", "vec4i(0)"};
const char* const cOut[] = {"prev", "c0", "c1", "c2"};
const int cOutSource[] = {0, 2, 4, 6};
const int aOutSource[] = {1, 3, 5, 7};

// Which inputs may hold values outside 0-255 at this point of the shader (RegState).
struct RegState {
  bool overflow[16] = {true, true, true, true, true, true, true, true, false, false, true, true, false, false, true, false};
};

// write_tev_regular (gx_shader.cpp:356-371). `comps` is ".rgb" or ".a"; WGSL has no shift of a vector
// by a scalar, so right shifts name a vector amount, and left shifts are the equal multiplications.
void tev_regular(Code& o, bool alpha, int bias, int op, int shift, int a, int b, int c, int zero, int one) {
  const char* comps = alpha ? ".a" : ".rgb";
  const char* s8 = alpha ? "8u" : "vec3u(8u)";
  const char* s1 = alpha ? "1u" : "vec3u(1u)";
  const char* left[] = {"", " * 2", " * 4", ""};
  const char* lerpBias[] = {"", " + 128", "", " + 127"};
  const char* biasTable[] = {"", " + 128", " - 128", ""};
  const char* opTable[] = {"+", "-"};
  const int lb = 2 * op + ((shift == 3) == alpha);
  o.w("((((tin_d%s%s)%s) %s ", comps, biasTable[bias], left[shift], opTable[op]);
  if (a == b || c == zero) o.w("((((tin_a%s * 256)%s)%s) >> %s)", comps, left[shift], lerpBias[lb], s8);
  else if (c == one) o.w("((((tin_b%s * 256)%s)%s) >> %s)", comps, left[shift], lerpBias[lb], s8);
  else if (a == zero) o.w("((((tin_b%s * tin_c%s)%s)%s) >> %s)", comps, comps, left[shift], lerpBias[lb], s8);
  else if (b == zero) o.w("((((tin_a%s * (256 - tin_c%s))%s)%s) >> %s)", comps, comps, left[shift], lerpBias[lb], s8);
  else o.w("(((((tin_a%s * 256) + (tin_b%s - tin_a%s) * tin_c%s)%s)%s) >> %s)", comps, comps, comps, comps, left[shift], lerpBias[lb], s8);
  o.w(")");
  if (shift == 3) o.w(" >> %s", s1);
  o.w(")");
}

// write_tev_compare (gx_shader.cpp:373-386): R8, GR16, BGR24 and per-component RGB8 / A8.
void tev_compare(Code& o, bool alpha, int cmp) {
  const char* c = alpha ? "tin_c.a" : "tin_c.rgb";
  const char* zero = alpha ? "0" : "vec3i(0)";
  const char* const conds[] = {
    "tin_a.r > tin_b.r", "tin_a.r == tin_b.r",
    "dot(tin_a.rgb, vec3i(1, 256, 0)) > dot(tin_b.rgb, vec3i(1, 256, 0))",
    "dot(tin_a.rgb, vec3i(1, 256, 0)) == dot(tin_b.rgb, vec3i(1, 256, 0))",
    "dot(tin_a.rgb, vec3i(1, 256, 65536)) > dot(tin_b.rgb, vec3i(1, 256, 65536))",
    "dot(tin_a.rgb, vec3i(1, 256, 65536)) == dot(tin_b.rgb, vec3i(1, 256, 65536))",
  };
  const char* d = alpha ? "tin_d.a" : "tin_d.rgb";
  if (cmp < 6) o.w("(%s + select(%s, %s, %s))", d, zero, c, conds[cmp]);
  else if (alpha) o.w("(%s + select(0, tin_c.a, tin_a.a %s tin_b.a))", d, cmp == 6 ? ">" : "==");
  else o.w("(%s + select(vec3i(0), tin_c.rgb, tin_a.rgb %s tin_b.rgb))", d, cmp == 6 ? ">" : "==");
}

// A swap table entry as a WGSL swizzle (ksel registers 2*table and 2*table+1).
std::string swizzle(const Uid& g, int table) {
  const char rgba[] = "rgba";
  return {rgba[g.swap1(table * 2)], rgba[g.swap2(table * 2)], rgba[g.swap1(table * 2 + 1)], rgba[g.swap2(table * 2 + 1)]};
}

void vertex_colour(Code& o, uint32_t components, int j, bool alpha_only, const char* dst) {
  // The vertex's colour j, else colour 0, else white (gen_lighting's `matsource` branch).
  const char* sw = alpha_only ? ".a" : "";
  if (components & (gx::VB_HAS_COL0 << j)) o.w("%s = round(color%d%s * 255.0);\n", dst, j, sw);
  else if (components & gx::VB_HAS_COL0) o.w("%s = round(color0%s * 255.0);\n", dst, sw);
  else o.w("%s = %s;\n", dst, alpha_only ? "255.0" : "vec4f(255.0)");
}

}  // namespace

ShaderUid make_uid(const gx::DrawCall& dc) {
  ShaderUid u;
  const gx::BPMemory& b = dc.bp;
  const uint32_t ntex = dc.xf_regs[0x3F] & 15, nchan = dc.xf_regs[0x09] & 3;
  const bool dual = dc.xf_regs[0x12] & 1;
  uint32_t components = dc.components & (gx::VB_HAS_COL0 | gx::VB_HAS_COL1 | gx::VB_HAS_NRM0);
  u.w[U_NUMCHANS] = nchan;
  // Only the bit the channels are generated from (no lights here; see the top of the file).
  for (uint32_t j = 0; j < nchan && j < 2; ++j) {
    u.w[U_CHANS + j] = dc.xf_regs[0x0E + j] & 1;
    u.w[U_CHANS + 2 + j] = dc.xf_regs[0x10 + j] & 1;
  }
  u.w[U_NUMTEXGENS] = ntex;
  u.w[U_DUALTEX] = dual;
  for (uint32_t i = 0; i < ntex && i < 8; ++i) {
    const uint32_t info = dc.xf_regs[0x40 + i] & 0x3FFFF;
    u.w[U_TEXGEN + i] = info;
    if (dual) u.w[U_POSTINFO + i] = dc.xf_regs[0x50 + i] & 0x100;   // normalise; the index is a uniform
    const uint32_t row = gx::tmi_sourcerow(info);
    if (row >= 5 && row <= 12) components |= dc.components & (gx::VB_HAS_UV0 << (row - 5));
  }
  u.w[U_COMPONENTS] = components;
  // PSUid (gx_shader.cpp:177-205): only the stages the shader emits.
  const int stages = int(b.numtevstages()) + 1;
  u.w[U_STAGES] = uint32_t(stages);
  for (int i = 0; i < stages; ++i) {
    u.w[U_COLOR_ENV + i] = b.tev_color(i) & 0xFFFFFF;
    u.w[U_ALPHA_ENV + i] = b.tev_alpha(i) & 0xFFFFFF;
  }
  for (int i = 0; i < 8; ++i) {
    const uint32_t tref_mask = (2 * i + 1 < stages) ? 0xFFFFFF : (2 * i < stages) ? 0xFFF : 0;
    const uint32_t ksel_mask = (2 * i + 1 < stages) ? 0xFFFFFF : (2 * i < stages) ? 0x3FFF : 0xF;
    u.w[U_TREF + i] = b.tref(i) & tref_mask;
    u.w[U_KSEL + i] = b.ksel(i) & ksel_mask;
  }
  u.w[U_ALPHA_OPS] = (b.alpha_test() >> 16) & 0xFF;
  u.w[U_FOG] = (b.fogparam3() & 0xF00000) | (b.fogrange(0) & 0x400);
  return u;
}

int uniform_rows(const ShaderUid& uid) { return ROW_TEXGEN + 3 * int(uid.w[U_NUMTEXGENS]); }

std::string generate_wgsl(const ShaderUid& uid) {
  const Uid g{uid};
  const uint32_t components = uid.w[U_COMPONENTS], nchan = uid.w[U_NUMCHANS];
  const uint32_t ntex = uid.w[U_NUMTEXGENS];
  const bool dual = uid.w[U_DUALTEX];
  const int stages = int(uid.w[U_STAGES]);
  Code o;
  o.w("struct Constants { rows: array<vec4f, %d> }\n@group(0) @binding(0) var<uniform> u: Constants;\n", MAX_ROWS);
  for (int n = 0; n < 8; ++n)
    o.w("@group(0) @binding(%d) var tex%d: texture_2d<f32>;\n@group(0) @binding(%d) var samp%d: sampler;\n", 1 + 2 * n, n, 2 + 2 * n, n);
  o.w("struct Out {\n  @builtin(position) pos: vec4f,\n  @location(0) clip: vec4f,\n  @location(1) colors_0: vec4f,\n  @location(2) colors_1: vec4f,\n");
  for (uint32_t i = 0; i < ntex; ++i) o.w("  @location(%u) tex%u: vec3f,\n", 3 + i, i);
  o.w("}\n");

  // ---- vertex: position and clip (the baseline transcription, gx_shader.cpp:671-748) -------------
  o.w("@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f,\n"
      "  @location(2) color0: vec4f, @location(3) color1: vec4f,\n");
  for (int k = 0; k < 8; ++k) o.w("  @location(%d) rawtex%d: vec2f,\n", 4 + k, k);
  o.w("  @location(12) indices: vec4u, @location(13) indices2: vec4u, @location(14) indices3: vec4u) -> Out {\n"
      "  let m = indices.x;\n"
      "  let raw = vec4f(position, 1.0);\n"
      "  let p = vec4f(dot(u.rows[6u + m], raw), dot(u.rows[7u + m], raw), dot(u.rows[8u + m], raw), 1.0);\n"
      "  var clip = vec4f(dot(u.rows[0], p), dot(u.rows[1], p), dot(u.rows[2], p), dot(u.rows[3], p));\n"
      "  clip.z = -clip.z;\n"
      // Dolphin's VertexShaderGen for a host without depth clamping (WebGPU has no user clip
      // distances): depth scaled by 1 - 1e-7, so a primitive on the near plane up to rounding is
      // not clipped. The shadow pass's white backdrop quad is one, 1.8e-8 beyond it; clipped, the
      // projected shadow texture is black and the stage under it too.
      "  clip.z = clip.z * (1.0 - 1e-7);\n"
      "  clip = vec4f(clip.xy * sign(u.rows[4].zw * vec2f(-1.0, 1.0)) + clip.w * u.rows[4].zw, clip.zw);\n"
      "  if (clip.w == 1.0) { clip = vec4f(round(clip.xy * u.rows[5].xy) * u.rows[5].zw, clip.zw); }\n"
      "  var o: Out;\n"
      "  o.clip = clip;\n"
      // Emulate the D3D viewport in clip space, allowing viewports outside the EFB.
      "  o.pos = vec4f(clip.xy * u.rows[102].xy + clip.w * u.rows[102].zw, clip.zw);\n");
  // ---- vertex: colour channels (gen_lighting without lights) ---------------------------------------
  if (nchan == 0) {
    o.w("  o.colors_0 = %s;\n", components & gx::VB_HAS_COL0 ? "color0" : "vec4f(1.0)");
    o.w("  o.colors_1 = %s;\n", components & gx::VB_HAS_COL1 ? "color1" : "o.colors_0");
  } else {
    o.w("  var mtl = vec4f(0.0);\n");
    for (uint32_t j = 0; j < nchan && j < 2; ++j) {
      const bool color_vertex = uid.w[U_CHANS + j], alpha_vertex = uid.w[U_CHANS + 2 + j];
      if (color_vertex) vertex_colour(o, components, int(j), false, "  mtl");
      else o.w("  mtl = u.rows[%d];\n", ROW_MATERIALS + 2 + int(j));
      if (alpha_vertex != color_vertex) {
        if (alpha_vertex) vertex_colour(o, components, int(j), true, "  mtl.w");
        else o.w("  mtl.w = u.rows[%d].a;\n", ROW_MATERIALS + 2 + int(j));
      }
      // Lighting disabled: the light accumulator is 255, and (mtl * 256) >> 8 is the material. A lit
      // channel is given the same: its lights are not generated here (see the top of the file).
      o.w("  o.colors_%u = mtl / 255.0;\n", j);
    }
    if (nchan < 2) o.w("  o.colors_1 = %s;\n", components & gx::VB_HAS_COL1 ? "color1" : "o.colors_0");
  }
  // ---- vertex: texture coordinate generation -------------------------------------------------------
  const char* const tmIndex[] = {"indices.y", "indices.z", "indices.w", "indices2.x", "indices2.y", "indices2.z", "indices2.w", "indices3.x"};
  for (uint32_t i = 0; i < ntex; ++i) {
    const uint32_t info = uid.w[U_TEXGEN + i];
    const uint32_t row = gx::tmi_sourcerow(info), type = gx::tmi_texgentype(info);
    const uint32_t inputform = gx::tmi_inputform(info), projection = gx::tmi_projection(info);
    o.w("  {\n    var coord = vec4f(0.0, 0.0, 1.0, 1.0);\n");
    if (row == 0) o.w("    coord = vec4f(position, 1.0);\n");
    else if (row == 1) { if (components & gx::VB_HAS_NRM0) o.w("    coord = vec4f(normal, 1.0);\n"); }
    else if (row >= 5 && row <= 12 && (components & (gx::VB_HAS_UV0 << (row - 5)))) o.w("    coord = vec4f(rawtex%u, 1.0, 1.0);\n", row - 5);
    if (inputform == 0) o.w("    coord.z = 1.0;\n");
    if (type == 1) o.w("    o.tex%u = vec3f(coord.xy, 1.0);\n", i);   // emboss without binormals, as upstream
    else if (type == 2) o.w("    o.tex%u = vec3f(o.colors_0.x, o.colors_0.y, 1.0);\n", i);
    else if (type == 3) o.w("    o.tex%u = vec3f(o.colors_1.x, o.colors_1.y, 1.0);\n", i);
    else {
      o.w("    let tm = %s;\n", tmIndex[i]);
      if (projection) o.w("    o.tex%u = vec3f(dot(coord, u.rows[6u + tm]), dot(coord, u.rows[7u + tm]), dot(coord, u.rows[8u + tm]));\n", i);
      else o.w("    o.tex%u = vec3f(dot(coord, u.rows[6u + tm]), dot(coord, u.rows[7u + tm]), 1.0);\n", i);
    }
    if (type == 0) {
      if (projection) o.w("    if (o.tex%u.z == 0.0) { o.tex%u = vec3f(clamp(o.tex%u.xy, vec2f(-2.0), vec2f(2.0)), o.tex%u.z); }\n", i, i, i, i);
      if (dual) {
        const int r = ROW_TEXGEN + 3 * int(i);
        if (uid.w[U_POSTINFO + i] & 0x100) o.w("    o.tex%u = normalize(o.tex%u);\n", i, i);
        o.w("    o.tex%u = vec3f(dot(u.rows[%d].xyz, o.tex%u) + u.rows[%d].w, dot(u.rows[%d].xyz, o.tex%u) + u.rows[%d].w, dot(u.rows[%d].xyz, o.tex%u) + u.rows[%d].w);\n",
            i, r, i, r, r + 1, i, r + 1, r + 2, i, r + 2);
      }
    }
    o.w("  }\n");
  }
  o.w("  return o;\n}\n");

  // ---- fragment ------------------------------------------------------------------------------------
  o.w("@fragment fn fs(i: Out) -> @location(0) vec4f {\n");
  // Texture coordinates after the projective divide.
  for (uint32_t t = 0; t < ntex; ++t) o.w("  let uv%u = i.tex%u.xy / select(i.tex%u.z, 2.0, i.tex%u.z == 0.0);\n", t, t, t, t);
  // Every stage's texture first, in uniform control flow (no sample may follow a discard).
  for (int n = 0; n < stages; ++n) {
    const uint32_t cc = g.color_env(n), ac = g.alpha_env(n);
    auto ccUses = [&](uint32_t v) { return bits(cc, 12, 4) == v || bits(cc, 8, 4) == v || bits(cc, 4, 4) == v || bits(cc, 0, 4) == v; };
    auto acUses = [&](uint32_t v) { return bits(ac, 13, 3) == v || bits(ac, 10, 3) == v || bits(ac, 7, 3) == v || bits(ac, 4, 3) == v; };
    const bool texEnable = g.order_enable(n) && (ccUses(8) || ccUses(9) || acUses(4));
    if (!texEnable) { o.w("  let tex_ta%d = vec4i(255);\n", n); continue; }
    const uint32_t coord = uint32_t(g.order_texcoord(n));
    const int map = g.order_texmap(n);
    const std::string uv = coord < ntex ? "uv" + std::to_string(coord) : "vec2f(0.0)";
    o.w("  let tex_ta%d = vec4i(round(textureSampleBias(tex%d, samp%d, %s, u.rows[%d][%d]) * 255.0));\n",
        n, map, map, uv.c_str(), 103 + map / 4, map % 4);
  }
  o.w("  if (any(abs(i.clip.xy) > vec2f(i.clip.w))) { discard; }\n");
  o.w("  var prev = vec4i(u.rows[%d]);\n  var c0 = vec4i(u.rows[%d]);\n  var c1 = vec4i(u.rows[%d]);\n  var c2 = vec4i(u.rows[%d]);\n",
      ROW_TEV_COLORS, ROW_TEV_COLORS + 1, ROW_TEV_COLORS + 2, ROW_TEV_COLORS + 3);
  for (int k = 0; k < 4; ++k) o.w("  let k%d = vec4i(u.rows[%d]);\n", k, ROW_KCOLORS + k);
  o.w("  let col0 = vec4i(round(i.colors_0 * 255.0));\n  let col1 = vec4i(round(i.colors_1 * 255.0));\n"
      "  var tex_t = vec4i(0);\n  var ras_t = vec4i(0);\n  var konst_t = vec4i(0);\n"
      "  var tin_a = vec4i(0);\n  var tin_b = vec4i(0);\n  var tin_c = vec4i(0);\n  var tin_d = vec4i(0);\n");
  RegState rs;
  for (int n = 0; n < stages; ++n) {
    const uint32_t cc = g.color_env(n), ac = g.alpha_env(n);
    const int cd = bits(cc, 0, 4), ccc = bits(cc, 4, 4), cb = bits(cc, 8, 4), ca = bits(cc, 12, 4);
    const int cbias = bits(cc, 16, 2), cop = bits(cc, 18, 1), cclamp = bits(cc, 19, 1), cshift = bits(cc, 20, 2), cdest = bits(cc, 22, 2);
    const int rswap = bits(ac, 0, 2), tswap = bits(ac, 2, 2);
    const int ad = bits(ac, 4, 3), acc = bits(ac, 7, 3), ab = bits(ac, 10, 3), aa = bits(ac, 13, 3);
    const int abias = bits(ac, 16, 2), aop = bits(ac, 18, 1), aclamp = bits(ac, 19, 1), ashift = bits(ac, 20, 2), adest = bits(ac, 22, 2);
    auto ccUses = [&](int v) { return ca == v || cb == v || ccc == v || cd == v; };
    auto acUses = [&](int v) { return aa == v || ab == v || acc == v || ad == v; };
    o.w("  // stage %d\n", n);
    if (ccUses(11) || ccUses(10) || acUses(5)) {
      const int ras = g.order_colorchan(n);
      if (ras < 2) o.w("  ras_t = %s.%s;\n", rasTable[ras], swizzle(g, rswap).c_str());
      else o.w("  ras_t = vec4i(0);\n");
      rs.overflow[10] = rs.overflow[11] = ras < 2;
    }
    o.w("  tex_t = tex_ta%d.%s;\n", n, swizzle(g, tswap).c_str());
    if (ccUses(14) || acUses(6)) {
      const int kc = g.ksel_kc(n), ka = g.ksel_ka(n);
      o.w("  konst_t = vec4i(%s, %s);\n", kselC[kc], kselA[ka]);
      rs.overflow[14] = kc > 11 || ka > 15;
    }
    auto in = [&](const char* name, int c, int a) {
      const bool chk = rs.overflow[c] || rs.overflow[aInputSource[a]];
      o.w("  %s = vec4i(%s, %s)%s;\n", name, cInput[c], aInput[a], chk ? " & vec4i(255)" : "");
    };
    in("tin_a", ca, aa);
    in("tin_b", cb, ab);
    in("tin_c", ccc, acc);
    const bool nrgb = ccc != 15 && cbias != 3, na = acc != 7 && abias != 3;
    if (nrgb && na) o.w("  tin_c = tin_c + (tin_c >> vec4u(7u));\n");
    else if (nrgb) o.w("  tin_c = vec4i(tin_c.rgb + (tin_c.rgb >> vec3u(7u)), tin_c.a);\n");
    else if (na) o.w("  tin_c.w = tin_c.a + (tin_c.a >> 7u);\n");
    o.w("  tin_d = vec4i(%s, %s);\n", cInput[cd], aInput[ad]);
    rs.overflow[cOutSource[cdest]] = !cclamp;
    rs.overflow[aOutSource[adest]] = !aclamp;
    o.w("  %s = vec4i(clamp(", cOut[cdest]);
    if (cbias != 3) tev_regular(o, false, cbias, cop, cshift, ca, cb, ccc, 15, 12);
    else tev_compare(o, false, (cshift << 1) | cop);
    o.w(cclamp ? ", vec3i(0), vec3i(255)), %s.a);\n" : ", vec3i(-1024), vec3i(1023)), %s.a);\n", cOut[cdest]);
    o.w("  %s.w = clamp(", cOut[adest]);
    if (abias != 3) tev_regular(o, true, abias, aop, ashift, aa, ab, acc, 7, 8);
    else tev_compare(o, true, (ashift << 1) | aop);
    o.w(aclamp ? ", 0, 255);\n" : ", -1024, 1023);\n");
  }
  const int lastC = bits(g.color_env(stages - 1), 22, 2), lastA = bits(g.alpha_env(stages - 1), 22, 2);
  if (lastC != 0) o.w("  prev = vec4i(%s.rgb, prev.a);\n", cOut[lastC]);
  if (lastA != 0) o.w("  prev.w = %s.a;\n", cOut[lastA]);
  if (rs.overflow[cOutSource[lastC]] || rs.overflow[aOutSource[lastA]]) o.w("  prev = prev & vec4i(255);\n");

  // ---- alpha test (AlphaTest::TestResult, then the comparison on the TEV's alpha) ------------------
  const uint32_t ops = uid.w[U_ALPHA_OPS];
  const uint32_t comp0 = ops & 7, comp1 = (ops >> 3) & 7, logic = ops >> 6;
  const bool a7 = comp0 == 7, b7 = comp1 == 7, a0 = comp0 == 0, b0 = comp1 == 0;
  const bool pass = (logic == 0 && a7 && b7) || (logic == 1 && (a7 || b7)) ||
                    (logic == 2 && ((a7 && b0) || (a0 && b7))) || (logic == 3 && ((a7 && b7) || (a0 && b0)));
  if (!pass) {
    const char* const funcs[] = {"false", "prev.a < %s", "prev.a == %s", "prev.a <= %s", "prev.a > %s", "prev.a != %s", "prev.a >= %s", "true"};
    const char* const logics[] = {" && ", " || ", " != ", " == "};
    o.w("  let alpharef = vec2i(u.rows[105].xy);\n  if (!((");
    o.w(funcs[comp0], "alpharef.x");
    o.w(")%s(", logics[logic]);
    o.w(funcs[comp1], "alpharef.y");
    o.w("))) { discard; }\n");
  }
  // ---- fog (gx_shader.cpp:599-614): the EFB depth is reversed, as upstream's -----------------------
  const uint32_t fog = uid.w[U_FOG];
  const uint32_t fsel = bits(fog, 21, 3), fproj = bits(fog, 20, 1);
  if (fsel != 0) {
    const int f = ROW_FOG;
    o.w("  let fogcolor = vec4i(u.rows[%d]);\n  let fogi = vec4i(u.rows[%d]);\n", f, f + 1);
    o.w("  let zCoord = clamp(i32(round((1.0 - i.pos.z) * 16777216.0)), 0, 16777215);\n");
    if (fproj == 0) o.w("  var ze = (u.rows[%d].x * 16777216.0) / f32(fogi.y - (zCoord >> u32(fogi.w)));\n", f + 3);
    else o.w("  var ze = u.rows[%d].x * (f32(zCoord) / 16777216.0);\n", f + 3);
    if (fog & 0x400) {
      o.w("  var x_adjust = (2.0 * (i.pos.x / u.rows[%d].y)) - 1.0 - u.rows[%d].x;\n", f + 2, f + 2);
      o.w("  x_adjust = sqrt(x_adjust * x_adjust + u.rows[%d].z * u.rows[%d].z) / u.rows[%d].z;\n  ze = ze * x_adjust;\n", f + 2, f + 2, f + 2);
    }
    o.w("  var fogv = clamp(ze - u.rows[%d].z, 0.0, 1.0);\n", f + 3);
    if (fsel == 4) o.w("  fogv = 1.0 - exp2(-8.0 * fogv);\n");
    if (fsel == 5) o.w("  fogv = 1.0 - exp2(-8.0 * fogv * fogv);\n");
    if (fsel == 6) o.w("  fogv = exp2(-8.0 * (1.0 - fogv));\n");
    if (fsel == 7) o.w("  fogv = 1.0 - fogv;\n  fogv = exp2(-8.0 * fogv * fogv);\n");
    o.w("  let ifog = i32(round(fogv * 256.0));\n");
    o.w("  prev = vec4i((prev.rgb * (256 - ifog) + fogcolor.rgb * ifog) >> vec3u(8u), prev.a);\n");
  }
  o.w("  return vec4f(prev) / 255.0;\n}\n");
  return o.s;
}

void fill_tev_rows(const gx::DrawCall& dc, float (*u)[4]) {
  const gx::BPMemory& bp = dc.bp;
  for (int i = 0; i < 4; ++i)
    for (int c = 0; c < 4; ++c) {
      u[ROW_TEV_COLORS + i][c] = float(dc.tev_colors[i][c]);
      u[ROW_KCOLORS + i][c] = float(dc.tev_kcolors[i][c]);
    }
  // Ambient 0/1 and material 0/1, RGBA from the high byte down (fill_vs_constants).
  for (int i = 0; i < 4; ++i) {
    const uint32_t v = dc.xf_regs[0x0A + i];
    for (int c = 0; c < 4; ++c) u[ROW_MATERIALS + i][c] = float((v >> (24 - 8 * c)) & 0xFF);
  }
  // Fog (fill_ps_constants), with an EFB scale of 1.
  const uint32_t fc = bp.fogcolor();
  float* fog = u[ROW_FOG];
  fog[0] = float((fc >> 16) & 0xFF); fog[1] = float((fc >> 8) & 0xFF); fog[2] = float(fc & 0xFF); fog[3] = 0;
  float* fogi = u[ROW_FOG + 1];
  fogi[0] = 0; fogi[1] = float(bp.fog_bmag() & 0xFFFFFF); fogi[2] = 0; fogi[3] = float(bp.fog_bshift() & 0x1F);
  // A and C are 11-bit-mantissa floats: mantissa 0-10, exponent 11-18, sign 19 (Dolphin's
  // FogParam0 / FogParam3). Upstream's f11 takes the sign from bit 20, which in FogParam3 is the
  // projection bit: C changes sign with the projection, and a negative A or C loses its sign.
  auto f11 = [](uint32_t v) {
    const uint32_t b = ((v >> 19) & 1) << 31 | ((v >> 11) & 0xFF) << 23 | (v & 0x7FF) << 12;
    float f; std::memcpy(&f, &b, 4); return f;
  };
  float* f0 = u[ROW_FOG + 2];
  float* f1 = u[ROW_FOG + 3];
  f1[0] = f11(bp.fogparam0()); f1[1] = 0; f1[2] = f11(bp.fogparam3()); f1[3] = 0;
  const float* vp = reinterpret_cast<const float*>(&dc.xf_regs[0x1A]);
  if (bits(bp.fogrange(0), 10, 1)) {
    const int center = int(bp.fogrange(0) & 0x3FF) - 342;
    float ssc = float(center) / (2.0f * vp[0]); ssc = ssc * 2.0f - 1.0f;
    f0[0] = ssc; f0[1] = 2.0f * vp[0]; f0[2] = float((bp.fogrange(5) >> 12) & 0xFFF) / 256.0f; f0[3] = 0;
  } else {
    f0[0] = 0; f0[1] = 1; f0[2] = 1; f0[3] = 0;
  }
  // Each texgen's post-transform matrix (XF 0x500 + 4 * index), three rows.
  const uint32_t ntex = dc.xf_regs[0x3F] & 15;
  for (uint32_t i = 0; i < ntex && i < 8; ++i) {
    const uint32_t post = dc.xf_regs[0x50 + i] & 0x3F;
    for (uint32_t k = 0; k < 3; ++k) std::memcpy(u[ROW_TEXGEN + 3 * i + k], dc.postMatrices + 4 * ((post + k) & 63), 16);
  }
}

}  // namespace gxw

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
//   - Colour channels (gen_lighting and gen_light, gx_shader.cpp:70-153): the material colour from the
//     vertex or from the XF register, per channel and separately for alpha, times the light
//     accumulator: the ambient colour plus each light in the channel's mask, with its attenuation
//     (none, spot or specular) and diffuse function, on the vertex normal through the normal matrix.
//
// What is not, and what happens instead (each is stated where it is generated):
//   - Indirect texturing (no draw in the measured menu and match frames uses an indirect stage), and
//     the texture coordinate scale registers (SU_SSIZE): coordinates are sampled normalised, which is
//     what GX does when it sets that scale to the texture's size itself.
//   - Z textures (ZTEX), the zfreeze slope and dither.
#include "gx_wgsl.h"
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <tuple>
#include <utility>

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
  // The channel controls the colour channels read (upstream's lighting_uid): the material source,
  // and for a lit channel its ambient source, lights, diffuse and attenuation functions too.
  for (uint32_t j = 0; j < nchan && j < 2; ++j) {
    const uint32_t color = dc.xf_regs[0x0E + j], alpha = dc.xf_regs[0x10 + j];
    u.w[U_CHANS + j] = color & 2 ? color & 0x7FFF : color & 1;
    u.w[U_CHANS + 2 + j] = alpha & 2 ? alpha & 0x7FFF : alpha & 1;
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

namespace {
// Whether a colour channel the draw uses has lighting enabled (bit 1 of a channel control).
bool lit(const ShaderUid& uid) {
  bool any = false;
  for (uint32_t j = 0; j < uid.w[U_NUMCHANS] && j < 2; ++j) any = any || ((uid.w[U_CHANS + j] | uid.w[U_CHANS + 2 + j]) & 2);
  return any;
}

// gen_light (gx_shader.cpp:70-100), the attenuation and diffuse functions of a channel resolved when
// the shader is generated: the factor light `i`'s colour is scaled by before it is rounded into the
// accumulator, from the vertex position `p` and its normal `n0`.
std::string light_factor(int i, uint32_t attn_fn, uint32_t diffuse_fn) {
  const int l = ROW_LIGHTS + 5 * i;
  Code o;
  o.w("    var ldir = u.rows[%d].xyz - p.xyz;\n    var attn = 1.0;\n", l + 3);
  if (attn_fn == 1) {
    o.w("    ldir = normalize(ldir);\n"
        "    attn = select(0.0, max(0.0, dot(n0, u.rows[%d].xyz)), dot(n0, ldir) >= 0.0);\n"
        "    let q = vec3f(1.0, attn, attn * attn);\n", l + 4);
    if (diffuse_fn != 0) o.w("    attn = max(0.0, dot(u.rows[%d].xyz, q)) / dot(normalize(u.rows[%d].xyz), q);\n", l + 1, l + 2);
    else o.w("    attn = max(0.0, dot(u.rows[%d].xyz, q)) / dot(u.rows[%d].xyz, q);\n", l + 1, l + 2);
  } else if (attn_fn == 3) {
    o.w("    let dist2 = dot(ldir, ldir);\n    let dist = sqrt(dist2);\n    ldir = ldir / dist;\n"
        "    attn = max(0.0, dot(ldir, u.rows[%d].xyz));\n"
        "    attn = max(0.0, dot(u.rows[%d].xyz, vec3f(1.0, attn, attn * attn))) / dot(u.rows[%d].xyz, vec3f(1.0, dist, dist2));\n",
        l + 4, l + 1, l + 2);
  } else {
    o.w("    ldir = normalize(ldir);\n    if (length(ldir) == 0.0) { ldir = n0; }\n");
  }
  if (diffuse_fn == 0) o.w("    let factor = attn;\n");
  else if (diffuse_fn == 1) o.w("    let factor = attn * dot(ldir, n0);\n");
  else o.w("    let factor = attn * max(0.0, dot(ldir, n0));\n");
  return o.s;
}

// The light mask of a channel control: lights 0-3 in bits 2-5, 4-7 in bits 11-14.
uint32_t light_mask(uint32_t control) { return ((control >> 2) & 15) | (((control >> 11) & 15) << 4); }
}  // namespace

// A lit draw reads the light rows, which come last of a generated shader's (the uid rows after them
// are the one shader's).
int uniform_rows(const ShaderUid& uid) { return lit(uid) ? ROW_UID : ROW_TEXGEN + 3 * int(uid.w[U_NUMTEXGENS]); }

std::string generate_wgsl(const ShaderUid& uid) {
  const Uid g{uid};
  const uint32_t components = uid.w[U_COMPONENTS], nchan = uid.w[U_NUMCHANS];
  const uint32_t ntex = uid.w[U_NUMTEXGENS];
  const bool dual = uid.w[U_DUALTEX];
  const int stages = int(uid.w[U_STAGES]);
  const bool lighting = lit(uid);
  Code o;
  o.w("struct Constants { rows: array<vec4f, %d> }\n@group(0) @binding(0) var<uniform> u: Constants;\n", lighting ? ROW_UID : ROW_LIGHTS);
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
  // ---- vertex: colour channels (gen_lighting) -------------------------------------------------------
  if (nchan == 0) {
    o.w("  o.colors_0 = %s;\n", components & gx::VB_HAS_COL0 ? "color0" : "vec4f(1.0)");
    o.w("  o.colors_1 = %s;\n", components & gx::VB_HAS_COL1 ? "color1" : "o.colors_0");
  } else {
    o.w("  var mtl = vec4f(0.0);\n");
    if (lighting) {
      // The normal through the normal matrix of the position matrix (Dolphin: index & 31).
      o.w("  var lacc = vec4f(255.0);\n  let ni = select(m, m - 32u, m >= 32u);\n");
      if (components & gx::VB_HAS_NRM0)
        o.w("  let n0 = normalize(vec3f(dot(u.rows[70u + ni].xyz, normal), dot(u.rows[71u + ni].xyz, normal), dot(u.rows[72u + ni].xyz, normal)));\n");
      else o.w("  let n0 = vec3f(0.0);\n");
    }
    for (uint32_t j = 0; j < nchan && j < 2; ++j) {
      const uint32_t color = uid.w[U_CHANS + j], alpha = uid.w[U_CHANS + 2 + j];
      const bool color_vertex = color & 1, alpha_vertex = alpha & 1;
      if (color_vertex) vertex_colour(o, components, int(j), false, "  mtl");
      else o.w("  mtl = u.rows[%d];\n", ROW_MATERIALS + 2 + int(j));
      if (alpha_vertex != color_vertex) {
        if (alpha_vertex) vertex_colour(o, components, int(j), true, "  mtl.w");
        else o.w("  mtl.w = u.rows[%d].a;\n", ROW_MATERIALS + 2 + int(j));
      }
      if (!((color | alpha) & 2)) {
        // Lighting disabled: the light accumulator is 255, and (mtl * 256) >> 8 is the material.
        o.w("  o.colors_%u = mtl / 255.0;\n", j);
        continue;
      }
      // The accumulator starts at the ambient colour (from the vertex or the XF register) of a lit
      // channel, 255 for an unlit one; each light in the mask adds its rounded contribution.
      if (color & 2) {
        if (color & 64) vertex_colour(o, components, int(j), false, "  lacc");
        else o.w("  lacc = u.rows[%d];\n", ROW_MATERIALS + int(j));
      } else o.w("  lacc = vec4f(255.0);\n");
      if (alpha & 2) {
        if (alpha & 64) vertex_colour(o, components, int(j), true, "  lacc.w");
        else o.w("  lacc.w = u.rows[%d].a;\n", ROW_MATERIALS + int(j));
      } else o.w("  lacc.w = 255.0;\n");
      for (int i = 0; i < 8; ++i) {
        if ((color & 2) && (light_mask(color) & (1u << i)))
          o.w("  {\n%s    lacc = vec4f(lacc.rgb + round(factor * u.rows[%d].rgb), lacc.a);\n  }\n",
              light_factor(i, (color >> 9) & 3, (color >> 7) & 3).c_str(), ROW_LIGHTS + 5 * i);
        if ((alpha & 2) && (light_mask(alpha) & (1u << i)))
          o.w("  {\n%s    lacc.w = lacc.w + round(factor * u.rows[%d].a);\n  }\n",
              light_factor(i, (alpha >> 9) & 3, (alpha >> 7) & 3).c_str(), ROW_LIGHTS + 5 * i);
      }
      o.w("  { let il = clamp(vec4i(lacc), vec4i(0), vec4i(255));\n"
          "    o.colors_%u = vec4f((vec4i(mtl) * (il + (il >> vec4u(7u)))) >> vec4u(8u)) / 255.0; }\n", j);
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

// ---- the one shader ---------------------------------------------------------------------------------
//
// generate_wgsl, with every decision it takes from the uid taken at run time from the uid's words in
// uniform rows 186-204 instead. Why: WebKit compiles every new WGSL text to a Metal library inside
// the GPU process, synchronously, ~450 ms each on the operator's iPhone, and the next
// transferToImageBitmap waits for it (docs/PROGRESS.md); a new pipeline whose WGSL text was seen
// before costs ~1-8 ms. With one text the game's 72-122 distinct shaders are one compile, made when
// the backend attaches. This is what Dolphin's ubershaders are for.
//
// The arithmetic is generate_wgsl's, step for step, and wasm/render/pixel_pipeline_check.mjs renders
// the same pseudo-random states through both and requires identical pixels. Where generate_wgsl
// specialises, this one computes the general form, which is the same integer:
//   - a lerp's special forms (a == b, c == 0, c == 255, a == 0, b == 0) are the general
//     a * 256 + (b - a) * c with those values;
//   - an input is always masked to 8 bits (CHK_O_U8). generate_wgsl masks only the inputs whose
//     register may be outside 0-255 (RegState); every other one is within 0-255, where the mask is
//     the identity. The same holds for the final PREV;
//   - the alpha test is always evaluated; the states generate_wgsl omits it for always pass.
std::string generate_uber_wgsl() {
  Code o;
  o.w("struct Constants { rows: array<vec4f, %d> }\n@group(0) @binding(0) var<uniform> u: Constants;\n", MAX_ROWS);
  for (int n = 0; n < 8; ++n)
    o.w("@group(0) @binding(%d) var tex%d: texture_2d<f32>;\n@group(0) @binding(%d) var samp%d: sampler;\n", 1 + 2 * n, n, 2 + 2 * n, n);
  std::string s = o.s + R"WGSL(struct Out {
  @builtin(position) pos: vec4f,
  @location(0) clip: vec4f,
  @location(1) colors_0: vec4f,
  @location(2) colors_1: vec4f,
  @location(3) tex0: vec3f, @location(4) tex1: vec3f, @location(5) tex2: vec3f, @location(6) tex3: vec3f,
  @location(7) tex4: vec3f, @location(8) tex5: vec3f, @location(9) tex6: vec3f, @location(10) tex7: vec3f,
}
// Word k of the draw's ShaderUid (fill_uid_rows).
fn uid(k: u32) -> u32 { return u32(u.rows[$ROW_UID + k / 4u][k % 4u]); }
fn bitfield(v: u32, lo: u32, n: u32) -> u32 { return (v >> lo) & ((1u << n) - 1u); }

// gen_lighting's `matsource` branch: the vertex's colour j, else colour 0, else white.
fn vertex_colour(components: u32, j: u32, color0: vec4f, color1: vec4f) -> vec4f {
  if ((components & ($COL0 << j)) != 0u) { return round(select(color0, color1, j == 1u) * 255.0); }
  if ((components & $COL0) != 0u) { return round(color0 * 255.0); }
  return vec4f(255.0);
}

// The light mask of a channel control: lights 0-3 in bits 2-5, 4-7 in bits 11-14.
fn light_mask(control: u32) -> u32 { return bitfield(control, 2u, 4u) | (bitfield(control, 11u, 4u) << 4u); }

// gen_light (gx_shader.cpp:70-100), generate_wgsl's light_factor with the channel control's
// attenuation (bits 9-10) and diffuse (bits 7-8) functions read at run time: the factor the light
// at rows `l` to `l + 4` scales its colour by, from the vertex position `p` and its normal `n0`.
fn light_factor(l: u32, control: u32, p: vec4f, n0: vec3f) -> f32 {
  let attn_fn = bitfield(control, 9u, 2u);
  let diffuse_fn = bitfield(control, 7u, 2u);
  var ldir = u.rows[l + 3u].xyz - p.xyz;
  var attn = 1.0;
  if (attn_fn == 1u) {
    ldir = normalize(ldir);
    attn = select(0.0, max(0.0, dot(n0, u.rows[l + 4u].xyz)), dot(n0, ldir) >= 0.0);
    let q = vec3f(1.0, attn, attn * attn);
    if (diffuse_fn != 0u) { attn = max(0.0, dot(u.rows[l + 1u].xyz, q)) / dot(normalize(u.rows[l + 2u].xyz), q); }
    else { attn = max(0.0, dot(u.rows[l + 1u].xyz, q)) / dot(u.rows[l + 2u].xyz, q); }
  } else if (attn_fn == 3u) {
    let dist2 = dot(ldir, ldir);
    let dist = sqrt(dist2);
    ldir = ldir / dist;
    attn = max(0.0, dot(ldir, u.rows[l + 4u].xyz));
    attn = max(0.0, dot(u.rows[l + 1u].xyz, vec3f(1.0, attn, attn * attn))) / dot(u.rows[l + 2u].xyz, vec3f(1.0, dist, dist2));
  } else {
    ldir = normalize(ldir);
    if (length(ldir) == 0.0) { ldir = n0; }
  }
  var factor = attn;
  if (diffuse_fn == 1u) { factor = attn * dot(ldir, n0); }
  if (diffuse_fn >= 2u) { factor = attn * max(0.0, dot(ldir, n0)); }
  return factor;
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) color0: vec4f, @location(3) color1: vec4f,
  @location(4) rawtex0: vec2f, @location(5) rawtex1: vec2f, @location(6) rawtex2: vec2f, @location(7) rawtex3: vec2f,
  @location(8) rawtex4: vec2f, @location(9) rawtex5: vec2f, @location(10) rawtex6: vec2f, @location(11) rawtex7: vec2f,
  @location(12) indices: vec4u, @location(13) indices2: vec4u, @location(14) indices3: vec4u) -> Out {
  let m = indices.x;
  let raw = vec4f(position, 1.0);
  let p = vec4f(dot(u.rows[6u + m], raw), dot(u.rows[7u + m], raw), dot(u.rows[8u + m], raw), 1.0);
  var clip = vec4f(dot(u.rows[0], p), dot(u.rows[1], p), dot(u.rows[2], p), dot(u.rows[3], p));
  clip.z = -clip.z;
  clip.z = clip.z * (1.0 - 1e-7);
  clip = vec4f(clip.xy * sign(u.rows[4].zw * vec2f(-1.0, 1.0)) + clip.w * u.rows[4].zw, clip.zw);
  if (clip.w == 1.0) { clip = vec4f(round(clip.xy * u.rows[5].xy) * u.rows[5].zw, clip.zw); }
  var o: Out;
  o.clip = clip;
  o.pos = vec4f(clip.xy * u.rows[102].xy + clip.w * u.rows[102].zw, clip.zw);
  // Colour channels (gen_lighting). A channel control is its bit 0 alone when unlit, else every bit
  // the light accumulator reads (make_uid).
  let components = uid($U_COMPONENTS);
  let nchan = uid($U_NUMCHANS);
  if (nchan == 0u) {
    o.colors_0 = select(vec4f(1.0), color0, (components & $COL0) != 0u);
    o.colors_1 = select(o.colors_0, color1, (components & $COL1) != 0u);
  } else {
    // The normal through the normal matrix of the position matrix (Dolphin: index & 31).
    let ni = select(m, m - 32u, m >= 32u);
    var n0 = vec3f(0.0);
    if ((components & $NRM0) != 0u) {
      n0 = normalize(vec3f(dot(u.rows[70u + ni].xyz, normal), dot(u.rows[71u + ni].xyz, normal), dot(u.rows[72u + ni].xyz, normal)));
    }
    var colors = array<vec4f, 2>(vec4f(0.0), vec4f(0.0));
    for (var j = 0u; j < min(nchan, 2u); j++) {
      let color = uid($U_CHANS + j);
      let alpha = uid($U_CHANS + 2u + j);
      let color_vertex = (color & 1u) != 0u;
      let alpha_vertex = (alpha & 1u) != 0u;
      let material = u.rows[$ROW_MATERIALS + 2u + j];
      let vcolor = vertex_colour(components, j, color0, color1);
      var mtl = select(material, vcolor, color_vertex);
      if (alpha_vertex != color_vertex) { mtl.w = select(material.a, vcolor.w, alpha_vertex); }
      // Lighting disabled: the light accumulator is 255, and (mtl * 256) >> 8 is the material.
      if (((color | alpha) & 2u) == 0u) { colors[j] = mtl / 255.0; continue; }
      // The accumulator starts at the ambient colour (from the vertex or the XF register) of a lit
      // channel, 255 for an unlit one; each light in the mask adds its rounded contribution.
      let ambient = u.rows[$ROW_MATERIALS + j];
      var lacc = vec4f(255.0);
      if ((color & 2u) != 0u) { lacc = select(ambient, vcolor, (color & 64u) != 0u); }
      lacc.w = 255.0;
      if ((alpha & 2u) != 0u) { lacc.w = select(ambient.a, vcolor.w, (alpha & 64u) != 0u); }
      let color_lights = select(0u, light_mask(color), (color & 2u) != 0u);
      let alpha_lights = select(0u, light_mask(alpha), (alpha & 2u) != 0u);
      for (var i = 0u; i < 8u; i++) {
        let lrow = $ROW_LIGHTS + 5u * i;
        if ((color_lights & (1u << i)) != 0u) {
          lacc = vec4f(lacc.rgb + round(light_factor(lrow, color, p, n0) * u.rows[lrow].rgb), lacc.a);
        }
        if ((alpha_lights & (1u << i)) != 0u) {
          lacc.w = lacc.w + round(light_factor(lrow, alpha, p, n0) * u.rows[lrow].a);
        }
      }
      let il = clamp(vec4i(lacc), vec4i(0), vec4i(255));
      colors[j] = vec4f((vec4i(mtl) * (il + (il >> vec4u(7u)))) >> vec4u(8u)) / 255.0;
    }
    o.colors_0 = colors[0];
    o.colors_1 = select(select(o.colors_0, color1, (components & $COL1) != 0u), colors[1], nchan >= 2u);
  }
  // Texture coordinate generation.
  let ntex = min(uid($U_NUMTEXGENS), 8u);
  let dual = uid($U_DUALTEX) != 0u;
  var rawtex = array<vec2f, 8>(rawtex0, rawtex1, rawtex2, rawtex3, rawtex4, rawtex5, rawtex6, rawtex7);
  var tm_index = array<u32, 8>(indices.y, indices.z, indices.w, indices2.x, indices2.y, indices2.z, indices2.w, indices3.x);
  var tc = array<vec3f, 8>();
  for (var i = 0u; i < ntex; i++) {
    let info = uid($U_TEXGEN + i);
    let src_row = bitfield(info, 7u, 5u);
    let kind = bitfield(info, 4u, 3u);
    let projection = bitfield(info, 1u, 1u) != 0u;
    var coord = vec4f(0.0, 0.0, 1.0, 1.0);
    if (src_row == 0u) { coord = vec4f(position, 1.0); }
    else if (src_row == 1u) { if ((components & $NRM0) != 0u) { coord = vec4f(normal, 1.0); } }
    else if (src_row >= 5u && src_row <= 12u && (components & ($UV0 << (src_row - 5u))) != 0u) { coord = vec4f(rawtex[src_row - 5u], 1.0, 1.0); }
    if (bitfield(info, 2u, 1u) == 0u) { coord.z = 1.0; }
    var t: vec3f;
    if (kind == 1u) { t = vec3f(coord.xy, 1.0); }
    else if (kind == 2u) { t = vec3f(o.colors_0.x, o.colors_0.y, 1.0); }
    else if (kind == 3u) { t = vec3f(o.colors_1.x, o.colors_1.y, 1.0); }
    else {
      let tm = tm_index[i];
      t = vec3f(dot(coord, u.rows[6u + tm]), dot(coord, u.rows[7u + tm]), 1.0);
      if (projection) { t.z = dot(coord, u.rows[8u + tm]); }
    }
    if (kind == 0u) {
      if (projection && t.z == 0.0) { t = vec3f(clamp(t.xy, vec2f(-2.0), vec2f(2.0)), t.z); }
      if (dual) {
        let r = $ROW_TEXGEN + 3u * i;
        if ((uid($U_POSTINFO + i) & 0x100u) != 0u) { t = normalize(t); }
        t = vec3f(dot(u.rows[r].xyz, t) + u.rows[r].w, dot(u.rows[r + 1u].xyz, t) + u.rows[r + 1u].w, dot(u.rows[r + 2u].xyz, t) + u.rows[r + 2u].w);
      }
    }
    tc[i] = t;
  }
  o.tex0 = tc[0]; o.tex1 = tc[1]; o.tex2 = tc[2]; o.tex3 = tc[3];
  o.tex4 = tc[4]; o.tex5 = tc[5]; o.tex6 = tc[6]; o.tex7 = tc[7];
  return o;
}

fn sample_map(tmap: u32, uv: vec2f, bias: f32) -> vec4f {
  var s: vec4f;
  switch tmap {
    case 0u: { s = textureSampleBias(tex0, samp0, uv, bias); }
    case 1u: { s = textureSampleBias(tex1, samp1, uv, bias); }
    case 2u: { s = textureSampleBias(tex2, samp2, uv, bias); }
    case 3u: { s = textureSampleBias(tex3, samp3, uv, bias); }
    case 4u: { s = textureSampleBias(tex4, samp4, uv, bias); }
    case 5u: { s = textureSampleBias(tex5, samp5, uv, bias); }
    case 6u: { s = textureSampleBias(tex6, samp6, uv, bias); }
    default: { s = textureSampleBias(tex7, samp7, uv, bias); }
  }
  return s;
}

// The TEV's registers PREV, C0, C1, C2 and K0-K3, and the current stage's texture, ras and konst
// colours. Separate variables and select chains, not arrays: an array indexed at run time is
// scratch memory on a GPU (and on SwiftShader), and the TEV indexes them in every stage.
var<private> r0: vec4i;
var<private> r1: vec4i;
var<private> r2: vec4i;
var<private> r3: vec4i;
var<private> k0: vec4i;
var<private> k1: vec4i;
var<private> k2: vec4i;
var<private> k3: vec4i;
var<private> tex_t: vec4i;
var<private> ras_t: vec4i;
var<private> konst_t: vec4i;

fn reg(i: u32) -> vec4i { return select(select(r3, r2, i == 2u), select(r1, r0, i == 0u), i < 2u); }
fn kreg(i: u32) -> vec4i { return select(select(k3, k2, i == 2u), select(k1, k0, i == 0u), i < 2u); }
fn set_rgb(i: u32, v: vec3i) {
  if (i == 0u) { r0 = vec4i(v, r0.a); } else if (i == 1u) { r1 = vec4i(v, r1.a); }
  else if (i == 2u) { r2 = vec4i(v, r2.a); } else { r3 = vec4i(v, r3.a); }
}
fn set_alpha(i: u32, v: i32) {
  if (i == 0u) { r0.w = v; } else if (i == 1u) { r1.w = v; } else if (i == 2u) { r2.w = v; } else { r3.w = v; }
}
// A swap table (ksel registers 2 * table and 2 * table + 1).
fn swap_table(v: vec4i, table: u32) -> vec4i {
  let a = uid($U_KSEL + 2u * table);
  let b = uid($U_KSEL + 2u * table + 1u);
  return vec4i(v[a & 3u], v[(a >> 2u) & 3u], v[b & 3u], v[(b >> 2u) & 3u]);
}
// kselC / kselA. Selections 0-7 are 255, 223, 191, 159, 128, 96, 64, 32.
fn konst_value(k: u32) -> i32 { return select(256, 255, k < 4u) - 32 * i32(k); }
fn konst_color(kc: u32) -> vec3i {
  if (kc < 8u) { return vec3i(konst_value(kc)); }
  if (kc < 12u) { return vec3i(0); }
  if (kc < 16u) { return kreg(kc - 12u).rgb; }
  return vec3i(kreg((kc - 16u) % 4u)[(kc - 16u) / 4u]);
}
fn konst_alpha(ka: u32) -> i32 {
  if (ka < 8u) { return konst_value(ka); }
  if (ka < 16u) { return 0; }
  return kreg((ka - 16u) % 4u)[(ka - 16u) / 4u];
}
// cInput / aInput.
fn color_in(i: u32) -> vec3i {
  var r = vec3i(0);
  if (i < 8u) { let v = reg(i >> 1u); r = select(v.rgb, vec3i(v.a), (i & 1u) != 0u); }
  else if (i == 8u) { r = tex_t.rgb; }
  else if (i == 9u) { r = vec3i(tex_t.a); }
  else if (i == 10u) { r = ras_t.rgb; }
  else if (i == 11u) { r = vec3i(ras_t.a); }
  else if (i == 12u) { r = vec3i(255); }
  else if (i == 13u) { r = vec3i(128); }
  else if (i == 14u) { r = konst_t.rgb; }
  return r;
}
fn alpha_in(i: u32) -> i32 {
  var r = 0;
  if (i < 4u) { r = reg(i).a; }
  else if (i == 4u) { r = tex_t.a; }
  else if (i == 5u) { r = ras_t.a; }
  else if (i == 6u) { r = konst_t.a; }
  return r;
}
// write_tev_regular's tables: the scale (1, 2, 4, 1/2 by the final shift), the bias (0, +128, -128),
// and the lerp's rounding lerpBias[2 * op + ((shift == 3) == alpha)]: 0, +128, 0, +127.
fn tev_scale(shift: u32) -> i32 { return select(1, 1 << shift, shift < 3u); }
fn tev_bias(bias: u32) -> i32 { return select(select(0, -128, bias == 2u), 128, bias == 1u); }
fn tev_round(op: u32, shift: u32, alpha: bool) -> i32 {
  return select(0, select(128, 127, op == 1u), (shift == 3u) == alpha);
}
fn regular_color(a: vec3i, b: vec3i, c: vec3i, d: vec3i, bias: u32, op: u32, shift: u32) -> vec3i {
  let s = tev_scale(shift);
  let lerped = ((a * 256 + (b - a) * c) * s + tev_round(op, shift, false)) >> vec3u(8u);
  let base = (d + tev_bias(bias)) * s;
  var r = select(base + lerped, base - lerped, op == 1u);
  if (shift == 3u) { r = r >> vec3u(1u); }
  return r;
}
fn regular_alpha(a: i32, b: i32, c: i32, d: i32, bias: u32, op: u32, shift: u32) -> i32 {
  let s = tev_scale(shift);
  let lerped = ((a * 256 + (b - a) * c) * s + tev_round(op, shift, true)) >> 8u;
  let base = (d + tev_bias(bias)) * s;
  var r = select(base + lerped, base - lerped, op == 1u);
  if (shift == 3u) { r = r >> 1u; }
  return r;
}
// write_tev_compare: R8, GR16, BGR24 (on the colour inputs, for either combiner), else per component.
fn compare_wide(cmp: u32, a: vec3i, b: vec3i) -> bool {
  let k = select(select(vec3i(1, 0, 0), vec3i(1, 256, 0), cmp >= 2u), vec3i(1, 256, 65536), cmp >= 4u);
  return select(dot(a, k) > dot(b, k), dot(a, k) == dot(b, k), (cmp & 1u) != 0u);
}
fn compare_color(cmp: u32, a: vec4i, b: vec4i, c: vec4i, d: vec4i) -> vec3i {
  if (cmp < 6u) { return d.rgb + select(vec3i(0), c.rgb, compare_wide(cmp, a.rgb, b.rgb)); }
  return d.rgb + select(vec3i(0), c.rgb, select(a.rgb > b.rgb, a.rgb == b.rgb, cmp == 7u));
}
fn compare_alpha(cmp: u32, a: vec4i, b: vec4i, c: vec4i, d: vec4i) -> i32 {
  if (cmp < 6u) { return d.a + select(0, c.a, compare_wide(cmp, a.rgb, b.rgb)); }
  return d.a + select(0, c.a, select(a.a > b.a, a.a == b.a, cmp == 7u));
}
// GX compare functions: bit 0 less, bit 1 equal, bit 2 greater (NEVER 0 ... ALWAYS 7).
fn alpha_compare(f: u32, a: i32, r: i32) -> bool {
  return ((f & 1u) != 0u && a < r) || ((f & 2u) != 0u && a == r) || ((f & 4u) != 0u && a > r);
}

@fragment fn fs(i: Out) -> @location(0) vec4f {
  let ntex = uid($U_NUMTEXGENS);
  let stages = uid($U_STAGES);
  r0 = vec4i(u.rows[$ROW_TEV_COLORS]); r1 = vec4i(u.rows[$ROW_TEV_COLORS + 1]);
  r2 = vec4i(u.rows[$ROW_TEV_COLORS + 2]); r3 = vec4i(u.rows[$ROW_TEV_COLORS + 3]);
  k0 = vec4i(u.rows[$ROW_KCOLORS]); k1 = vec4i(u.rows[$ROW_KCOLORS + 1]);
  k2 = vec4i(u.rows[$ROW_KCOLORS + 2]); k3 = vec4i(u.rows[$ROW_KCOLORS + 3]);
  let col0 = vec4i(round(i.colors_0 * 255.0));
  let col1 = vec4i(round(i.colors_1 * 255.0));
  // Each stage samples its texture in the stage, in uniform control flow; the clip test's discard
  // comes after the last stage, so that no sample follows a discard.
)WGSL";
  // Emit the GX maximum once, with a uniform guard for each stage. The old WGSL for-loop
  // was finite (make_uid supplies 1..16). Avoid its back edge on the stalled CI SwiftShader
  // path, keeping the arithmetic and runtime state. See docs/LIT_TEV_FLOW.md for evidence.
  // This expansion is independent of the draw uid: still one shader compiled at attach.
  for (unsigned stage = 0; stage < 16; ++stage) {
    s += "  if (stages > " + std::to_string(stage) + "u) {\n    let n = " + std::to_string(stage) + "u;\n";
    s += R"WGSL(    let cc = uid($U_COLOR_ENV + n);
    let ac = uid($U_ALPHA_ENV + n);
    let tref = uid($U_TREF + n / 2u);
    let odd = (n & 1u) != 0u;
    let cd = bitfield(cc, 0u, 4u); let ccc = bitfield(cc, 4u, 4u); let cb = bitfield(cc, 8u, 4u); let ca = bitfield(cc, 12u, 4u);
    let cbias = bitfield(cc, 16u, 2u); let cop = bitfield(cc, 18u, 1u); let cclamp = bitfield(cc, 19u, 1u);
    let cshift = bitfield(cc, 20u, 2u); let cdest = bitfield(cc, 22u, 2u);
    let ad = bitfield(ac, 4u, 3u); let acc = bitfield(ac, 7u, 3u); let ab = bitfield(ac, 10u, 3u); let aa = bitfield(ac, 13u, 3u);
    let abias = bitfield(ac, 16u, 2u); let aop = bitfield(ac, 18u, 1u); let aclamp = bitfield(ac, 19u, 1u);
    let ashift = bitfield(ac, 20u, 2u); let adest = bitfield(ac, 22u, 2u);
    var texel = vec4i(255);
    let uses_tex = ca == 8u || cb == 8u || ccc == 8u || cd == 8u || ca == 9u || cb == 9u || ccc == 9u || cd == 9u ||
                   aa == 4u || ab == 4u || acc == 4u || ad == 4u;
    if (bitfield(tref, select(6u, 18u, odd), 1u) != 0u && uses_tex) {
      let coord = bitfield(tref, select(3u, 15u, odd), 3u);
      let tmap = bitfield(tref, select(0u, 12u, odd), 3u);
      var uv = vec2f(0.0);
      if (coord < ntex) {
        var t = i.tex0;
        if (coord == 1u) { t = i.tex1; } else if (coord == 2u) { t = i.tex2; } else if (coord == 3u) { t = i.tex3; }
        else if (coord == 4u) { t = i.tex4; } else if (coord == 5u) { t = i.tex5; } else if (coord == 6u) { t = i.tex6; }
        else if (coord == 7u) { t = i.tex7; }
        uv = t.xy / select(t.z, 2.0, t.z == 0.0);
      }
      texel = vec4i(round(sample_map(tmap, uv, u.rows[103u + tmap / 4u][tmap % 4u]) * 255.0));
    }
    if (ca == 10u || cb == 10u || ccc == 10u || cd == 10u || ca == 11u || cb == 11u || ccc == 11u || cd == 11u ||
        aa == 5u || ab == 5u || acc == 5u || ad == 5u) {
      let chan = bitfield(tref, select(7u, 19u, odd), 3u);
      ras_t = vec4i(0);
      if (chan == 0u) { ras_t = swap_table(col0, bitfield(ac, 0u, 2u)); }
      if (chan == 1u) { ras_t = swap_table(col1, bitfield(ac, 0u, 2u)); }
    }
    tex_t = swap_table(texel, bitfield(ac, 2u, 2u));
    if (ca == 14u || cb == 14u || ccc == 14u || cd == 14u || aa == 6u || ab == 6u || acc == 6u || ad == 6u) {
      let ksel = uid($U_KSEL + n / 2u);
      konst_t = vec4i(konst_color(bitfield(ksel, select(4u, 14u, odd), 5u)), konst_alpha(bitfield(ksel, select(9u, 19u, odd), 5u)));
    }
    let tin_a = vec4i(color_in(ca), alpha_in(aa)) & vec4i(255);
    let tin_b = vec4i(color_in(cb), alpha_in(ab)) & vec4i(255);
    var tin_c = vec4i(color_in(ccc), alpha_in(acc)) & vec4i(255);
    if (ccc != 15u && cbias != 3u) { tin_c = vec4i(tin_c.rgb + (tin_c.rgb >> vec3u(7u)), tin_c.a); }
    if (acc != 7u && abias != 3u) { tin_c.w = tin_c.a + (tin_c.a >> 7u); }
    let tin_d = vec4i(color_in(cd), alpha_in(ad));
    var c: vec3i;
    if (cbias != 3u) { c = regular_color(tin_a.rgb, tin_b.rgb, tin_c.rgb, tin_d.rgb, cbias, cop, cshift); }
    else { c = compare_color((cshift << 1u) | cop, tin_a, tin_b, tin_c, tin_d); }
    var a: i32;
    if (abias != 3u) { a = regular_alpha(tin_a.a, tin_b.a, tin_c.a, tin_d.a, abias, aop, ashift); }
    else { a = compare_alpha((ashift << 1u) | aop, tin_a, tin_b, tin_c, tin_d); }
    if (cclamp != 0u) { c = clamp(c, vec3i(0), vec3i(255)); } else { c = clamp(c, vec3i(-1024), vec3i(1023)); }
    if (aclamp != 0u) { a = clamp(a, 0, 255); } else { a = clamp(a, -1024, 1023); }
    set_rgb(cdest, c);
    set_alpha(adest, a);
  }
)WGSL";
  }
  s += R"WGSL(  if (any(abs(i.clip.xy) > vec2f(i.clip.w))) { discard; }
  var prev = r0;
  let last_c = bitfield(uid($U_COLOR_ENV + stages - 1u), 22u, 2u);
  let last_a = bitfield(uid($U_ALPHA_ENV + stages - 1u), 22u, 2u);
  prev = vec4i(reg(last_c).rgb, reg(last_a).a) & vec4i(255);
  // Alpha test.
  let ops = uid($U_ALPHA_OPS);
  let alpharef = vec2i(u.rows[105].xy);
  let pass0 = alpha_compare(ops & 7u, prev.a, alpharef.x);
  let pass1 = alpha_compare((ops >> 3u) & 7u, prev.a, alpharef.y);
  let logic = ops >> 6u;
  var passed = pass0 == pass1;
  if (logic == 0u) { passed = pass0 && pass1; }
  if (logic == 1u) { passed = pass0 || pass1; }
  if (logic == 2u) { passed = pass0 != pass1; }
  if (!passed) { discard; }
  // Fog: the EFB depth is reversed, as upstream's.
  let fog = uid($U_FOG);
  let fsel = bitfield(fog, 21u, 3u);
  if (fsel != 0u) {
    let fogcolor = vec4i(u.rows[$ROW_FOG]);
    let fogi = vec4i(u.rows[$ROW_FOG + 1]);
    let zCoord = clamp(i32(round((1.0 - i.pos.z) * 16777216.0)), 0, 16777215);
    var ze: f32;
    if (bitfield(fog, 20u, 1u) == 0u) { ze = (u.rows[$ROW_FOG + 3].x * 16777216.0) / f32(fogi.y - (zCoord >> u32(fogi.w))); }
    else { ze = u.rows[$ROW_FOG + 3].x * (f32(zCoord) / 16777216.0); }
    if ((fog & 0x400u) != 0u) {
      var x_adjust = (2.0 * (i.pos.x / u.rows[$ROW_FOG + 2].y)) - 1.0 - u.rows[$ROW_FOG + 2].x;
      x_adjust = sqrt(x_adjust * x_adjust + u.rows[$ROW_FOG + 2].z * u.rows[$ROW_FOG + 2].z) / u.rows[$ROW_FOG + 2].z;
      ze = ze * x_adjust;
    }
    var fogv = clamp(ze - u.rows[$ROW_FOG + 3].z, 0.0, 1.0);
    if (fsel == 4u) { fogv = 1.0 - exp2(-8.0 * fogv); }
    if (fsel == 5u) { fogv = 1.0 - exp2(-8.0 * fogv * fogv); }
    if (fsel == 6u) { fogv = exp2(-8.0 * (1.0 - fogv)); }
    if (fsel == 7u) { fogv = 1.0 - fogv; fogv = exp2(-8.0 * fogv * fogv); }
    let ifog = i32(round(fogv * 256.0));
    prev = vec4i((prev.rgb * (256 - ifog) + fogcolor.rgb * ifog) >> vec3u(8u), prev.a);
  }
  return vec4f(prev) / 255.0;
}
)WGSL";
  const std::pair<const char*, int> tokens[] = {
    {"$ROW_UID", ROW_UID}, {"$ROW_TEV_COLORS", ROW_TEV_COLORS}, {"$ROW_KCOLORS", ROW_KCOLORS},
    {"$ROW_MATERIALS", ROW_MATERIALS}, {"$ROW_FOG", ROW_FOG}, {"$ROW_TEXGEN", ROW_TEXGEN}, {"$ROW_LIGHTS", ROW_LIGHTS},
    {"$U_COMPONENTS", U_COMPONENTS}, {"$U_NUMCHANS", U_NUMCHANS}, {"$U_CHANS", U_CHANS},
    {"$U_NUMTEXGENS", U_NUMTEXGENS}, {"$U_DUALTEX", U_DUALTEX}, {"$U_TEXGEN", U_TEXGEN},
    {"$U_POSTINFO", U_POSTINFO}, {"$U_STAGES", U_STAGES}, {"$U_COLOR_ENV", U_COLOR_ENV},
    {"$U_ALPHA_ENV", U_ALPHA_ENV}, {"$U_TREF", U_TREF}, {"$U_KSEL", U_KSEL},
    {"$U_ALPHA_OPS", U_ALPHA_OPS}, {"$U_FOG", U_FOG},
    {"$COL0", int(gx::VB_HAS_COL0)}, {"$COL1", int(gx::VB_HAS_COL1)}, {"$NRM0", int(gx::VB_HAS_NRM0)},
    {"$UV0", int(gx::VB_HAS_UV0)},
  };
  for (const auto& [token, value] : tokens) {
    const std::string name(token), number = std::to_string(value) + "u";
    for (size_t at; (at = s.find(name)) != std::string::npos;) {
      // A token is followed by neither a letter, a digit nor '_' ($U_CHANS is not $U_CHANSX).
      const size_t end = at + name.size();
      if (end < s.size() && (std::isalnum(static_cast<unsigned char>(s[end])) || s[end] == '_')) {
        std::fprintf(stderr, "gx_wgsl: token %s is a prefix of another\n", token);
        std::abort();
      }
      s.replace(at, name.size(), number);
    }
  }
  return s;
}

void fill_uid_rows(const ShaderUid& uid, float (*u)[4]) {
  for (size_t k = 0; k < uid.w.size(); ++k) u[ROW_UID + k / 4][k % 4] = float(uid.w[k]);
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
  // The lights, for a draw with a lit channel (fill_vs_constants, gx_shader.cpp:756-779). A light
  // block is XF 0x600 + 16i as xf_load stored it: three unused words, the colour (R in the high
  // byte), then cosine and distance attenuation, position and direction, three floats each.
  bool lit = false;
  for (uint32_t j = 0; j < (dc.xf_regs[0x09] & 3) && j < 2; ++j) lit = lit || ((dc.xf_regs[0x0E + j] | dc.xf_regs[0x10 + j]) & 2);
  for (int i = 0; lit && i < 8; ++i) {
    const uint8_t* L = dc.lights[i];
    float* row = u[ROW_LIGHTS + 5 * i];
    uint32_t colour; std::memcpy(&colour, L + 12, 4);
    for (int c = 0; c < 4; ++c) row[c] = float((colour >> (24 - 8 * c)) & 0xFF);
    float f[9]; std::memcpy(f, L + 16, sizeof f);
    for (int k = 0; k < 3; ++k) { u[ROW_LIGHTS + 5 * i + 1][k] = f[k]; u[ROW_LIGHTS + 5 * i + 2][k] = f[3 + k]; u[ROW_LIGHTS + 5 * i + 3][k] = f[6 + k]; }
    // A distance attenuation of zero divides by zero: upstream's (and Dolphin's) small constant.
    if (std::fabs(f[3]) < 0.00001f && std::fabs(f[4]) < 0.00001f && std::fabs(f[5]) < 0.00001f) u[ROW_LIGHTS + 5 * i + 2][0] = 0.00001f;
    float d[3]; std::memcpy(d, L + 52, sizeof d);
    const double norm = double(d[0]) * d[0] + double(d[1]) * d[1] + double(d[2]) * d[2];
    const float nf = norm > 0 ? float(1.0 / std::sqrt(norm)) : 0.0f;
    for (int k = 0; k < 3; ++k) u[ROW_LIGHTS + 5 * i + 4][k] = d[k] * nf;
    for (int r = 1; r <= 4; ++r) u[ROW_LIGHTS + 5 * i + r][3] = 0.0f;
  }
  // Each texgen's post-transform matrix (XF 0x500 + 4 * index), three rows.
  const uint32_t ntex = dc.xf_regs[0x3F] & 15;
  for (uint32_t i = 0; i < ntex && i < 8; ++i) {
    const uint32_t post = dc.xf_regs[0x50 + i] & 0x3F;
    for (uint32_t k = 0; k < 3; ++k) std::memcpy(u[ROW_TEXGEN + 3 * i + k], dc.postMatrices + 4 * ((post + k) & 63), 16);
  }
}

}  // namespace gxw

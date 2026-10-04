// WGSL for one GX draw: the TEV, texture coordinate generation, colour channels, alpha test and
// fog of the draw's register snapshot (gx_wgsl.cpp says what is transcribed and what is not).
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include "gx_core.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <tuple>

namespace gxw {

// Uniform rows (vec4f) of a draw. 0-105 are gx_webgpu.cpp's (projection, viewport, the position
// and normal matrices, LOD bias, alpha references); fill_tev_rows writes the rest.
//   106-109  TEV registers PREV, C0, C1, C2 (signed 11-bit integers)    DrawCall::tev_colors
//   110-113  TEV konstant colours K0-K3                                  DrawCall::tev_kcolors
//   114-117  ambient 0, ambient 1, material 0, material 1 (0-255)         XF 0x0A-0x0D
//   118-121  fog colour, fog integers (y: B magnitude, w: B shift), fog floats 0 and 1 (upstream's
//            PSConstants fogcolor / fogi / fogf)
//   122-140  the draw's ShaderUid, word k in row 122 + k / 4, lane k % 4, as an exact float (every
//            word is below 2^24): what the one shader (generate_uber_wgsl) reads its state from
//   141+3i   texgen i: its post-transform matrix (dual texture transform). Its texture matrix is
//            read from rows 6-69 (the position matrices, which are the same XF memory) at the
//            vertex's own index: the decoder gives every vertex the CP default when the stream has
//            none (gx_core.cpp, decode_vertices), so that index is always the one GX uses.
//   165+5i   light i (XF 0x600 + 16i), as upstream's fill_vs_constants: colour (0-255), cosine
//            attenuation, distance attenuation, position, normalised direction. Written and uploaded
//            for a draw with a lit colour channel only (uniform_rows).
constexpr int ROW_TEV_COLORS = 106, ROW_KCOLORS = 110, ROW_MATERIALS = 114, ROW_FOG = 118, ROW_UID = 122;
constexpr int ROW_TEXGEN = 141, ROW_LIGHTS = ROW_TEXGEN + 3 * 8;
constexpr int MAX_ROWS = ROW_LIGHTS + 5 * 8;

// Everything the generated WGSL depends on, with unused state masked out (upstream's VSUid and
// PSUid, gx_shader.cpp:163-205): equal uids are equal shaders.
struct ShaderUid {
  std::array<uint32_t, 76> w{};
  bool operator==(const ShaderUid& o) const { return w == o.w; }
};
struct ShaderUidHash {
  size_t operator()(const ShaderUid& u) const {
    uint64_t h = 1469598103934665603ull;
    for (uint32_t v : u.w) { h ^= v; h *= 1099511628211ull; }
    return size_t(h);
  }
};

static_assert(ROW_UID + (std::tuple_size<decltype(ShaderUid::w)>::value + 3) / 4 <= ROW_TEXGEN, "uid rows");

ShaderUid make_uid(const gx::DrawCall& dc);
// Rows this uid's shader reads: everything up to its last texgen block.
int uniform_rows(const ShaderUid& uid);
// The WGSL generated for one uid: its state is constant in the code.
std::string generate_wgsl(const ShaderUid& uid);
// One WGSL for every uid: the same arithmetic, with the uid read from rows 122-140 (fill_uid_rows).
// The backend draws with it, so that a new draw state is new uniform values and not a new shader:
// on WebKit every new WGSL text is a Metal compile that blocks the GPU process (gx_webgpu.cpp).
std::string generate_uber_wgsl();
// Rows 122-140 of `u` (MAX_ROWS x vec4f).
void fill_uid_rows(const ShaderUid& uid, float (*u)[4]);
// Rows 106 and up of `u` (MAX_ROWS x vec4f), the lights' included when a colour channel is lit.
void fill_tev_rows(const gx::DrawCall& dc, float (*u)[4]);

}  // namespace gxw

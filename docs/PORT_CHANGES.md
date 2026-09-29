# Port changes

Every modification this project makes to upstream code is recorded here before it is
made, together with the reason. The upstream is a pinned submodule and is never edited in
place: changes live as patches in `patches/`, applied by `scripts/apply_patches.sh` onto
the CI checkout only.

| Patch | Upstream files touched | Reason | Applied by | Verified by |
| --- | --- | --- | --- | --- |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/ppc/ppc.h` | Portable intrinsic shim and single-rounding `std::fma` family for Emscripten/non-MSVC; unchanged MSVC branch | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; compilation and exact native/WASM hash gate pending CI |
| `0001-ppc-portable-fma-and-intrinsics.patch` | `port/runtime/gx/gx_texture.h` | Explicit `<stddef.h>` for the public `size_t` parameter; avoid reliance on MSVC transitive includes | `scripts/apply_patches.sh` (CI only) | Local `git apply --check`; texture snapshot test pending CI |

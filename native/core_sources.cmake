# One offline simulation boundary for the native oracle and WASM executable.
set(MELEE_HEADLESS_SOURCES
  "${REPO}/native/headless_main.cpp" "${REPO}/native/headless_host.cpp"
  "${REPO}/native/headless_input.cpp" "${REPO}/native/real_fifo.cpp"
  "${REPO}/native/headless_services.cpp")
set(MELEE_SIM_SOURCES
  "${PORT}/runtime/ppc/ppc_runtime.cpp" "${PORT}/runtime/ppc/interp.cpp"
  "${PORT}/runtime/hle/hle_os.cpp" "${PORT}/runtime/hle/hle_dvd.cpp"
  "${PORT}/runtime/hle/hle_pad.cpp" "${PORT}/runtime/hle/hle_card.cpp"
  "${PORT}/runtime/hle/hle_stubs.cpp" "${PORT}/runtime/hle/audio_core.cpp"
  "${PORT}/runtime/hle/ax_ucode.cpp"
  # Q10(a) experiment: shared by native, Node and web; never substitute on only one side.
  "${PORT}/runtime/gx/gx_core.cpp" "${PORT}/runtime/gx/gx_texture.cpp"
  "${PORT}/runtime/gx/render_observer.cpp" "${PORT}/runtime/gx/native_pose_bridge.cpp"
  "${PORT}/runtime/gx/native_draw_audit.cpp")
# Known unresolved dependency: render_observer -> authored_stats (authored_pose.cpp).
# See docs/OPEN_QUESTIONS.md Q10(a); deliberately no replacement statistics stub.
set(MELEE_CORE_INCLUDES
  "${REPO}/native" "${REPO}" "${REPO}/wasm/compat" "${MELEE_GEN}"
  "${PORT}/runtime/ppc" "${PORT}/runtime/hle" "${PORT}/runtime/host"
  "${PORT}/runtime/gx" "${REPO}/upstream/melee-unlocked/native")

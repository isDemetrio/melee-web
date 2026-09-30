# One offline simulation boundary for the native oracle and WASM executable.
set(MELEE_HEADLESS_SOURCES
  "${REPO}/native/headless_main.cpp" "${REPO}/native/headless_host.cpp"
  "${REPO}/native/headless_input.cpp" "${REPO}/native/headless_fifo.cpp"
  "${REPO}/native/headless_services.cpp")
set(MELEE_SIM_SOURCES
  "${PORT}/runtime/ppc/ppc_runtime.cpp" "${PORT}/runtime/ppc/interp.cpp"
  "${PORT}/runtime/hle/hle_os.cpp" "${PORT}/runtime/hle/hle_dvd.cpp"
  "${PORT}/runtime/hle/hle_pad.cpp" "${PORT}/runtime/hle/hle_card.cpp"
  "${PORT}/runtime/hle/hle_stubs.cpp" "${PORT}/runtime/hle/audio_core.cpp"
  "${PORT}/runtime/hle/ax_ucode.cpp")
set(MELEE_CORE_INCLUDES
  "${REPO}/native" "${REPO}" "${REPO}/wasm/compat" "${MELEE_GEN}"
  "${PORT}/runtime/ppc" "${PORT}/runtime/hle" "${PORT}/runtime/host"
  "${PORT}/runtime/gx")

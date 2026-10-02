cmake_minimum_required(VERSION 3.22)
project(melee_core LANGUAGES CXX)
get_filename_component(REPO "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
set(PORT "${REPO}/upstream/melee-unlocked/port")
set(MELEE_GEN "" CACHE PATH "External generated guest directory")
if(NOT EXISTS "${MELEE_GEN}/guest_sources.cmake")
  message(FATAL_ERROR "Set MELEE_GEN to an external matching generated tree")
endif()
include("${MELEE_GEN}/guest_sources.cmake")
include("${REPO}/native/core_sources.cmake")
add_library(core_options INTERFACE)
target_compile_features(core_options INTERFACE cxx_std_17)
target_include_directories(core_options INTERFACE ${MELEE_CORE_INCLUDES})
# -Oz and no debug info, to find out what they cost in size and whether they cost anything in
# behaviour. The oracle answers the second question: the -O1 module was verified bit-identical
# to the native reference on all 2400 checkpoints, so any -Oz module that reproduces the same
# trace is bit-exact too, whatever it optimised away. -ffp-contract=off and -fno-fast-math are
# not negotiable at any level: they are what keeps the arithmetic reproducible.
#
# The level itself is a variable rather than a constant so that a rebuild at another level can be
# produced from CI without editing this file (docs/OPT_LEVEL_EXPERIMENT.md). The default stays
# -Oz, so an ordinary build is byte-for-byte the build it was before this change.
set(MELEE_OPT "-Oz" CACHE STRING "Optimisation level for the core, compile and link")
set_property(CACHE MELEE_OPT PROPERTY STRINGS -Oz -O1 -O2 -O3)
if(NOT MELEE_OPT MATCHES "^-O[a-z0-9]+$")
  message(FATAL_ERROR "MELEE_OPT must be an -O flag such as -Oz or -O1, got '${MELEE_OPT}'")
endif()
# The level actually in force, written where the workflow can read it. The workflow used to grep
# the first -O token out of this file for core.json's "opt" field, which matched the "-O1" in the
# comment above rather than the level being compiled with.
file(WRITE "${CMAKE_BINARY_DIR}/melee_opt.txt" "${MELEE_OPT}")
target_compile_options(core_options INTERFACE ${MELEE_OPT} -g0 -ffp-contract=off -fno-fast-math)
target_compile_definitions(core_options INTERFACE _FILE_OFFSET_BITS=64 MELEE_SINGLE_THREAD=1)
if(EMSCRIPTEN)
  target_compile_definitions(core_options INTERFACE MELEE_OFFLINE_COST=1)
  target_compile_options(core_options INTERFACE -fwasm-exceptions)
  target_link_options(core_options INTERFACE ${MELEE_OPT} -g0 -fwasm-exceptions -ffp-contract=off -fno-fast-math
    -sERROR_ON_UNDEFINED_SYMBOLS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB
    -sSTACK_SIZE=8MB -sALLOW_TABLE_GROWTH=1 -sASSERTIONS=0)
endif()
# P0-04: relocatable list, never a glob or a hand-maintained TU list.
add_library(guest STATIC ${GUEST_SOURCES}
  "${MELEE_GEN}/function_names.cpp" "${MELEE_GEN}/gecko_data.cpp")
target_link_libraries(guest PUBLIC core_options)
# P0-05 compile gate for the exact proposed upstream component boundary.
# The experimental offline executable below uses the SAME host/real GX/services as native/.
add_library(runtime_core STATIC
  "${PORT}/runtime/ppc/ppc_runtime.cpp" "${PORT}/runtime/ppc/interp.cpp"
  "${PORT}/runtime/host/host.cpp" "${PORT}/runtime/host/vcdiff.cpp"
  "${PORT}/runtime/hle/hle_os.cpp" "${PORT}/runtime/hle/hle_pad.cpp"
  "${PORT}/runtime/hle/hle_dvd.cpp" "${PORT}/runtime/hle/hle_card.cpp"
  "${PORT}/runtime/hle/hle_stubs.cpp" "${PORT}/runtime/hle/ax_ucode.cpp"
  "${PORT}/runtime/hle/exi_slippi.cpp" "${PORT}/runtime/gx/gx_core.cpp"
  "${PORT}/runtime/gx/gx_texture.cpp")
target_link_libraries(runtime_core PUBLIC core_options)
target_include_directories(runtime_core PRIVATE "${REPO}/upstream/melee-unlocked/native")
if(EMSCRIPTEN)
  add_library(offline_core OBJECT ${MELEE_HEADLESS_SOURCES} ${MELEE_SIM_SOURCES})
  target_link_libraries(offline_core PUBLIC core_options)
  target_compile_definitions(offline_core PRIVATE MELEE_HEADLESS=1)
  # Per-file optimisation experiment (docs/FRAME_TIME_CONSULT.md). The PowerPC runtime and its
  # interpreter fallback are the likeliest hot translation units in the simulation boundary, and
  # the shipped executables are built from THIS target: runtime_core above is a compile gate and
  # contributes no shipped byte, so a flag changed there would move nothing that runs. Only these
  # two files move to -O2; the rest of the boundary, the generated guest code and the final link
  # stay at ${MELEE_OPT}, which bounds the size cost to them.
  #
  # A source property is appended after the target's own and interface options, so -O2 is the last
  # -O flag in these two compile commands and wins. That order is an assumption about CMake, and if
  # it ever stops holding the experiment would silently measure nothing, so the workflow asserts it
  # against the real compile commands (scripts/phase0/assert_hot_opt.sh).
  set(MELEE_HOT_SOURCES "${PORT}/runtime/ppc/ppc_runtime.cpp" "${PORT}/runtime/ppc/interp.cpp")
  set_source_files_properties(${MELEE_HOT_SOURCES} PROPERTIES COMPILE_OPTIONS "-O2")
  foreach(platform IN ITEMS node web)
    add_executable(melee_core_${platform} $<TARGET_OBJECTS:offline_core>)
    target_link_libraries(melee_core_${platform} PRIVATE guest core_options)
    set_target_properties(melee_core_${platform} PROPERTIES SUFFIX ".js")
  endforeach()
  target_link_options(melee_core_node PRIVATE -sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1)
  # The WebGPU backend exists only in the browser module: Node has no canvas, and the native
  # reference never attaches a backend (native/headless.h, gx_set_backend).
  target_sources(melee_core_web PRIVATE "${REPO}/wasm/render/gx_webgpu.cpp")
  target_link_options(melee_core_web PRIVATE -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1
    -sMODULARIZE=1 -sEXPORT_NAME=createMeleeCore -sINVOKE_RUN=0 -sEXPORT_ES6=1 -lworkerfs.js
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain']")
  add_custom_target(melee_core_wasm DEPENDS melee_core_node melee_core_web)
endif()
add_executable(sha1_test sha1_test.cpp)
target_link_libraries(sha1_test PRIVATE core_options)
if(EMSCRIPTEN)
  target_link_options(sha1_test PRIVATE -sENVIRONMENT=node -sEXIT_RUNTIME=1)
endif()

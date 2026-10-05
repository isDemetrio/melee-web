cmake_minimum_required(VERSION 3.20)
project(melee_wasm_probe LANGUAGES CXX)
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake; native baselines build before patching")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(PORT "${ROOT}/upstream/melee-unlocked/port")
find_package(Python3 REQUIRED COMPONENTS Interpreter)
find_program(NODE_EXECUTABLE node REQUIRED)
add_compile_options(-O3 -fwasm-exceptions -ffp-contract=off -fno-fast-math)
add_link_options(-O3 -fwasm-exceptions -ffp-contract=off -sENVIRONMENT=node
                 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1)
include_directories("${ROOT}" "${PORT}/runtime/ppc" "${PORT}/runtime/hle" "${PORT}/runtime/gx")
enable_testing()
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/port_load_test.cpp"
  COMMAND "${CMAKE_COMMAND}" -E env PYTHONDONTWRITEBYTECODE=1 "${Python3_EXECUTABLE}"
          "${PORT}/tests/generate_load_test.py" "${CMAKE_CURRENT_BINARY_DIR}/port_load_test.cpp"
  DEPENDS "${PORT}/tests/generate_load_test.py" "${PORT}/recomp/emit.py" "${PORT}/recomp/gekko.py"
  VERBATIM)
# generate_load_test.py:5-9,26-42 uses the actual decoder/emitter, without a DOL.
add_executable(port_load_test "${CMAKE_CURRENT_BINARY_DIR}/port_load_test.cpp")
add_executable(ram_watch_test "${PORT}/tests/ram_watch_test.cpp")
add_executable(ax_ucode_test "${PORT}/tests/ax_ucode_test.cpp" "${PORT}/runtime/hle/ax_ucode.cpp")
add_executable(texture_snapshot_test "${PORT}/tests/texture_snapshot_test.cpp" "${PORT}/runtime/gx/gx_texture.cpp")
# All four candidates have portable dependencies. Do not link ppc_runtime.cpp:
# its update_mxcsr at :230-236 requires x86 rounding/FTZ/DAZ control.
foreach(test port_load_test ram_watch_test ax_ucode_test texture_snapshot_test)
  add_test(NAME ${test} COMMAND "${NODE_EXECUTABLE}" "$<TARGET_FILE:${test}>")
endforeach()
# Differential corpus for the word-wise texture compare (patch 0012) against the !memcmp it
# replaced. Built at the two levels the core compiles that header at: -O2 (gx_core.cpp is a hot
# source, wasm/core/CMakeLists.txt) and -Oz (the core's default); the target option comes after
# the directory's -O3, so it is the level in force.
foreach(level O2 Oz)
  add_executable(texture_compare_test_${level} texture_compare_test.cpp "${PORT}/runtime/gx/gx_texture.cpp")
  target_compile_options(texture_compare_test_${level} PRIVATE -${level})
  add_test(NAME texture_compare_test_${level} COMMAND "${NODE_EXECUTABLE}" "$<TARGET_FILE:texture_compare_test_${level}>")
endforeach()
add_executable(fma_vectors fma_vectors.cpp)
# --dump writes 64 MB of raw result bits to the host file system for the native compare.
target_link_options(fma_vectors PRIVATE -sNODERAWFS=1)
add_executable(bench bench.cpp)
# Our own shim test, through the patched ppc.h: it fails on musl fma.c's zero-addend
# shortcut (wasm/compat/fma.h) and on any drift in the four wrappers' sign conventions.
add_executable(fma_shim_test fma_shim_test.cpp)
add_test(NAME fma_shim_test COMMAND "${NODE_EXECUTABLE}" "$<TARGET_FILE:fma_shim_test>")

cmake_minimum_required(VERSION 3.22)
project(melee_native_headless LANGUAGES CXX)

# Configure/build only in GitHub Actions, never on the editing VPS.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
  message(FATAL_ERROR "The initial native reference supports Linux x86-64 only (PPC MXCSR semantics).")
endif()
get_filename_component(REPO "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(PORT "${REPO}/upstream/melee-unlocked/port")
set(PORT_GEN "" CACHE PATH "External generated guest directory; use recomp.py --no-slippi")
if(NOT EXISTS "${PORT_GEN}/guest_sources.cmake")
  message(FATAL_ERROR "Set -DPORT_GEN=<external generated directory>; see native/README.md")
endif()
file(READ "${PORT}/runtime/ppc/ppc.h" PPC_HEADER)
if(NOT PPC_HEADER MATCHES "Native Linux still needs MXCSR")
  message(FATAL_ERROR "Apply the patch series with scripts/apply_patches.sh in CI first")
endif()
include("${PORT_GEN}/guest_sources.cmake")
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED COMPONENTS Crypto)

add_executable(melee_core_headless
  headless_main.cpp headless_host.cpp headless_input.cpp headless_fifo.cpp headless_services.cpp
  ${GUEST_SOURCES} "${PORT_GEN}/function_names.cpp" "${PORT_GEN}/gecko_data.cpp"
  "${PORT}/runtime/ppc/ppc_runtime.cpp" "${PORT}/runtime/ppc/interp.cpp"
  "${PORT}/runtime/hle/hle_os.cpp" "${PORT}/runtime/hle/hle_dvd.cpp"
  "${PORT}/runtime/hle/hle_pad.cpp" "${PORT}/runtime/hle/hle_card.cpp"
  "${PORT}/runtime/hle/hle_stubs.cpp" "${PORT}/runtime/hle/audio_core.cpp"
  "${PORT}/runtime/hle/ax_ucode.cpp")
target_compile_features(melee_core_headless PRIVATE cxx_std_17)
target_include_directories(melee_core_headless PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}" "${REPO}" "${REPO}/wasm/compat" "${PORT_GEN}"
  "${PORT}/runtime/ppc" "${PORT}/runtime/hle" "${PORT}/runtime/host")
# No fast math or implicit contraction: translated instructions select rounding explicitly.
# -O1 keeps the 144+ large generated TUs affordable on CI; no LTO.
target_compile_options(melee_core_headless PRIVATE -O1 -ffp-contract=off -fno-fast-math)
target_compile_definitions(melee_core_headless PRIVATE _FILE_OFFSET_BITS=64 MELEE_HEADLESS=1)
target_link_libraries(melee_core_headless PRIVATE Threads::Threads OpenSSL::Crypto)

include(CTest)
if(BUILD_TESTING)
  add_executable(native_fifo_test tests/fifo_test.cpp headless_fifo.cpp)
  get_target_property(HEADLESS_INCLUDES melee_core_headless INCLUDE_DIRECTORIES)
  target_include_directories(native_fifo_test PRIVATE ${HEADLESS_INCLUDES})
  target_compile_features(native_fifo_test PRIVATE cxx_std_17)
  add_test(NAME native_fifo COMMAND native_fifo_test)
endif()

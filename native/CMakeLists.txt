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
set(MELEE_GEN "${PORT_GEN}")
include("${CMAKE_CURRENT_LIST_DIR}/core_sources.cmake")
option(MELEE_SINGLE_THREAD "Run host workers inline (WASM parity configuration)" OFF)
option(MELEE_PROFILE_INTERVALS "Emit monotonic simulation intervals for CI perf sampling" OFF)

add_executable(melee_core_headless ${MELEE_HEADLESS_SOURCES} ${MELEE_SIM_SOURCES}
  ${GUEST_SOURCES} "${PORT_GEN}/function_names.cpp" "${PORT_GEN}/gecko_data.cpp")
target_compile_features(melee_core_headless PRIVATE cxx_std_17)
target_include_directories(melee_core_headless PRIVATE ${MELEE_CORE_INCLUDES})
# No fast math or implicit contraction: translated instructions select rounding explicitly.
# -O1 keeps the 144+ large generated TUs affordable on CI; no LTO.
target_compile_options(melee_core_headless PRIVATE -O1 -ffp-contract=off -fno-fast-math)
target_compile_definitions(melee_core_headless PRIVATE _FILE_OFFSET_BITS=64 MELEE_HEADLESS=1)
target_link_libraries(melee_core_headless PRIVATE Threads::Threads)
target_link_options(melee_core_headless PRIVATE -Wl,--no-undefined)
if(MELEE_PROFILE_INTERVALS)
  target_compile_definitions(melee_core_headless PRIVATE MELEE_PROFILE_INTERVALS=1)
  # Debug information for inlined decoder helpers, without changing optimization
  # or adding debug data to the 144 generated translation units.
  set_source_files_properties("${PORT}/runtime/gx/gx_core.cpp"
    PROPERTIES COMPILE_OPTIONS "-g")
endif()
if(MELEE_SINGLE_THREAD)
  target_compile_definitions(melee_core_headless PRIVATE MELEE_SINGLE_THREAD=1)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(native_fifo_test tests/fifo_test.cpp headless_fifo.cpp)
  get_target_property(HEADLESS_INCLUDES melee_core_headless INCLUDE_DIRECTORIES)
  target_include_directories(native_fifo_test PRIVATE ${HEADLESS_INCLUDES})
  target_compile_features(native_fifo_test PRIVATE cxx_std_17)
  add_test(NAME native_fifo COMMAND native_fifo_test)
endif()

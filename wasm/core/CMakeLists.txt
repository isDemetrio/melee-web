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
target_compile_options(core_options INTERFACE -O1 -ffp-contract=off -fno-fast-math)
target_compile_definitions(core_options INTERFACE _FILE_OFFSET_BITS=64 MELEE_SINGLE_THREAD=1)
if(EMSCRIPTEN)
  target_compile_options(core_options INTERFACE -fwasm-exceptions)
  target_link_options(core_options INTERFACE -O1 -g2 -fwasm-exceptions -ffp-contract=off -fno-fast-math
    -sERROR_ON_UNDEFINED_SYMBOLS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB
    -sSTACK_SIZE=8MB -sALLOW_TABLE_GROWTH=1 -sASSERTIONS=1)
endif()
# P0-04: relocatable list, never a glob or a hand-maintained TU list.
add_library(guest STATIC ${GUEST_SOURCES}
  "${MELEE_GEN}/function_names.cpp" "${MELEE_GEN}/gecko_data.cpp")
target_link_libraries(guest PUBLIC core_options)
# P0-05 compile gate for the exact proposed upstream component boundary.
# The proven offline executable below uses the SAME host/FIFO/services as native/.
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
  foreach(platform IN ITEMS node web)
    add_executable(melee_core_${platform} $<TARGET_OBJECTS:offline_core>)
    target_link_libraries(melee_core_${platform} PRIVATE guest core_options)
    set_target_properties(melee_core_${platform} PROPERTIES SUFFIX ".js")
  endforeach()
  target_link_options(melee_core_node PRIVATE -sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1)
  target_link_options(melee_core_web PRIVATE -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1
    -sMODULARIZE=1 -sEXPORT_NAME=createMeleeCore -sINVOKE_RUN=0
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain']")
  add_custom_target(melee_core_wasm DEPENDS melee_core_node melee_core_web)
endif()
add_executable(sha1_test sha1_test.cpp)
target_link_libraries(sha1_test PRIVATE core_options)
if(EMSCRIPTEN)
  target_link_options(sha1_test PRIVATE -sENVIRONMENT=node -sEXIT_RUNTIME=1)
endif()

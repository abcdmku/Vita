cmake_minimum_required(VERSION 3.22)

project(vita_cef_osr_spike LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(PSD_SPIKE_ENABLE_CEF "Enable the CEF accelerated-OSR backend when CEF_ROOT is present" ON)
option(PSD_SPIKE_ENABLE_WPE "Enable the WPE WebKit fallback backend when pkg-config finds it" ON)

add_executable(vita-cef-osr-spike
  src/main.cpp
)

target_compile_features(vita-cef-osr-spike PRIVATE cxx_std_20)

if(PSD_SPIKE_ENABLE_CEF)
  set(CEF_ROOT "$ENV{CEF_ROOT}" CACHE PATH "CEF binary distribution root")
  if(CEF_ROOT AND EXISTS "${CEF_ROOT}/include/cef_app.h")
    target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_CEF_PRESENT=1)
    target_include_directories(vita-cef-osr-spike PRIVATE "${CEF_ROOT}" "${CEF_ROOT}/include")
    message(STATUS "CEF headers found at ${CEF_ROOT}; build will require the matching libcef runtime on PATH/LD_LIBRARY_PATH.")
  else()
    target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_CEF_PRESENT=0)
    message(WARNING "CEF_ROOT does not contain include/cef_app.h; CEF backend will report unavailable.")
  endif()
else()
  target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_CEF_PRESENT=0)
endif()

if(PSD_SPIKE_ENABLE_WPE)
  find_package(PkgConfig QUIET)
  if(PkgConfig_FOUND)
    pkg_check_modules(WPE QUIET IMPORTED_TARGET wpe-webkit-1.1)
  endif()
  if(WPE_FOUND)
    target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_WPE_PRESENT=1)
    target_link_libraries(vita-cef-osr-spike PRIVATE PkgConfig::WPE)
    message(STATUS "WPE WebKit found; fallback backend can be wired on the VMware target.")
  else()
    target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_WPE_PRESENT=0)
    message(WARNING "WPE WebKit pkg-config module not found; WPE backend will report unavailable.")
  endif()
else()
  target_compile_definitions(vita-cef-osr-spike PRIVATE PSD_SPIKE_WPE_PRESENT=0)
endif()


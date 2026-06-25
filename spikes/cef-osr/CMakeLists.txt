# Vita CEF OSR host — M0 spike build.
# Standalone CMake project that consumes the vendored CEF minimal distribution,
# builds libcef_dll_wrapper, and links the windowless OSR host (osr_host.cc).
cmake_minimum_required(VERSION 3.21)

# Allow older CEF cmake (which calls cmake_minimum_required < 3.5 internally).
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

project(vita_cef_osr C CXX)

# Point FindCEF at the vendored distribution.
set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.vendor/cef_binary_149.0.5+g6770623+chromium-149.0.7827.197_linux64_minimal" CACHE PATH "CEF root")
set(CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")

# Default to a Release build (CEF binaries shipped are Release).
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(CEF REQUIRED)

# Build the wrapper library from the vendored sources.
add_subdirectory("${CEF_ROOT}/libcef_dll" libcef_dll_wrapper)

set(OSR_TARGET "vita_cef_osr")
add_executable(${OSR_TARGET} osr_host.cc)
SET_EXECUTABLE_TARGET_PROPERTIES(${OSR_TARGET})

add_dependencies(${OSR_TARGET} libcef_dll_wrapper)

target_include_directories(${OSR_TARGET} PRIVATE
  "${CEF_ROOT}"
  "${CMAKE_CURRENT_SOURCE_DIR}"   # for stb_image_write.h
)

target_link_libraries(${OSR_TARGET}
  libcef_dll_wrapper
  ${CEF_STANDARD_LIBS}
)

# Link libcef.so directly (Release).
target_link_libraries(${OSR_TARGET} "${CEF_BINARY_DIR}/libcef.so")

# Place the binary alongside the CEF runtime files so it can find libcef.so etc.
SET_CEF_TARGET_OUT_DIR()

# Copy CEF binary + resource files next to the executable so the app can run
# in-place (libcef.so, *.pak, icudtl.dat, locales, swiftshader, snapshot...).
COPY_FILES(${OSR_TARGET} "${CEF_BINARY_FILES}"   "${CEF_BINARY_DIR}"   "${CEF_TARGET_OUT_DIR}")
COPY_FILES(${OSR_TARGET} "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")

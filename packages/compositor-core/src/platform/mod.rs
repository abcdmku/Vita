#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod stub;

#[cfg(target_os = "linux")]
pub use linux::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test, query_default_output_mode,
    PlatformGpuBackend,
};
#[cfg(not(target_os = "linux"))]
pub use stub::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test, query_default_output_mode,
    PlatformGpuBackend,
};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod stub;

#[cfg(target_os = "linux")]
pub use linux::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test,
    run_dmabuf_round_trip_self_test, PlatformGpuBackend,
};
#[cfg(not(target_os = "linux"))]
pub use stub::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test,
    run_dmabuf_round_trip_self_test, PlatformGpuBackend,
};

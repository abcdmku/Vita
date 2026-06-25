use crate::{
    CompositeReport, CompositorError, GpuTextureHandle, InputAvailability, InputEvent, Placement,
    PresentationMode, Rect, RenderBackend, RenderSurface, TestPattern, TextureFormat,
    TextureHandleKind,
};

#[derive(Debug)]
pub struct PlatformGpuBackend;

pub fn open_default_gpu_backend(
    _width: u32,
    _height: u32,
) -> Result<PlatformGpuBackend, CompositorError> {
    Err(CompositorError::Unavailable(
        "DRM/GBM/EGL compositor backend is only built on linux".to_owned(),
    ))
}

pub fn open_default_gpu_backend_for_self_test(
    _width: u32,
    _height: u32,
) -> Result<PlatformGpuBackend, CompositorError> {
    Err(CompositorError::Unavailable(
        "DRM/GBM/EGL compositor backend is only built on linux".to_owned(),
    ))
}

impl RenderBackend for PlatformGpuBackend {
    type Texture = ();

    fn backend_name(&self) -> &str {
        "unavailable"
    }

    fn presentation_mode(&self) -> PresentationMode {
        PresentationMode::UNVERIFIED
    }

    fn input_availability(&self) -> InputAvailability {
        InputAvailability::Unverified
    }

    fn create_test_texture(
        &mut self,
        _width: u32,
        _height: u32,
        _pattern: &TestPattern,
    ) -> Result<Self::Texture, CompositorError> {
        Err(CompositorError::Unavailable(
            "non-linux compositor backend cannot create GPU textures".to_owned(),
        ))
    }

    fn export_handle(&self, _texture: &Self::Texture) -> GpuTextureHandle {
        GpuTextureHandle {
            kind: TextureHandleKind::TestOnly,
            value: -1,
            width: 0,
            height: 0,
            format: TextureFormat::Rgba8Unorm,
        }
    }

    fn composite(
        &mut self,
        _surfaces: &[RenderSurface<Self::Texture>],
        _placements: &[Placement],
        _damage: &[Rect],
        _output_width: u32,
        _output_height: u32,
    ) -> Result<CompositeReport, CompositorError> {
        Err(CompositorError::Unavailable(
            "non-linux compositor backend cannot composite".to_owned(),
        ))
    }

    fn read_texture_rgba_for_test(
        &mut self,
        _texture: &Self::Texture,
    ) -> Result<Vec<u8>, CompositorError> {
        Err(CompositorError::Unavailable(
            "non-linux compositor backend cannot read back GPU textures".to_owned(),
        ))
    }

    fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
        Err(CompositorError::Unavailable(
            "input_unavailable: libinput is only built on linux".to_owned(),
        ))
    }

    fn source_repaint_count(&self) -> u64 {
        0
    }
}

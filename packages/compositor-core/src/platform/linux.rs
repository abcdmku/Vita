#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs::{read_dir, read_link, File, OpenOptions};
use std::mem;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::slice;

use crate::{
    CompositeReport, CompositorError, GpuTextureHandle, InputAvailability, InputEvent, Placement,
    PointerButtonState, PresentationMode, Rect, RenderBackend, RenderSurface, TestPattern,
    TextureFormat, TextureHandleKind,
};

const RTLD_NOW: c_int = 2;
const EGL_PLATFORM_GBM_KHR: u32 = 0x31D7;
const EGL_OPENGL_ES_API: u32 = 0x30A0;
const EGL_NONE: i32 = 0x3038;
const EGL_SURFACE_TYPE: i32 = 0x3033;
const EGL_WINDOW_BIT: i32 = 0x0004;
const EGL_RENDERABLE_TYPE: i32 = 0x3040;
const EGL_OPENGL_ES2_BIT: i32 = 0x0004;
const EGL_RED_SIZE: i32 = 0x3024;
const EGL_GREEN_SIZE: i32 = 0x3023;
const EGL_BLUE_SIZE: i32 = 0x3022;
const EGL_ALPHA_SIZE: i32 = 0x3021;
const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;

const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_TRIANGLES: u32 = 0x0004;
const GL_FLOAT: u32 = 0x1406;
const GL_FALSE: u8 = 0;
const GL_COLOR_BUFFER_BIT: u32 = 0x00004000;
const GL_VERTEX_SHADER: u32 = 0x8B31;
const GL_FRAGMENT_SHADER: u32 = 0x8B30;
const GL_COMPILE_STATUS: u32 = 0x8B81;
const GL_LINK_STATUS: u32 = 0x8B82;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_CLAMP_TO_EDGE: i32 = 0x812F;
const GL_NEAREST: i32 = 0x2600;
const GL_TEXTURE0: u32 = 0x84C0;
const GL_SCISSOR_TEST: u32 = 0x0C11;
const GL_BLEND: u32 = 0x0BE2;
const GL_SRC_ALPHA: u32 = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
const GL_PACK_ALIGNMENT: u32 = 0x0D05;
const GL_UNPACK_ALIGNMENT: u32 = 0x0CF5;

const LIBINPUT_EVENT_KEYBOARD_KEY: u32 = 300;
const LIBINPUT_EVENT_POINTER_MOTION: u32 = 400;
const LIBINPUT_EVENT_POINTER_BUTTON: u32 = 402;
const LIBINPUT_BUTTON_STATE_PRESSED: u32 = 1;
const LIBINPUT_KEY_STATE_PRESSED: u32 = 1;

const GBM_FORMAT_ARGB8888: u32 = fourcc_code(b'A', b'R', b'2', b'4');
const GBM_BO_USE_SCANOUT: u32 = 1 << 0;
const GBM_BO_USE_RENDERING: u32 = 1 << 2;
const DRM_MODE_CONNECTED: c_int = 1;
const DRM_MODE_PAGE_FLIP_EVENT: u32 = 0x01;
const DRM_EVENT_CONTEXT_VERSION: c_int = 2;
const POLLIN: i16 = 0x0001;

type EglDisplay = *mut c_void;
type EglConfig = *mut c_void;
type EglContext = *mut c_void;
type EglSurface = *mut c_void;
type EglBoolean = u32;
type EglGetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type GlInt = i32;
type GlUInt = u32;
type GlSizeI = i32;
type GlEnum = u32;
type GlBool = u8;
type GlFloat = f32;

#[link(name = "dl")]
extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
    fn dlerror() -> *const c_char;
}

extern "C" {
    #[link_name = "open"]
    fn libc_open(path: *const c_char, flags: c_int) -> c_int;
    #[link_name = "close"]
    fn libc_close(fd: c_int) -> c_int;
    fn poll(fds: *mut PollFd, nfds: usize, timeout: c_int) -> c_int;
}

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: i16,
    revents: i16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct DrmModeModeInfo {
    clock: u32,
    hdisplay: u16,
    hsync_start: u16,
    hsync_end: u16,
    htotal: u16,
    hskew: u16,
    vdisplay: u16,
    vsync_start: u16,
    vsync_end: u16,
    vtotal: u16,
    vscan: u16,
    vrefresh: u32,
    flags: u32,
    kind: u32,
    name: [c_char; 32],
}

#[repr(C)]
struct DrmModeRes {
    count_fbs: c_int,
    fbs: *mut u32,
    count_crtcs: c_int,
    crtcs: *mut u32,
    count_connectors: c_int,
    connectors: *mut u32,
    count_encoders: c_int,
    encoders: *mut u32,
    min_width: u32,
    max_width: u32,
    min_height: u32,
    max_height: u32,
}

#[repr(C)]
struct DrmModeConnector {
    connector_id: u32,
    encoder_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: c_int,
    mm_width: u32,
    mm_height: u32,
    subpixel: c_int,
    count_modes: c_int,
    modes: *mut DrmModeModeInfo,
    count_props: c_int,
    props: *mut u32,
    prop_values: *mut u64,
    count_encoders: c_int,
    encoders: *mut u32,
}

#[repr(C)]
struct DrmModeEncoder {
    encoder_id: u32,
    encoder_type: u32,
    crtc_id: u32,
    possible_crtcs: u32,
    possible_clones: u32,
}

#[repr(C)]
struct DrmModeCrtc {
    crtc_id: u32,
    buffer_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    mode_valid: c_int,
    mode: DrmModeModeInfo,
    gamma_size: c_int,
}

#[repr(C)]
struct DrmEventContext {
    version: c_int,
    vblank_handler: Option<unsafe extern "C" fn(c_int, u32, u32, u32, *mut c_void)>,
    page_flip_handler: Option<unsafe extern "C" fn(c_int, u32, u32, u32, *mut c_void)>,
    page_flip_handler2: Option<unsafe extern "C" fn(c_int, u32, u32, u32, u32, *mut c_void)>,
    sequence_handler: Option<unsafe extern "C" fn(c_int, u64, u64, u64)>,
}

#[repr(C)]
union GbmBoHandle {
    u32_value: u32,
    i32_value: i32,
    u64_value: u64,
    ptr_value: *mut c_void,
}

#[derive(Debug, Clone)]
pub struct GpuTexture {
    id: GlUInt,
    width: u32,
    height: u32,
}

pub struct PlatformGpuBackend {
    drm: File,
    _render_node: File,
    libinput: Option<LibinputState>,
    input_availability: InputAvailability,
    kms: KmsState,
    gbm: Gbm,
    egl: Egl,
    gl: Gl,
    gbm_device: *mut c_void,
    gbm_surface: *mut c_void,
    egl_display: EglDisplay,
    egl_context: EglContext,
    egl_surface: EglSurface,
    output_texture: GlUInt,
    output_fbo: GlUInt,
    scratch_fbo: GlUInt,
    program: GlUInt,
    position_attr: GlInt,
    uv_attr: GlInt,
    sampler_uniform: GlInt,
    opacity_uniform: GlInt,
    output_width: u32,
    output_height: u32,
    gpu_name: String,
    repaint_count: u64,
}

pub fn open_default_gpu_backend(
    width: u32,
    height: u32,
) -> Result<PlatformGpuBackend, CompositorError> {
    PlatformGpuBackend::open(width, height)
}

pub fn open_default_gpu_backend_for_self_test(
    width: u32,
    height: u32,
) -> Result<PlatformGpuBackend, CompositorError> {
    PlatformGpuBackend::open_for_self_test(width, height)
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum InputPolicy {
    Required,
    Optional,
}

impl PlatformGpuBackend {
    pub fn open(width: u32, height: u32) -> Result<Self, CompositorError> {
        Self::open_with_input_policy(width, height, InputPolicy::Required)
    }

    pub fn open_for_self_test(width: u32, height: u32) -> Result<Self, CompositorError> {
        Self::open_with_input_policy(width, height, InputPolicy::Optional)
    }

    fn open_with_input_policy(
        width: u32,
        height: u32,
        input_policy: InputPolicy,
    ) -> Result<Self, CompositorError> {
        if width == 0 || height == 0 {
            return Err(CompositorError::InvalidDimensions { width, height });
        }

        let drm = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/dri/card0")
            .map_err(|err| {
                CompositorError::Unavailable(format!("failed to open /dev/dri/card0: {err}"))
            })?;
        let render_node = open_render_node()?;
        let kms = KmsState::open(drm.as_raw_fd())?;
        let gpu_name = detect_drm_driver();
        let (libinput, input_availability) = match input_policy {
            InputPolicy::Required => (Some(LibinputState::open()?), InputAvailability::Available),
            InputPolicy::Optional => (None, InputAvailability::Unavailable),
        };
        let gbm = Gbm::open()?;
        let egl = Egl::open()?;
        let gbm_device = unsafe { (gbm.create_device)(drm.as_raw_fd()) };
        if gbm_device.is_null() {
            return Err(CompositorError::Unavailable(
                "gbm_create_device returned null".to_owned(),
            ));
        }
        let gbm_surface = unsafe {
            (gbm.surface_create)(
                gbm_device,
                kms.scanout_width,
                kms.scanout_height,
                GBM_FORMAT_ARGB8888,
                GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING,
            )
        };
        if gbm_surface.is_null() {
            unsafe {
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "gbm_surface_create(scanout) returned null".to_owned(),
            ));
        }

        let egl_display = unsafe {
            (egl.get_platform_display_ext)(EGL_PLATFORM_GBM_KHR, gbm_device, ptr::null())
        };
        if egl_display.is_null() {
            unsafe {
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglGetPlatformDisplayEXT(GBM) returned null".to_owned(),
            ));
        }

        let mut major = 0_i32;
        let mut minor = 0_i32;
        if unsafe { (egl.initialize)(egl_display, &mut major, &mut minor) } == 0 {
            unsafe {
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglInitialize failed for GBM display".to_owned(),
            ));
        }
        if unsafe { (egl.bind_api)(EGL_OPENGL_ES_API) } == 0 {
            unsafe {
                (egl.terminate)(egl_display);
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglBindAPI(OpenGL ES) failed".to_owned(),
            ));
        }

        let config = choose_config(&egl, egl_display)?;
        let context_attribs = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];
        let egl_context = unsafe {
            (egl.create_context)(
                egl_display,
                config,
                ptr::null_mut(),
                context_attribs.as_ptr(),
            )
        };
        if egl_context.is_null() {
            unsafe {
                (egl.terminate)(egl_display);
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglCreateContext failed".to_owned(),
            ));
        }

        let egl_surface =
            unsafe { (egl.create_window_surface)(egl_display, config, gbm_surface, ptr::null()) };
        if egl_surface.is_null() {
            unsafe {
                (egl.destroy_context)(egl_display, egl_context);
                (egl.terminate)(egl_display);
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglCreateWindowSurface(GBM scanout) failed".to_owned(),
            ));
        }

        if unsafe { (egl.make_current)(egl_display, egl_surface, egl_surface, egl_context) } == 0 {
            unsafe {
                (egl.destroy_surface)(egl_display, egl_surface);
                (egl.destroy_context)(egl_display, egl_context);
                (egl.terminate)(egl_display);
                (gbm.surface_destroy)(gbm_surface);
                (gbm.destroy_device)(gbm_device);
            }
            return Err(CompositorError::Unavailable(
                "eglMakeCurrent failed".to_owned(),
            ));
        }

        let gl = Gl::open(&egl)?;
        let mut backend = Self {
            drm,
            _render_node: render_node,
            libinput,
            input_availability,
            kms,
            gbm,
            egl,
            gl,
            gbm_device,
            gbm_surface,
            egl_display,
            egl_context,
            egl_surface,
            output_texture: 0,
            output_fbo: 0,
            scratch_fbo: 0,
            program: 0,
            position_attr: -1,
            uv_attr: -1,
            sampler_uniform: -1,
            opacity_uniform: -1,
            output_width: width,
            output_height: height,
            gpu_name,
            repaint_count: 0,
        };

        backend.initialize_gl_state()?;
        backend.probe_optional_input(input_policy);
        Ok(backend)
    }

    fn probe_optional_input(&mut self, input_policy: InputPolicy) {
        if input_policy != InputPolicy::Optional {
            return;
        }

        if let Ok(libinput) = LibinputState::open() {
            self.libinput = Some(libinput);
            self.input_availability = InputAvailability::Available;
        }
    }

    fn initialize_gl_state(&mut self) -> Result<(), CompositorError> {
        unsafe {
            (self.gl.pixel_store_i)(GL_UNPACK_ALIGNMENT, 1);
            (self.gl.pixel_store_i)(GL_PACK_ALIGNMENT, 1);
            (self.gl.gen_framebuffers)(1, &mut self.output_fbo);
            (self.gl.gen_framebuffers)(1, &mut self.scratch_fbo);
        }

        self.output_texture = self.create_empty_texture(self.output_width, self.output_height)?;
        unsafe {
            (self.gl.bind_framebuffer)(GL_FRAMEBUFFER, self.output_fbo);
            (self.gl.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                self.output_texture,
                0,
            );
        }
        self.check_framebuffer("output")?;
        self.program = self.create_program()?;

        let position_attr = cstring("a_position")?;
        let uv_attr = cstring("a_uv")?;
        let sampler_uniform = cstring("u_texture")?;
        let opacity_uniform = cstring("u_opacity")?;
        unsafe {
            self.position_attr =
                (self.gl.get_attrib_location)(self.program, position_attr.as_ptr());
            self.uv_attr = (self.gl.get_attrib_location)(self.program, uv_attr.as_ptr());
            self.sampler_uniform =
                (self.gl.get_uniform_location)(self.program, sampler_uniform.as_ptr());
            self.opacity_uniform =
                (self.gl.get_uniform_location)(self.program, opacity_uniform.as_ptr());
        }
        if self.position_attr < 0 || self.uv_attr < 0 || self.sampler_uniform < 0 {
            return Err(CompositorError::Backend(
                "shader locations were not resolved".to_owned(),
            ));
        }
        Ok(())
    }

    fn create_program(&self) -> Result<GlUInt, CompositorError> {
        let vertex = self.compile_shader(
            GL_VERTEX_SHADER,
            r#"
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_uv;
}
"#,
        )?;
        let fragment = self.compile_shader(
            GL_FRAGMENT_SHADER,
            r#"
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  vec4 color = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
"#,
        )?;

        let program = unsafe { (self.gl.create_program)() };
        unsafe {
            (self.gl.attach_shader)(program, vertex);
            (self.gl.attach_shader)(program, fragment);
            (self.gl.link_program)(program);
            (self.gl.delete_shader)(vertex);
            (self.gl.delete_shader)(fragment);
        }

        let mut ok = 0_i32;
        unsafe {
            (self.gl.get_program_iv)(program, GL_LINK_STATUS, &mut ok);
        }
        if ok == 0 {
            return Err(CompositorError::Backend("shader link failed".to_owned()));
        }

        Ok(program)
    }

    fn compile_shader(&self, kind: GlEnum, source: &str) -> Result<GlUInt, CompositorError> {
        let shader = unsafe { (self.gl.create_shader)(kind) };
        let source = cstring(source)?;
        let source_ptr = source.as_ptr();
        unsafe {
            (self.gl.shader_source)(shader, 1, &source_ptr, ptr::null());
            (self.gl.compile_shader)(shader);
        }

        let mut ok = 0_i32;
        unsafe {
            (self.gl.get_shader_iv)(shader, GL_COMPILE_STATUS, &mut ok);
        }
        if ok == 0 {
            return Err(CompositorError::Backend("shader compile failed".to_owned()));
        }

        Ok(shader)
    }

    fn create_empty_texture(&self, width: u32, height: u32) -> Result<GlUInt, CompositorError> {
        let mut texture = 0_u32;
        unsafe {
            (self.gl.gen_textures)(1, &mut texture);
            (self.gl.bind_texture)(GL_TEXTURE_2D, texture);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            (self.gl.tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA as i32,
                width as i32,
                height as i32,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                ptr::null(),
            );
        }
        Ok(texture)
    }

    fn check_framebuffer(&self, label: &str) -> Result<(), CompositorError> {
        let status = unsafe { (self.gl.check_framebuffer_status)(GL_FRAMEBUFFER) };
        if status != GL_FRAMEBUFFER_COMPLETE {
            return Err(CompositorError::Backend(format!(
                "{label} framebuffer incomplete: 0x{status:x}"
            )));
        }
        Ok(())
    }

    fn draw_placement(
        &self,
        texture: GlUInt,
        placement: &Placement,
    ) -> Result<(), CompositorError> {
        let left = pixel_to_clip_x(placement.x, self.output_width);
        let right = pixel_to_clip_x(placement.x + placement.width as i32, self.output_width);
        let top = pixel_to_clip_y(placement.y, self.output_height);
        let bottom = pixel_to_clip_y(placement.y + placement.height as i32, self.output_height);
        let vertices: [f32; 24] = [
            left, top, 0.0, 0.0, right, top, 1.0, 0.0, left, bottom, 0.0, 1.0, right, top, 1.0,
            0.0, right, bottom, 1.0, 1.0, left, bottom, 0.0, 1.0,
        ];
        let stride = (4 * mem::size_of::<f32>()) as i32;

        unsafe {
            (self.gl.active_texture)(GL_TEXTURE0);
            (self.gl.bind_texture)(GL_TEXTURE_2D, texture);
            (self.gl.uniform_1i)(self.sampler_uniform, 0);
            if self.opacity_uniform >= 0 {
                (self.gl.uniform_1f)(self.opacity_uniform, placement.opacity);
            }
            (self.gl.enable_vertex_attrib_array)(self.position_attr as u32);
            (self.gl.enable_vertex_attrib_array)(self.uv_attr as u32);
            (self.gl.vertex_attrib_pointer)(
                self.position_attr as u32,
                2,
                GL_FLOAT,
                GL_FALSE,
                stride,
                vertices.as_ptr().cast(),
            );
            (self.gl.vertex_attrib_pointer)(
                self.uv_attr as u32,
                2,
                GL_FLOAT,
                GL_FALSE,
                stride,
                vertices.as_ptr().add(2).cast(),
            );
            (self.gl.draw_arrays)(GL_TRIANGLES, 0, 6);
        }

        Ok(())
    }
}

impl RenderBackend for PlatformGpuBackend {
    type Texture = GpuTexture;

    fn backend_name(&self) -> &str {
        &self.gpu_name
    }

    fn presentation_mode(&self) -> PresentationMode {
        PresentationMode::KMS
    }

    fn input_availability(&self) -> InputAvailability {
        self.input_availability
    }

    fn create_test_texture(
        &mut self,
        width: u32,
        height: u32,
        pattern: &TestPattern,
    ) -> Result<Self::Texture, CompositorError> {
        let bytes = pattern.rgba_bytes(width, height)?;
        let mut texture = 0_u32;
        unsafe {
            (self.gl.gen_textures)(1, &mut texture);
            (self.gl.bind_texture)(GL_TEXTURE_2D, texture);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            (self.gl.tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            (self.gl.tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA as i32,
                width as i32,
                height as i32,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                bytes.as_ptr().cast(),
            );
        }
        self.repaint_count += 1;
        Ok(GpuTexture {
            id: texture,
            width,
            height,
        })
    }

    fn export_handle(&self, texture: &Self::Texture) -> GpuTextureHandle {
        GpuTextureHandle {
            kind: TextureHandleKind::OpaqueNativeTexture,
            value: i64::from(texture.id),
            width: texture.width,
            height: texture.height,
            format: TextureFormat::Rgba8Unorm,
        }
    }

    fn composite(
        &mut self,
        surfaces: &[RenderSurface<Self::Texture>],
        placements: &[Placement],
        damage: &[Rect],
        output_width: u32,
        output_height: u32,
    ) -> Result<CompositeReport, CompositorError> {
        if output_width != self.output_width || output_height != self.output_height {
            return Err(CompositorError::Backend(
                "dynamic output resize is not implemented in this slice".to_owned(),
            ));
        }

        let textures = surfaces
            .iter()
            .map(|surface| (surface.id.clone(), surface.texture.id))
            .collect::<BTreeMap<_, _>>();
        let full_output = [Rect {
            x: 0,
            y: 0,
            width: self.output_width,
            height: self.output_height,
        }];
        let damage = if damage.is_empty() {
            &full_output[..]
        } else {
            damage
        };

        unsafe {
            (self.gl.bind_framebuffer)(GL_FRAMEBUFFER, self.output_fbo);
            (self.gl.viewport)(0, 0, self.output_width as i32, self.output_height as i32);
            (self.gl.use_program)(self.program);
            (self.gl.enable)(GL_BLEND);
            (self.gl.blend_func)(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
            (self.gl.enable)(GL_SCISSOR_TEST);
        }

        for rect in damage {
            unsafe {
                (self.gl.scissor)(
                    rect.x,
                    self.output_height as i32 - rect.y - rect.height as i32,
                    rect.width as i32,
                    rect.height as i32,
                );
                (self.gl.clear_color)(0.0, 0.0, 0.0, 1.0);
                (self.gl.clear)(GL_COLOR_BUFFER_BIT);
            }
            for placement in placements {
                let texture = textures
                    .get(&placement.surface_id)
                    .ok_or_else(|| CompositorError::UnknownSurface(placement.surface_id.clone()))?;
                self.draw_placement(*texture, placement)?;
            }
        }

        unsafe {
            (self.gl.disable)(GL_SCISSOR_TEST);
            (self.gl.flush)();
            (self.gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            (self.gl.viewport)(0, 0, self.output_width as i32, self.output_height as i32);
            (self.gl.clear_color)(0.0, 0.0, 0.0, 1.0);
            (self.gl.clear)(GL_COLOR_BUFFER_BIT);
            (self.gl.use_program)(self.program);
        }
        let output_placement = Placement::new(
            crate::SurfaceId::new("kms-output")?,
            0,
            0,
            self.output_width,
            self.output_height,
            0,
        )?;
        self.draw_placement(self.output_texture, &output_placement)?;
        if unsafe { (self.egl.swap_buffers)(self.egl_display, self.egl_surface) } == 0 {
            return Err(CompositorError::Unavailable(
                "eglSwapBuffers(GBM scanout) failed".to_owned(),
            ));
        }
        self.kms
            .present(self.drm.as_raw_fd(), &self.gbm, self.gbm_surface)?;

        Ok(CompositeReport {
            surfaces: placements.len(),
            composited: true,
            damage_rects: damage.len(),
        })
    }

    fn read_texture_rgba_for_test(
        &mut self,
        texture: &Self::Texture,
    ) -> Result<Vec<u8>, CompositorError> {
        let mut bytes = vec![0_u8; (texture.width * texture.height * 4) as usize];
        unsafe {
            (self.gl.bind_framebuffer)(GL_FRAMEBUFFER, self.scratch_fbo);
            (self.gl.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                texture.id,
                0,
            );
        }
        self.check_framebuffer("readback")?;
        unsafe {
            (self.gl.read_pixels)(
                0,
                0,
                texture.width as i32,
                texture.height as i32,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                bytes.as_mut_ptr().cast(),
            );
        }
        Ok(bytes)
    }

    fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
        let libinput = self
            .libinput
            .as_mut()
            .ok_or_else(|| input_unavailable("libinput is unavailable for this backend"))?;
        libinput.poll_events()
    }

    fn source_repaint_count(&self) -> u64 {
        self.repaint_count
    }
}

impl Drop for PlatformGpuBackend {
    fn drop(&mut self) {
        unsafe {
            if self.output_texture != 0 {
                (self.gl.delete_textures)(1, &self.output_texture);
            }
            if self.output_fbo != 0 {
                (self.gl.delete_framebuffers)(1, &self.output_fbo);
            }
            if self.scratch_fbo != 0 {
                (self.gl.delete_framebuffers)(1, &self.scratch_fbo);
            }
            if self.program != 0 {
                (self.gl.delete_program)(self.program);
            }
            if !self.egl_display.is_null() {
                (self.egl.make_current)(
                    self.egl_display,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
                if !self.egl_surface.is_null() {
                    (self.egl.destroy_surface)(self.egl_display, self.egl_surface);
                }
                if !self.egl_context.is_null() {
                    (self.egl.destroy_context)(self.egl_display, self.egl_context);
                }
                (self.egl.terminate)(self.egl_display);
            }
            self.kms
                .restore_and_release(self.drm.as_raw_fd(), &self.gbm, self.gbm_surface);
            if !self.gbm_surface.is_null() {
                (self.gbm.surface_destroy)(self.gbm_surface);
            }
            if !self.gbm_device.is_null() {
                (self.gbm.destroy_device)(self.gbm_device);
            }
        }
    }
}

fn choose_config(egl: &Egl, display: EglDisplay) -> Result<EglConfig, CompositorError> {
    let attrs = [
        EGL_SURFACE_TYPE,
        EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE,
        EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE,
        8,
        EGL_GREEN_SIZE,
        8,
        EGL_BLUE_SIZE,
        8,
        EGL_ALPHA_SIZE,
        8,
        EGL_NONE,
    ];
    let mut config = ptr::null_mut();
    let mut count = 0_i32;
    let ok = unsafe { (egl.choose_config)(display, attrs.as_ptr(), &mut config, 1, &mut count) };
    if ok == 0 || count == 0 || config.is_null() {
        return Err(CompositorError::Unavailable(
            "eglChooseConfig found no GLES2 RGBA window config".to_owned(),
        ));
    }
    Ok(config)
}

fn pixel_to_clip_x(x: i32, width: u32) -> f32 {
    (x as f32 / width as f32) * 2.0 - 1.0
}

fn pixel_to_clip_y(y: i32, height: u32) -> f32 {
    1.0 - (y as f32 / height as f32) * 2.0
}

fn detect_drm_driver() -> String {
    match read_link("/sys/class/drm/card0/device/driver/module") {
        Ok(path) => path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("drm")
            .to_owned(),
        Err(_) => "drm".to_owned(),
    }
}

fn open_render_node() -> Result<File, CompositorError> {
    let entries = read_dir("/dev/dri").map_err(|err| {
        CompositorError::Unavailable(format!("failed to list /dev/dri for render node: {err}"))
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("renderD") {
            continue;
        }
        return OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|err| {
                CompositorError::Unavailable(format!(
                    "failed to open DRM render node {}: {err}",
                    path.display()
                ))
            });
    }

    Err(CompositorError::Unavailable(
        "no DRM render node found under /dev/dri".to_owned(),
    ))
}

const fn fourcc_code(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}

fn last_os_unavailable(context: &str) -> CompositorError {
    CompositorError::Unavailable(format!("{context}: {}", std::io::Error::last_os_error()))
}

fn cstring(value: &str) -> Result<CString, CompositorError> {
    CString::new(value).map_err(|_| CompositorError::Backend("string contained NUL".to_owned()))
}

struct DynamicLibrary {
    handle: *mut c_void,
}

impl DynamicLibrary {
    fn open(names: &[&str]) -> Result<Self, CompositorError> {
        for name in names {
            let c_name = cstring(name)?;
            let handle = unsafe { dlopen(c_name.as_ptr(), RTLD_NOW) };
            if !handle.is_null() {
                return Ok(Self { handle });
            }
        }

        Err(CompositorError::Unavailable(format!(
            "failed to load any of {}",
            names.join(",")
        )))
    }

    fn symbol<T>(&self, name: &str) -> Result<T, CompositorError>
    where
        T: Copy,
    {
        let c_name = cstring(name)?;
        unsafe {
            let symbol = dlsym(self.handle, c_name.as_ptr());
            if symbol.is_null() {
                let reason = dl_last_error();
                return Err(CompositorError::Unavailable(format!(
                    "missing symbol {name}: {reason}"
                )));
            }
            Ok(mem::transmute_copy::<*mut c_void, T>(&symbol))
        }
    }
}

impl Drop for DynamicLibrary {
    fn drop(&mut self) {
        unsafe {
            if !self.handle.is_null() {
                dlclose(self.handle);
            }
        }
    }
}

fn dl_last_error() -> String {
    unsafe {
        let error = dlerror();
        if error.is_null() {
            "unknown dlerror".to_owned()
        } else {
            CStr::from_ptr(error).to_string_lossy().into_owned()
        }
    }
}

struct DrmMode {
    _lib: DynamicLibrary,
    get_resources: unsafe extern "C" fn(c_int) -> *mut DrmModeRes,
    free_resources: unsafe extern "C" fn(*mut DrmModeRes),
    get_connector: unsafe extern "C" fn(c_int, u32) -> *mut DrmModeConnector,
    free_connector: unsafe extern "C" fn(*mut DrmModeConnector),
    get_encoder: unsafe extern "C" fn(c_int, u32) -> *mut DrmModeEncoder,
    free_encoder: unsafe extern "C" fn(*mut DrmModeEncoder),
    get_crtc: unsafe extern "C" fn(c_int, u32) -> *mut DrmModeCrtc,
    free_crtc: unsafe extern "C" fn(*mut DrmModeCrtc),
    add_fb2: unsafe extern "C" fn(
        c_int,
        u32,
        u32,
        u32,
        *const u32,
        *const u32,
        *const u32,
        *mut u32,
        u32,
    ) -> c_int,
    rm_fb: unsafe extern "C" fn(c_int, u32) -> c_int,
    set_crtc: unsafe extern "C" fn(
        c_int,
        u32,
        u32,
        u32,
        u32,
        *const u32,
        c_int,
        *const DrmModeModeInfo,
    ) -> c_int,
    page_flip: unsafe extern "C" fn(c_int, u32, u32, u32, *mut c_void) -> c_int,
    handle_event: unsafe extern "C" fn(c_int, *mut DrmEventContext) -> c_int,
}

impl DrmMode {
    fn open() -> Result<Self, CompositorError> {
        let lib = DynamicLibrary::open(&["libdrm.so.2", "libdrm.so"])?;
        let get_resources = lib.symbol("drmModeGetResources")?;
        let free_resources = lib.symbol("drmModeFreeResources")?;
        let get_connector = lib.symbol("drmModeGetConnector")?;
        let free_connector = lib.symbol("drmModeFreeConnector")?;
        let get_encoder = lib.symbol("drmModeGetEncoder")?;
        let free_encoder = lib.symbol("drmModeFreeEncoder")?;
        let get_crtc = lib.symbol("drmModeGetCrtc")?;
        let free_crtc = lib.symbol("drmModeFreeCrtc")?;
        let add_fb2 = lib.symbol("drmModeAddFB2")?;
        let rm_fb = lib.symbol("drmModeRmFB")?;
        let set_crtc = lib.symbol("drmModeSetCrtc")?;
        let page_flip = lib.symbol("drmModePageFlip")?;
        let handle_event = lib.symbol("drmHandleEvent")?;
        Ok(Self {
            _lib: lib,
            get_resources,
            free_resources,
            get_connector,
            free_connector,
            get_encoder,
            free_encoder,
            get_crtc,
            free_crtc,
            add_fb2,
            rm_fb,
            set_crtc,
            page_flip,
            handle_event,
        })
    }
}

struct SavedCrtc {
    crtc_id: u32,
    buffer_id: u32,
    x: u32,
    y: u32,
    mode_valid: bool,
    mode: DrmModeModeInfo,
}

struct KmsState {
    drm: DrmMode,
    connector_id: u32,
    crtc_id: u32,
    mode: DrmModeModeInfo,
    scanout_width: u32,
    scanout_height: u32,
    original: Option<SavedCrtc>,
    current_fb: u32,
    current_bo: *mut c_void,
}

impl KmsState {
    fn open(fd: c_int) -> Result<Self, CompositorError> {
        let drm = DrmMode::open()?;
        let selection = select_kms_mode(fd, &drm)?;
        Ok(Self {
            drm,
            connector_id: selection.connector_id,
            crtc_id: selection.crtc_id,
            mode: selection.mode,
            scanout_width: u32::from(selection.mode.hdisplay),
            scanout_height: u32::from(selection.mode.vdisplay),
            original: selection.original,
            current_fb: 0,
            current_bo: ptr::null_mut(),
        })
    }

    fn present(
        &mut self,
        fd: c_int,
        gbm: &Gbm,
        gbm_surface: *mut c_void,
    ) -> Result<(), CompositorError> {
        let bo = unsafe { (gbm.surface_lock_front_buffer)(gbm_surface) };
        if bo.is_null() {
            return Err(CompositorError::Unavailable(
                "gbm_surface_lock_front_buffer returned null".to_owned(),
            ));
        }

        let fb = match self.add_framebuffer(fd, gbm, bo) {
            Ok(fb) => fb,
            Err(err) => {
                unsafe {
                    (gbm.surface_release_buffer)(gbm_surface, bo);
                }
                return Err(err);
            }
        };

        let present_result = if self.current_fb == 0 {
            self.set_initial_crtc(fd, fb)
        } else {
            self.page_flip(fd, fb)
        };

        if let Err(err) = present_result {
            unsafe {
                (self.drm.rm_fb)(fd, fb);
                (gbm.surface_release_buffer)(gbm_surface, bo);
            }
            return Err(err);
        }

        if self.current_fb != 0 {
            unsafe {
                (self.drm.rm_fb)(fd, self.current_fb);
            }
        }
        if !self.current_bo.is_null() {
            unsafe {
                (gbm.surface_release_buffer)(gbm_surface, self.current_bo);
            }
        }
        self.current_fb = fb;
        self.current_bo = bo;
        Ok(())
    }

    fn restore_and_release(&mut self, fd: c_int, gbm: &Gbm, gbm_surface: *mut c_void) {
        if let Some(original) = &self.original {
            if original.mode_valid {
                let connector = self.connector_id;
                unsafe {
                    (self.drm.set_crtc)(
                        fd,
                        original.crtc_id,
                        original.buffer_id,
                        original.x,
                        original.y,
                        &connector,
                        1,
                        &original.mode,
                    );
                }
            }
        }
        if self.current_fb != 0 {
            unsafe {
                (self.drm.rm_fb)(fd, self.current_fb);
            }
            self.current_fb = 0;
        }
        if !self.current_bo.is_null() && !gbm_surface.is_null() {
            unsafe {
                (gbm.surface_release_buffer)(gbm_surface, self.current_bo);
            }
            self.current_bo = ptr::null_mut();
        }
    }

    fn add_framebuffer(
        &self,
        fd: c_int,
        gbm: &Gbm,
        bo: *mut c_void,
    ) -> Result<u32, CompositorError> {
        let handle = unsafe { (gbm.bo_get_handle)(bo).u32_value };
        let stride = unsafe { (gbm.bo_get_stride)(bo) };
        let handles = [handle, 0, 0, 0];
        let pitches = [stride, 0, 0, 0];
        let offsets = [0_u32, 0, 0, 0];
        let mut fb = 0_u32;
        let rc = unsafe {
            (self.drm.add_fb2)(
                fd,
                self.scanout_width,
                self.scanout_height,
                GBM_FORMAT_ARGB8888,
                handles.as_ptr(),
                pitches.as_ptr(),
                offsets.as_ptr(),
                &mut fb,
                0,
            )
        };
        if rc != 0 {
            return Err(last_os_unavailable("drmModeAddFB2(scanout) failed"));
        }
        Ok(fb)
    }

    fn set_initial_crtc(&self, fd: c_int, fb: u32) -> Result<(), CompositorError> {
        let connector = self.connector_id;
        let rc =
            unsafe { (self.drm.set_crtc)(fd, self.crtc_id, fb, 0, 0, &connector, 1, &self.mode) };
        if rc != 0 {
            return Err(last_os_unavailable(
                "drmModeSetCrtc(scanout) failed; DRM master may be unavailable",
            ));
        }
        Ok(())
    }

    fn page_flip(&self, fd: c_int, fb: u32) -> Result<(), CompositorError> {
        let mut complete = false;
        let rc = unsafe {
            (self.drm.page_flip)(
                fd,
                self.crtc_id,
                fb,
                DRM_MODE_PAGE_FLIP_EVENT,
                (&mut complete as *mut bool).cast(),
            )
        };
        if rc != 0 {
            return Err(last_os_unavailable("drmModePageFlip(scanout) failed"));
        }

        let mut event_context = DrmEventContext {
            version: DRM_EVENT_CONTEXT_VERSION,
            vblank_handler: None,
            page_flip_handler: Some(page_flip_complete),
            page_flip_handler2: None,
            sequence_handler: None,
        };
        for _ in 0..30 {
            if complete {
                return Ok(());
            }
            let mut poll_fd = PollFd {
                fd,
                events: POLLIN,
                revents: 0,
            };
            let poll_rc = unsafe { poll(&mut poll_fd, 1, 100) };
            if poll_rc < 0 {
                return Err(last_os_unavailable("poll(page-flip) failed"));
            }
            if poll_rc > 0 && (poll_fd.revents & POLLIN) != 0 {
                let event_rc = unsafe { (self.drm.handle_event)(fd, &mut event_context) };
                if event_rc != 0 {
                    return Err(last_os_unavailable("drmHandleEvent(page-flip) failed"));
                }
            }
        }

        Err(CompositorError::Unavailable(
            "timed out waiting for KMS page flip".to_owned(),
        ))
    }
}

struct KmsSelection {
    connector_id: u32,
    crtc_id: u32,
    mode: DrmModeModeInfo,
    original: Option<SavedCrtc>,
}

fn select_kms_mode(fd: c_int, drm: &DrmMode) -> Result<KmsSelection, CompositorError> {
    let resources = unsafe { (drm.get_resources)(fd) };
    if resources.is_null() {
        return Err(last_os_unavailable("drmModeGetResources failed"));
    }

    let result = unsafe { select_kms_mode_from_resources(fd, drm, &*resources) };
    unsafe {
        (drm.free_resources)(resources);
    }
    result
}

unsafe fn select_kms_mode_from_resources(
    fd: c_int,
    drm: &DrmMode,
    resources: &DrmModeRes,
) -> Result<KmsSelection, CompositorError> {
    let connectors = raw_u32_slice(resources.connectors, resources.count_connectors);
    let crtcs = raw_u32_slice(resources.crtcs, resources.count_crtcs);
    if connectors.is_empty() || crtcs.is_empty() {
        return Err(CompositorError::Unavailable(
            "DRM/KMS device has no connectors or CRTCs".to_owned(),
        ));
    }

    for connector_id in connectors {
        let connector = (drm.get_connector)(fd, *connector_id);
        if connector.is_null() {
            continue;
        }
        let selected = select_connected_connector(fd, drm, &*connector, crtcs);
        (drm.free_connector)(connector);
        if let Some(selected) = selected {
            return selected;
        }
    }

    Err(CompositorError::Unavailable(
        "no connected DRM/KMS connector with a compatible CRTC".to_owned(),
    ))
}

unsafe fn select_connected_connector(
    fd: c_int,
    drm: &DrmMode,
    connector: &DrmModeConnector,
    crtcs: &[u32],
) -> Option<Result<KmsSelection, CompositorError>> {
    if connector.connection != DRM_MODE_CONNECTED || connector.count_modes <= 0 {
        return None;
    }
    let modes = raw_mode_slice(connector.modes, connector.count_modes);
    let mode = *modes.first()?;
    let encoder = find_connector_encoder(fd, drm, connector)?;
    let crtc_id = choose_crtc_id(&encoder, crtcs)?;
    let original = saved_crtc(fd, drm, crtc_id);
    Some(Ok(KmsSelection {
        connector_id: connector.connector_id,
        crtc_id,
        mode,
        original,
    }))
}

unsafe fn find_connector_encoder(
    fd: c_int,
    drm: &DrmMode,
    connector: &DrmModeConnector,
) -> Option<DrmModeEncoder> {
    if connector.encoder_id != 0 {
        let encoder = (drm.get_encoder)(fd, connector.encoder_id);
        if !encoder.is_null() {
            let value = copy_encoder(encoder);
            (drm.free_encoder)(encoder);
            if value.possible_crtcs != 0 || value.crtc_id != 0 {
                return Some(value);
            }
        }
    }

    for encoder_id in raw_u32_slice(connector.encoders, connector.count_encoders) {
        let encoder = (drm.get_encoder)(fd, *encoder_id);
        if encoder.is_null() {
            continue;
        }
        let value = copy_encoder(encoder);
        (drm.free_encoder)(encoder);
        if value.possible_crtcs != 0 || value.crtc_id != 0 {
            return Some(value);
        }
    }

    None
}

unsafe fn copy_encoder(encoder: *mut DrmModeEncoder) -> DrmModeEncoder {
    let value = &*encoder;
    DrmModeEncoder {
        encoder_id: value.encoder_id,
        encoder_type: value.encoder_type,
        crtc_id: value.crtc_id,
        possible_crtcs: value.possible_crtcs,
        possible_clones: value.possible_clones,
    }
}

fn choose_crtc_id(encoder: &DrmModeEncoder, crtcs: &[u32]) -> Option<u32> {
    if encoder.crtc_id != 0 && crtcs.contains(&encoder.crtc_id) {
        return Some(encoder.crtc_id);
    }
    for (index, crtc_id) in crtcs.iter().enumerate() {
        if index < u32::BITS as usize && (encoder.possible_crtcs & (1_u32 << index)) != 0 {
            return Some(*crtc_id);
        }
    }
    None
}

unsafe fn saved_crtc(fd: c_int, drm: &DrmMode, crtc_id: u32) -> Option<SavedCrtc> {
    let crtc = (drm.get_crtc)(fd, crtc_id);
    if crtc.is_null() {
        return None;
    }
    let value = &*crtc;
    let saved = SavedCrtc {
        crtc_id: value.crtc_id,
        buffer_id: value.buffer_id,
        x: value.x,
        y: value.y,
        mode_valid: value.mode_valid != 0,
        mode: value.mode,
    };
    (drm.free_crtc)(crtc);
    Some(saved)
}

unsafe fn raw_u32_slice<'a>(ptr: *const u32, count: c_int) -> &'a [u32] {
    if ptr.is_null() || count <= 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, count as usize)
    }
}

unsafe fn raw_mode_slice<'a>(ptr: *const DrmModeModeInfo, count: c_int) -> &'a [DrmModeModeInfo] {
    if ptr.is_null() || count <= 0 {
        &[]
    } else {
        slice::from_raw_parts(ptr, count as usize)
    }
}

unsafe extern "C" fn page_flip_complete(
    _fd: c_int,
    _sequence: u32,
    _tv_sec: u32,
    _tv_usec: u32,
    user_data: *mut c_void,
) {
    if !user_data.is_null() {
        *(user_data.cast::<bool>()) = true;
    }
}

struct Gbm {
    _lib: DynamicLibrary,
    create_device: unsafe extern "C" fn(c_int) -> *mut c_void,
    destroy_device: unsafe extern "C" fn(*mut c_void),
    surface_create: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32) -> *mut c_void,
    surface_destroy: unsafe extern "C" fn(*mut c_void),
    surface_lock_front_buffer: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    surface_release_buffer: unsafe extern "C" fn(*mut c_void, *mut c_void),
    bo_get_handle: unsafe extern "C" fn(*mut c_void) -> GbmBoHandle,
    bo_get_stride: unsafe extern "C" fn(*mut c_void) -> u32,
}

impl Gbm {
    fn open() -> Result<Self, CompositorError> {
        let lib = DynamicLibrary::open(&["libgbm.so.1", "libgbm.so"])?;
        let create_device = lib.symbol("gbm_create_device")?;
        let destroy_device = lib.symbol("gbm_device_destroy")?;
        let surface_create = lib.symbol("gbm_surface_create")?;
        let surface_destroy = lib.symbol("gbm_surface_destroy")?;
        let surface_lock_front_buffer = lib.symbol("gbm_surface_lock_front_buffer")?;
        let surface_release_buffer = lib.symbol("gbm_surface_release_buffer")?;
        let bo_get_handle = lib.symbol("gbm_bo_get_handle")?;
        let bo_get_stride = lib.symbol("gbm_bo_get_stride")?;
        Ok(Self {
            _lib: lib,
            create_device,
            destroy_device,
            surface_create,
            surface_destroy,
            surface_lock_front_buffer,
            surface_release_buffer,
            bo_get_handle,
            bo_get_stride,
        })
    }
}

struct Egl {
    _lib: DynamicLibrary,
    get_proc_address: EglGetProcAddress,
    get_platform_display_ext: unsafe extern "C" fn(u32, *mut c_void, *const i32) -> EglDisplay,
    initialize: unsafe extern "C" fn(EglDisplay, *mut i32, *mut i32) -> EglBoolean,
    bind_api: unsafe extern "C" fn(u32) -> EglBoolean,
    choose_config:
        unsafe extern "C" fn(EglDisplay, *const i32, *mut EglConfig, i32, *mut i32) -> EglBoolean,
    create_context:
        unsafe extern "C" fn(EglDisplay, EglConfig, EglContext, *const i32) -> EglContext,
    create_window_surface:
        unsafe extern "C" fn(EglDisplay, EglConfig, *mut c_void, *const i32) -> EglSurface,
    make_current:
        unsafe extern "C" fn(EglDisplay, EglSurface, EglSurface, EglContext) -> EglBoolean,
    swap_buffers: unsafe extern "C" fn(EglDisplay, EglSurface) -> EglBoolean,
    destroy_surface: unsafe extern "C" fn(EglDisplay, EglSurface) -> EglBoolean,
    destroy_context: unsafe extern "C" fn(EglDisplay, EglContext) -> EglBoolean,
    terminate: unsafe extern "C" fn(EglDisplay) -> EglBoolean,
}

impl Egl {
    fn open() -> Result<Self, CompositorError> {
        let lib = DynamicLibrary::open(&["libEGL.so.1", "libEGL.so"])?;
        let get_proc_address: EglGetProcAddress = lib.symbol("eglGetProcAddress")?;
        let get_platform_display_ext = {
            let name = cstring("eglGetPlatformDisplayEXT")?;
            let symbol = unsafe { get_proc_address(name.as_ptr()) };
            if symbol.is_null() {
                return Err(CompositorError::Unavailable(
                    "eglGetPlatformDisplayEXT unavailable".to_owned(),
                ));
            }
            unsafe {
                mem::transmute_copy::<
                    *mut c_void,
                    unsafe extern "C" fn(u32, *mut c_void, *const i32) -> EglDisplay,
                >(&symbol)
            }
        };
        let initialize = lib.symbol("eglInitialize")?;
        let bind_api = lib.symbol("eglBindAPI")?;
        let choose_config = lib.symbol("eglChooseConfig")?;
        let create_context = lib.symbol("eglCreateContext")?;
        let create_window_surface = lib.symbol("eglCreateWindowSurface")?;
        let make_current = lib.symbol("eglMakeCurrent")?;
        let swap_buffers = lib.symbol("eglSwapBuffers")?;
        let destroy_surface = lib.symbol("eglDestroySurface")?;
        let destroy_context = lib.symbol("eglDestroyContext")?;
        let terminate = lib.symbol("eglTerminate")?;
        Ok(Self {
            _lib: lib,
            get_proc_address,
            get_platform_display_ext,
            initialize,
            bind_api,
            choose_config,
            create_context,
            create_window_surface,
            make_current,
            swap_buffers,
            destroy_surface,
            destroy_context,
            terminate,
        })
    }
}

struct Gl {
    _lib: DynamicLibrary,
    active_texture: unsafe extern "C" fn(GlEnum),
    attach_shader: unsafe extern "C" fn(GlUInt, GlUInt),
    bind_framebuffer: unsafe extern "C" fn(GlEnum, GlUInt),
    bind_texture: unsafe extern "C" fn(GlEnum, GlUInt),
    blend_func: unsafe extern "C" fn(GlEnum, GlEnum),
    check_framebuffer_status: unsafe extern "C" fn(GlEnum) -> GlEnum,
    clear: unsafe extern "C" fn(GlEnum),
    clear_color: unsafe extern "C" fn(GlFloat, GlFloat, GlFloat, GlFloat),
    compile_shader: unsafe extern "C" fn(GlUInt),
    create_program: unsafe extern "C" fn() -> GlUInt,
    create_shader: unsafe extern "C" fn(GlEnum) -> GlUInt,
    delete_framebuffers: unsafe extern "C" fn(GlSizeI, *const GlUInt),
    delete_program: unsafe extern "C" fn(GlUInt),
    delete_shader: unsafe extern "C" fn(GlUInt),
    delete_textures: unsafe extern "C" fn(GlSizeI, *const GlUInt),
    disable: unsafe extern "C" fn(GlEnum),
    draw_arrays: unsafe extern "C" fn(GlEnum, GlInt, GlSizeI),
    enable: unsafe extern "C" fn(GlEnum),
    enable_vertex_attrib_array: unsafe extern "C" fn(GlUInt),
    flush: unsafe extern "C" fn(),
    framebuffer_texture_2d: unsafe extern "C" fn(GlEnum, GlEnum, GlEnum, GlUInt, GlInt),
    gen_framebuffers: unsafe extern "C" fn(GlSizeI, *mut GlUInt),
    gen_textures: unsafe extern "C" fn(GlSizeI, *mut GlUInt),
    get_attrib_location: unsafe extern "C" fn(GlUInt, *const c_char) -> GlInt,
    get_program_iv: unsafe extern "C" fn(GlUInt, GlEnum, *mut GlInt),
    get_shader_iv: unsafe extern "C" fn(GlUInt, GlEnum, *mut GlInt),
    get_uniform_location: unsafe extern "C" fn(GlUInt, *const c_char) -> GlInt,
    link_program: unsafe extern "C" fn(GlUInt),
    pixel_store_i: unsafe extern "C" fn(GlEnum, GlInt),
    read_pixels: unsafe extern "C" fn(GlInt, GlInt, GlSizeI, GlSizeI, GlEnum, GlEnum, *mut c_void),
    scissor: unsafe extern "C" fn(GlInt, GlInt, GlSizeI, GlSizeI),
    shader_source: unsafe extern "C" fn(GlUInt, GlSizeI, *const *const c_char, *const GlInt),
    tex_image_2d: unsafe extern "C" fn(
        GlEnum,
        GlInt,
        GlInt,
        GlSizeI,
        GlSizeI,
        GlInt,
        GlEnum,
        GlEnum,
        *const c_void,
    ),
    tex_parameter_i: unsafe extern "C" fn(GlEnum, GlEnum, GlInt),
    uniform_1f: unsafe extern "C" fn(GlInt, GlFloat),
    uniform_1i: unsafe extern "C" fn(GlInt, GlInt),
    use_program: unsafe extern "C" fn(GlUInt),
    vertex_attrib_pointer:
        unsafe extern "C" fn(GlUInt, GlInt, GlEnum, GlBool, GlSizeI, *const c_void),
    viewport: unsafe extern "C" fn(GlInt, GlInt, GlSizeI, GlSizeI),
}

impl Gl {
    fn open(egl: &Egl) -> Result<Self, CompositorError> {
        let lib = DynamicLibrary::open(&["libGLESv2.so.2", "libGLESv2.so"])?;
        Ok(Self {
            active_texture: gl_symbol(&lib, egl, "glActiveTexture")?,
            attach_shader: gl_symbol(&lib, egl, "glAttachShader")?,
            bind_framebuffer: gl_symbol(&lib, egl, "glBindFramebuffer")?,
            bind_texture: gl_symbol(&lib, egl, "glBindTexture")?,
            blend_func: gl_symbol(&lib, egl, "glBlendFunc")?,
            check_framebuffer_status: gl_symbol(&lib, egl, "glCheckFramebufferStatus")?,
            clear: gl_symbol(&lib, egl, "glClear")?,
            clear_color: gl_symbol(&lib, egl, "glClearColor")?,
            compile_shader: gl_symbol(&lib, egl, "glCompileShader")?,
            create_program: gl_symbol(&lib, egl, "glCreateProgram")?,
            create_shader: gl_symbol(&lib, egl, "glCreateShader")?,
            delete_framebuffers: gl_symbol(&lib, egl, "glDeleteFramebuffers")?,
            delete_program: gl_symbol(&lib, egl, "glDeleteProgram")?,
            delete_shader: gl_symbol(&lib, egl, "glDeleteShader")?,
            delete_textures: gl_symbol(&lib, egl, "glDeleteTextures")?,
            disable: gl_symbol(&lib, egl, "glDisable")?,
            draw_arrays: gl_symbol(&lib, egl, "glDrawArrays")?,
            enable: gl_symbol(&lib, egl, "glEnable")?,
            enable_vertex_attrib_array: gl_symbol(&lib, egl, "glEnableVertexAttribArray")?,
            flush: gl_symbol(&lib, egl, "glFlush")?,
            framebuffer_texture_2d: gl_symbol(&lib, egl, "glFramebufferTexture2D")?,
            gen_framebuffers: gl_symbol(&lib, egl, "glGenFramebuffers")?,
            gen_textures: gl_symbol(&lib, egl, "glGenTextures")?,
            get_attrib_location: gl_symbol(&lib, egl, "glGetAttribLocation")?,
            get_program_iv: gl_symbol(&lib, egl, "glGetProgramiv")?,
            get_shader_iv: gl_symbol(&lib, egl, "glGetShaderiv")?,
            get_uniform_location: gl_symbol(&lib, egl, "glGetUniformLocation")?,
            link_program: gl_symbol(&lib, egl, "glLinkProgram")?,
            pixel_store_i: gl_symbol(&lib, egl, "glPixelStorei")?,
            read_pixels: gl_symbol(&lib, egl, "glReadPixels")?,
            scissor: gl_symbol(&lib, egl, "glScissor")?,
            shader_source: gl_symbol(&lib, egl, "glShaderSource")?,
            tex_image_2d: gl_symbol(&lib, egl, "glTexImage2D")?,
            tex_parameter_i: gl_symbol(&lib, egl, "glTexParameteri")?,
            uniform_1f: gl_symbol(&lib, egl, "glUniform1f")?,
            uniform_1i: gl_symbol(&lib, egl, "glUniform1i")?,
            use_program: gl_symbol(&lib, egl, "glUseProgram")?,
            vertex_attrib_pointer: gl_symbol(&lib, egl, "glVertexAttribPointer")?,
            viewport: gl_symbol(&lib, egl, "glViewport")?,
            _lib: lib,
        })
    }
}

fn gl_symbol<T>(lib: &DynamicLibrary, egl: &Egl, name: &str) -> Result<T, CompositorError>
where
    T: Copy,
{
    if let Ok(symbol) = lib.symbol(name) {
        return Ok(symbol);
    }

    let c_name = cstring(name)?;
    let symbol = unsafe { (egl.get_proc_address)(c_name.as_ptr()) };
    if symbol.is_null() {
        return Err(CompositorError::Unavailable(format!(
            "missing GL symbol {name}"
        )));
    }
    unsafe { Ok(mem::transmute_copy::<*mut c_void, T>(&symbol)) }
}

struct LibinputState {
    libinput: Libinput,
    context: *mut c_void,
}

impl LibinputState {
    fn open() -> Result<Self, CompositorError> {
        let libinput = Libinput::open()
            .map_err(|err| input_unavailable(format!("failed to load libinput: {err}")))?;
        let context =
            unsafe { (libinput.path_create_context)(&LIBINPUT_INTERFACE, ptr::null_mut()) };
        if context.is_null() {
            return Err(input_unavailable(
                "libinput_path_create_context returned null",
            ));
        }

        match add_default_input_devices(&libinput, context) {
            Ok(_) => {}
            Err(error) => {
                unsafe {
                    (libinput.unref)(context);
                }
                return Err(error);
            }
        };

        Ok(Self { libinput, context })
    }

    fn poll_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
        let libinput = &self.libinput;
        if self.context.is_null() {
            return Err(input_unavailable("libinput context is null"));
        }

        let mut events = Vec::new();
        unsafe {
            if (libinput.dispatch)(self.context) < 0 {
                return Err(input_unavailable("libinput_dispatch failed"));
            }
            loop {
                let event = (libinput.get_event)(self.context);
                if event.is_null() {
                    break;
                }
                let event_type = (libinput.event_get_type)(event);
                match event_type {
                    LIBINPUT_EVENT_KEYBOARD_KEY => {
                        let key_event = (libinput.event_get_keyboard_event)(event);
                        if !key_event.is_null() {
                            events.push(InputEvent::Key {
                                key_code: (libinput.keyboard_get_key)(key_event),
                                pressed: (libinput.keyboard_get_key_state)(key_event)
                                    == LIBINPUT_KEY_STATE_PRESSED,
                            });
                        }
                    }
                    LIBINPUT_EVENT_POINTER_BUTTON => {
                        let pointer_event = (libinput.event_get_pointer_event)(event);
                        if !pointer_event.is_null() {
                            let state = if (libinput.pointer_get_button_state)(pointer_event)
                                == LIBINPUT_BUTTON_STATE_PRESSED
                            {
                                PointerButtonState::Pressed
                            } else {
                                PointerButtonState::Released
                            };
                            events.push(InputEvent::PointerButton {
                                button: (libinput.pointer_get_button)(pointer_event),
                                state,
                            });
                        }
                    }
                    LIBINPUT_EVENT_POINTER_MOTION => {
                        let pointer_event = (libinput.event_get_pointer_event)(event);
                        if !pointer_event.is_null() {
                            let dx = (libinput.pointer_get_dx)(pointer_event);
                            let dy = (libinput.pointer_get_dy)(pointer_event);
                            if dx.is_finite() && dy.is_finite() {
                                events.push(InputEvent::PointerMotion {
                                    dx_micropixels: (dx * 1_000_000.0) as i64,
                                    dy_micropixels: (dy * 1_000_000.0) as i64,
                                });
                            }
                        }
                    }
                    _ => {}
                }
                (libinput.event_destroy)(event);
            }
        }

        Ok(events)
    }
}

impl Drop for LibinputState {
    fn drop(&mut self) {
        if !self.context.is_null() {
            unsafe {
                (self.libinput.unref)(self.context);
            }
        }
    }
}

fn input_unavailable(reason: impl AsRef<str>) -> CompositorError {
    CompositorError::Unavailable(format!("input_unavailable: {}", reason.as_ref()))
}

fn add_default_input_devices(
    libinput: &Libinput,
    context: *mut c_void,
) -> Result<usize, CompositorError> {
    let entries = read_dir("/dev/input")
        .map_err(|err| input_unavailable(format!("failed to list /dev/input: {err}")))?;
    let paths = entries.map(|entry| {
        entry
            .map(|entry| entry.path())
            .map_err(|err| input_unavailable(format!("failed to read /dev/input: {err}")))
    });

    add_selected_input_devices(paths, |path| {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| input_unavailable("input device path contained an interior NUL byte"))?;
        let device = unsafe { (libinput.path_add_device)(context, path.as_ptr()) };
        Ok(!device.is_null())
    })
}

fn add_selected_input_devices<I, F>(paths: I, mut add_device: F) -> Result<usize, CompositorError>
where
    I: IntoIterator<Item = Result<std::path::PathBuf, CompositorError>>,
    F: FnMut(&Path) -> Result<bool, CompositorError>,
{
    let mut selected_count = 0_usize;
    let mut device_count = 0_usize;

    for path in paths {
        let path = path?;
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("event") {
            continue;
        }

        selected_count += 1;
        if !add_device(&path)? {
            return Err(input_unavailable(format!(
                "failed to add selected input device {}",
                path.display()
            )));
        }
        device_count += 1;
    }

    if selected_count == 0 {
        return Err(input_unavailable(
            "no libinput event devices found under /dev/input",
        ));
    }

    Ok(device_count)
}

#[repr(C)]
struct LibinputInterface {
    open_restricted: Option<unsafe extern "C" fn(*const c_char, c_int, *mut c_void) -> c_int>,
    close_restricted: Option<unsafe extern "C" fn(c_int, *mut c_void)>,
}

static LIBINPUT_INTERFACE: LibinputInterface = LibinputInterface {
    open_restricted: Some(libinput_open_restricted),
    close_restricted: Some(libinput_close_restricted),
};

unsafe extern "C" fn libinput_open_restricted(
    path: *const c_char,
    flags: c_int,
    _user_data: *mut c_void,
) -> c_int {
    libc_open(path, flags)
}

unsafe extern "C" fn libinput_close_restricted(fd: c_int, _user_data: *mut c_void) {
    libc_close(fd);
}

struct Libinput {
    _lib: DynamicLibrary,
    path_create_context: unsafe extern "C" fn(*const LibinputInterface, *mut c_void) -> *mut c_void,
    path_add_device: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    dispatch: unsafe extern "C" fn(*mut c_void) -> c_int,
    get_event: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    event_get_type: unsafe extern "C" fn(*mut c_void) -> u32,
    event_destroy: unsafe extern "C" fn(*mut c_void),
    event_get_keyboard_event: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    keyboard_get_key: unsafe extern "C" fn(*mut c_void) -> u32,
    keyboard_get_key_state: unsafe extern "C" fn(*mut c_void) -> u32,
    event_get_pointer_event: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pointer_get_button: unsafe extern "C" fn(*mut c_void) -> u32,
    pointer_get_button_state: unsafe extern "C" fn(*mut c_void) -> u32,
    pointer_get_dx: unsafe extern "C" fn(*mut c_void) -> f64,
    pointer_get_dy: unsafe extern "C" fn(*mut c_void) -> f64,
    unref: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
}

impl Libinput {
    fn open() -> Result<Self, CompositorError> {
        let lib = DynamicLibrary::open(&["libinput.so.10", "libinput.so"])?;
        Ok(Self {
            path_create_context: lib.symbol("libinput_path_create_context")?,
            path_add_device: lib.symbol("libinput_path_add_device")?,
            dispatch: lib.symbol("libinput_dispatch")?,
            get_event: lib.symbol("libinput_get_event")?,
            event_get_type: lib.symbol("libinput_event_get_type")?,
            event_destroy: lib.symbol("libinput_event_destroy")?,
            event_get_keyboard_event: lib.symbol("libinput_event_get_keyboard_event")?,
            keyboard_get_key: lib.symbol("libinput_event_keyboard_get_key")?,
            keyboard_get_key_state: lib.symbol("libinput_event_keyboard_get_key_state")?,
            event_get_pointer_event: lib.symbol("libinput_event_get_pointer_event")?,
            pointer_get_button: lib.symbol("libinput_event_pointer_get_button")?,
            pointer_get_button_state: lib.symbol("libinput_event_pointer_get_button_state")?,
            pointer_get_dx: lib.symbol("libinput_event_pointer_get_dx")?,
            pointer_get_dy: lib.symbol("libinput_event_pointer_get_dy")?,
            unref: lib.symbol("libinput_unref")?,
            _lib: lib,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn selected_input_device_add_failure_is_failsafe_error() {
        let err = add_selected_input_devices(
            input_paths(&[
                "/dev/input/event0",
                "/dev/input/mouse0",
                "/dev/input/event1",
            ]),
            |path| Ok(!path.ends_with("event1")),
        )
        .unwrap_err();

        assert_eq!(
            err,
            CompositorError::Unavailable(
                "input_unavailable: failed to add selected input device /dev/input/event1"
                    .to_owned()
            )
        );
    }

    #[test]
    fn unselected_input_device_is_not_required_to_add() {
        let mut attempted = Vec::new();
        let count = add_selected_input_devices(
            input_paths(&["/dev/input/mouse0", "/dev/input/event0"]),
            |path| {
                attempted.push(path.to_path_buf());
                Ok(true)
            },
        )
        .unwrap();

        assert_eq!(count, 1);
        assert_eq!(attempted, vec![PathBuf::from("/dev/input/event0")]);
    }

    fn input_paths(paths: &[&str]) -> Vec<Result<PathBuf, CompositorError>> {
        paths.iter().map(|path| Ok(PathBuf::from(path))).collect()
    }
}

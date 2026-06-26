use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

pub mod platform;

pub const VITA_COMPOSITOR_MARKER: &str = "VITA-COMPOSITOR";
pub const VITA_INPUT_ROUTE_MARKER: &str = "VITA-INPUT-ROUTE";
pub const DESKTOP_DEMO_OUTPUT_WIDTH: u32 = 1280;
pub const DESKTOP_DEMO_OUTPUT_HEIGHT: u32 = 720;
const INPUT_MICROPIXELS_PER_PIXEL: i128 = 1_000_000;

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CompositorError {
    Backend(String),
    DuplicatePlacement(SurfaceId),
    DuplicateSurface(SurfaceId),
    InvalidBufferLength { expected: usize, actual: usize },
    InvalidDimensions { width: u32, height: u32 },
    InvalidOpacity,
    InvalidSurfaceId(String),
    Protocol(String),
    UnknownSurface(SurfaceId),
    Unavailable(String),
    Verification(String),
}

impl Display for CompositorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backend(reason) => write!(f, "backend error: {reason}"),
            Self::DuplicatePlacement(id) => write!(f, "duplicate placement for surface {id}"),
            Self::DuplicateSurface(id) => write!(f, "duplicate surface {id}"),
            Self::InvalidBufferLength { expected, actual } => write!(
                f,
                "invalid RGBA buffer length {actual} bytes, expected {expected}"
            ),
            Self::InvalidDimensions { width, height } => {
                write!(f, "invalid dimensions {width}x{height}")
            }
            Self::InvalidOpacity => write!(f, "invalid opacity"),
            Self::InvalidSurfaceId(id) => write!(f, "invalid surface id {id:?}"),
            Self::Protocol(reason) => write!(f, "protocol error: {reason}"),
            Self::UnknownSurface(id) => write!(f, "unknown surface {id}"),
            Self::Unavailable(reason) => write!(f, "unavailable: {reason}"),
            Self::Verification(reason) => write!(f, "verification failed: {reason}"),
        }
    }
}

impl Error for CompositorError {}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SurfaceId(String);

impl SurfaceId {
    pub fn new(value: impl Into<String>) -> Result<Self, CompositorError> {
        let value = value.into();

        if value.is_empty() || value.len() > 128 {
            return Err(CompositorError::InvalidSurfaceId(value));
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        {
            return Err(CompositorError::InvalidSurfaceId(value));
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for SurfaceId {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum TextureFormat {
    Rgba8Unorm,
}

impl TextureFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rgba8Unorm => "rgba8-unorm",
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum TextureHandleKind {
    DrmPrimeFd,
    OpaqueNativeTexture,
    TestOnly,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct GpuTextureHandle {
    pub kind: TextureHandleKind,
    pub value: i64,
    pub width: u32,
    pub height: u32,
    pub format: TextureFormat,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SurfaceRegistration {
    pub surface_id: SurfaceId,
    pub texture: GpuTextureHandle,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Result<Self, CompositorError> {
        validate_dimensions(width, height)?;
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub surface_id: SurfaceId,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z_index: i32,
    pub opacity: f32,
}

impl Placement {
    pub fn new(
        surface_id: SurfaceId,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        z_index: i32,
    ) -> Result<Self, CompositorError> {
        Self::with_opacity(surface_id, x, y, width, height, z_index, 1.0)
    }

    pub fn with_opacity(
        surface_id: SurfaceId,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        z_index: i32,
        opacity: f32,
    ) -> Result<Self, CompositorError> {
        validate_dimensions(width, height)?;
        if !(0.0..=1.0).contains(&opacity) || !opacity.is_finite() {
            return Err(CompositorError::InvalidOpacity);
        }

        Ok(Self {
            surface_id,
            x,
            y,
            width,
            height,
            z_index,
            opacity,
        })
    }

    pub fn rect(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum PointerButtonState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum InputEvent {
    Key {
        key_code: u32,
        pressed: bool,
    },
    PointerButton {
        button: u32,
        state: PointerButtonState,
    },
    PointerMotion {
        dx_micropixels: i64,
        dy_micropixels: i64,
    },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct InputRouter {
    cursor_x_micropixels: i128,
    cursor_y_micropixels: i128,
    focus: Option<SurfaceId>,
}

impl InputRouter {
    pub fn new() -> Self {
        Self {
            cursor_x_micropixels: 0,
            cursor_y_micropixels: 0,
            focus: None,
        }
    }

    pub fn cursor(&self) -> (u32, u32) {
        (
            micropixels_to_output_pixel(self.cursor_x_micropixels),
            micropixels_to_output_pixel(self.cursor_y_micropixels),
        )
    }

    pub fn focus(&self) -> Option<&SurfaceId> {
        self.focus.as_ref()
    }

    pub fn set_focus(&mut self, focus: Option<SurfaceId>) {
        self.focus = focus;
    }

    pub fn route_input_event(
        &mut self,
        event: &InputEvent,
        placements: &[Placement],
        output_width: u32,
        output_height: u32,
    ) -> RoutedInputEvent {
        if output_width == 0 || output_height == 0 {
            return self.dropped(RoutedInputDropReason::InvalidOutputBounds);
        }

        match event {
            InputEvent::PointerMotion {
                dx_micropixels,
                dy_micropixels,
            } => {
                self.cursor_x_micropixels = self
                    .cursor_x_micropixels
                    .saturating_add(*dx_micropixels as i128);
                self.cursor_y_micropixels = self
                    .cursor_y_micropixels
                    .saturating_add(*dy_micropixels as i128);
                self.clamp_cursor(output_width, output_height);

                let (cursor_x, cursor_y) = self.cursor();
                match topmost_placement_at(placements, cursor_x, cursor_y).and_then(|placement| {
                    placement_local_coordinates(placement, cursor_x, cursor_y)
                }) {
                    Some((surface_id, local_x, local_y)) => RoutedInputEvent::PointerMotion {
                        surface_id,
                        local_x,
                        local_y,
                        cursor_x,
                        cursor_y,
                        dx_micropixels: *dx_micropixels,
                        dy_micropixels: *dy_micropixels,
                    },
                    None => self.dropped(RoutedInputDropReason::NoSurfaceAtCursor),
                }
            }
            InputEvent::PointerButton { button, state } => {
                self.clamp_cursor(output_width, output_height);

                let (cursor_x, cursor_y) = self.cursor();
                match topmost_placement_at(placements, cursor_x, cursor_y).and_then(|placement| {
                    placement_local_coordinates(placement, cursor_x, cursor_y)
                }) {
                    Some((surface_id, local_x, local_y)) => {
                        if *state == PointerButtonState::Pressed {
                            self.focus = Some(surface_id.clone());
                        }
                        RoutedInputEvent::PointerButton {
                            surface_id,
                            local_x,
                            local_y,
                            cursor_x,
                            cursor_y,
                            button: *button,
                            state: *state,
                        }
                    }
                    None => self.dropped(RoutedInputDropReason::NoSurfaceAtCursor),
                }
            }
            InputEvent::Key { key_code, pressed } => match self.focus.clone() {
                Some(surface_id) => RoutedInputEvent::Key {
                    surface_id,
                    key_code: *key_code,
                    pressed: *pressed,
                },
                None => self.dropped(RoutedInputDropReason::NoFocusedSurface),
            },
        }
    }

    fn clamp_cursor(&mut self, output_width: u32, output_height: u32) {
        let max_x = ((output_width - 1) as i128) * INPUT_MICROPIXELS_PER_PIXEL;
        let max_y = ((output_height - 1) as i128) * INPUT_MICROPIXELS_PER_PIXEL;
        self.cursor_x_micropixels = self.cursor_x_micropixels.clamp(0, max_x);
        self.cursor_y_micropixels = self.cursor_y_micropixels.clamp(0, max_y);
    }

    fn dropped(&self, reason: RoutedInputDropReason) -> RoutedInputEvent {
        let (cursor_x, cursor_y) = self.cursor();
        RoutedInputEvent::Dropped {
            reason,
            cursor_x,
            cursor_y,
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum RoutedInputEvent {
    PointerMotion {
        surface_id: SurfaceId,
        local_x: u32,
        local_y: u32,
        cursor_x: u32,
        cursor_y: u32,
        dx_micropixels: i64,
        dy_micropixels: i64,
    },
    PointerButton {
        surface_id: SurfaceId,
        local_x: u32,
        local_y: u32,
        cursor_x: u32,
        cursor_y: u32,
        button: u32,
        state: PointerButtonState,
    },
    Key {
        surface_id: SurfaceId,
        key_code: u32,
        pressed: bool,
    },
    Dropped {
        reason: RoutedInputDropReason,
        cursor_x: u32,
        cursor_y: u32,
    },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum RoutedInputDropReason {
    InvalidOutputBounds,
    NoSurfaceAtCursor,
    NoFocusedSurface,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct InputRoutingSelfTestReport {
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub target: Option<SurfaceId>,
    pub focus: Option<SurfaceId>,
    pub status_ok: bool,
}

impl InputRoutingSelfTestReport {
    pub fn marker_line(&self) -> String {
        format!(
            "{VITA_INPUT_ROUTE_MARKER}: cursor={},{} target={} focus={} status={}",
            self.cursor_x,
            self.cursor_y,
            marker_surface(self.target.as_ref()),
            marker_surface(self.focus.as_ref()),
            if self.status_ok { "OK" } else { "FAIL" }
        )
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum TestPattern {
    Solid { rgba: [u8; 4] },
    Checkerboard { a: [u8; 4], b: [u8; 4], tile: u32 },
}

impl TestPattern {
    pub fn rgba_bytes(&self, width: u32, height: u32) -> Result<Vec<u8>, CompositorError> {
        validate_dimensions(width, height)?;
        let pixel_count = width
            .checked_mul(height)
            .ok_or(CompositorError::InvalidDimensions { width, height })?;
        let byte_count = pixel_count
            .checked_mul(4)
            .ok_or(CompositorError::InvalidDimensions { width, height })?;
        let mut bytes = vec![0_u8; byte_count as usize];

        match self {
            Self::Solid { rgba } => {
                for pixel in bytes.chunks_exact_mut(4) {
                    pixel.copy_from_slice(rgba);
                }
            }
            Self::Checkerboard { a, b, tile } => {
                if *tile == 0 {
                    return Err(CompositorError::InvalidDimensions { width, height });
                }
                for y in 0..height {
                    for x in 0..width {
                        let tile_x = x / *tile;
                        let tile_y = y / *tile;
                        let color = if (tile_x + tile_y) % 2 == 0 { a } else { b };
                        let offset = ((y * width + x) * 4) as usize;
                        bytes[offset..offset + 4].copy_from_slice(color);
                    }
                }
            }
        }

        Ok(bytes)
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DamageReport {
    pub changed_surfaces: Vec<SurfaceId>,
    pub rects: Vec<Rect>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CompositeReport {
    pub surfaces: usize,
    pub composited: bool,
    pub damage_rects: usize,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum PresentationModeKind {
    Kms,
    Recording,
    Unverified,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct PresentationMode {
    kind: PresentationModeKind,
}

impl PresentationMode {
    pub const RECORDING: Self = Self {
        kind: PresentationModeKind::Recording,
    };
    pub const UNVERIFIED: Self = Self {
        kind: PresentationModeKind::Unverified,
    };
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) const KMS: Self = Self {
        kind: PresentationModeKind::Kms,
    };

    pub fn marker_token(self) -> &'static str {
        match self.kind {
            PresentationModeKind::Kms => "kms",
            PresentationModeKind::Recording => "recording",
            PresentationModeKind::Unverified => "unverified",
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum InputAvailability {
    Available,
    Unavailable,
    Unverified,
}

impl InputAvailability {
    pub fn marker_token(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Unverified => "unverified",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RenderSurface<T> {
    pub id: SurfaceId,
    pub width: u32,
    pub height: u32,
    pub texture: T,
}

pub trait RenderBackend {
    type Texture: Clone;

    fn backend_name(&self) -> &str;
    fn presentation_mode(&self) -> PresentationMode;
    fn input_availability(&self) -> InputAvailability {
        InputAvailability::Unverified
    }

    fn create_test_texture(
        &mut self,
        width: u32,
        height: u32,
        pattern: &TestPattern,
    ) -> Result<Self::Texture, CompositorError>;

    fn create_buffer_texture(
        &mut self,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<Self::Texture, CompositorError>;

    fn update_texture_rgba(
        &mut self,
        texture: &mut Self::Texture,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), CompositorError>;

    fn export_handle(&self, texture: &Self::Texture) -> GpuTextureHandle;

    fn composite(
        &mut self,
        surfaces: &[RenderSurface<Self::Texture>],
        placements: &[Placement],
        damage: &[Rect],
        output_width: u32,
        output_height: u32,
    ) -> Result<CompositeReport, CompositorError>;

    fn read_texture_rgba_for_test(
        &mut self,
        texture: &Self::Texture,
    ) -> Result<Vec<u8>, CompositorError>;

    fn read_output_rgba(
        &mut self,
        output_width: u32,
        output_height: u32,
    ) -> Result<Vec<u8>, CompositorError>;

    fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError>;

    fn source_repaint_count(&self) -> u64;
}

#[derive(Debug, Clone)]
struct SurfaceState<T> {
    id: SurfaceId,
    width: u32,
    height: u32,
    texture: T,
}

pub struct Compositor<B: RenderBackend> {
    backend: B,
    output_width: u32,
    output_height: u32,
    surfaces: BTreeMap<SurfaceId, SurfaceState<B::Texture>>,
    placements: Vec<Placement>,
    focus: Option<SurfaceId>,
    input_router: InputRouter,
}

impl<B: RenderBackend> Compositor<B> {
    pub fn new(backend: B, output_width: u32, output_height: u32) -> Result<Self, CompositorError> {
        validate_dimensions(output_width, output_height)?;
        Ok(Self {
            backend,
            output_width,
            output_height,
            surfaces: BTreeMap::new(),
            placements: Vec::new(),
            focus: None,
            input_router: InputRouter::new(),
        })
    }

    pub fn backend_name(&self) -> &str {
        self.backend.backend_name()
    }

    pub fn presentation_mode(&self) -> PresentationMode {
        self.backend.presentation_mode()
    }

    pub fn register_test_surface(
        &mut self,
        id: SurfaceId,
        width: u32,
        height: u32,
        pattern: TestPattern,
    ) -> Result<SurfaceRegistration, CompositorError> {
        validate_dimensions(width, height)?;
        if self.surfaces.contains_key(&id) {
            return Err(CompositorError::DuplicateSurface(id));
        }

        let texture = self.backend.create_test_texture(width, height, &pattern)?;
        let handle = self.backend.export_handle(&texture);
        self.surfaces.insert(
            id.clone(),
            SurfaceState {
                id: id.clone(),
                width,
                height,
                texture,
            },
        );

        Ok(SurfaceRegistration {
            surface_id: id,
            texture: handle,
        })
    }

    pub fn register_buffer_surface(
        &mut self,
        id: SurfaceId,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<SurfaceRegistration, CompositorError> {
        validate_rgba_buffer(width, height, rgba)?;
        if self.surfaces.contains_key(&id) {
            return Err(CompositorError::DuplicateSurface(id));
        }

        let texture = self.backend.create_buffer_texture(width, height, rgba)?;
        let handle = self.backend.export_handle(&texture);
        self.surfaces.insert(
            id.clone(),
            SurfaceState {
                id: id.clone(),
                width,
                height,
                texture,
            },
        );

        Ok(SurfaceRegistration {
            surface_id: id,
            texture: handle,
        })
    }

    pub fn update_buffer_surface(
        &mut self,
        id: &SurfaceId,
        rgba: &[u8],
    ) -> Result<DamageReport, CompositorError> {
        let surface = self
            .surfaces
            .get_mut(id)
            .ok_or_else(|| CompositorError::UnknownSurface(id.clone()))?;
        validate_rgba_buffer(surface.width, surface.height, rgba)?;
        self.backend.update_texture_rgba(
            &mut surface.texture,
            surface.width,
            surface.height,
            rgba,
        )?;

        let mut rects = Vec::new();
        for placement in &self.placements {
            if &placement.surface_id == id {
                push_unique_rect(&mut rects, placement.rect());
            }
        }

        Ok(DamageReport {
            changed_surfaces: vec![id.clone()],
            rects,
        })
    }

    pub fn update_placements(
        &mut self,
        mut placements: Vec<Placement>,
    ) -> Result<DamageReport, CompositorError> {
        let mut seen = BTreeSet::new();
        for placement in &placements {
            if !self.surfaces.contains_key(&placement.surface_id) {
                return Err(CompositorError::UnknownSurface(
                    placement.surface_id.clone(),
                ));
            }
            if !seen.insert(placement.surface_id.clone()) {
                return Err(CompositorError::DuplicatePlacement(
                    placement.surface_id.clone(),
                ));
            }
        }

        placements.sort_by(|left, right| {
            left.z_index
                .cmp(&right.z_index)
                .then_with(|| left.surface_id.cmp(&right.surface_id))
        });

        let old_by_id = placement_map(&self.placements);
        let new_by_id = placement_map(&placements);
        let mut ids = BTreeSet::new();
        ids.extend(old_by_id.keys().cloned());
        ids.extend(new_by_id.keys().cloned());

        let mut changed_surfaces = Vec::new();
        let mut rects = Vec::new();
        for id in ids {
            let old = old_by_id.get(&id);
            let new = new_by_id.get(&id);
            if old == new {
                continue;
            }
            changed_surfaces.push(id);
            if let Some(old_placement) = old {
                push_unique_rect(&mut rects, old_placement.rect());
            }
            if let Some(new_placement) = new {
                push_unique_rect(&mut rects, new_placement.rect());
            }
        }

        self.placements = placements;
        Ok(DamageReport {
            changed_surfaces,
            rects,
        })
    }

    pub fn remove_surface(&mut self, id: &SurfaceId) -> Result<DamageReport, CompositorError> {
        if self.surfaces.remove(id).is_none() {
            return Err(CompositorError::UnknownSurface(id.clone()));
        }

        if self.focus.as_ref() == Some(id) {
            self.focus = None;
            self.input_router.set_focus(None);
        }

        let mut changed_surfaces = Vec::new();
        let mut rects = Vec::new();
        self.placements.retain(|placement| {
            if &placement.surface_id == id {
                changed_surfaces.push(placement.surface_id.clone());
                push_unique_rect(&mut rects, placement.rect());
                false
            } else {
                true
            }
        });

        Ok(DamageReport {
            changed_surfaces,
            rects,
        })
    }

    pub fn composite(&mut self, damage: &DamageReport) -> Result<CompositeReport, CompositorError> {
        let surfaces = self
            .surfaces
            .values()
            .map(|surface| RenderSurface {
                id: surface.id.clone(),
                width: surface.width,
                height: surface.height,
                texture: surface.texture.clone(),
            })
            .collect::<Vec<_>>();

        self.backend.composite(
            &surfaces,
            &self.placements,
            &damage.rects,
            self.output_width,
            self.output_height,
        )
    }

    pub fn set_focus(&mut self, focus: Option<SurfaceId>) -> Result<(), CompositorError> {
        if let Some(id) = &focus {
            if !self.surfaces.contains_key(id) {
                return Err(CompositorError::UnknownSurface(id.clone()));
            }
        }
        self.focus = focus.clone();
        self.input_router.set_focus(focus);
        Ok(())
    }

    pub fn focus(&self) -> Option<&SurfaceId> {
        self.focus.as_ref()
    }

    pub fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
        self.backend.poll_input_events()
    }

    pub fn route_input_event(
        &mut self,
        event: &InputEvent,
    ) -> Result<RoutedInputEvent, CompositorError> {
        self.input_router.set_focus(self.focus.clone());
        let routed = self.input_router.route_input_event(
            event,
            &self.placements,
            self.output_width,
            self.output_height,
        );
        let routed_focus = self.input_router.focus().cloned();
        if self.focus.as_ref() != routed_focus.as_ref() {
            self.set_focus(routed_focus)?;
        }
        Ok(routed)
    }

    pub fn surface_readback_rgba_for_test(
        &mut self,
        id: &SurfaceId,
    ) -> Result<Vec<u8>, CompositorError> {
        let texture = self
            .surfaces
            .get(id)
            .ok_or_else(|| CompositorError::UnknownSurface(id.clone()))?
            .texture
            .clone();
        self.backend.read_texture_rgba_for_test(&texture)
    }

    pub fn output_readback_rgba(&mut self) -> Result<Vec<u8>, CompositorError> {
        self.backend
            .read_output_rgba(self.output_width, self.output_height)
    }

    pub fn write_output_png(&mut self, path: impl AsRef<Path>) -> Result<(), CompositorError> {
        let rgba = self.output_readback_rgba()?;
        write_rgba_png(path, self.output_width, self.output_height, &rgba)
    }

    pub fn source_repaint_count(&self) -> u64 {
        self.backend.source_repaint_count()
    }

    pub fn surface_count(&self) -> usize {
        self.surfaces.len()
    }

    pub fn has_surface(&self, id: &SurfaceId) -> bool {
        self.surfaces.contains_key(id)
    }

    pub fn surface_rgba_byte_len(&self, id: &SurfaceId) -> Result<usize, CompositorError> {
        let surface = self
            .surfaces
            .get(id)
            .ok_or_else(|| CompositorError::UnknownSurface(id.clone()))?;
        rgba_buffer_byte_len(surface.width, surface.height)
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SelfTestReport {
    pub gpu: String,
    pub surfaces: usize,
    pub composited_ok: bool,
    pub reposition_no_repaint: bool,
    pub present: PresentationMode,
    pub damage_ok: bool,
    pub input: InputAvailability,
    pub status: SelfTestStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum SelfTestStatus {
    Ok,
    Failsafe,
}

impl SelfTestReport {
    pub fn marker_line(&self) -> String {
        match self.status {
            SelfTestStatus::Ok => format!(
                "{VITA_COMPOSITOR_MARKER}: gpu={} surfaces={} composited=OK reposition=no-repaint present={} damage=OK status=OK input={}",
                marker_token(&self.gpu),
                self.surfaces,
                self.present.marker_token(),
                self.input.marker_token()
            ),
            SelfTestStatus::Failsafe => format!(
                "{VITA_COMPOSITOR_MARKER}: gpu={} surfaces={} composited={} reposition={} present={} damage={} status=FAILSAFE reason={} input={}",
                marker_token(&self.gpu),
                self.surfaces,
                if self.composited_ok { "OK" } else { "FAIL" },
                if self.reposition_no_repaint {
                    "no-repaint"
                } else {
                    "unverified"
                },
                self.present.marker_token(),
                if self.damage_ok { "OK" } else { "FAIL" },
                marker_token(self.reason.as_deref().unwrap_or("unavailable")),
                self.input.marker_token()
            ),
        }
    }
}

pub fn failsafe_report(gpu: impl Into<String>, reason: impl Into<String>) -> SelfTestReport {
    failsafe_report_for_gpu(
        gpu,
        PresentationMode::UNVERIFIED,
        InputAvailability::Unverified,
        reason,
    )
}

fn failsafe_report_for_gpu(
    gpu: impl Into<String>,
    present: PresentationMode,
    input: InputAvailability,
    reason: impl Into<String>,
) -> SelfTestReport {
    SelfTestReport {
        gpu: gpu.into(),
        surfaces: 0,
        composited_ok: false,
        reposition_no_repaint: false,
        present,
        damage_ok: false,
        input,
        status: SelfTestStatus::Failsafe,
        reason: Some(reason.into()),
    }
}

pub fn run_reposition_self_test_or_failsafe<B: RenderBackend>(
    backend: Result<B, CompositorError>,
) -> SelfTestReport {
    let backend = match backend {
        Ok(backend) => backend,
        Err(error) => {
            return failsafe_report("unavailable", failsafe_reason(&error));
        }
    };
    let gpu = backend.backend_name().to_owned();
    let present = backend.presentation_mode();
    let input = backend.input_availability();

    match run_reposition_self_test(backend) {
        Ok(report) => report,
        Err(error) => failsafe_report_for_gpu(gpu, present, input, failsafe_reason(&error)),
    }
}

pub fn run_reposition_self_test<B: RenderBackend>(
    backend: B,
) -> Result<SelfTestReport, CompositorError> {
    let gpu = backend.backend_name().to_owned();
    let input = backend.input_availability();
    let mut compositor = Compositor::new(backend, 96, 64)?;
    let present = compositor.presentation_mode();
    let surface_a = SurfaceId::new("surface-a")?;
    let surface_b = SurfaceId::new("surface-b")?;

    compositor.register_test_surface(
        surface_a.clone(),
        16,
        16,
        TestPattern::Checkerboard {
            a: [255, 0, 0, 255],
            b: [0, 255, 0, 255],
            tile: 4,
        },
    )?;
    compositor.register_test_surface(
        surface_b.clone(),
        12,
        12,
        TestPattern::Solid {
            rgba: [0, 0, 255, 255],
        },
    )?;

    let initial = compositor.update_placements(vec![
        Placement::new(surface_a.clone(), 4, 4, 16, 16, 0)?,
        Placement::new(surface_b, 32, 4, 12, 12, 1)?,
    ])?;
    let initial_report = compositor.composite(&initial)?;
    let before_repaint_count = compositor.source_repaint_count();
    let before = compositor.surface_readback_rgba_for_test(&surface_a)?;

    let moved = compositor.update_placements(vec![
        Placement::new(surface_a.clone(), 40, 24, 16, 16, 0)?,
        Placement::new(SurfaceId::new("surface-b")?, 32, 4, 12, 12, 1)?,
    ])?;
    let moved_report = compositor.composite(&moved)?;
    let after = compositor.surface_readback_rgba_for_test(&surface_a)?;
    let after_repaint_count = compositor.source_repaint_count();

    let damage_ok = moved.rects == vec![Rect::new(4, 4, 16, 16)?, Rect::new(40, 24, 16, 16)?];
    let reposition_no_repaint = before == after && before_repaint_count == after_repaint_count;
    let composited_ok = initial_report.composited && moved_report.composited;

    if !composited_ok {
        return Err(CompositorError::Verification(
            "composite did not complete".to_owned(),
        ));
    }
    if !damage_ok {
        return Err(CompositorError::Verification(
            "move damage did not cover old and new rects".to_owned(),
        ));
    }
    if !reposition_no_repaint {
        return Err(CompositorError::Verification(
            "surface content changed during reposition".to_owned(),
        ));
    }

    Ok(SelfTestReport {
        gpu,
        surfaces: compositor.surface_count(),
        composited_ok,
        reposition_no_repaint,
        present,
        damage_ok,
        input,
        status: SelfTestStatus::Ok,
        reason: None,
    })
}

pub fn run_desktop_demo_or_failsafe<B: RenderBackend>(
    backend: Result<B, CompositorError>,
) -> SelfTestReport {
    start_desktop_demo_or_failsafe(backend).into_report()
}

pub enum DesktopDemoOutcome<B: RenderBackend> {
    Running(DesktopDemoSession<B>),
    Failsafe(SelfTestReport),
}

impl<B: RenderBackend> DesktopDemoOutcome<B> {
    pub fn report(&self) -> &SelfTestReport {
        match self {
            Self::Running(session) => session.report(),
            Self::Failsafe(report) => report,
        }
    }

    pub fn into_report(self) -> SelfTestReport {
        match self {
            Self::Running(session) => session.into_report(),
            Self::Failsafe(report) => report,
        }
    }
}

pub struct DesktopDemoSession<B: RenderBackend> {
    _compositor: Compositor<B>,
    report: SelfTestReport,
}

impl<B: RenderBackend> DesktopDemoSession<B> {
    pub fn report(&self) -> &SelfTestReport {
        &self.report
    }

    pub fn write_screenshot_png(&mut self, path: impl AsRef<Path>) -> Result<(), CompositorError> {
        self._compositor.write_output_png(path)
    }

    pub fn into_report(self) -> SelfTestReport {
        self.report
    }
}

pub fn start_desktop_demo_or_failsafe<B: RenderBackend>(
    backend: Result<B, CompositorError>,
) -> DesktopDemoOutcome<B> {
    let backend = match backend {
        Ok(backend) => backend,
        Err(error) => {
            return DesktopDemoOutcome::Failsafe(failsafe_report(
                "unavailable",
                failsafe_reason(&error),
            ));
        }
    };
    let gpu = backend.backend_name().to_owned();
    let present = backend.presentation_mode();
    let input = backend.input_availability();

    match start_desktop_demo(backend) {
        Ok(session) => DesktopDemoOutcome::Running(session),
        Err(error) => DesktopDemoOutcome::Failsafe(failsafe_report_for_gpu(
            gpu,
            present,
            input,
            failsafe_reason(&error),
        )),
    }
}

pub fn run_desktop_demo<B: RenderBackend>(backend: B) -> Result<SelfTestReport, CompositorError> {
    start_desktop_demo(backend).map(DesktopDemoSession::into_report)
}

pub fn start_desktop_demo<B: RenderBackend>(
    backend: B,
) -> Result<DesktopDemoSession<B>, CompositorError> {
    let gpu = backend.backend_name().to_owned();
    let input = backend.input_availability();
    let mut compositor = Compositor::new(
        backend,
        DESKTOP_DEMO_OUTPUT_WIDTH,
        DESKTOP_DEMO_OUTPUT_HEIGHT,
    )?;
    let present = compositor.presentation_mode();

    for surface in desktop_demo_surfaces() {
        compositor.register_test_surface(
            SurfaceId::new(surface.id)?,
            surface.width,
            surface.height,
            surface.pattern.clone(),
        )?;
    }

    let initial =
        compositor.update_placements(desktop_demo_placements(DemoPlacementPhase::Initial)?)?;
    let initial_report = compositor.composite(&initial)?;
    let moved_surface = SurfaceId::new("window.terminal.body")?;
    let before = compositor.surface_readback_rgba_for_test(&moved_surface)?;
    let before_repaint_count = compositor.source_repaint_count();

    let moved =
        compositor.update_placements(desktop_demo_placements(DemoPlacementPhase::Final)?)?;
    let moved_report = compositor.composite(&moved)?;
    let after = compositor.surface_readback_rgba_for_test(&moved_surface)?;
    let after_repaint_count = compositor.source_repaint_count();

    let composited_ok = initial_report.composited && moved_report.composited;
    let reposition_no_repaint = before == after && before_repaint_count == after_repaint_count;
    let damage_ok = moved.changed_surfaces
        == vec![
            SurfaceId::new("window.terminal.body")?,
            SurfaceId::new("window.terminal.titlebar")?,
        ]
        && moved.rects.len() == 4
        && moved_report.damage_rects == moved.rects.len();

    if !composited_ok {
        return Err(CompositorError::Verification(
            "desktop demo composite did not complete".to_owned(),
        ));
    }
    if !damage_ok {
        return Err(CompositorError::Verification(
            "desktop demo move damage did not cover old and new window rects".to_owned(),
        ));
    }
    if !reposition_no_repaint {
        return Err(CompositorError::Verification(
            "desktop demo source content changed during reposition".to_owned(),
        ));
    }

    let report = SelfTestReport {
        gpu,
        surfaces: compositor.surface_count(),
        composited_ok,
        reposition_no_repaint,
        present,
        damage_ok,
        input,
        status: SelfTestStatus::Ok,
        reason: None,
    };

    Ok(DesktopDemoSession {
        _compositor: compositor,
        report,
    })
}

#[derive(Debug, Clone)]
struct DesktopDemoSurface {
    id: &'static str,
    width: u32,
    height: u32,
    pattern: TestPattern,
    initial_x: i32,
    initial_y: i32,
    final_x: i32,
    final_y: i32,
    z_index: i32,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum DemoPlacementPhase {
    Initial,
    Final,
}

fn desktop_demo_surfaces() -> Vec<DesktopDemoSurface> {
    vec![
        DesktopDemoSurface {
            id: "desktop.wallpaper",
            width: DESKTOP_DEMO_OUTPUT_WIDTH,
            height: DESKTOP_DEMO_OUTPUT_HEIGHT,
            pattern: TestPattern::Checkerboard {
                a: [24, 52, 78, 255],
                b: [33, 77, 98, 255],
                tile: 80,
            },
            initial_x: 0,
            initial_y: 0,
            final_x: 0,
            final_y: 0,
            z_index: 0,
        },
        DesktopDemoSurface {
            id: "desktop.top-panel",
            width: DESKTOP_DEMO_OUTPUT_WIDTH,
            height: 42,
            pattern: TestPattern::Solid {
                rgba: [18, 24, 31, 255],
            },
            initial_x: 0,
            initial_y: 0,
            final_x: 0,
            final_y: 0,
            z_index: 10,
        },
        DesktopDemoSurface {
            id: "window.files.body",
            width: 420,
            height: 280,
            pattern: TestPattern::Solid {
                rgba: [230, 237, 242, 255],
            },
            initial_x: 86,
            initial_y: 96,
            final_x: 86,
            final_y: 96,
            z_index: 20,
        },
        DesktopDemoSurface {
            id: "window.files.titlebar",
            width: 420,
            height: 30,
            pattern: TestPattern::Solid {
                rgba: [56, 95, 128, 255],
            },
            initial_x: 86,
            initial_y: 96,
            final_x: 86,
            final_y: 96,
            z_index: 21,
        },
        DesktopDemoSurface {
            id: "window.terminal.body",
            width: 470,
            height: 260,
            pattern: TestPattern::Solid {
                rgba: [31, 35, 44, 255],
            },
            initial_x: 650,
            initial_y: 205,
            final_x: 690,
            final_y: 235,
            z_index: 30,
        },
        DesktopDemoSurface {
            id: "window.terminal.titlebar",
            width: 470,
            height: 30,
            pattern: TestPattern::Solid {
                rgba: [197, 78, 74, 255],
            },
            initial_x: 650,
            initial_y: 205,
            final_x: 690,
            final_y: 235,
            z_index: 31,
        },
        DesktopDemoSurface {
            id: "window.notes.body",
            width: 360,
            height: 230,
            pattern: TestPattern::Solid {
                rgba: [252, 235, 179, 255],
            },
            initial_x: 252,
            initial_y: 410,
            final_x: 252,
            final_y: 410,
            z_index: 40,
        },
        DesktopDemoSurface {
            id: "window.notes.titlebar",
            width: 360,
            height: 30,
            pattern: TestPattern::Solid {
                rgba: [92, 117, 74, 255],
            },
            initial_x: 252,
            initial_y: 410,
            final_x: 252,
            final_y: 410,
            z_index: 41,
        },
    ]
}

fn desktop_demo_placements(phase: DemoPlacementPhase) -> Result<Vec<Placement>, CompositorError> {
    desktop_demo_surfaces()
        .into_iter()
        .map(|surface| {
            let (x, y) = match phase {
                DemoPlacementPhase::Initial => (surface.initial_x, surface.initial_y),
                DemoPlacementPhase::Final => (surface.final_x, surface.final_y),
            };
            Placement::new(
                SurfaceId::new(surface.id)?,
                x,
                y,
                surface.width,
                surface.height,
                surface.z_index,
            )
        })
        .collect()
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), CompositorError> {
    if width == 0 || height == 0 {
        return Err(CompositorError::InvalidDimensions { width, height });
    }
    Ok(())
}

pub fn rgba_buffer_byte_len(width: u32, height: u32) -> Result<usize, CompositorError> {
    validate_dimensions(width, height)?;
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(CompositorError::InvalidDimensions { width, height })
}

pub fn validate_rgba_buffer(width: u32, height: u32, rgba: &[u8]) -> Result<(), CompositorError> {
    let expected = rgba_buffer_byte_len(width, height)?;
    if rgba.len() != expected {
        return Err(CompositorError::InvalidBufferLength {
            expected,
            actual: rgba.len(),
        });
    }
    Ok(())
}

fn placement_map(placements: &[Placement]) -> BTreeMap<SurfaceId, &Placement> {
    let mut map = BTreeMap::new();
    for placement in placements {
        map.insert(placement.surface_id.clone(), placement);
    }
    map
}

fn topmost_placement_at(placements: &[Placement], x: u32, y: u32) -> Option<&Placement> {
    placements
        .iter()
        .filter(|placement| placement_contains_output_point(placement, x, y))
        .max_by(|left, right| {
            left.z_index
                .cmp(&right.z_index)
                .then_with(|| left.surface_id.cmp(&right.surface_id))
        })
}

fn placement_contains_output_point(placement: &Placement, x: u32, y: u32) -> bool {
    if placement.width == 0 || placement.height == 0 {
        return false;
    }

    let point_x = i64::from(x);
    let point_y = i64::from(y);
    let left = i64::from(placement.x);
    let top = i64::from(placement.y);
    let right = left + i64::from(placement.width);
    let bottom = top + i64::from(placement.height);

    left <= point_x && point_x < right && top <= point_y && point_y < bottom
}

fn placement_local_coordinates(
    placement: &Placement,
    x: u32,
    y: u32,
) -> Option<(SurfaceId, u32, u32)> {
    if !placement_contains_output_point(placement, x, y) {
        return None;
    }

    let local_x = i64::from(x) - i64::from(placement.x);
    let local_y = i64::from(y) - i64::from(placement.y);
    Some((
        placement.surface_id.clone(),
        u32::try_from(local_x).ok()?,
        u32::try_from(local_y).ok()?,
    ))
}

fn micropixels_to_output_pixel(micropixels: i128) -> u32 {
    let pixel = micropixels / INPUT_MICROPIXELS_PER_PIXEL;
    pixel.clamp(0, i128::from(u32::MAX)) as u32
}

fn push_unique_rect(rects: &mut Vec<Rect>, rect: Rect) {
    if !rects.contains(&rect) {
        rects.push(rect);
    }
}

fn write_rgba_png(
    path: impl AsRef<Path>,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<(), CompositorError> {
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| {
            CompositorError::Backend("screenshot dimensions overflowed usize".to_owned())
        })?;
    if rgba.len() != expected_len {
        return Err(CompositorError::Backend(format!(
            "screenshot readback returned {} bytes, expected {expected_len}",
            rgba.len()
        )));
    }

    let file = File::create(path.as_ref()).map_err(|err| {
        CompositorError::Backend(format!(
            "failed to create screenshot {}: {err}",
            path.as_ref().display()
        ))
    })?;
    let writer = BufWriter::new(file);
    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut png_writer = encoder
        .write_header()
        .map_err(|err| CompositorError::Backend(format!("failed to write PNG header: {err}")))?;
    png_writer
        .write_image_data(rgba)
        .map_err(|err| CompositorError::Backend(format!("failed to write PNG pixels: {err}")))
}

fn marker_token(value: &str) -> String {
    let token = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if token.is_empty() {
        "unknown".to_owned()
    } else {
        token
    }
}

fn marker_surface(surface_id: Option<&SurfaceId>) -> String {
    surface_id
        .map(|id| marker_token(id.as_str()))
        .unwrap_or_else(|| "none".to_owned())
}

fn failsafe_reason(error: &CompositorError) -> String {
    match error {
        CompositorError::Unavailable(reason) | CompositorError::Backend(reason)
            if reason.starts_with("input_unavailable") =>
        {
            "input_unavailable".to_owned()
        }
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::rc::Rc;

    mod input_routing {
        use super::*;

        const MICROPIXELS_PER_PIXEL: i64 = 1_000_000;

        #[test]
        fn motion_accumulates_relative_micropixels_and_clamps_to_edges() {
            let desktop = surface_id("desktop");
            let placements = vec![placement("desktop", 0, 0, 10, 8, 0)];
            let mut router = InputRouter::new();

            assert_eq!(router.cursor(), (0, 0));
            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerMotion {
                        dx_micropixels: 500_000,
                        dy_micropixels: 500_000,
                    },
                    &placements,
                    10,
                    8,
                ),
                RoutedInputEvent::PointerMotion {
                    surface_id: desktop.clone(),
                    local_x: 0,
                    local_y: 0,
                    cursor_x: 0,
                    cursor_y: 0,
                    dx_micropixels: 500_000,
                    dy_micropixels: 500_000,
                }
            );
            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerMotion {
                        dx_micropixels: 500_000,
                        dy_micropixels: 1_500_000,
                    },
                    &placements,
                    10,
                    8,
                ),
                RoutedInputEvent::PointerMotion {
                    surface_id: desktop.clone(),
                    local_x: 1,
                    local_y: 2,
                    cursor_x: 1,
                    cursor_y: 2,
                    dx_micropixels: 500_000,
                    dy_micropixels: 1_500_000,
                }
            );
            assert_eq!(router.cursor(), (1, 2));

            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerMotion {
                        dx_micropixels: 20 * MICROPIXELS_PER_PIXEL,
                        dy_micropixels: 20 * MICROPIXELS_PER_PIXEL,
                    },
                    &placements,
                    10,
                    8,
                ),
                RoutedInputEvent::PointerMotion {
                    surface_id: desktop.clone(),
                    local_x: 9,
                    local_y: 7,
                    cursor_x: 9,
                    cursor_y: 7,
                    dx_micropixels: 20 * MICROPIXELS_PER_PIXEL,
                    dy_micropixels: 20 * MICROPIXELS_PER_PIXEL,
                }
            );
            assert_eq!(router.cursor(), (9, 7));

            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerMotion {
                        dx_micropixels: -20 * MICROPIXELS_PER_PIXEL,
                        dy_micropixels: -20 * MICROPIXELS_PER_PIXEL,
                    },
                    &placements,
                    10,
                    8,
                ),
                RoutedInputEvent::PointerMotion {
                    surface_id: desktop,
                    local_x: 0,
                    local_y: 0,
                    cursor_x: 0,
                    cursor_y: 0,
                    dx_micropixels: -20 * MICROPIXELS_PER_PIXEL,
                    dy_micropixels: -20 * MICROPIXELS_PER_PIXEL,
                }
            );
            assert_eq!(router.cursor(), (0, 0));
        }

        #[test]
        fn press_hit_tests_topmost_surface_and_reports_surface_local_coordinates() {
            let surface_c = surface_id("surface-c");
            let placements = stacked_layout();
            let mut router = InputRouter::new();

            router.route_input_event(
                &InputEvent::PointerMotion {
                    dx_micropixels: 6 * MICROPIXELS_PER_PIXEL,
                    dy_micropixels: 7 * MICROPIXELS_PER_PIXEL,
                },
                &placements,
                40,
                40,
            );

            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerButton {
                        button: 272,
                        state: PointerButtonState::Pressed,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::PointerButton {
                    surface_id: surface_c.clone(),
                    local_x: 2,
                    local_y: 3,
                    cursor_x: 6,
                    cursor_y: 7,
                    button: 272,
                    state: PointerButtonState::Pressed,
                }
            );
            assert_eq!(router.focus(), Some(&surface_c));
        }

        #[test]
        fn key_routes_to_focus_and_subsequent_key_follows_pressed_surface() {
            let surface_a = surface_id("surface-a");
            let surface_c = surface_id("surface-c");
            let placements = stacked_layout();
            let mut router = InputRouter::new();

            assert_eq!(
                router.route_input_event(
                    &InputEvent::Key {
                        key_code: 30,
                        pressed: true,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::Dropped {
                    reason: RoutedInputDropReason::NoFocusedSurface,
                    cursor_x: 0,
                    cursor_y: 0,
                }
            );

            router.set_focus(Some(surface_a.clone()));
            assert_eq!(router.focus(), Some(&surface_a));
            assert_eq!(
                router.route_input_event(
                    &InputEvent::Key {
                        key_code: 30,
                        pressed: true,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::Key {
                    surface_id: surface_a,
                    key_code: 30,
                    pressed: true,
                }
            );

            router.route_input_event(
                &InputEvent::PointerMotion {
                    dx_micropixels: 6 * MICROPIXELS_PER_PIXEL,
                    dy_micropixels: 7 * MICROPIXELS_PER_PIXEL,
                },
                &placements,
                40,
                40,
            );
            router.route_input_event(
                &InputEvent::PointerButton {
                    button: 272,
                    state: PointerButtonState::Pressed,
                },
                &placements,
                40,
                40,
            );

            assert_eq!(router.focus(), Some(&surface_c));
            assert_eq!(
                router.route_input_event(
                    &InputEvent::Key {
                        key_code: 31,
                        pressed: false,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::Key {
                    surface_id: surface_c,
                    key_code: 31,
                    pressed: false,
                }
            );
        }

        #[test]
        fn pointer_events_over_no_surface_drop_without_changing_focus() {
            let surface_a = surface_id("surface-a");
            let placements = stacked_layout();
            let mut router = InputRouter::new();
            router.set_focus(Some(surface_a.clone()));

            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerMotion {
                        dx_micropixels: 30 * MICROPIXELS_PER_PIXEL,
                        dy_micropixels: 30 * MICROPIXELS_PER_PIXEL,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::Dropped {
                    reason: RoutedInputDropReason::NoSurfaceAtCursor,
                    cursor_x: 30,
                    cursor_y: 30,
                }
            );
            assert_eq!(router.focus(), Some(&surface_a));

            assert_eq!(
                router.route_input_event(
                    &InputEvent::PointerButton {
                        button: 272,
                        state: PointerButtonState::Pressed,
                    },
                    &placements,
                    40,
                    40,
                ),
                RoutedInputEvent::Dropped {
                    reason: RoutedInputDropReason::NoSurfaceAtCursor,
                    cursor_x: 30,
                    cursor_y: 30,
                }
            );
            assert_eq!(router.focus(), Some(&surface_a));
        }

        #[test]
        fn marker_line_is_stable() {
            let report = InputRoutingSelfTestReport {
                cursor_x: 6,
                cursor_y: 7,
                target: Some(surface_id("surface-c")),
                focus: Some(surface_id("surface-c")),
                status_ok: true,
            };

            assert_eq!(VITA_INPUT_ROUTE_MARKER, "VITA-INPUT-ROUTE");
            assert_eq!(
                report.marker_line(),
                "VITA-INPUT-ROUTE: cursor=6,7 target=surface-c focus=surface-c status=OK"
            );
        }

        #[test]
        fn compositor_wrapper_routes_and_updates_registered_focus() {
            let surface_c = surface_id("surface-c");
            let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 40, 40)
                .expect("compositor should initialize");
            register_surface(&mut compositor, "surface-a", 12, 12);
            register_surface(&mut compositor, "surface-b", 10, 10);
            register_surface(&mut compositor, "surface-c", 10, 10);
            compositor
                .update_placements(stacked_layout())
                .expect("placements should be registered");

            assert_eq!(
                compositor
                    .route_input_event(&InputEvent::Key {
                        key_code: 30,
                        pressed: true,
                    })
                    .expect("routing should be pure"),
                RoutedInputEvent::Dropped {
                    reason: RoutedInputDropReason::NoFocusedSurface,
                    cursor_x: 0,
                    cursor_y: 0,
                }
            );

            compositor
                .route_input_event(&InputEvent::PointerMotion {
                    dx_micropixels: 6 * MICROPIXELS_PER_PIXEL,
                    dy_micropixels: 7 * MICROPIXELS_PER_PIXEL,
                })
                .expect("motion should route");
            assert_eq!(
                compositor
                    .route_input_event(&InputEvent::PointerButton {
                        button: 272,
                        state: PointerButtonState::Pressed,
                    })
                    .expect("press should route"),
                RoutedInputEvent::PointerButton {
                    surface_id: surface_c.clone(),
                    local_x: 2,
                    local_y: 3,
                    cursor_x: 6,
                    cursor_y: 7,
                    button: 272,
                    state: PointerButtonState::Pressed,
                }
            );
            assert_eq!(compositor.focus(), Some(&surface_c));
            assert_eq!(
                compositor
                    .route_input_event(&InputEvent::Key {
                        key_code: 31,
                        pressed: true,
                    })
                    .expect("focused key should route"),
                RoutedInputEvent::Key {
                    surface_id: surface_c,
                    key_code: 31,
                    pressed: true,
                }
            );
        }

        fn stacked_layout() -> Vec<Placement> {
            vec![
                placement("surface-a", 0, 0, 12, 12, 0),
                placement("surface-b", 4, 4, 10, 10, 7),
                placement("surface-c", 4, 4, 10, 10, 7),
            ]
        }

        fn placement(id: &str, x: i32, y: i32, width: u32, height: u32, z_index: i32) -> Placement {
            Placement::new(surface_id(id), x, y, width, height, z_index).unwrap()
        }

        fn register_surface(
            compositor: &mut Compositor<RecordingBackend>,
            id: &str,
            width: u32,
            height: u32,
        ) {
            compositor
                .register_test_surface(
                    surface_id(id),
                    width,
                    height,
                    TestPattern::Solid {
                        rgba: [1, 2, 3, 255],
                    },
                )
                .expect("surface should register");
        }

        fn surface_id(id: &str) -> SurfaceId {
            SurfaceId::new(id).unwrap()
        }
    }

    #[test]
    fn move_changes_damage_without_repainting_source_texture() {
        let report = run_reposition_self_test(RecordingBackend::new("test-gpu"))
            .expect("self-test should pass");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.surfaces, 2);
        assert!(report.reposition_no_repaint);
        assert_eq!(
            report.marker_line(),
            "VITA-COMPOSITOR: gpu=test-gpu surfaces=2 composited=OK reposition=no-repaint present=recording damage=OK status=OK input=unverified"
        );
    }

    #[test]
    fn desktop_demo_draws_wallpaper_panel_windows_and_preserves_marker_shape() {
        let surfaces = desktop_demo_surfaces();
        assert_eq!(surfaces.len(), 8);
        assert!(surfaces.iter().any(|surface| {
            surface.id == "desktop.wallpaper"
                && surface.width == DESKTOP_DEMO_OUTPUT_WIDTH
                && surface.height == DESKTOP_DEMO_OUTPUT_HEIGHT
                && surface.z_index == 0
        }));
        assert!(surfaces.iter().any(|surface| {
            surface.id == "desktop.top-panel"
                && surface.width == DESKTOP_DEMO_OUTPUT_WIDTH
                && surface.height == 42
                && surface.initial_x == 0
                && surface.initial_y == 0
        }));
        assert_eq!(
            surfaces
                .iter()
                .filter(|surface| surface.id.starts_with("window.") && surface.id.ends_with(".body"))
                .count(),
            3
        );
        assert_eq!(
            surfaces
                .iter()
                .filter(|surface| surface.id.starts_with("window.")
                    && surface.id.ends_with(".titlebar"))
                .count(),
            3
        );

        let report = run_desktop_demo(RecordingBackend::new("test-gpu"))
            .expect("desktop demo should composite");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.surfaces, 8);
        assert!(report.reposition_no_repaint);
        assert_eq!(
            report.marker_line(),
            "VITA-COMPOSITOR: gpu=test-gpu surfaces=8 composited=OK reposition=no-repaint present=recording damage=OK status=OK input=unverified"
        );
    }

    #[test]
    fn desktop_demo_session_holds_backend_until_dropped() {
        let drop_count = Rc::new(Cell::new(0_u32));
        let session = start_desktop_demo(RecordingBackend::with_drop_counter(
            "test-gpu",
            drop_count.clone(),
        ))
        .expect("desktop demo should composite");

        assert_eq!(session.report().status, SelfTestStatus::Ok);
        assert_eq!(drop_count.get(), 0);

        drop(session);
        assert_eq!(drop_count.get(), 1);
    }

    #[test]
    fn desktop_demo_writes_png_screenshot_from_final_composited_frame() {
        let path = std::env::temp_dir().join(format!(
            "vita-compositor-demo-{}-screenshot.png",
            std::process::id()
        ));
        let mut session = start_desktop_demo(RecordingBackend::new("test-gpu"))
            .expect("desktop demo should composite");

        session
            .write_screenshot_png(&path)
            .expect("desktop demo should write screenshot");
        let png = fs::read(&path).expect("screenshot should be readable");
        let _ = fs::remove_file(&path);

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            DESKTOP_DEMO_OUTPUT_WIDTH
        );
        assert_eq!(
            u32::from_be_bytes(png[20..24].try_into().unwrap()),
            DESKTOP_DEMO_OUTPUT_HEIGHT
        );
        assert!(png.windows(4).any(|window| window == b"IDAT"));
        assert_eq!(&png[png.len() - 12 + 4..png.len() - 12 + 8], b"IEND");

        let rgba = session
            ._compositor
            .output_readback_rgba()
            .expect("recording backend should keep final output");
        assert_pixel(&rgba, 10, 10, [18, 24, 31, 255]);
        assert_pixel(&rgba, 10, 50, [24, 52, 78, 255]);
        assert_pixel(&rgba, 100, 100, [56, 95, 128, 255]);
        assert_pixel(&rgba, 700, 240, [197, 78, 74, 255]);
        assert_pixel(&rgba, 700, 300, [31, 35, 44, 255]);
        assert_pixel(&rgba, 260, 420, [92, 117, 74, 255]);
        assert_pixel(&rgba, 260, 450, [252, 235, 179, 255]);
    }

    #[test]
    fn recording_backend_never_emits_kms_ok_acceptance_marker() {
        let report = run_reposition_self_test(RecordingBackend::new("vmwgfx"))
            .expect("recording self-test should pass");
        let marker = report.marker_line();

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.present, PresentationMode::RECORDING);
        assert!(marker.contains("present=recording damage=OK status=OK"));
        assert!(!marker.contains("present=kms damage=OK status=OK"));
    }

    #[test]
    fn self_test_does_not_failsafe_when_input_is_unavailable() {
        let report = run_reposition_self_test(RecordingBackend::with_input(
            "vmwgfx",
            InputAvailability::Unavailable,
        ))
        .expect("GPU self-test should not depend on input availability");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.input, InputAvailability::Unavailable);
        assert_eq!(
            report.marker_line(),
            "VITA-COMPOSITOR: gpu=vmwgfx surfaces=2 composited=OK reposition=no-repaint present=recording damage=OK status=OK input=unavailable"
        );
    }

    #[test]
    fn self_test_gpu_path_failure_still_returns_failsafe_marker() {
        let report =
            run_reposition_self_test_or_failsafe(Ok(RecordingBackend::failing_composite("vmwgfx")));

        assert_eq!(report.status, SelfTestStatus::Failsafe);
        assert_eq!(report.gpu, "vmwgfx");
        assert_eq!(report.present, PresentationMode::RECORDING);
        let marker = report.marker_line();
        assert!(marker.starts_with("VITA-COMPOSITOR: gpu=vmwgfx "));
        assert!(marker.contains("status=FAILSAFE"));
        assert!(marker.contains("reason=unavailable:_injected_composite_failure"));
    }

    #[test]
    fn input_unavailable_failure_uses_stable_failsafe_reason() {
        let report = run_reposition_self_test_or_failsafe::<RecordingBackend>(Err(
            CompositorError::Unavailable("input_unavailable: failed to load libinput".to_owned()),
        ));

        assert_eq!(report.status, SelfTestStatus::Failsafe);
        assert_eq!(report.reason.as_deref(), Some("input_unavailable"));
        assert_eq!(
            report.marker_line(),
            "VITA-COMPOSITOR: gpu=unavailable surfaces=0 composited=FAIL reposition=unverified present=unverified damage=FAIL status=FAILSAFE reason=input_unavailable input=unverified"
        );
    }

    #[test]
    fn placement_update_rejects_unknown_and_duplicate_surfaces() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 64, 64).unwrap();
        let surface = SurfaceId::new("surface-a").unwrap();
        compositor
            .register_test_surface(
                surface.clone(),
                8,
                8,
                TestPattern::Solid {
                    rgba: [1, 2, 3, 255],
                },
            )
            .unwrap();

        let unknown = SurfaceId::new("missing").unwrap();
        let unknown_err = compositor
            .update_placements(vec![Placement::new(unknown.clone(), 0, 0, 8, 8, 0).unwrap()])
            .unwrap_err();
        assert_eq!(unknown_err, CompositorError::UnknownSurface(unknown));

        let duplicate_err = compositor
            .update_placements(vec![
                Placement::new(surface.clone(), 0, 0, 8, 8, 0).unwrap(),
                Placement::new(surface.clone(), 2, 2, 8, 8, 1).unwrap(),
            ])
            .unwrap_err();
        assert_eq!(duplicate_err, CompositorError::DuplicatePlacement(surface));
    }

    #[test]
    fn remove_surface_drops_placement_focus_and_reports_old_damage() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 64, 64).unwrap();
        let surface = SurfaceId::new("surface-a").unwrap();
        compositor
            .register_test_surface(
                surface.clone(),
                8,
                8,
                TestPattern::Solid {
                    rgba: [1, 2, 3, 255],
                },
            )
            .unwrap();
        compositor
            .update_placements(vec![Placement::new(surface.clone(), 4, 5, 8, 8, 1).unwrap()])
            .unwrap();
        compositor.set_focus(Some(surface.clone())).unwrap();

        let damage = compositor.remove_surface(&surface).unwrap();

        assert_eq!(damage.changed_surfaces, vec![surface.clone()]);
        assert_eq!(damage.rects, vec![Rect::new(4, 5, 8, 8).unwrap()]);
        assert_eq!(compositor.surface_count(), 0);
        assert_eq!(compositor.focus(), None);
        assert_eq!(
            compositor.remove_surface(&surface).unwrap_err(),
            CompositorError::UnknownSurface(surface)
        );
    }

    #[test]
    fn focus_is_mechanism_only_and_requires_registered_surface() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 64, 64).unwrap();
        let surface = SurfaceId::new("surface-a").unwrap();
        compositor
            .register_test_surface(
                surface.clone(),
                8,
                8,
                TestPattern::Solid {
                    rgba: [1, 2, 3, 255],
                },
            )
            .unwrap();

        compositor.set_focus(Some(surface.clone())).unwrap();
        assert_eq!(compositor.focus(), Some(&surface));
        compositor.set_focus(None).unwrap();
        assert_eq!(compositor.focus(), None);

        let missing = SurfaceId::new("missing").unwrap();
        assert_eq!(
            compositor.set_focus(Some(missing.clone())).unwrap_err(),
            CompositorError::UnknownSurface(missing)
        );
    }

    #[test]
    fn buffer_surface_composites_exact_rgba_pixels_at_placement() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 6, 5).unwrap();
        let surface = SurfaceId::new("surface-buffer").unwrap();
        let rgba = vec![
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
        ];
        compositor
            .register_buffer_surface(surface.clone(), 2, 2, &rgba)
            .unwrap();

        let damage = compositor
            .update_placements(vec![Placement::new(surface.clone(), 2, 1, 2, 2, 0).unwrap()])
            .unwrap();
        compositor.composite(&damage).unwrap();

        let surface_readback = compositor.surface_readback_rgba_for_test(&surface).unwrap();
        assert_eq!(surface_readback, rgba);
        let output = compositor.output_readback_rgba().unwrap();
        assert_output_pixel(&output, 6, 2, 1, [10, 20, 30, 255]);
        assert_output_pixel(&output, 6, 3, 1, [40, 50, 60, 255]);
        assert_output_pixel(&output, 6, 2, 2, [70, 80, 90, 255]);
        assert_output_pixel(&output, 6, 3, 2, [100, 110, 120, 255]);
        assert_output_pixel(&output, 6, 1, 1, [0, 0, 0, 0]);
    }

    #[test]
    fn buffer_surface_update_reuploads_pixels_and_marks_visible_damage() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 6, 5).unwrap();
        let surface = SurfaceId::new("surface-buffer").unwrap();
        compositor
            .register_buffer_surface(surface.clone(), 1, 1, &[10, 20, 30, 255])
            .unwrap();
        compositor
            .update_placements(vec![Placement::new(surface.clone(), 4, 3, 1, 1, 0).unwrap()])
            .unwrap();

        let damage = compositor
            .update_buffer_surface(&surface, &[200, 150, 100, 255])
            .unwrap();
        assert_eq!(damage.changed_surfaces, vec![surface.clone()]);
        assert_eq!(damage.rects, vec![Rect::new(4, 3, 1, 1).unwrap()]);

        compositor.composite(&damage).unwrap();
        let output = compositor.output_readback_rgba().unwrap();
        assert_output_pixel(&output, 6, 4, 3, [200, 150, 100, 255]);
    }

    #[test]
    fn buffer_surface_rejects_mismatched_lengths_fail_closed() {
        let mut compositor = Compositor::new(RecordingBackend::new("test-gpu"), 6, 5).unwrap();
        let surface = SurfaceId::new("surface-buffer").unwrap();
        let err = compositor
            .register_buffer_surface(surface.clone(), 2, 2, &[1, 2, 3])
            .unwrap_err();

        assert_eq!(
            err,
            CompositorError::InvalidBufferLength {
                expected: 16,
                actual: 3,
            }
        );
        assert!(!compositor.has_surface(&surface));

        compositor
            .register_buffer_surface(surface.clone(), 1, 1, &[10, 20, 30, 255])
            .unwrap();
        let err = compositor
            .update_buffer_surface(&surface, &[1, 2, 3])
            .unwrap_err();
        assert_eq!(
            err,
            CompositorError::InvalidBufferLength {
                expected: 4,
                actual: 3,
            }
        );
        assert_eq!(
            compositor.surface_readback_rgba_for_test(&surface).unwrap(),
            vec![10, 20, 30, 255]
        );
    }

    #[derive(Debug, Clone)]
    struct RecordingTexture {
        id: u64,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    }

    #[derive(Debug, Clone)]
    struct RecordingOutput {
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    }

    struct RecordingBackend {
        name: String,
        next_id: u64,
        repaint_count: u64,
        fail_composite: bool,
        input: InputAvailability,
        drop_count: Option<Rc<Cell<u32>>>,
        last_output: Option<RecordingOutput>,
    }

    impl RecordingBackend {
        fn new(name: &str) -> Self {
            Self {
                name: name.to_owned(),
                next_id: 1,
                repaint_count: 0,
                fail_composite: false,
                input: InputAvailability::Unverified,
                drop_count: None,
                last_output: None,
            }
        }

        fn failing_composite(name: &str) -> Self {
            Self {
                name: name.to_owned(),
                next_id: 1,
                repaint_count: 0,
                fail_composite: true,
                input: InputAvailability::Unverified,
                drop_count: None,
                last_output: None,
            }
        }

        fn with_input(name: &str, input: InputAvailability) -> Self {
            Self {
                name: name.to_owned(),
                next_id: 1,
                repaint_count: 0,
                fail_composite: false,
                input,
                drop_count: None,
                last_output: None,
            }
        }

        fn with_drop_counter(name: &str, drop_count: Rc<Cell<u32>>) -> Self {
            Self {
                name: name.to_owned(),
                next_id: 1,
                repaint_count: 0,
                fail_composite: false,
                input: InputAvailability::Unverified,
                drop_count: Some(drop_count),
                last_output: None,
            }
        }
    }

    impl Drop for RecordingBackend {
        fn drop(&mut self) {
            if let Some(drop_count) = &self.drop_count {
                drop_count.set(drop_count.get() + 1);
            }
        }
    }

    impl RenderBackend for RecordingBackend {
        type Texture = RecordingTexture;

        fn backend_name(&self) -> &str {
            &self.name
        }

        fn presentation_mode(&self) -> PresentationMode {
            PresentationMode::RECORDING
        }

        fn input_availability(&self) -> InputAvailability {
            self.input
        }

        fn create_test_texture(
            &mut self,
            width: u32,
            height: u32,
            pattern: &TestPattern,
        ) -> Result<Self::Texture, CompositorError> {
            let bytes = pattern.rgba_bytes(width, height)?;
            self.create_buffer_texture(width, height, &bytes)
        }

        fn create_buffer_texture(
            &mut self,
            width: u32,
            height: u32,
            rgba: &[u8],
        ) -> Result<Self::Texture, CompositorError> {
            validate_rgba_buffer(width, height, rgba)?;
            let id = self.next_id;
            self.next_id += 1;
            self.repaint_count += 1;

            Ok(RecordingTexture {
                id,
                width,
                height,
                bytes: rgba.to_vec(),
            })
        }

        fn update_texture_rgba(
            &mut self,
            texture: &mut Self::Texture,
            width: u32,
            height: u32,
            rgba: &[u8],
        ) -> Result<(), CompositorError> {
            validate_rgba_buffer(width, height, rgba)?;
            if texture.width != width || texture.height != height {
                return Err(CompositorError::Backend(
                    "recording texture dimensions changed during RGBA update".to_owned(),
                ));
            }
            texture.bytes = rgba.to_vec();
            self.repaint_count += 1;
            Ok(())
        }

        fn export_handle(&self, texture: &Self::Texture) -> GpuTextureHandle {
            GpuTextureHandle {
                kind: TextureHandleKind::TestOnly,
                value: texture.id as i64,
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
            if self.fail_composite {
                return Err(CompositorError::Unavailable(
                    "injected composite failure".to_owned(),
                ));
            }

            self.last_output = Some(render_recording_output(
                surfaces,
                placements,
                output_width,
                output_height,
            )?);

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
            Ok(texture.bytes.clone())
        }

        fn read_output_rgba(
            &mut self,
            output_width: u32,
            output_height: u32,
        ) -> Result<Vec<u8>, CompositorError> {
            let output = self
                .last_output
                .as_ref()
                .ok_or_else(|| CompositorError::Backend("no recorded output frame".to_owned()))?;
            if output.width != output_width || output.height != output_height {
                return Err(CompositorError::Backend(
                    "recorded output dimensions changed".to_owned(),
                ));
            }
            Ok(output.bytes.clone())
        }

        fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
            Ok(Vec::new())
        }

        fn source_repaint_count(&self) -> u64 {
            self.repaint_count
        }
    }

    fn render_recording_output(
        surfaces: &[RenderSurface<RecordingTexture>],
        placements: &[Placement],
        output_width: u32,
        output_height: u32,
    ) -> Result<RecordingOutput, CompositorError> {
        let mut output = vec![0_u8; (output_width * output_height * 4) as usize];
        let textures = surfaces
            .iter()
            .map(|surface| (surface.id.clone(), &surface.texture))
            .collect::<BTreeMap<_, _>>();

        for placement in placements {
            let texture = textures
                .get(&placement.surface_id)
                .ok_or_else(|| CompositorError::UnknownSurface(placement.surface_id.clone()))?;
            draw_recording_placement(&mut output, output_width, output_height, placement, texture);
        }

        Ok(RecordingOutput {
            width: output_width,
            height: output_height,
            bytes: output,
        })
    }

    fn draw_recording_placement(
        output: &mut [u8],
        output_width: u32,
        output_height: u32,
        placement: &Placement,
        texture: &RecordingTexture,
    ) {
        let left = placement.x.max(0) as u32;
        let top = placement.y.max(0) as u32;
        let right = (placement.x + placement.width as i32).clamp(0, output_width as i32) as u32;
        let bottom = (placement.y + placement.height as i32).clamp(0, output_height as i32) as u32;
        if left >= right || top >= bottom {
            return;
        }

        for y in top..bottom {
            let rel_y = y as i32 - placement.y;
            let src_y = (rel_y as u64 * texture.height as u64 / placement.height as u64) as u32;
            for x in left..right {
                let rel_x = x as i32 - placement.x;
                let src_x = (rel_x as u64 * texture.width as u64 / placement.width as u64) as u32;
                let src = ((src_y * texture.width + src_x) * 4) as usize;
                let dst = ((y * output_width + x) * 4) as usize;
                output[dst..dst + 4].copy_from_slice(&texture.bytes[src..src + 4]);
            }
        }
    }

    fn assert_pixel(rgba: &[u8], x: u32, y: u32, expected: [u8; 4]) {
        let offset = ((y * DESKTOP_DEMO_OUTPUT_WIDTH + x) * 4) as usize;
        assert_eq!(rgba[offset..offset + 4], expected);
    }

    fn assert_output_pixel(rgba: &[u8], width: u32, x: u32, y: u32, expected: [u8; 4]) {
        let offset = ((y * width + x) * 4) as usize;
        assert_eq!(rgba[offset..offset + 4], expected);
    }
}

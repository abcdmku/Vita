use std::collections::BTreeMap;

use vita_compositor_core::{
    validate_rgba_buffer, CompositeReport, Compositor, CompositorError, GpuTextureHandle,
    InputAvailability, InputEvent, Placement, PresentationMode, Rect, RenderBackend, RenderSurface,
    SelfTestReport, SelfTestStatus, SurfaceId, TestPattern, TextureFormat, TextureHandleKind,
};

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
    last_output: Option<RecordingOutput>,
}

impl RecordingBackend {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            next_id: 1,
            repaint_count: 0,
            last_output: None,
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
        InputAvailability::Unverified
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

#[test]
fn stacking_multi_surface_zorder() {
    let (mut compositor, back, middle, front) = three_surface_stack();

    let damage = compositor
        .update_placements(vec![
            Placement::new(back.clone(), 0, 0, 5, 5, 0).unwrap(),
            Placement::new(middle, 1, 1, 4, 4, 10).unwrap(),
            Placement::new(front, 2, 2, 3, 3, 20).unwrap(),
        ])
        .unwrap();
    let report = compositor.composite(&damage).unwrap();

    assert_eq!(report.surfaces, 3);
    let output = compositor.output_readback_rgba().unwrap();
    assert_output_pixel(&output, 6, 0, 0, [160, 0, 0, 255]);
    assert_output_pixel(&output, 6, 1, 1, [0, 150, 0, 255]);
    assert_output_pixel(&output, 6, 2, 2, [0, 0, 180, 255]);
}

#[test]
fn raise_surface_reorders_without_repainting_source_textures() {
    let (mut compositor, back, middle, front) = three_surface_stack();
    let placement_rect = Rect::new(1, 1, 4, 4).unwrap();
    let initial = compositor
        .update_placements(vec![
            Placement::new(back, 0, 0, 5, 5, 0).unwrap(),
            Placement::new(middle.clone(), 1, 1, 4, 4, 10).unwrap(),
            Placement::new(front, 2, 2, 3, 3, 20).unwrap(),
        ])
        .unwrap();
    compositor.composite(&initial).unwrap();
    let before_repaint_count = compositor.source_repaint_count();

    let damage = compositor.raise_surface(&middle).unwrap();

    assert_eq!(damage.changed_surfaces, vec![middle]);
    assert_eq!(damage.rects, vec![placement_rect]);
    assert_eq!(compositor.source_repaint_count(), before_repaint_count);

    let report = compositor.composite(&damage).unwrap();
    assert_eq!(report.damage_rects, 1);
    assert_eq!(report.surfaces, 3);
    assert_eq!(compositor.source_repaint_count(), before_repaint_count);

    let output = compositor.output_readback_rgba().unwrap();
    assert_output_pixel(&output, 6, 2, 2, [0, 150, 0, 255]);
}

#[test]
fn remove_surface_preserves_remaining_textures_and_damages_vacated_rect() {
    let (mut compositor, back, middle, front) = three_surface_stack();
    let initial = compositor
        .update_placements(vec![
            Placement::new(back.clone(), 0, 0, 5, 5, 0).unwrap(),
            Placement::new(middle.clone(), 1, 1, 4, 4, 10).unwrap(),
            Placement::new(front.clone(), 2, 2, 3, 3, 20).unwrap(),
        ])
        .unwrap();
    compositor.composite(&initial).unwrap();

    let back_before = compositor.surface_readback_rgba_for_test(&back).unwrap();
    let front_before = compositor.surface_readback_rgba_for_test(&front).unwrap();
    let repaint_before = compositor.source_repaint_count();

    let damage = compositor.remove_surface(&middle).unwrap();

    assert_eq!(damage.changed_surfaces, vec![middle]);
    assert_eq!(damage.rects, vec![Rect::new(1, 1, 4, 4).unwrap()]);
    assert_eq!(compositor.source_repaint_count(), repaint_before);
    assert_eq!(
        compositor.surface_readback_rgba_for_test(&back).unwrap(),
        back_before
    );
    assert_eq!(
        compositor.surface_readback_rgba_for_test(&front).unwrap(),
        front_before
    );

    let report = compositor.composite(&damage).unwrap();
    assert_eq!(report.surfaces, 2);
    assert_eq!(compositor.source_repaint_count(), repaint_before);

    let output = compositor.output_readback_rgba().unwrap();
    assert_output_pixel(&output, 6, 1, 1, [160, 0, 0, 255]);
    assert_output_pixel(&output, 6, 2, 2, [0, 0, 180, 255]);
}

#[test]
fn out_of_order_updates_composite_from_latest_snapshot() {
    let mut compositor = Compositor::new(RecordingBackend::new("stacking-test-gpu"), 5, 5).unwrap();
    let base = sid("base");
    let async_surface = sid("async");
    let surface_rect = Rect::new(1, 1, 3, 3).unwrap();

    compositor
        .register_buffer_surface(base.clone(), 5, 5, &solid_rgba(5, 10, 15, 255, 5, 5))
        .unwrap();
    compositor
        .register_buffer_surface(
            async_surface.clone(),
            3,
            3,
            &solid_rgba(20, 30, 40, 255, 3, 3),
        )
        .unwrap();
    let initial = compositor
        .update_placements(vec![
            Placement::new(base, 0, 0, 5, 5, 0).unwrap(),
            Placement::new(async_surface.clone(), 1, 1, 3, 3, 1).unwrap(),
        ])
        .unwrap();
    compositor.composite(&initial).unwrap();

    let stale_buffer_damage = compositor
        .update_buffer_surface(&async_surface, &solid_rgba(0, 120, 0, 255, 3, 3))
        .unwrap();
    let stale_z_damage = compositor.set_z(&async_surface, -5).unwrap();
    let latest_buffer_damage = compositor
        .update_buffer_surface(&async_surface, &solid_rgba(240, 210, 0, 255, 3, 3))
        .unwrap();
    let latest_z_damage = compositor.set_z(&async_surface, 5).unwrap();

    assert_eq!(stale_buffer_damage.rects, vec![surface_rect]);
    assert_eq!(stale_z_damage.rects, vec![surface_rect]);
    assert_eq!(latest_buffer_damage.rects, vec![surface_rect]);
    assert_eq!(latest_z_damage.rects, vec![surface_rect]);

    let report = compositor.composite(&stale_z_damage).unwrap();
    assert_eq!(report.surfaces, 2);
    assert_eq!(report.damage_rects, 1);

    let output = compositor.output_readback_rgba().unwrap();
    assert_output_pixel(&output, 5, 0, 0, [5, 10, 15, 255]);
    assert_output_pixel(&output, 5, 1, 1, [240, 210, 0, 255]);
}

#[test]
fn multi_surface_marker_line_stays_well_formed() {
    let (mut compositor, back, middle, front) = three_surface_stack();
    let damage = compositor
        .update_placements(vec![
            Placement::new(back, 0, 0, 5, 5, 0).unwrap(),
            Placement::new(middle, 1, 1, 4, 4, 10).unwrap(),
            Placement::new(front, 2, 2, 3, 3, 20).unwrap(),
        ])
        .unwrap();
    let composite = compositor.composite(&damage).unwrap();
    let report = SelfTestReport {
        gpu: compositor.backend_name().to_owned(),
        surfaces: composite.surfaces,
        composited_ok: composite.composited,
        reposition_no_repaint: true,
        present: compositor.presentation_mode(),
        damage_ok: true,
        input: InputAvailability::Unverified,
        status: SelfTestStatus::Ok,
        reason: None,
    };
    let marker = report.marker_line();

    println!("{marker}");
    assert!(marker.starts_with("VITA-COMPOSITOR: "));
    assert!(marker.contains("surfaces=3"));
    assert!(marker.contains("status=OK"));
}

fn three_surface_stack() -> (
    Compositor<RecordingBackend>,
    SurfaceId,
    SurfaceId,
    SurfaceId,
) {
    let mut compositor = Compositor::new(RecordingBackend::new("stacking-test-gpu"), 6, 6).unwrap();
    let back = sid("back");
    let middle = sid("middle");
    let front = sid("front");

    compositor
        .register_buffer_surface(back.clone(), 5, 5, &solid_rgba(160, 0, 0, 255, 5, 5))
        .unwrap();
    compositor
        .register_buffer_surface(middle.clone(), 4, 4, &solid_rgba(0, 150, 0, 255, 4, 4))
        .unwrap();
    compositor
        .register_buffer_surface(front.clone(), 3, 3, &solid_rgba(0, 0, 180, 255, 3, 3))
        .unwrap();

    (compositor, back, middle, front)
}

fn render_recording_output(
    surfaces: &[RenderSurface<RecordingTexture>],
    placements: &[Placement],
    output_width: u32,
    output_height: u32,
) -> Result<RecordingOutput, CompositorError> {
    let byte_count = (output_width as usize)
        .checked_mul(output_height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| CompositorError::Backend("recording output overflowed".to_owned()))?;
    let mut output = vec![0_u8; byte_count];
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
    let left = i64::from(placement.x).clamp(0, i64::from(output_width)) as u32;
    let top = i64::from(placement.y).clamp(0, i64::from(output_height)) as u32;
    let right = (i64::from(placement.x) + i64::from(placement.width))
        .clamp(0, i64::from(output_width)) as u32;
    let bottom = (i64::from(placement.y) + i64::from(placement.height))
        .clamp(0, i64::from(output_height)) as u32;
    if left >= right || top >= bottom {
        return;
    }

    for y in top..bottom {
        let rel_y = y as i64 - i64::from(placement.y);
        let src_y = (rel_y as u64 * u64::from(texture.height) / u64::from(placement.height)) as u32;
        for x in left..right {
            let rel_x = x as i64 - i64::from(placement.x);
            let src_x =
                (rel_x as u64 * u64::from(texture.width) / u64::from(placement.width)) as u32;
            let src = ((src_y * texture.width + src_x) * 4) as usize;
            let dst = ((y * output_width + x) * 4) as usize;
            output[dst..dst + 4].copy_from_slice(&texture.bytes[src..src + 4]);
        }
    }
}

fn solid_rgba(r: u8, g: u8, b: u8, a: u8, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    for _ in 0..width * height {
        bytes.extend_from_slice(&[r, g, b, a]);
    }
    bytes
}

fn sid(value: &str) -> SurfaceId {
    SurfaceId::new(value).unwrap()
}

fn assert_output_pixel(rgba: &[u8], width: u32, x: u32, y: u32, expected: [u8; 4]) {
    let offset = ((y * width + x) * 4) as usize;
    assert_eq!(rgba[offset..offset + 4], expected);
}

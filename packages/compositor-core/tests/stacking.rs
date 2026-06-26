use std::collections::BTreeMap;

use vita_compositor_core::{
    CompositeReport, Compositor, CompositorError, GpuTextureHandle, InputAvailability, InputEvent,
    Placement, PresentationMode, Rect, RenderBackend, RenderSurface, SelfTestReport,
    SelfTestStatus, SurfaceId, TestPattern, TextureFormat, TextureHandleKind,
};

#[test]
fn stacking_multi_surface_zorder_raise_remove_latest_snapshot_and_marker() {
    let bottom = surface_id("surface:bottom");
    let middle = surface_id("surface:middle");
    let top = surface_id("surface:top");

    let mut compositor = Compositor::new(RecordingBackend::new("stacking-test-gpu"), 10, 10)
        .expect("compositor should initialize");
    register_solid(&mut compositor, &bottom, 6, 6, [220, 0, 0, 255]);
    register_solid(&mut compositor, &middle, 6, 6, [0, 190, 0, 255]);
    register_solid(&mut compositor, &top, 6, 6, [0, 0, 230, 255]);

    let bottom_rect = Rect::new(1, 1, 6, 6).unwrap();
    let middle_rect = Rect::new(2, 2, 6, 6).unwrap();
    let top_rect = Rect::new(3, 3, 6, 6).unwrap();
    let damage = compositor
        .update_placements(vec![
            Placement::new(bottom.clone(), 1, 1, 6, 6, 0).unwrap(),
            Placement::new(middle.clone(), 2, 2, 6, 6, 5).unwrap(),
            Placement::new(top.clone(), 3, 3, 6, 6, 10).unwrap(),
        ])
        .expect("placements should update");
    assert_eq!(damage.rects, vec![bottom_rect, middle_rect, top_rect]);
    let report = compositor
        .composite(&damage)
        .expect("initial stack should composite");
    assert_eq!(report.surfaces, 3);
    let output = compositor
        .output_readback_rgba()
        .expect("recorded output should be readable");
    assert_output_pixel(&output, 10, 4, 4, [0, 0, 230, 255]);

    let repaint_count = compositor.source_repaint_count();
    let raise_damage = compositor
        .raise_surface(&middle)
        .expect("middle surface should raise");
    assert_eq!(raise_damage.changed_surfaces, vec![middle.clone()]);
    assert_eq!(raise_damage.rects, vec![middle_rect]);
    assert_eq!(compositor.source_repaint_count(), repaint_count);
    compositor
        .composite(&raise_damage)
        .expect("raised stack should composite");
    let output = compositor
        .output_readback_rgba()
        .expect("raised output should be readable");
    assert_output_pixel(&output, 10, 4, 4, [0, 190, 0, 255]);

    let bottom_before_remove = compositor
        .surface_readback_rgba_for_test(&bottom)
        .expect("bottom readback should work");
    let top_before_remove = compositor
        .surface_readback_rgba_for_test(&top)
        .expect("top readback should work");
    let repaint_count = compositor.source_repaint_count();
    let remove_damage = compositor
        .remove_surface(&middle)
        .expect("middle surface should remove");
    assert_eq!(remove_damage.changed_surfaces, vec![middle.clone()]);
    assert_eq!(remove_damage.rects, vec![middle_rect]);
    assert_eq!(compositor.source_repaint_count(), repaint_count);
    assert_eq!(
        compositor
            .surface_readback_rgba_for_test(&bottom)
            .expect("bottom should remain"),
        bottom_before_remove
    );
    assert_eq!(
        compositor
            .surface_readback_rgba_for_test(&top)
            .expect("top should remain"),
        top_before_remove
    );
    let report = compositor
        .composite(&remove_damage)
        .expect("stack without middle should composite");
    assert_eq!(report.surfaces, 2);
    let output = compositor
        .output_readback_rgba()
        .expect("post-remove output should be readable");
    assert_output_pixel(&output, 10, 4, 4, [0, 0, 230, 255]);
    assert_output_pixel(&output, 10, 2, 2, [220, 0, 0, 255]);

    let mut latest = Compositor::new(RecordingBackend::new("stacking-test-gpu"), 10, 10)
        .expect("latest snapshot compositor should initialize");
    register_solid(&mut latest, &bottom, 6, 6, [220, 0, 0, 255]);
    register_solid(&mut latest, &middle, 6, 6, [0, 190, 0, 255]);
    register_solid(&mut latest, &top, 6, 6, [0, 0, 230, 255]);
    let initial = latest
        .update_placements(vec![
            Placement::new(bottom.clone(), 1, 1, 6, 6, 0).unwrap(),
            Placement::new(middle.clone(), 2, 2, 6, 6, 1).unwrap(),
            Placement::new(top.clone(), 3, 3, 6, 6, 2).unwrap(),
        ])
        .expect("initial latest placements should update");
    latest
        .composite(&initial)
        .expect("initial latest stack should composite");

    let stale_middle_pixels = solid_rgba(6, 6, [120, 120, 120, 255]);
    let latest_middle_pixels = solid_rgba(6, 6, [240, 240, 0, 255]);
    let latest_top_pixels = solid_rgba(6, 6, [180, 0, 220, 255]);
    let latest_damage = latest
        .update_buffer_surface_snapshot(&middle, 10, &latest_middle_pixels)
        .expect("latest middle pixels should apply");
    let z_latest_damage = latest
        .set_z_snapshot(&middle, 11, 20)
        .expect("latest z update should apply");
    let top_damage = latest
        .update_buffer_surface_snapshot(&top, 10, &latest_top_pixels)
        .expect("latest top pixels should apply");
    let repaint_count_after_latest = latest.source_repaint_count();
    let stale_damage = latest
        .update_buffer_surface_snapshot(&middle, 9, &stale_middle_pixels)
        .expect("older middle pixels should be reconciled away");
    let stale_z_damage = latest
        .set_z_snapshot(&middle, 9, -5)
        .expect("older z update should be reconciled away");

    assert_eq!(latest_damage.rects, vec![middle_rect]);
    assert_eq!(z_latest_damage.rects, vec![middle_rect]);
    assert_eq!(top_damage.rects, vec![top_rect]);
    assert_eq!(stale_damage.rects, Vec::<Rect>::new());
    assert_eq!(stale_z_damage.rects, Vec::<Rect>::new());
    assert_eq!(latest.source_repaint_count(), repaint_count_after_latest);

    let merged = merge_damage([
        latest_damage,
        top_damage,
        z_latest_damage,
        stale_damage,
        stale_z_damage,
    ]);
    let report = latest
        .composite(&merged)
        .expect("latest snapshot should composite");
    assert_eq!(report.surfaces, 3);
    let output = latest
        .output_readback_rgba()
        .expect("latest output should be readable");
    assert_output_pixel(&output, 10, 4, 4, [240, 240, 0, 255]);
    assert_output_pixel(&output, 10, 8, 8, [180, 0, 220, 255]);
    assert_output_pixel(&output, 10, 1, 1, [220, 0, 0, 255]);

    let marker_report = SelfTestReport {
        gpu: "stacking-test-gpu".to_owned(),
        surfaces: 3,
        composited_ok: true,
        reposition_no_repaint: true,
        present: PresentationMode::RECORDING,
        damage_ok: true,
        input: InputAvailability::Unverified,
        status: SelfTestStatus::Ok,
        reason: None,
    };
    let marker = marker_report.marker_line();
    println!("{marker}");
    assert!(marker.starts_with("VITA-COMPOSITOR: "));
    assert!(marker.contains("surfaces=3"));
    assert!(marker.contains("status=OK"));

    assert_eq!(
        compositor.raise_surface(&surface_id("surface:missing")),
        Err(CompositorError::UnknownSurface(surface_id(
            "surface:missing"
        )))
    );
    assert_eq!(
        compositor.set_z(&surface_id("surface:missing"), 99),
        Err(CompositorError::UnknownSurface(surface_id(
            "surface:missing"
        )))
    );
}

#[derive(Clone, Debug)]
struct RecordingTexture {
    handle: i64,
    width: u32,
    height: u32,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct RecordingOutput {
    width: u32,
    height: u32,
    bytes: Vec<u8>,
}

struct RecordingBackend {
    name: String,
    next_handle: i64,
    repaint_count: u64,
    last_output: Option<RecordingOutput>,
}

impl RecordingBackend {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            next_handle: 1,
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
        vita_compositor_core::validate_rgba_buffer(width, height, rgba)?;
        let handle = self.next_handle;
        self.next_handle += 1;
        self.repaint_count += 1;
        Ok(RecordingTexture {
            handle,
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
        vita_compositor_core::validate_rgba_buffer(width, height, rgba)?;
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
            value: texture.handle,
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

fn register_solid(
    compositor: &mut Compositor<RecordingBackend>,
    id: &SurfaceId,
    width: u32,
    height: u32,
    rgba: [u8; 4],
) {
    let pixels = solid_rgba(width, height, rgba);
    compositor
        .register_buffer_surface(id.clone(), width, height, &pixels)
        .expect("buffer surface should register");
}

fn solid_rgba(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for _ in 0..(width * height) {
        pixels.extend_from_slice(&rgba);
    }
    pixels
}

fn merge_damage<const N: usize>(
    reports: [vita_compositor_core::DamageReport; N],
) -> vita_compositor_core::DamageReport {
    let mut changed_surfaces = Vec::new();
    let mut rects = Vec::new();
    for report in reports {
        for surface in report.changed_surfaces {
            if !changed_surfaces.contains(&surface) {
                changed_surfaces.push(surface);
            }
        }
        for rect in report.rects {
            if !rects.contains(&rect) {
                rects.push(rect);
            }
        }
    }
    vita_compositor_core::DamageReport {
        changed_surfaces,
        rects,
    }
}

fn assert_output_pixel(rgba: &[u8], width: u32, x: u32, y: u32, expected: [u8; 4]) {
    let offset = ((y * width + x) * 4) as usize;
    assert_eq!(rgba[offset..offset + 4], expected);
}

fn surface_id(id: &str) -> SurfaceId {
    SurfaceId::new(id).expect("surface id should be valid")
}

use std::collections::{BTreeMap, VecDeque};
use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::{fs::FileTypeExt, net::UnixStream};

use vita_compositor_core::platform::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test, query_default_output_mode,
};
use vita_compositor_core::{
    failsafe_report, rgba_buffer_byte_len, run_reposition_self_test_or_failsafe,
    start_desktop_demo_or_failsafe, Compositor, CompositorError, DamageReport, InputAvailability,
    InputEvent, Placement, PointerButtonState, Rect, RenderBackend, RoutedInputEvent,
    SelfTestReport, SelfTestStatus, SurfaceId, TestPattern, DESKTOP_DEMO_OUTPUT_HEIGHT,
    DESKTOP_DEMO_OUTPUT_WIDTH,
};

const DEFAULT_DEMO_HOLD_SECONDS: u64 = 30;
const MAX_COMMAND_RGBA_BYTES: usize = 16 * 1024 * 1024;
// PSD-055: the visible software-cursor surface id the launch stream registers; the session keeps
// its placement tracking the router's absolute pointer position.
const CURSOR_SURFACE_ID: &str = "cursor:pointer";
const INPUT_EVENT_QUEUE_CAPACITY: usize = 256;
const MAX_INPUT_EVENTS_PER_TICK: usize = 256;
const MAX_INPUT_EVENT_LINE_BYTES: usize = 512;
#[cfg(target_os = "linux")]
const LINUX_O_NONBLOCK: i32 = 0o4000;

// PSD-500: resolve the REAL output dimensions for the live desktop. Prefer the actual DRM/KMS
// connector mode (the VMware virtual display size, e.g. 1920x1080) so the desktop fills the screen
// instead of rendering in a 1280x720 corner. Fall back to the demo default (1280x720) when the mode
// cannot be read (no card0 / headless / non-VMware). Emits a diagnostic marker either way.
fn resolve_output_dimensions() -> (u32, u32) {
    match query_default_output_mode() {
        Some((w, h)) if w >= 320 && h >= 240 && w <= 16384 && h <= 16384 => {
            emit_marker_best_effort(&format!(
                "VITA-DISPLAY: output-mode={w}x{h} source=kms-connector"
            ));
            (w, h)
        }
        Some((w, h)) => {
            emit_marker_best_effort(&format!(
                "VITA-DISPLAY: output-mode={w}x{h} rejected (out-of-range) source=kms-connector \
                 fallback={DESKTOP_DEMO_OUTPUT_WIDTH}x{DESKTOP_DEMO_OUTPUT_HEIGHT}"
            ));
            (DESKTOP_DEMO_OUTPUT_WIDTH, DESKTOP_DEMO_OUTPUT_HEIGHT)
        }
        None => {
            emit_marker_best_effort(&format!(
                "VITA-DISPLAY: output-mode=unknown source=fallback \
                 {DESKTOP_DEMO_OUTPUT_WIDTH}x{DESKTOP_DEMO_OUTPUT_HEIGHT}"
            ));
            (DESKTOP_DEMO_OUTPUT_WIDTH, DESKTOP_DEMO_OUTPUT_HEIGHT)
        }
    }
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let result = dispatch(args);

    if let Err(error) = result {
        eprintln!("vita-compositor-core: {error}");
        std::process::exit(1);
    }
}

fn dispatch(args: Vec<String>) -> Result<(), CompositorError> {
    if args
        .iter()
        .any(|arg| arg == "--commands" || arg == "--command-stream")
    {
let continuous = args.iter().any(|arg| arg == "--continuous");
        run_command_stream(
            parse_hold_seconds(&args)?,
            parse_screenshot_path(&args)?,
            parse_input_out_path(&args)?,
            continuous,
        )
    } else if args.iter().any(|arg| arg == "--serve") {
        serve()
    } else if args.iter().any(|arg| arg == "--demo") {
        run_demo(parse_hold_seconds(&args)?, parse_screenshot_path(&args)?)
    } else {
        run_self_test()
    }
}

fn run_self_test() -> Result<(), CompositorError> {
    let report =
        run_reposition_self_test_or_failsafe(open_default_gpu_backend_for_self_test(96, 64));
    emit_marker(&report.marker_line())?;
    Ok(())
}

fn run_demo(hold_seconds: u64, screenshot_path: Option<PathBuf>) -> Result<(), CompositorError> {
    let outcome = start_desktop_demo_or_failsafe(open_default_gpu_backend_for_self_test(
        DESKTOP_DEMO_OUTPUT_WIDTH,
        DESKTOP_DEMO_OUTPUT_HEIGHT,
    ));

    match outcome {
        vita_compositor_core::DesktopDemoOutcome::Running(mut session) => {
            if let Some(path) = screenshot_path {
                if let Err(error) = session.write_screenshot_png(&path) {
                    let mut report = session.report().clone();
                    report.status = SelfTestStatus::Failsafe;
                    report.reason = Some(format!("screenshot_failed: {error}"));
                    emit_marker(&report.marker_line())?;
                    return Err(error);
                }
            }
            emit_marker(&session.report().marker_line())?;
            thread::sleep(Duration::from_secs(hold_seconds));
        }
        vita_compositor_core::DesktopDemoOutcome::Failsafe(report) => {
            emit_marker(&report.marker_line())?;
        }
    }
    Ok(())
}

fn run_command_stream(
    hold_seconds: u64,
    screenshot_path: Option<PathBuf>,
    input_out_path: Option<PathBuf>,
    continuous: bool,
) -> Result<(), CompositorError> {
    let mut reverse_input = input_out_path
        .as_deref()
        .map(ReverseInputChannel::open_path);
    // PSD-500: render at the REAL display resolution (queried from the KMS connector) so the live
    // desktop fills the screen rather than a 1280x720 corner. Falls back to the demo default.
    let (output_width, output_height) = resolve_output_dimensions();
    let backend = match open_default_gpu_backend_for_self_test(output_width, output_height) {
        Ok(backend) => backend,
        Err(error) => {
            if let Some(channel) = reverse_input.as_mut() {
                channel.finish();
                emit_marker(&channel.summary_marker())?;
            }
            let report = failsafe_report("unavailable", command_failsafe_reason(&error));
            emit_marker(&report.marker_line())?;
            return Ok(());
        }
    };
    let mut session = CommandDrivenSession::new(backend, output_width, output_height)?;
    if let Some(channel) = reverse_input.take() {
        session.set_reverse_input_channel(channel);
    }
    let stdin = io::stdin();

    // PERSISTENT desktop (spike/cef-vm): --continuous keeps the compositor presenting every
    // frame the CEF stream delivers, indefinitely, so a powered-on VM shows the LIVE desktop
    // rather than a few-frame flash. The stream never EOFs in normal operation; the OK marker
    // (which carries gpu=…/present=kms — the verification gate) must therefore be emitted ONCE
    // after the FIRST successful present, not at EOF. write_screenshot is skipped (the desktop
    // is live on the GPU; the running VM is captured with vmrun captureScreen). On a clean EOF
    // (the upstream pipe closed) we exit 0 fail-closed; on error we emit the failsafe marker.
    if continuous {
        // PSD-055: continuous = the interactive live desktop. Drain libinput + move the cursor
        // surface every present, and relax the static no-repaint verification invariant.
        session.set_interactive(true);
        // The closure emits the REAL VITA-COMPOSITOR OK marker (with gpu=…/present=kms — the
        // verification gate) exactly once, right after the first frame is presented on the GPU.
        let report = match session.run_continuous(stdin.lock(), |marker| {
            emit_marker_best_effort(marker);
        }) {
            Ok(report) => report,
            Err(error) => {
                let report = session.failsafe_report(command_failsafe_reason(&error));
                emit_marker(&report.marker_line())?;
                return Err(error);
            }
        };
        // Reached only on a clean upstream EOF: emit the final report and exit.
        emit_marker(&report.marker_line())?;
        return Ok(());
    }

    let report = match session.run(stdin.lock()) {
        Ok(report) => report,
        Err(error) => {
            if let Some(line) = session.reverse_input_summary_marker() {
                emit_marker(&line)?;
            }
            let report = session.failsafe_report(command_failsafe_reason(&error));
            emit_marker(&report.marker_line())?;
            return Err(error);
        }
    };

    if let Some(line) = session.reverse_input_summary_marker() {
        emit_marker(&line)?;
    }

    if let Some(path) = screenshot_path {
        if let Err(error) = session.write_screenshot_png(&path) {
            let report = session.failsafe_report(format!("screenshot_failed: {error}"));
            emit_marker(&report.marker_line())?;
            return Err(error);
        }
    }

    emit_marker(&report.marker_line())?;
    thread::sleep(Duration::from_secs(hold_seconds));
    Ok(())
}

// Emit a marker line to stdout, ignoring any I/O error (used from the continuous-present hot
// path where a transient stdout error must not tear the live desktop down).
fn emit_marker_best_effort(line: &str) {
    let mut stdout = io::stdout();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn emit_marker(line: &str) -> Result<(), CompositorError> {
    let mut stdout = io::stdout();
    writeln!(stdout, "{line}").map_err(|err| CompositorError::Protocol(err.to_string()))?;
    stdout
        .flush()
        .map_err(|err| CompositorError::Protocol(err.to_string()))
}

fn serve() -> Result<(), CompositorError> {
    let backend = open_default_gpu_backend(1280, 720)?;
    let mut compositor = Compositor::new(backend, 1280, 720)?;
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    writeln!(stdout, "ready backend={}", compositor.backend_name())
        .map_err(|err| CompositorError::Protocol(err.to_string()))?;

    for line in stdin.lock().lines() {
        let line = line.map_err(|err| CompositorError::Protocol(err.to_string()))?;
        if line.trim() == "input-events" {
            writeln!(stdout, "input-stream-started")
                .map_err(|err| CompositorError::Protocol(err.to_string()))?;
            stdout
                .flush()
                .map_err(|err| CompositorError::Protocol(err.to_string()))?;
            stream_input_events(&mut compositor, &mut stdout)?;
            return Ok(());
        }
        let response = handle_command(&mut compositor, &line)?;
        writeln!(stdout, "{response}").map_err(|err| CompositorError::Protocol(err.to_string()))?;
        stdout
            .flush()
            .map_err(|err| CompositorError::Protocol(err.to_string()))?;
    }

    Ok(())
}

fn handle_command<B: vita_compositor_core::RenderBackend>(
    compositor: &mut Compositor<B>,
    line: &str,
) -> Result<String, CompositorError> {
    let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
    let command = fields
        .first()
        .ok_or_else(|| CompositorError::Protocol("empty command".to_owned()))?;

    match *command {
        "register-surface" => {
            let id = SurfaceId::new(required_field(&fields, 1, "surface id")?)?;
            let width = parse_u32(required_field(&fields, 2, "width")?, "width")?;
            let height = parse_u32(required_field(&fields, 3, "height")?, "height")?;
            let color = parse_rgba(required_field(&fields, 4, "rgba")?)?;
            let registration = compositor.register_test_surface(
                id,
                width,
                height,
                TestPattern::Solid { rgba: color },
            )?;
            Ok(format!(
                "surface-registered id={} texture-kind={:?} texture={} format={}",
                registration.surface_id,
                registration.texture.kind,
                registration.texture.value,
                registration.texture.format.as_str()
            ))
        }
        "update-placements" => {
            let mut placements = Vec::new();
            for field in fields.iter().skip(1) {
                placements.push(parse_placement(field)?);
            }
            let damage = compositor.update_placements(placements)?;
            Ok(format!(
                "placements-updated changed={} damage={}",
                damage.changed_surfaces.len(),
                damage.rects.len()
            ))
        }
        "set-focus" => {
            let id = required_field(&fields, 1, "surface id or none")?;
            if id == "none" {
                compositor.set_focus(None)?;
            } else {
                compositor.set_focus(Some(SurfaceId::new(id)?))?;
            }
            Ok("focus-updated".to_owned())
        }
        "composite" => {
            let damage = DamageReport {
                changed_surfaces: Vec::new(),
                rects: vec![Rect::new(0, 0, 1280, 720)?],
            };
            let report = compositor.composite(&damage)?;
            Ok(format!(
                "composited surfaces={} damage={} status=OK",
                report.surfaces, report.damage_rects
            ))
        }
        "poll-input" => {
            let events = compositor.poll_input_events()?;
            if events.is_empty() {
                return Ok("input-events empty".to_owned());
            }
            Ok(format!(
                "input-events {}",
                events
                    .iter()
                    .map(format_input_event)
                    .collect::<Vec<_>>()
                    .join(" ")
            ))
        }
        _ => Err(CompositorError::Protocol(format!(
            "unknown command {command:?}"
        ))),
    }
}

pub(crate) struct CommandDrivenSession<B: RenderBackend> {
    compositor: Compositor<B>,
    placements: BTreeMap<SurfaceId, Placement>,
    pending_damage: DamageReport,
    gpu: String,
    present: vita_compositor_core::PresentationMode,
    input: InputAvailability,
    reposition_no_repaint: bool,
    presented: bool,
    reverse_input: Option<ReverseInputChannel>,
    // PSD-055: interactive (continuous) mode relaxes the strict "no repaint during placement
    // updates" verification invariant — moving the cursor surface IS a legitimate placement
    // change every tick — and tracks the absolute cursor so the cursor surface follows it.
    interactive: bool,
    cursor_pos: (u32, u32),
    cursor_surface: Option<SurfaceId>,
}

impl<B: RenderBackend> CommandDrivenSession<B> {
    pub(crate) fn new(
        backend: B,
        output_width: u32,
        output_height: u32,
    ) -> Result<Self, CompositorError> {
        let gpu = backend.backend_name().to_owned();
        let present = backend.presentation_mode();
        let input = backend.input_availability();
        Ok(Self {
            compositor: Compositor::new(backend, output_width, output_height)?,
            gpu,
            input,
            pending_damage: empty_damage(),
            placements: BTreeMap::new(),
            present,
            presented: false,
            reposition_no_repaint: true,
            reverse_input: None,
            interactive: false,
            cursor_pos: (0, 0),
            cursor_surface: None,
        })
    }

    pub(crate) fn set_interactive(&mut self, interactive: bool) {
        self.interactive = interactive;
    }

    pub(crate) fn set_reverse_input_channel(&mut self, channel: ReverseInputChannel) {
        self.reverse_input = Some(channel);
    }

    pub(crate) fn reverse_input_summary_marker(&self) -> Option<String> {
        self.reverse_input
            .as_ref()
            .map(ReverseInputChannel::summary_marker)
    }

    pub(crate) fn run<R: BufRead>(&mut self, reader: R) -> Result<SelfTestReport, CompositorError> {
        let result = self.run_inner(reader);
        self.finish_reverse_input();
        result
    }

    fn run_inner<R: BufRead>(&mut self, reader: R) -> Result<SelfTestReport, CompositorError> {
        for line in reader.lines() {
            let line = line.map_err(|err| CompositorError::Protocol(err.to_string()))?;
            if line.trim().is_empty() {
                return Err(CompositorError::Protocol("empty command".to_owned()));
            }
            self.handle_line(&line)?;
        }

        if !self.presented {
            return Err(CompositorError::Protocol(
                "command stream ended before present".to_owned(),
            ));
        }

        Ok(self.ok_report())
    }

    // PERSISTENT desktop (spike/cef-vm): like `run`, but the OK report marker is emitted (via
    // `on_first_present`) the FIRST time a frame is presented, and the loop then keeps reading +
    // presenting every subsequent frame indefinitely. It returns the ok_report only on a CLEAN
    // EOF (the upstream CEF pipe closed). This is what keeps the live desktop on the KMS scanout
    // for the whole life of the powered-on VM instead of a few-frame flash.
    fn run_continuous<R: BufRead>(
        &mut self,
        reader: R,
        mut on_first_present: impl FnMut(&str),
    ) -> Result<SelfTestReport, CompositorError> {
        let mut announced = false;
        for line in reader.lines() {
            let line = line.map_err(|err| CompositorError::Protocol(err.to_string()))?;
            if line.trim().is_empty() {
                return Err(CompositorError::Protocol("empty command".to_owned()));
            }
            self.handle_line(&line)?;
            if !announced && self.presented {
                announced = true;
                on_first_present(&self.ok_report().marker_line());
            }
        }

        if !self.presented {
            return Err(CompositorError::Protocol(
                "command stream ended before present".to_owned(),
            ));
        }

        Ok(self.ok_report())
    }

    fn handle_line(&mut self, line: &str) -> Result<(), CompositorError> {
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        let command = fields
            .first()
            .ok_or_else(|| CompositorError::Protocol("empty command".to_owned()))?;

        match *command {
            "registerSurface" => self.register_surface(&fields),
            "registerBufferSurface" => self.register_buffer_surface(&fields),
            "updateBufferSurface" => self.update_buffer_surface(&fields),
            "updatePlacement" => self.update_placement(&fields),
            "removeSurface" => self.remove_surface(&fields),
            "present" => self.present(&fields),
            "routeInput" => self.route_input(&fields),
            _ => Err(CompositorError::Protocol(format!(
                "unknown command {command:?}"
            ))),
        }
    }

    fn register_surface(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 5, "registerSurface")?;
        let id = SurfaceId::new(required_field(fields, 1, "surface id")?)?;
        let width = parse_u32(required_field(fields, 2, "width")?, "width")?;
        let height = parse_u32(required_field(fields, 3, "height")?, "height")?;
        let color = parse_rgba(required_field(fields, 4, "rgba")?)?;
        self.compositor.register_test_surface(
            id,
            width,
            height,
            TestPattern::Solid { rgba: color },
        )?;
        // Mutating the scene invalidates the last present: a fresh present must follow before the
        // stream can succeed (otherwise a screenshot would show the stale pre-mutation frame).
        self.presented = false;
        Ok(())
    }

    fn register_buffer_surface(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 5, "registerBufferSurface")?;
        let id = SurfaceId::new(required_field(fields, 1, "surface id")?)?;
        let width = parse_u32(required_field(fields, 2, "width")?, "width")?;
        let height = parse_u32(required_field(fields, 3, "height")?, "height")?;
        let expected_len = checked_command_rgba_len(width, height)?;
        let rgba = parse_buffer_payload(required_field(fields, 4, "rgba")?, expected_len)?;
        self.compositor
            .register_buffer_surface(id, width, height, &rgba)?;
        // Mutating the scene invalidates the last present: a fresh present must follow before the
        // stream can succeed (otherwise a screenshot would show the stale pre-mutation frame).
        self.presented = false;
        Ok(())
    }

    fn update_buffer_surface(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 3, "updateBufferSurface")?;
        let id = SurfaceId::new(required_field(fields, 1, "surface id")?)?;
        let expected_len = self.compositor.surface_rgba_byte_len(&id)?;
        if expected_len > MAX_COMMAND_RGBA_BYTES {
            return Err(CompositorError::Protocol(
                "rgba payload exceeds maximum command size".to_owned(),
            ));
        }
        let rgba = parse_buffer_payload(required_field(fields, 2, "rgba")?, expected_len)?;
        let damage = self.compositor.update_buffer_surface(&id, &rgba)?;
        self.merge_damage(damage);
        // Scene changed: invalidate the last present (see register_surface).
        self.presented = false;
        Ok(())
    }

    fn update_placement(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 8, "updatePlacement")?;
        let id = SurfaceId::new(required_field(fields, 1, "surface id")?)?;
        if !self.compositor.has_surface(&id) {
            return Err(CompositorError::UnknownSurface(id));
        }

        let x = parse_i32(required_field(fields, 2, "x")?, "x")?;
        let y = parse_i32(required_field(fields, 3, "y")?, "y")?;
        let width = parse_u32(required_field(fields, 4, "width")?, "width")?;
        let height = parse_u32(required_field(fields, 5, "height")?, "height")?;
        let z = parse_i32(required_field(fields, 6, "z")?, "z")?;
        let visible = parse_bool(required_field(fields, 7, "visible")?, "visible")?;
        let before_repaint_count = self.compositor.source_repaint_count();

        // PSD-055: recognise the visible-cursor surface so present() can keep it tracking the
        // router's absolute pointer position. Seed cursor_pos from its initial placement.
        if id.as_str() == CURSOR_SURFACE_ID {
            if visible {
                self.cursor_surface = Some(id.clone());
                self.cursor_pos = (x.max(0) as u32, y.max(0) as u32);
            } else {
                self.cursor_surface = None;
            }
        }

        if visible {
            self.placements
                .insert(id.clone(), Placement::new(id, x, y, width, height, z)?);
        } else {
            self.placements.remove(&id);
        }

        let placements = self.placements.values().cloned().collect::<Vec<_>>();
        let damage = self.compositor.update_placements(placements)?;
        if self.compositor.source_repaint_count() != before_repaint_count {
            self.reposition_no_repaint = false;
        }
        self.merge_damage(damage);
        // Scene changed: invalidate the last present (see register_surface).
        self.presented = false;
        Ok(())
    }

    fn remove_surface(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 2, "removeSurface")?;
        let id = SurfaceId::new(required_field(fields, 1, "surface id")?)?;
        self.placements.remove(&id);
        let damage = self.compositor.remove_surface(&id)?;
        self.merge_damage(damage);
        // Scene changed: invalidate the last present (see register_surface).
        self.presented = false;
        Ok(())
    }

    fn present(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 1, "present")?;
        // Interactive desktop: pull the latest input + move the cursor surface BEFORE compositing
        // so the visible cursor is up to date in the frame we are about to scan out.
        if self.interactive {
            self.drain_reverse_input();
            self.reposition_cursor_surface()?;
        }
        let before_repaint_count = self.compositor.source_repaint_count();
        let report = self.compositor.composite(&self.pending_damage)?;
        if self.compositor.source_repaint_count() != before_repaint_count {
            self.reposition_no_repaint = false;
        }
        if !report.composited {
            return Err(CompositorError::Verification(
                "command stream composite did not complete".to_owned(),
            ));
        }
        // The no-repaint invariant is a verification guard for the static self-test/one-shot path.
        // In interactive mode the cursor surface moves every tick (a legitimate repaint), so the
        // invariant does not apply — skip it. The one-shot/self-test path keeps enforcing it.
        if !self.interactive && !self.reposition_no_repaint {
            return Err(CompositorError::Verification(
                "command stream source content changed during placement updates".to_owned(),
            ));
        }

        self.pending_damage = empty_damage();
        if !self.interactive {
            // Non-interactive path drains input after present (PSD-302 default cadence).
            self.drain_reverse_input();
        }
        self.presented = true;
        Ok(())
    }

    // PSD-055 visible cursor: keep the top-most cursor surface placed at the router's absolute
    // cursor position. The cursor surface is registered by the launch command stream as
    // `cursor:pointer` with a high z-index; here we only update its placement to follow the mouse.
    fn reposition_cursor_surface(&mut self) -> Result<(), CompositorError> {
        let Some(id) = self.cursor_surface.clone() else {
            return Ok(());
        };
        let Some(existing) = self.placements.get(&id).cloned() else {
            return Ok(());
        };
        let (cx, cy) = self.cursor_pos;
        if existing.x == cx as i32 && existing.y == cy as i32 {
            return Ok(()); // unchanged — avoid a needless placement update
        }
        let updated = Placement::new(
            id.clone(),
            cx as i32,
            cy as i32,
            existing.width,
            existing.height,
            existing.z_index,
        )?;
        self.placements.insert(id, updated);
        let placements = self.placements.values().cloned().collect::<Vec<_>>();
        let damage = self.compositor.update_placements(placements)?;
        self.merge_damage(damage);
        Ok(())
    }

    fn route_input(&mut self, fields: &[&str]) -> Result<(), CompositorError> {
        require_field_count(fields, 1, "routeInput")?;
        self.drain_reverse_input();
        Ok(())
    }

    fn drain_reverse_input(&mut self) {
        let Some(mut channel) = self.reverse_input.take() else {
            return;
        };

        self.drain_reverse_input_into(&mut channel);
        self.reverse_input = Some(channel);
    }

    fn drain_reverse_input_into(&mut self, channel: &mut ReverseInputChannel) {
        let events = match self.compositor.poll_input_events() {
            Ok(events) => events,
            Err(error) => {
                channel.record_failsafe(format!("poll_failed:{error}"));
                return;
            }
        };

        if !events.is_empty() {
            eprintln!("VITA-INPUT-DIAG: drain got {} InputEvent(s)", events.len());
        }

        let overflow = events.len().saturating_sub(MAX_INPUT_EVENTS_PER_TICK);
        if overflow > 0 {
            channel.drop_events(overflow);
        }

        for event in events.iter().take(MAX_INPUT_EVENTS_PER_TICK) {
            let routed = match self.compositor.route_input_event(event) {
                Ok(routed) => routed,
                Err(error) => {
                    channel.record_failsafe(format!("route_failed:{error}"));
                    channel.drop_events(1);
                    continue;
                }
            };
            // PSD-055 wiring: emit the ROUTED event carrying the absolute cursor position the
            // router computed (clamped, accumulated from libinput deltas), so the CEF host can
            // SendMouseMoveEvent/SendMouseClickEvent at the right absolute coordinates and the
            // visible cursor surface tracks it. The compositor owns the cursor; track it here so
            // the cursor surface (registered by the launch stream as cursor:pointer) follows.
            self.cursor_pos = self.compositor.cursor();
            channel.enqueue(format_reverse_input_event(&routed));
        }

        channel.drain_best_effort();
    }

    fn finish_reverse_input(&mut self) {
        if let Some(channel) = &mut self.reverse_input {
            channel.finish();
        }
    }

    fn merge_damage(&mut self, damage: DamageReport) {
        for surface in damage.changed_surfaces {
            if !self.pending_damage.changed_surfaces.contains(&surface) {
                self.pending_damage.changed_surfaces.push(surface);
            }
        }
        for rect in damage.rects {
            if !self.pending_damage.rects.contains(&rect) {
                self.pending_damage.rects.push(rect);
            }
        }
    }

    fn write_screenshot_png(&mut self, path: &PathBuf) -> Result<(), CompositorError> {
        self.compositor.write_output_png(path)
    }

    fn ok_report(&self) -> SelfTestReport {
        SelfTestReport {
            composited_ok: true,
            damage_ok: true,
            gpu: self.gpu.clone(),
            input: self.input,
            present: self.present,
            reason: None,
            reposition_no_repaint: self.reposition_no_repaint,
            status: SelfTestStatus::Ok,
            surfaces: self.compositor.surface_count(),
        }
    }

    fn failsafe_report(&self, reason: impl Into<String>) -> SelfTestReport {
        SelfTestReport {
            composited_ok: false,
            damage_ok: false,
            gpu: self.gpu.clone(),
            input: self.input,
            present: self.present,
            reason: Some(reason.into()),
            reposition_no_repaint: self.reposition_no_repaint,
            status: SelfTestStatus::Failsafe,
            surfaces: self.compositor.surface_count(),
        }
    }
}

pub(crate) struct ReverseInputChannel {
    writer: Option<Box<dyn Write>>,
    queue: VecDeque<String>,
    capacity: usize,
    routed: u64,
    dropped: u64,
    failsafe_reason: Option<String>,
}

impl ReverseInputChannel {
    fn open_path(path: &Path) -> Self {
        match open_input_out_writer(path) {
            Ok(writer) => Self::new(writer, INPUT_EVENT_QUEUE_CAPACITY),
            Err(error) => {
                let mut channel = Self::closed(INPUT_EVENT_QUEUE_CAPACITY);
                channel.record_failsafe(format!("open_failed:{error}"));
                channel
            }
        }
    }

    pub(crate) fn new(writer: Box<dyn Write>, capacity: usize) -> Self {
        Self {
            writer: Some(writer),
            queue: VecDeque::with_capacity(capacity),
            capacity,
            routed: 0,
            dropped: 0,
            failsafe_reason: None,
        }
    }

    fn closed(capacity: usize) -> Self {
        Self {
            writer: None,
            queue: VecDeque::with_capacity(capacity),
            capacity,
            routed: 0,
            dropped: 0,
            failsafe_reason: None,
        }
    }

    fn enqueue(&mut self, line: String) {
        if line.len() > MAX_INPUT_EVENT_LINE_BYTES || self.queue.len() >= self.capacity {
            self.drop_events(1);
            return;
        }

        self.queue.push_back(line);
    }

    fn drain_best_effort(&mut self) {
        while let Some(line) = self.queue.pop_front() {
            match self.write_line(&line) {
                ReverseInputWriteResult::Written => {
                    eprintln!("VITA-INPUT-DIAG: channel wrote line ({} bytes)", line.len());
                    self.routed = self.routed.saturating_add(1);
                }
                ReverseInputWriteResult::Backpressure => {
                    eprintln!("VITA-INPUT-DIAG: channel BACKPRESSURE (drop)");
                    self.drop_events(1 + self.queue.len());
                    self.queue.clear();
                    break;
                }
                ReverseInputWriteResult::Closed => {
                    eprintln!("VITA-INPUT-DIAG: channel CLOSED (no reader)");
                    self.writer = None;
                    self.drop_events(1 + self.queue.len());
                    self.queue.clear();
                    break;
                }
                ReverseInputWriteResult::Failed(reason) => {
                    eprintln!("VITA-INPUT-DIAG: channel FAILED: {reason}");
                    self.record_failsafe(reason);
                    self.writer = None;
                    self.drop_events(1 + self.queue.len());
                    self.queue.clear();
                    break;
                }
            }
        }
    }

    fn write_line(&mut self, line: &str) -> ReverseInputWriteResult {
        let Some(writer) = self.writer.as_mut() else {
            return ReverseInputWriteResult::Closed;
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');

        match writer.write(&bytes) {
            Ok(written) if written == bytes.len() => ReverseInputWriteResult::Written,
            Ok(_) => ReverseInputWriteResult::Failed("partial_write".to_owned()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                ReverseInputWriteResult::Backpressure
            }
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                ReverseInputWriteResult::Closed
            }
            Err(error) => ReverseInputWriteResult::Failed(format!("write_failed:{error}")),
        }
    }

    fn finish(&mut self) {
        self.drain_best_effort();
        if let Some(writer) = self.writer.as_mut() {
            if let Err(error) = writer.flush() {
                if error.kind() != io::ErrorKind::BrokenPipe
                    && error.kind() != io::ErrorKind::WouldBlock
                {
                    self.record_failsafe(format!("flush_failed:{error}"));
                }
            }
        }
    }

    fn drop_events(&mut self, count: usize) {
        self.dropped = self.dropped.saturating_add(count as u64);
    }

    fn record_failsafe(&mut self, reason: impl Into<String>) {
        if self.failsafe_reason.is_none() {
            self.failsafe_reason = Some(reason.into());
        }
    }

    fn summary_marker(&self) -> String {
        match self.failsafe_reason.as_deref() {
            Some(reason) => format!(
                "VITA-INPUT: routed={} dropped={} status=FAILSAFE reason={}",
                self.routed,
                self.dropped,
                marker_token(reason)
            ),
            None => format!(
                "VITA-INPUT: routed={} dropped={} status=OK",
                self.routed, self.dropped
            ),
        }
    }
}

enum ReverseInputWriteResult {
    Written,
    Backpressure,
    Closed,
    Failed(String),
}

fn stream_input_events<B: vita_compositor_core::RenderBackend>(
    compositor: &mut Compositor<B>,
    stdout: &mut impl Write,
) -> Result<(), CompositorError> {
    loop {
        let events = compositor.poll_input_events()?;
        for event in &events {
            writeln!(stdout, "input-event {}", format_input_event(event))
                .map_err(|err| CompositorError::Protocol(err.to_string()))?;
        }
        if !events.is_empty() {
            stdout
                .flush()
                .map_err(|err| CompositorError::Protocol(err.to_string()))?;
        }
        thread::sleep(Duration::from_millis(16));
    }
}

fn required_field<'a>(
    fields: &'a [&str],
    index: usize,
    name: &str,
) -> Result<&'a str, CompositorError> {
    fields
        .get(index)
        .copied()
        .ok_or_else(|| CompositorError::Protocol(format!("missing {name}")))
}

fn require_field_count(
    fields: &[&str],
    expected: usize,
    command: &str,
) -> Result<(), CompositorError> {
    if fields.len() != expected {
        return Err(CompositorError::Protocol(format!(
            "{command} expects {} fields",
            expected - 1
        )));
    }

    Ok(())
}

fn parse_u32(value: &str, name: &str) -> Result<u32, CompositorError> {
    value
        .parse::<u32>()
        .map_err(|_| CompositorError::Protocol(format!("invalid {name}")))
}

fn parse_hold_seconds(args: &[String]) -> Result<u64, CompositorError> {
    let mut hold_seconds = DEFAULT_DEMO_HOLD_SECONDS;
    let mut index = 0_usize;
    while index < args.len() {
        if args[index] == "--hold-seconds" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| CompositorError::Protocol("missing hold seconds".to_owned()))?;
            hold_seconds = value
                .parse::<u64>()
                .map_err(|_| CompositorError::Protocol("invalid hold seconds".to_owned()))?;
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(hold_seconds)
}

fn parse_screenshot_path(args: &[String]) -> Result<Option<PathBuf>, CompositorError> {
    let mut path = None;
    let mut index = 0_usize;
    while index < args.len() {
        if args[index] == "--screenshot" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| CompositorError::Protocol("missing screenshot path".to_owned()))?;
            path = Some(PathBuf::from(value));
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(path)
}

fn parse_input_out_path(args: &[String]) -> Result<Option<PathBuf>, CompositorError> {
    let mut path = None;

    for arg in args {
        if let Some(value) = arg.strip_prefix("--input-out=") {
            if value.is_empty() {
                return Err(CompositorError::Protocol(
                    "missing input-out path".to_owned(),
                ));
            }
            path = Some(PathBuf::from(value));
        } else if arg == "--input-out" {
            return Err(CompositorError::Protocol(
                "input-out must use --input-out=<path>".to_owned(),
            ));
        }
    }

    Ok(path)
}

fn parse_i32(value: &str, name: &str) -> Result<i32, CompositorError> {
    value
        .parse::<i32>()
        .map_err(|_| CompositorError::Protocol(format!("invalid {name}")))
}

fn parse_bool(value: &str, name: &str) -> Result<bool, CompositorError> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(CompositorError::Protocol(format!("invalid {name}"))),
    }
}

fn parse_rgba(value: &str) -> Result<[u8; 4], CompositorError> {
    if value.len() != 8
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(CompositorError::Protocol(
            "rgba must be eight lowercase hex digits".to_owned(),
        ));
    }

    let parsed = u32::from_str_radix(value, 16)
        .map_err(|_| CompositorError::Protocol("invalid rgba hex".to_owned()))?;
    Ok([
        ((parsed >> 24) & 0xff) as u8,
        ((parsed >> 16) & 0xff) as u8,
        ((parsed >> 8) & 0xff) as u8,
        (parsed & 0xff) as u8,
    ])
}

fn checked_command_rgba_len(width: u32, height: u32) -> Result<usize, CompositorError> {
    let expected_len = rgba_buffer_byte_len(width, height)?;
    if expected_len > MAX_COMMAND_RGBA_BYTES {
        return Err(CompositorError::Protocol(
            "rgba payload exceeds maximum command size".to_owned(),
        ));
    }
    Ok(expected_len)
}

fn parse_buffer_payload(value: &str, expected_len: usize) -> Result<Vec<u8>, CompositorError> {
    if expected_len > MAX_COMMAND_RGBA_BYTES
        || value.len() > MAX_COMMAND_RGBA_BYTES.saturating_mul(2)
    {
        return Err(CompositorError::Protocol(
            "rgba payload exceeds maximum command size".to_owned(),
        ));
    }

    // PSD-FPS: single-pass LUT hex decode that also validates (returns None on any
    // non-hex byte / odd length). This replaces the previous two full scans of the
    // ~22 MB payload (`bytes().all(is_hex_digit)` then a branchy per-nibble decode) and
    // the trailing clone of the decoded buffer — the hot path for every content frame.
    // Behaviour is preserved: a valid-hex payload of the expected length returns here;
    // a valid-hex payload of the wrong length still falls through to the base64 attempt
    // below (and the error reports the hex-decoded length, as before).
    let hex = decode_hex_payload_checked(value);
    let hex_len = hex.as_ref().map(Vec::len);

    if let Some(bytes) = hex {
        if bytes.len() == expected_len {
            return Ok(bytes);
        }
    }

    match decode_base64_payload(value) {
        Ok(bytes) if bytes.len() == expected_len => Ok(bytes),
        Ok(bytes) => Err(CompositorError::InvalidBufferLength {
            expected: expected_len,
            actual: hex_len.unwrap_or(bytes.len()),
        }),
        Err(base64_error) => {
            if let Some(actual) = hex_len {
                return Err(CompositorError::InvalidBufferLength {
                    expected: expected_len,
                    actual,
                });
            }
            Err(base64_error)
        }
    }
}

// PSD-FPS: 256-entry hex lookup table — ASCII byte -> nibble value, or 0xFF for any
// non-hex byte. Lets the per-frame decode validate + decode in a single branch-light
// pass over the ~22 MB payload (was: a full `is_hex_digit` scan followed by a branchy
// `hex_value` decode + a clone).
const HEX_LUT: [u8; 256] = {
    let mut t = [0xFFu8; 256];
    let mut c = b'0';
    while c <= b'9' {
        t[c as usize] = c - b'0';
        c += 1;
    }
    let mut c = b'a';
    while c <= b'f' {
        t[c as usize] = c - b'a' + 10;
        c += 1;
    }
    let mut c = b'A';
    while c <= b'F' {
        t[c as usize] = c - b'A' + 10;
        c += 1;
    }
    t
};

// Single-pass LUT hex decode. Returns None if the input has odd length or contains any
// non-hex byte (so the caller falls through to base64), matching the old guard exactly.
fn decode_hex_payload_checked(value: &str) -> Option<Vec<u8>> {
    let s = value.as_bytes();
    if s.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(s.len() / 2);
    for chunk in s.chunks_exact(2) {
        let high = HEX_LUT[chunk[0] as usize];
        let low = HEX_LUT[chunk[1] as usize];
        if high == 0xFF || low == 0xFF {
            return None;
        }
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn decode_base64_payload(value: &str) -> Result<Vec<u8>, CompositorError> {
    let mut out = Vec::with_capacity(value.len().saturating_mul(3) / 4);
    let mut block = [0_u8; 4];
    let mut block_len = 0_usize;
    let mut finished = false;

    for byte in value.bytes() {
        if finished {
            return Err(CompositorError::Protocol(
                "invalid base64 rgba payload".to_owned(),
            ));
        }

        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => {
                return Err(CompositorError::Protocol(
                    "invalid base64 rgba payload".to_owned(),
                ));
            }
        };

        block[block_len] = value;
        block_len += 1;
        if block_len == 4 {
            finished = decode_base64_block(&block, &mut out)?;
            block_len = 0;
        }
    }

    match block_len {
        0 => Ok(out),
        2 => {
            if block[0] == 64 || block[1] == 64 {
                return Err(CompositorError::Protocol(
                    "invalid base64 rgba payload".to_owned(),
                ));
            }
            out.push((block[0] << 2) | (block[1] >> 4));
            Ok(out)
        }
        3 => {
            if block[0] == 64 || block[1] == 64 || block[2] == 64 {
                return Err(CompositorError::Protocol(
                    "invalid base64 rgba payload".to_owned(),
                ));
            }
            out.push((block[0] << 2) | (block[1] >> 4));
            out.push((block[1] << 4) | (block[2] >> 2));
            Ok(out)
        }
        _ => Err(CompositorError::Protocol(
            "invalid base64 rgba payload".to_owned(),
        )),
    }
}

fn decode_base64_block(block: &[u8; 4], out: &mut Vec<u8>) -> Result<bool, CompositorError> {
    if block[0] == 64 || block[1] == 64 {
        return Err(CompositorError::Protocol(
            "invalid base64 rgba payload".to_owned(),
        ));
    }

    out.push((block[0] << 2) | (block[1] >> 4));
    match (block[2], block[3]) {
        (64, 64) => Ok(true),
        (64, _) => Err(CompositorError::Protocol(
            "invalid base64 rgba payload".to_owned(),
        )),
        (third, 64) => {
            out.push((block[1] << 4) | (third >> 2));
            Ok(true)
        }
        (third, fourth) => {
            out.push((block[1] << 4) | (third >> 2));
            out.push((third << 6) | fourth);
            Ok(false)
        }
    }
}

fn parse_placement(value: &str) -> Result<Placement, CompositorError> {
    let parts = value.split(',').collect::<Vec<_>>();
    if parts.len() != 6 {
        return Err(CompositorError::Protocol(
            "placement must be id,x,y,width,height,z".to_owned(),
        ));
    }

    Placement::new(
        SurfaceId::new(required_field(&parts, 0, "surface id")?)?,
        parse_i32(required_field(&parts, 1, "x")?, "x")?,
        parse_i32(required_field(&parts, 2, "y")?, "y")?,
        parse_u32(required_field(&parts, 3, "width")?, "width")?,
        parse_u32(required_field(&parts, 4, "height")?, "height")?,
        parse_i32(required_field(&parts, 5, "z")?, "z")?,
    )
}

fn format_input_event(event: &InputEvent) -> String {
    match event {
        InputEvent::Key { key_code, pressed } => {
            format!(
                "kind=key key-code={key_code} pressed={}",
                if *pressed { "true" } else { "false" }
            )
        }
        InputEvent::PointerButton { button, state } => {
            let state = match state {
                PointerButtonState::Pressed => "pressed",
                PointerButtonState::Released => "released",
            };
            format!("kind=pointer-button button={button} state={state}")
        }
        InputEvent::PointerMotion {
            dx_micropixels,
            dy_micropixels,
        } => format!(
            "kind=pointer-motion dx-micropixels={dx_micropixels} dy-micropixels={dy_micropixels}"
        ),
        InputEvent::PointerMotionAbsolute {
            x_micropixels,
            y_micropixels,
        } => format!(
            "kind=pointer-motion-absolute x-micropixels={x_micropixels} y-micropixels={y_micropixels}"
        ),
    }
}

// PSD-055: the reverse-channel line the CEF host (osr_host) reads. It carries the ROUTED event
// with the ABSOLUTE cursor position the router computed, so osr_host can call CEF's
// SendMouseMoveEvent/SendMouseClickEvent at the right coordinates and SendKeyEvent to the focused
// surface. Format (one event per line, space-separated key=value):
//   inputEvent surface=<id|none> kind=pointer-motion cursor-x=N cursor-y=N
//   inputEvent surface=<id|none> kind=pointer-button cursor-x=N cursor-y=N button=N state=pressed|released
//   inputEvent surface=<id|none> kind=key key-code=N pressed=true|false
// Dropped events still emit (surface=none) so the host/cursor can ignore them cleanly.
fn format_reverse_input_event(routed: &RoutedInputEvent) -> String {
    match routed {
        RoutedInputEvent::PointerMotion {
            surface_id,
            cursor_x,
            cursor_y,
            ..
        } => format!(
            "inputEvent surface={} kind=pointer-motion cursor-x={cursor_x} cursor-y={cursor_y}",
            surface_id.as_str()
        ),
        RoutedInputEvent::PointerButton {
            surface_id,
            cursor_x,
            cursor_y,
            button,
            state,
            ..
        } => format!(
            "inputEvent surface={} kind=pointer-button cursor-x={cursor_x} cursor-y={cursor_y} button={button} state={}",
            surface_id.as_str(),
            match state {
                PointerButtonState::Pressed => "pressed",
                PointerButtonState::Released => "released",
            }
        ),
        RoutedInputEvent::Key {
            surface_id,
            key_code,
            pressed,
        } => format!(
            "inputEvent surface={} kind=key key-code={key_code} pressed={}",
            surface_id.as_str(),
            if *pressed { "true" } else { "false" }
        ),
        RoutedInputEvent::Dropped {
            cursor_x, cursor_y, ..
        } => format!(
            "inputEvent surface=none kind=pointer-motion cursor-x={cursor_x} cursor-y={cursor_y}"
        ),
    }
}

fn empty_damage() -> DamageReport {
    DamageReport {
        changed_surfaces: Vec::new(),
        rects: Vec::new(),
    }
}

fn open_input_out_writer(path: &Path) -> io::Result<Box<dyn Write>> {
    #[cfg(unix)]
    {
        open_input_out_writer_unix(path)
    }

    #[cfg(not(unix))]
    {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        Ok(Box::new(file))
    }
}

#[cfg(unix)]
fn open_input_out_writer_unix(path: &Path) -> io::Result<Box<dyn Write>> {
    let file_type = std::fs::metadata(path)
        .ok()
        .map(|metadata| metadata.file_type());

    if file_type
        .as_ref()
        .is_some_and(|file_type| file_type.is_socket())
    {
        let stream = UnixStream::connect(path)?;
        stream.set_nonblocking(true)?;
        return Ok(Box::new(stream));
    }

    let is_fifo = file_type
        .as_ref()
        .is_some_and(|file_type| file_type.is_fifo());
    let mut options = OpenOptions::new();
    options.write(true);
    if !is_fifo {
        options.create(true).truncate(true);
    }
    #[cfg(target_os = "linux")]
    {
        options.custom_flags(LINUX_O_NONBLOCK);
    }

    let file = options.open(path)?;
    Ok(Box::new(file))
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

fn command_failsafe_reason(error: &CompositorError) -> String {
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
    use std::io::Cursor;
    use vita_compositor_core::{
        CompositeReport, GpuTextureHandle, RenderSurface, TextureFormat, TextureHandleKind,
    };

    #[test]
    fn command_session_presents_registered_surface_layout() {
        let report = run_commands(&[
            "registerSurface surface:files 32 24 e6edf2ff",
            "updatePlacement surface:files 4 5 32 24 7 true",
            "present",
        ])
        .expect("registered and placed surface should present");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.surfaces, 1);
        assert!(report.reposition_no_repaint);
        assert_eq!(
            report.marker_line(),
            "VITA-COMPOSITOR: gpu=command-test-gpu surfaces=1 composited=OK reposition=no-repaint present=recording damage=OK status=OK input=unverified"
        );
    }

    #[test]
    fn command_session_allows_remove_before_final_present() {
        let report = run_commands(&[
            "registerSurface surface:files 32 24 e6edf2ff",
            "updatePlacement surface:files 4 5 32 24 7 true",
            "removeSurface surface:files",
            "present",
        ])
        .expect("removed surface should still allow the final scene to present");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.surfaces, 0);
    }

    #[test]
    fn command_session_rejects_mutation_after_present_without_fresh_present() {
        let error = run_commands(&[
            "registerSurface surface:files 32 24 e6edf2ff",
            "updatePlacement surface:files 4 5 32 24 7 true",
            "present",
            "removeSurface surface:files",
        ])
        .expect_err("post-present mutation must not report OK with a stale frame");

        assert_eq!(
            error,
            CompositorError::Protocol("command stream ended before present".to_owned())
        );
    }

    #[test]
    fn command_session_rejects_malformed_protocol_line() {
        let error = run_commands(&["registerSurface oops"])
            .expect_err("malformed registerSurface line must fail closed");

        assert_eq!(
            error,
            CompositorError::Protocol("registerSurface expects 4 fields".to_owned())
        );
    }

    #[test]
    fn command_session_presents_buffer_surface_and_update_requires_fresh_present() {
        let report = run_commands(&[
            "registerBufferSurface surface:buffer 2 1 0a141eff28323cff",
            "updatePlacement surface:buffer 3 4 2 1 7 true",
            "present",
            "updateBufferSurface surface:buffer ZG5keP8AAP8=",
            "present",
        ])
        .expect("registered and updated buffer surface should present");

        assert_eq!(report.status, SelfTestStatus::Ok);
        assert_eq!(report.surfaces, 1);
        assert!(report.reposition_no_repaint);

        let error = run_commands(&[
            "registerBufferSurface surface:buffer 1 1 0a141eff",
            "updatePlacement surface:buffer 3 4 1 1 7 true",
            "present",
            "updateBufferSurface surface:buffer ZG5keA==",
        ])
        .expect_err("post-present buffer update must not report OK with a stale frame");

        assert_eq!(
            error,
            CompositorError::Protocol("command stream ended before present".to_owned())
        );
    }

    #[test]
    fn command_session_rejects_bad_buffer_length_fail_closed() {
        let error = run_commands(&["registerBufferSurface surface:buffer 2 2 0a141eff"])
            .expect_err("short buffer payload must fail closed");

        assert_eq!(
            error,
            CompositorError::InvalidBufferLength {
                expected: 16,
                actual: 4,
            }
        );
    }

    #[test]
    fn command_session_rejects_oversized_buffer_payload_fail_closed() {
        let error = run_commands(&["registerBufferSurface surface:buffer 2049 2048 AA=="])
            .expect_err("oversized buffer payload must fail closed");

        assert_eq!(
            error,
            CompositorError::Protocol("rgba payload exceeds maximum command size".to_owned())
        );
    }

    fn run_commands(commands: &[&str]) -> Result<SelfTestReport, CompositorError> {
        let mut session = CommandDrivenSession::new(CommandTestBackend::new(), 64, 64)?;
        let mut input = String::new();

        for command in commands {
            input.push_str(command);
            input.push('\n');
        }

        session.run(Cursor::new(input))
    }

    #[derive(Debug, Clone)]
    struct CommandTestTexture {
        handle: i64,
        width: u32,
        height: u32,
        bytes: Vec<u8>,
    }

    struct CommandTestBackend {
        next_handle: i64,
        repaint_count: u64,
    }

    impl CommandTestBackend {
        fn new() -> Self {
            Self {
                next_handle: 1,
                repaint_count: 0,
            }
        }
    }

    impl RenderBackend for CommandTestBackend {
        type Texture = CommandTestTexture;

        fn backend_name(&self) -> &str {
            "command-test-gpu"
        }

        fn presentation_mode(&self) -> vita_compositor_core::PresentationMode {
            vita_compositor_core::PresentationMode::RECORDING
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

            Ok(CommandTestTexture {
                bytes: rgba.to_vec(),
                handle,
                height,
                width,
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
                    "command test texture dimensions changed during RGBA update".to_owned(),
                ));
            }
            texture.bytes = rgba.to_vec();
            self.repaint_count += 1;
            Ok(())
        }

        fn export_handle(&self, texture: &Self::Texture) -> GpuTextureHandle {
            GpuTextureHandle {
                format: TextureFormat::Rgba8Unorm,
                height: texture.height,
                kind: TextureHandleKind::TestOnly,
                value: texture.handle,
                width: texture.width,
            }
        }

        fn composite(
            &mut self,
            surfaces: &[RenderSurface<Self::Texture>],
            _placements: &[Placement],
            damage: &[Rect],
            _output_width: u32,
            _output_height: u32,
        ) -> Result<CompositeReport, CompositorError> {
            Ok(CompositeReport {
                composited: true,
                damage_rects: damage.len(),
                surfaces: surfaces.len(),
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
            let byte_count = (output_width as usize)
                .checked_mul(output_height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or_else(|| {
                    CompositorError::Backend("recording output dimensions overflowed".to_owned())
                })?;

            Ok(vec![0_u8; byte_count])
        }

        fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
            Ok(Vec::new())
        }

        fn source_repaint_count(&self) -> u64 {
            self.repaint_count
        }
    }
}

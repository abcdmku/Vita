#[allow(dead_code)]
#[path = "../src/main.rs"]
mod compositor_bin;

use std::collections::VecDeque;
use std::io::{self, Cursor, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use compositor_bin::{CommandDrivenSession, ReverseInputChannel};
use vita_compositor_core::{
    CompositeReport, CompositorError, GpuTextureHandle, InputAvailability, InputEvent, Placement,
    PointerButtonState, Rect, RenderBackend, RenderSurface, SelfTestReport, SelfTestStatus,
    TestPattern, TextureFormat, TextureHandleKind,
};

#[test]
fn command_session_writes_ordered_reverse_input_lines() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let poll_count = Arc::new(AtomicUsize::new(0));
    let backend = RecordingBackend::with_events(
        vec![
            InputEvent::Key {
                key_code: 29,
                pressed: false,
            },
            InputEvent::PointerMotion {
                dx_micropixels: 5_000_000,
                dy_micropixels: 6_000_000,
            },
            InputEvent::PointerButton {
                button: 1,
                state: PointerButtonState::Pressed,
            },
            InputEvent::Key {
                key_code: 30,
                pressed: true,
            },
            InputEvent::PointerButton {
                button: 1,
                state: PointerButtonState::Released,
            },
        ],
        Arc::clone(&poll_count),
    );
    let mut session = CommandDrivenSession::new(backend, 64, 64).expect("session should create");
    session.set_reverse_input_channel(ReverseInputChannel::new(
        Box::new(SharedSink::new(Arc::clone(&output))),
        16,
    ));

    let report = run_commands(
        &mut session,
        &[
            "registerSurface surface:cef 32 24 e6edf2ff",
            "updatePlacement surface:cef 0 0 32 24 0 true",
            "present",
        ],
    )
    .expect("present should succeed with reverse input enabled");

    assert_eq!(report.status, SelfTestStatus::Ok);
    assert_eq!(poll_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        output_lines(&output),
        vec![
            "inputEvent surface=none kind=key key-code=29 pressed=false",
            "inputEvent surface=surface:cef kind=pointer-motion dx-micropixels=5000000 dy-micropixels=6000000",
            "inputEvent surface=surface:cef kind=pointer-button button=1 state=pressed",
            "inputEvent surface=surface:cef kind=key key-code=30 pressed=true",
            "inputEvent surface=surface:cef kind=pointer-button button=1 state=released",
        ]
    );
    assert_eq!(
        session.reverse_input_summary_marker().as_deref(),
        Some("VITA-INPUT: routed=5 dropped=0 status=OK")
    );
}

#[test]
fn command_session_writes_reverse_input_lines_on_explicit_route_tick() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let poll_count = Arc::new(AtomicUsize::new(0));
    let backend = RecordingBackend::with_events(
        vec![InputEvent::PointerMotion {
            dx_micropixels: 2_000_000,
            dy_micropixels: 3_000_000,
        }],
        Arc::clone(&poll_count),
    );
    let mut session = CommandDrivenSession::new(backend, 64, 64).expect("session should create");
    session.set_reverse_input_channel(ReverseInputChannel::new(
        Box::new(SharedSink::new(Arc::clone(&output))),
        8,
    ));

    let report = run_commands(
        &mut session,
        &[
            "registerSurface surface:cef 32 24 e6edf2ff",
            "updatePlacement surface:cef 0 0 32 24 0 true",
            "routeInput",
            "present",
        ],
    )
    .expect("explicit routeInput tick should not disturb present");

    assert_eq!(report.status, SelfTestStatus::Ok);
    assert_eq!(poll_count.load(Ordering::SeqCst), 2);
    assert_eq!(
        output_lines(&output),
        vec![
            "inputEvent surface=surface:cef kind=pointer-motion dx-micropixels=2000000 dy-micropixels=3000000",
        ]
    );
    assert_eq!(
        session.reverse_input_summary_marker().as_deref(),
        Some("VITA-INPUT: routed=1 dropped=0 status=OK")
    );
}

#[test]
fn command_session_drops_reverse_input_when_queue_is_full_and_still_presents() {
    let output = Arc::new(Mutex::new(Vec::new()));
    let poll_count = Arc::new(AtomicUsize::new(0));
    let backend = RecordingBackend::with_events(
        vec![
            InputEvent::PointerMotion {
                dx_micropixels: 1_000_000,
                dy_micropixels: 0,
            },
            InputEvent::PointerMotion {
                dx_micropixels: 1_000_000,
                dy_micropixels: 0,
            },
            InputEvent::PointerMotion {
                dx_micropixels: 1_000_000,
                dy_micropixels: 0,
            },
        ],
        Arc::clone(&poll_count),
    );
    let mut session = CommandDrivenSession::new(backend, 64, 64).expect("session should create");
    session.set_reverse_input_channel(ReverseInputChannel::new(
        Box::new(SharedSink::new(Arc::clone(&output))),
        1,
    ));

    let report = run_commands(
        &mut session,
        &[
            "registerSurface surface:cef 32 24 e6edf2ff",
            "updatePlacement surface:cef 0 0 32 24 0 true",
            "present",
        ],
    )
    .expect("backpressure should not fail present");

    assert_eq!(report.status, SelfTestStatus::Ok);
    assert_eq!(poll_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        output_lines(&output),
        vec![
            "inputEvent surface=surface:cef kind=pointer-motion dx-micropixels=1000000 dy-micropixels=0",
        ]
    );
    assert_eq!(
        session.reverse_input_summary_marker().as_deref(),
        Some("VITA-INPUT: routed=1 dropped=2 status=OK")
    );
}

#[test]
fn command_session_drops_reverse_input_when_sink_is_closed_and_still_presents() {
    let poll_count = Arc::new(AtomicUsize::new(0));
    let backend = RecordingBackend::with_events(
        vec![
            InputEvent::PointerMotion {
                dx_micropixels: 1_000_000,
                dy_micropixels: 0,
            },
            InputEvent::PointerButton {
                button: 1,
                state: PointerButtonState::Pressed,
            },
        ],
        Arc::clone(&poll_count),
    );
    let mut session = CommandDrivenSession::new(backend, 64, 64).expect("session should create");
    session.set_reverse_input_channel(ReverseInputChannel::new(Box::new(BrokenSink), 8));

    let report = run_commands(
        &mut session,
        &[
            "registerSurface surface:cef 32 24 e6edf2ff",
            "updatePlacement surface:cef 0 0 32 24 0 true",
            "present",
        ],
    )
    .expect("closed reverse sink should not fail present");

    assert_eq!(report.status, SelfTestStatus::Ok);
    assert_eq!(poll_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        session.reverse_input_summary_marker().as_deref(),
        Some("VITA-INPUT: routed=0 dropped=2 status=OK")
    );
}

#[test]
fn command_session_without_reverse_input_does_not_poll_or_change_present_behavior() {
    let poll_count = Arc::new(AtomicUsize::new(0));
    let backend = RecordingBackend::with_events(
        vec![InputEvent::PointerMotion {
            dx_micropixels: 1_000_000,
            dy_micropixels: 0,
        }],
        Arc::clone(&poll_count),
    );
    let mut session = CommandDrivenSession::new(backend, 64, 64).expect("session should create");

    let report = run_commands(
        &mut session,
        &[
            "registerSurface surface:cef 32 24 e6edf2ff",
            "updatePlacement surface:cef 0 0 32 24 0 true",
            "present",
        ],
    )
    .expect("present should behave as before without reverse input");

    assert_eq!(poll_count.load(Ordering::SeqCst), 0);
    assert_eq!(session.reverse_input_summary_marker(), None);
    assert_eq!(
        report.marker_line(),
        "VITA-COMPOSITOR: gpu=reverse-input-test-gpu surfaces=1 composited=OK reposition=no-repaint present=recording damage=OK status=OK input=unverified"
    );
}

fn run_commands(
    session: &mut CommandDrivenSession<RecordingBackend>,
    commands: &[&str],
) -> Result<SelfTestReport, CompositorError> {
    let mut input = String::new();
    for command in commands {
        input.push_str(command);
        input.push('\n');
    }
    session.run(Cursor::new(input))
}

fn output_lines(output: &Arc<Mutex<Vec<u8>>>) -> Vec<String> {
    let bytes = output.lock().expect("output lock should not be poisoned");
    String::from_utf8(bytes.clone())
        .expect("reverse input should be UTF-8")
        .lines()
        .map(str::to_owned)
        .collect()
}

struct SharedSink {
    output: Arc<Mutex<Vec<u8>>>,
}

impl SharedSink {
    fn new(output: Arc<Mutex<Vec<u8>>>) -> Self {
        Self { output }
    }
}

impl Write for SharedSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.output
            .lock()
            .expect("output lock should not be poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BrokenSink;

impl Write for BrokenSink {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "injected closed sink",
        ))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct RecordingTexture {
    handle: i64,
    width: u32,
    height: u32,
    bytes: Vec<u8>,
}

struct RecordingBackend {
    next_handle: i64,
    repaint_count: u64,
    scripted_events: VecDeque<Vec<InputEvent>>,
    poll_count: Arc<AtomicUsize>,
}

impl RecordingBackend {
    fn with_events(events: Vec<InputEvent>, poll_count: Arc<AtomicUsize>) -> Self {
        let mut scripted_events = VecDeque::new();
        scripted_events.push_back(events);
        Self {
            next_handle: 1,
            repaint_count: 0,
            scripted_events,
            poll_count,
        }
    }
}

impl RenderBackend for RecordingBackend {
    type Texture = RecordingTexture;

    fn backend_name(&self) -> &str {
        "reverse-input-test-gpu"
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
                "recording texture dimensions changed".to_owned(),
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
            .ok_or_else(|| CompositorError::Backend("output dimensions overflowed".to_owned()))?;
        Ok(vec![0_u8; byte_count])
    }

    fn poll_input_events(&mut self) -> Result<Vec<InputEvent>, CompositorError> {
        self.poll_count.fetch_add(1, Ordering::SeqCst);
        Ok(self.scripted_events.pop_front().unwrap_or_default())
    }

    fn source_repaint_count(&self) -> u64 {
        self.repaint_count
    }
}

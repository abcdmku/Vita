use std::env;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;

use vita_compositor_core::platform::{
    open_default_gpu_backend, open_default_gpu_backend_for_self_test,
};
use vita_compositor_core::{
    run_reposition_self_test_or_failsafe, Compositor, CompositorError, DamageReport, InputEvent,
    Placement, PointerButtonState, Rect, SurfaceId, TestPattern,
};

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let result = if args.iter().any(|arg| arg == "--serve") {
        serve()
    } else {
        run_self_test()
    };

    if let Err(error) = result {
        eprintln!("vita-compositor-core: {error}");
        std::process::exit(1);
    }
}

fn run_self_test() -> Result<(), CompositorError> {
    let report =
        run_reposition_self_test_or_failsafe(open_default_gpu_backend_for_self_test(96, 64));
    println!("{}", report.marker_line());
    Ok(())
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

fn parse_u32(value: &str, name: &str) -> Result<u32, CompositorError> {
    value
        .parse::<u32>()
        .map_err(|_| CompositorError::Protocol(format!("invalid {name}")))
}

fn parse_i32(value: &str, name: &str) -> Result<i32, CompositorError> {
    value
        .parse::<i32>()
        .map_err(|_| CompositorError::Protocol(format!("invalid {name}")))
}

fn parse_rgba(value: &str) -> Result<[u8; 4], CompositorError> {
    if value.len() != 8 {
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
    }
}

//! PSD-CURSOR: baked 24x24 RGBA cursor sprites for the on-device software cursor.
//!
//! The live desktop's visible cursor is a single compositor surface (`cursor:pointer`) registered
//! by the boot launch stream (`cursor.commands`) at 24x24 with a baked black-outline/white-fill
//! arrow. CEF's `OnCursorChange` (osr_host) maps the page's `cursor:` shape to a token and pushes a
//! `cursorShape <name>` command down the SAME command stream; the command-driven session swaps the
//! cursor surface's pixels to the matching sprite here (via `update_buffer_surface`, which requires
//! the new RGBA to match the surface's registered 24x24 size — so EVERY sprite is exactly 24x24).
//!
//! Sprites are generated programmatically (no binary assets) in the SAME visual language as the
//! baked arrow: a 1px black outline (`#000000ff`), a white fill (`#ffffffff`), and a fully
//! transparent background (`#00000000`). The set is the v1 minimum the task calls for:
//!   arrow, text (I-beam), pointer (hand), ew-resize, ns-resize, nwse-resize, nesw-resize, grabbing.
//! Unknown tokens fail safe to `arrow` (see [`sprite_rgba_for`]).

/// The fixed cursor sprite edge length. Matches the `cursor:pointer` surface size registered by the
/// boot launch stream (`cursor.commands`: `registerBufferSurface cursor:pointer 24 24 ...`). The
/// compositor's `update_buffer_surface` rejects any payload whose length != width*height*4, so this
/// MUST equal the registered cursor surface dimensions.
pub const CURSOR_SPRITE_SIZE: u32 = 24;
const SIZE: usize = CURSOR_SPRITE_SIZE as usize;
const BYTES: usize = SIZE * SIZE * 4;

// Palette (RGBA), matching the baked arrow in cursor.commands.
const TRANSPARENT: [u8; 4] = [0x00, 0x00, 0x00, 0x00];
const OUTLINE: [u8; 4] = [0x00, 0x00, 0x00, 0xff]; // black
const FILL: [u8; 4] = [0xff, 0xff, 0xff, 0xff]; // white

/// The canonical shape tokens. These are the on-the-wire names carried by the `cursorShape`
/// command (produced by osr_host's `CursorTypeToShape`). Kept in one place so the parser and the
/// sprite table cannot drift.
pub const CURSOR_SHAPES: &[&str] = &[
    "arrow",
    "text",
    "pointer",
    "ew-resize",
    "ns-resize",
    "nwse-resize",
    "nesw-resize",
    "grabbing",
];

/// A tiny 24x24 paint buffer used to compose a sprite, then serialize to RGBA.
struct Canvas {
    px: [[u8; 4]; SIZE * SIZE],
}

impl Canvas {
    fn new() -> Self {
        Self {
            px: [TRANSPARENT; SIZE * SIZE],
        }
    }

    #[inline]
    fn set(&mut self, x: i32, y: i32, color: [u8; 4]) {
        if x < 0 || y < 0 || x >= SIZE as i32 || y >= SIZE as i32 {
            return;
        }
        self.px[y as usize * SIZE + x as usize] = color;
    }

    /// Draw a filled rectangle [x0,x1] x [y0,y1] inclusive.
    fn rect(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, color: [u8; 4]) {
        for y in y0..=y1 {
            for x in x0..=x1 {
                self.set(x, y, color);
            }
        }
    }

    /// Draw a horizontal run [x0,x1] at row y.
    fn hline(&mut self, x0: i32, x1: i32, y: i32, color: [u8; 4]) {
        for x in x0..=x1 {
            self.set(x, y, color);
        }
    }

    /// Draw a vertical run [y0,y1] at column x.
    fn vline(&mut self, x: i32, y0: i32, y1: i32, color: [u8; 4]) {
        for y in y0..=y1 {
            self.set(x, y, color);
        }
    }

    /// Draw a 1px-thick line via Bresenham.
    fn line(&mut self, mut x0: i32, mut y0: i32, x1: i32, y1: i32, color: [u8; 4]) {
        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;
        loop {
            self.set(x0, y0, color);
            if x0 == x1 && y0 == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x0 += sx;
            }
            if e2 <= dx {
                err += dx;
                y0 += sy;
            }
        }
    }

    fn into_rgba(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(BYTES);
        for p in self.px.iter() {
            out.extend_from_slice(p);
        }
        out
    }
}

/// Build all sprites once. Returns RGBA byte vectors keyed by canonical token.
fn build_all() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("arrow", arrow()),
        ("text", text_ibeam()),
        ("pointer", pointer_hand()),
        ("ew-resize", ew_resize()),
        ("ns-resize", ns_resize()),
        ("nwse-resize", nwse_resize()),
        ("nesw-resize", nesw_resize()),
        ("grabbing", grabbing()),
    ]
}

/// Return the 24x24 RGBA sprite for a shape token, FAILING SAFE to `arrow` for any unknown token.
/// Returns the arrow even when `shape` is empty/garbage so an unexpected `cursorShape` line never
/// leaves the cursor without pixels.
pub fn sprite_rgba_for(shape: &str) -> Vec<u8> {
    for (name, bytes) in build_all() {
        if name == shape {
            return bytes;
        }
    }
    arrow()
}

/// The default arrow — a classic top-left pointer, outline + white fill, hotspot at (0,0).
fn arrow() -> Vec<u8> {
    let mut c = Canvas::new();
    // Outline of the arrow body: a diagonal pointer with a tail. Drawn so the left edge runs
    // straight down from the tip and the right edge is the diagonal.
    // Tip at (0,0). For each row y, the arrow spans columns [0, right(y)].
    let right = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 9, 7, 6, 6];
    let n = right.len() as i32;
    for y in 0..n {
        let r = right[y as usize];
        // Fill row interior with white.
        c.hline(0, r, y, FILL);
    }
    // Outline: left vertical edge, the diagonal right edge, and the notched tail.
    c.vline(0, 0, n - 1, OUTLINE); // left edge straight down
    for y in 0..n {
        let r = right[y as usize];
        c.set(r, y, OUTLINE); // right edge of each row
    }
    // The tail notch (rows 12..16) — outline the inner cut so it reads as an arrowhead with a tail.
    // Inner tail starts around column 6 at row 12 going down-right.
    c.line(6, 12, 9, 16, OUTLINE);
    c.line(9, 16, 6, 16, OUTLINE);
    c.set(6, 16, OUTLINE);
    c.into_rgba()
}

/// Text / I-beam cursor — a vertical bar with serifs, centered. Hotspot at the middle.
fn text_ibeam() -> Vec<u8> {
    let mut c = Canvas::new();
    let cx = (SIZE / 2) as i32; // 12
    let top = 3;
    let bot = 20;
    // White stem (3px wide) with a black outline around it.
    // Outline first (a 5px-wide black bar), then a 3px white core, then 1px white serifs.
    c.rect(cx - 2, top, cx + 2, top + 1, OUTLINE); // top serif outline
    c.rect(cx - 2, bot - 1, cx + 2, bot, OUTLINE); // bottom serif outline
    c.vline(cx - 1, top, bot, OUTLINE); // left of stem
    c.vline(cx + 1, top, bot, OUTLINE); // right of stem
    // White core
    c.vline(cx, top + 1, bot - 1, FILL);
    c.hline(cx - 1, cx + 1, top, FILL); // top serif white cap
    c.hline(cx - 1, cx + 1, bot, FILL); // bottom serif white cap
    c.into_rgba()
}

/// Pointer / hand cursor — a pointing hand with the index finger up. Hotspot near the fingertip.
fn pointer_hand() -> Vec<u8> {
    let mut c = Canvas::new();
    // Index finger (a vertical white capsule near the top), then a rounded palm below.
    // Finger
    c.rect(9, 2, 12, 11, FILL);
    // Palm
    c.rect(7, 9, 17, 19, FILL);
    // Knuckle bumps (suggest folded fingers) — thin white columns on top of the palm.
    c.rect(13, 7, 14, 11, FILL);
    c.rect(15, 8, 16, 11, FILL);
    // Outline the whole silhouette: trace the bounding contour roughly.
    // Finger outline
    c.vline(8, 2, 9, OUTLINE);
    c.vline(13, 2, 6, OUTLINE);
    c.hline(9, 12, 1, OUTLINE);
    // Knuckles top outline
    c.hline(13, 16, 6, OUTLINE);
    c.vline(17, 7, 9, OUTLINE);
    // Palm outline
    c.vline(6, 9, 20, OUTLINE);
    c.vline(18, 9, 20, OUTLINE);
    c.hline(6, 18, 20, OUTLINE);
    c.into_rgba()
}

/// East-West resize — a horizontal double-headed arrow. Hotspot at the center.
fn ew_resize() -> Vec<u8> {
    let mut c = Canvas::new();
    let cy = (SIZE / 2) as i32; // 12
    let left = 2;
    let right = 21;
    // White shaft (3px tall)
    c.rect(left + 3, cy - 1, right - 3, cy + 1, FILL);
    // Arrowheads (white triangles)
    for i in 0..4 {
        c.vline(left + i, cy - i, cy + i, FILL);
        c.vline(right - i, cy - i, cy + i, FILL);
    }
    // Outline: top + bottom of shaft, and the head edges.
    c.hline(left + 3, right - 3, cy - 2, OUTLINE);
    c.hline(left + 3, right - 3, cy + 2, OUTLINE);
    c.line(left, cy, left + 3, cy - 4, OUTLINE);
    c.line(left, cy, left + 3, cy + 4, OUTLINE);
    c.line(right, cy, right - 3, cy - 4, OUTLINE);
    c.line(right, cy, right - 3, cy + 4, OUTLINE);
    c.into_rgba()
}

/// North-South resize — a vertical double-headed arrow. Hotspot at the center.
fn ns_resize() -> Vec<u8> {
    let mut c = Canvas::new();
    let cx = (SIZE / 2) as i32; // 12
    let top = 2;
    let bot = 21;
    // White shaft (3px wide)
    c.rect(cx - 1, top + 3, cx + 1, bot - 3, FILL);
    // Arrowheads (white triangles)
    for i in 0..4 {
        c.hline(cx - i, cx + i, top + i, FILL);
        c.hline(cx - i, cx + i, bot - i, FILL);
    }
    // Outline: left + right of shaft, and the head edges.
    c.vline(cx - 2, top + 3, bot - 3, OUTLINE);
    c.vline(cx + 2, top + 3, bot - 3, OUTLINE);
    c.line(cx, top, cx - 4, top + 3, OUTLINE);
    c.line(cx, top, cx + 4, top + 3, OUTLINE);
    c.line(cx, bot, cx - 4, bot - 3, OUTLINE);
    c.line(cx, bot, cx + 4, bot - 3, OUTLINE);
    c.into_rgba()
}

/// NWSE resize — a diagonal double-headed arrow from top-left to bottom-right (↘↖). Hotspot center.
fn nwse_resize() -> Vec<u8> {
    diagonal_resize(false)
}

/// NESW resize — a diagonal double-headed arrow from top-right to bottom-left (↙↗). Hotspot center.
fn nesw_resize() -> Vec<u8> {
    diagonal_resize(true)
}

/// Shared diagonal double-arrow. `mirror=false` => NW<->SE; `mirror=true` => NE<->SW.
fn diagonal_resize(mirror: bool) -> Vec<u8> {
    let mut c = Canvas::new();
    // Endpoints near opposite corners.
    let (mut ax, ay) = (3, 3);
    let (mut bx, by) = (20, 20);
    if mirror {
        ax = SIZE as i32 - 1 - ax;
        bx = SIZE as i32 - 1 - bx;
    }
    // White shaft: a 3px-wide diagonal band (draw three parallel diagonals).
    for off in -1..=1 {
        c.line(ax, ay + off, bx, by + off, FILL);
        c.line(ax + off, ay, bx + off, by, FILL);
    }
    // Outline the shaft (one diagonal on each side).
    c.line(ax, ay - 2, bx, by - 2, OUTLINE);
    c.line(ax, ay + 2, bx, by + 2, OUTLINE);
    // Arrowheads at each end (two short barbs forming a corner).
    let head = 5;
    let dir = if mirror { -1 } else { 1 };
    // Head at corner A (top): barbs go along +x*dir and +y.
    c.line(ax, ay, ax + head * dir, ay, OUTLINE);
    c.line(ax, ay, ax, ay + head, OUTLINE);
    c.hline(ax.min(ax + head * dir), ax.max(ax + head * dir), ay, FILL);
    c.vline(ax, ay, ay + head, FILL);
    // Head at corner B (bottom): barbs go along -x*dir and -y.
    c.line(bx, by, bx - head * dir, by, OUTLINE);
    c.line(bx, by, bx, by - head, OUTLINE);
    c.hline(bx.min(bx - head * dir), bx.max(bx - head * dir), by, FILL);
    c.vline(bx, by - head, by, FILL);
    c.into_rgba()
}

/// Grabbing — a closed fist. Hotspot at the center. Used for drag/grab.
fn grabbing() -> Vec<u8> {
    let mut c = Canvas::new();
    // A rounded closed-fist blob with knuckle ridges.
    c.rect(6, 8, 18, 19, FILL); // palm/fist body
    c.rect(7, 6, 17, 8, FILL); // knuckle row
    // Knuckle separators (outline notches on top).
    c.set(9, 6, OUTLINE);
    c.set(12, 6, OUTLINE);
    c.set(15, 6, OUTLINE);
    c.vline(9, 6, 8, OUTLINE);
    c.vline(12, 6, 8, OUTLINE);
    c.vline(15, 6, 8, OUTLINE);
    // Thumb nub on the left.
    c.rect(4, 11, 6, 15, FILL);
    c.vline(3, 11, 15, OUTLINE);
    // Outline the fist.
    c.hline(7, 17, 5, OUTLINE);
    c.vline(6, 8, 20, OUTLINE);
    c.vline(18, 6, 20, OUTLINE);
    c.hline(6, 18, 20, OUTLINE);
    c.into_rgba()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_is_exactly_24x24_rgba() {
        for shape in CURSOR_SHAPES {
            let rgba = sprite_rgba_for(shape);
            assert_eq!(
                rgba.len(),
                BYTES,
                "sprite {shape} must be {SIZE}x{SIZE} RGBA ({BYTES} bytes)"
            );
        }
    }

    #[test]
    fn unknown_shape_fails_safe_to_arrow() {
        assert_eq!(sprite_rgba_for("bogus-shape"), arrow());
        assert_eq!(sprite_rgba_for(""), arrow());
        assert_eq!(sprite_rgba_for("ARROW"), arrow()); // case-sensitive -> falls back
    }

    #[test]
    fn each_named_shape_is_distinct_from_arrow() {
        // Every non-arrow shape must actually differ from the arrow (otherwise the resize/text/
        // pointer cursors would be visually indistinguishable and the feature would be vacuous).
        let arrow = arrow();
        for shape in CURSOR_SHAPES {
            if *shape == "arrow" {
                continue;
            }
            assert_ne!(
                sprite_rgba_for(shape),
                arrow,
                "sprite {shape} must differ from the arrow"
            );
        }
    }

    #[test]
    fn shapes_are_all_distinct_from_each_other() {
        let built = build_all();
        for i in 0..built.len() {
            for j in (i + 1)..built.len() {
                assert_ne!(
                    built[i].1, built[j].1,
                    "sprites {} and {} must differ",
                    built[i].0, built[j].0
                );
            }
        }
    }

    #[test]
    fn sprites_have_visible_pixels() {
        // Each sprite must paint SOME opaque pixels (a blank cursor would be invisible).
        for shape in CURSOR_SHAPES {
            let rgba = sprite_rgba_for(shape);
            let opaque = rgba.chunks_exact(4).filter(|p| p[3] != 0).count();
            assert!(opaque > 10, "sprite {shape} has too few opaque pixels ({opaque})");
        }
    }
}

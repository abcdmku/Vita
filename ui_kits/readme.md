# Vita OS — Design System

**Vita** is a TypeScript-native operating system: developer-flavored underneath, consumer-friendly on the surface. This project is its design system — tokens, foundations, reusable components, and full-screen UI kits for **desktop and mobile**, in **light and dark**, plus a power-user **tiling** layout.

> Sources: Vita is an original concept created in this project (no external Figma/codebase). The visual language was first explored in **`Vita OS — Directions.dc.html`** (the Lumen / Umbra / Strata study) and then unified into the single system documented here.

---

## Brand
- **Name:** Vita · always paired with the monospace suffix **`.ts`** in the accent color → the wordmark is **Vita.ts**.
- **App mark:** the accent tile (rounded square) carrying a monospace glyph (e.g. `V`).
- **Tagline register:** quietly technical, never loud. "A TypeScript-native OS."

## Content fundamentals
- **Voice:** precise, calm, engineer-to-engineer but never cold. Short declaratives.
- **Person:** address the user as **you**; the system refers to itself as **Vita**, not "we".
- **Casing:** Sentence case for UI labels and buttons ("Run kernel.ts", "Toggle dark mode"). `UPPERCASE` monospace only for overlines/section eyebrows ("SYSTEM · LIVE").
- **Numbers & code:** filenames, paths, durations, counts and shortcuts are set in **Geist Mono** (`kernel.ts`, `0.42s`, `⌘K`, `~/vita/src`).
- **Emoji:** none. Icons come from the **Lucide** library (see Iconography).
- **Examples:** "Build passed · kernel.ts compiled · 0.8s" · "2 builds passed today" · "Search or run a command…"

## Visual foundations
- **Color.** Cool neutral ink ramp + a single brand hue (**TypeScript blue**, `#3178C6` in light, brightened to `#4F9DFF` in dark). Semantic green/amber/red are desaturated to sit beside the neutrals. A full **syntax-highlighting palette** is a first-class token set — every surface can show code.
- **Type.** **Geist** for UI, **Geist Mono** for code, data and labels. Tight tracking on display/headings; generous line-height (1.55) on body.
- **Spacing.** 4px base grid (`--space-*`).
- **Radius.** Soft by default (windows/tiles 13px, controls 8px); **tiling mode drops to 4px** for a sharp, structured feel.
- **Elevation.** Soft blue-tinted shadows in light; deeper black shadows + an optional **accent glow** on active elements in dark.
- **Transparency & blur.** Menu bar, dock, command palette, control center and notifications use translucent surfaces with backdrop-blur. "Reduce transparency" is a documented setting.
- **Motion.** Base 200ms; `--ease-standard` for most, `--ease-spring` for toggles. Restrained — one purposeful transition over many.
- **States.** Hover = a step up in surface tone (or accent-hover for primary); press = accent-active; focus = a 3px `--focus-ring`. Active app/pane = accent border (+ glow in dark).
- **Cards & windows.** 1px border + soft shadow; window title bars are monospace, path-style, with three neutral dot controls (not colored).
- **Themes.** `:root` = light; `.theme-dark` = dark; `.mode-tiling` (compose with `.theme-dark`) = graphite + sharp + grid.

## Iconography
Vita uses the **[Lucide](https://lucide.dev)** icon library — clean 2px-stroke outline icons that match the flat/minimal aesthetic. No custom-drawn SVGs, no emoji.
- **Recoloring:** icons inherit `currentColor` (stroke), so they take ink / muted / accent / white-on-accent automatically across light & dark.
- **Sizing:** app/dock tile icons 22–26px, list & menu icons 15–16px, inline UI 18–20px, status cluster 15–19px.
- **Common names:** `terminal` Shell · `code` Studio · `folder` Files · `mail` Mail · `globe` Web · `music` Music · `image` Photos · `settings` Settings · `search` · `wifi` · `bell` · `chevron-right`.
- **Loading:** the static cards & screens include the Lucide UMD script and call `lucide.createIcons()`; the `Icon` component (and anything using it) needs `window.lucide` present in the host. The only monospace glyph that remains is the brand suffix **`.ts`** and the shell prompt `›` (those are type, not icons).

---

## Manifest

**Entry:** `styles.css` (link this) → `tokens/{fonts,colors,typography,spacing,elevation,motion}.css`

**Foundations (Design System tab cards):** `guidelines/` — colors (surfaces L/D, accent ramp, semantic, syntax), type (display, body, mono, scale), spacing, radius, elevation L/D, icon tokens, motion, brand.

**Components** (`components/<group>/<Name>.jsx` + `.d.ts` + `.prompt.md`):
- **icon** — Icon (Lucide wrapper; used by all icon-bearing components)
- **buttons** — Button, IconButton
- **forms** — Input, SearchField, Select
- **selection** — Checkbox, Radio, Switch, SegmentedControl, Slider
- **feedback** — Badge, Tag, Tooltip, ProgressBar, Toast
- **surfaces** — Card, Dialog
- **navigation** — Tabs, ContextMenu, ListRow
- **os** — WindowChrome, MenuBar, AppTile, Dock, StatusBar, CommandPalette, ControlCenterTile
- **mobile** — PhoneFrame, PhoneStatusBar, HomeTile, LockClock, Widget

**UI kits (full screens):**
- `ui_kits/desktop/` — Desktop (home), Settings, Files, Shell, Tiling, Notifications/Control Center, Lock/Login, Activity (sample app)
- `ui_kits/mobile/` — Home, Lock, Settings, Control Center

## Notes & caveats
- **Fonts** are **vendored offline** (Geist + Geist Mono): `tokens/fonts.css` declares `@font-face` rules over self-hosted `.woff2` binaries in `_vendor/fonts/` — no Google Fonts CDN.
- **Specimen & screen HTML** are intentionally **self-contained** (they link `styles.css` and use the tokens directly) so they render reliably in the Design System tab without the component bundle. The `.jsx` components are the reusable source of truth for consuming projects and Starting Points.
- **Icons** are **Lucide**, **vendored offline**. The `Icon` component lazy-loads the Lucide UMD runtime from the local vendored copy (`_vendor/lucide.min.js`) on first use, exposing `window.lucide`; static cards/screens include that same vendored UMD `<script>` directly. No CDN.

---

## Handoff — using Vita in another project
This project is a **Design System reference** for the project agent to build against.
1. **Enable it:** in the Share menu, set this project's **file type to "Design System"** so your org (and consuming project agents) can reference it.
2. **Styles:** link the single entry **`styles.css`**. Every token is then available (`--accent`, `--surface`, `--text`, `--radius-*`, `--shadow-*`, syntax colors…). Theme with `class="theme-dark"` and/or `class="mode-tiling"` on a container.
3. **Components:** import the bundled primitives by name — `Button`, `IconButton`, `Input`, `SearchField`, `Select`, `Checkbox`, `Radio`, `Switch`, `SegmentedControl`, `Slider`, `Badge`, `Tag`, `Tooltip`, `ProgressBar`, `Toast`, `Card`, `Dialog`, `Tabs`, `ContextMenu`, `ListRow`, `Icon`, `WindowChrome`, `MenuBar`, `AppTile`, `Dock`, `StatusBar`, `CommandPalette`, `ControlCenterTile`, `PhoneFrame`, `PhoneStatusBar`, `HomeTile`, `LockClock`, `Widget`. They reference only CSS variables, so they adopt the host theme automatically; `Icon` needs no setup (lazy-loads the vendored Lucide runtime offline).
4. **Starting Points:** the picker is seeded with the full screens (Desktop, Settings, Files, Shell, Tiling, Notifications, Lock, Activity; mobile Home / Lock / Settings / Control Center) plus key components (Button, Card, WindowChrome, CommandPalette) — pick one to scaffold a new design.
5. **Rules:** follow this README + each component's `.prompt.md`. Geist + Geist Mono, TS-blue accent, Lucide icons, sentence-case copy, monospace for code / paths / shortcuts.

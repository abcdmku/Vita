# Phase 6 — Desktop environment: decomposition & sequencing

Source of truth: [spec §Phase 6 (1447+)](../typescript_personal_node_os_build_spec.md). Owner intent 2026-06-24:
the desktop is the DEFAULT UX but **not the foundation** — a separable first-class package; the OS boots/recovers/
updates/manages-data **headless** without it; accelerated OSR with shared GPU textures (CPU readback only for
tests/screenshots/fallback); composite TSX/CSS shell customizable by registering components + editing its own TSX,
with preview/apply/rollback + a known-good fallback shell.

## Thin vertical slices (dependency-ordered)

| id | slice | depends on | risk | verifiable headless? |
|----|-------|-----------|------|----------------------|
| **PSD-000** | **De-risking SPIKE** — CEF accelerated-OSR → shared GPU texture → composited by a native core → drag/animate a heavy web app ≥60fps with web content NOT repainting. WPE fallback + re-measure if CEF misses budget. **Gates the engine choice before production decomposition.** | — | spike | **NO — needs GPU/display** |
| **PSD-001** | **Separable desktop package + OS-headless boundary** — desktop as an installable package via the capsule mechanism; OS boots/recovers/updates/manages-data with NO desktop installed; define the stable compositor-substrate interface (the seam); a stub/no-op desktop package installs+launches. | capsule mech (P1-045), control plane | R2 | **YES** |
| **PSD-002** | **Native compositor core** — thin DRM/KMS + libinput + GPU compositing + damage tracking substrate (not OS-coupled). | PSD-001 | R2 | NO — needs GPU/display |
| **PSD-003** | **Texture/surface bridge** — CEF accelerated-OSR → shared GPU texture → composited by the core; move/resize repositions a texture, web NOT repainted (the render/composite split). | PSD-000, PSD-002 | R2 | NO — needs GPU/display |
| **PSD-004** | **WM policy (TypeScript)** — layout, focus, workspaces, animation as TS policy over the native mechanism. | PSD-002 | R1 | partial (logic unit-testable headless) |
| **PSD-005** | **Composite TSX/CSS shell + component registry** — shell as composite TSX/CSS; register components; preview/apply/**rollback** + known-good **fallback shell** (a broken edit can't brick the GUI / lock the owner out). | PSD-003, PSD-004 | R2 | partial |
| **PSD-006** | Panel / launcher / notifications. | PSD-005 | R1 | partial |
| **PSD-007** | Settings & file-manager as TSX apps. | PSD-005 | R1 | partial |
| **PSD-008** | Webview app class — TSX/web/WASM/container apps as ONE windowed-surface class on the capsule runtimes. | PSD-005, capsule runtimes | R2 | partial |

## Critical infra dependency (surface to owner)
PSD-000 (the spike) + PSD-002/003 (compositor + texture bridge) require **real GPU/display hardware** to verify
accelerated OSR / DRM-KMS / 60fps. The current verification floor (headless Borg51 WSL + headless QEMU asserting serial
markers) **cannot** verify GPU compositing. Phase 6 GPU slices need a display/GPU test environment (real hardware, or a
GPU-passthrough VM). **PSD-001 + the TS-logic parts of PSD-004/005 are verifiable headless now**; the GPU path is gated
on this infra decision. Build PSD-001 first (foundation, headless), resolve GPU-test infra before PSD-000/002/003.

## Build order
PSD-001 (now, headless) → [resolve GPU-test infra] → PSD-000 spike → PSD-002 → PSD-003 → PSD-004 → PSD-005 →
PSD-006/007/008.

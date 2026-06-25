# PSD-000 CEF OSR Spike

This directory contains the standalone Phase 6 de-risking spike for the web-engine decision:

1. Load `assets/heavy-app.html` in accelerated offscreen rendering.
2. Receive the web content as a shared GPU texture/surface.
3. Composite and move that texture in a native loop while the web content does not repaint.
4. Emit a JSON report with FPS, frame-time histogram inputs, screenshot path, no-repaint proof, and the CEF-vs-WPE verdict.

The root repo intentionally does not depend on CEF or WPE. The VMware Workstation Pro GPU target must provide those engine SDK/runtime packages. On hosts without that target, the spike emits `not-run` or `unavailable` evidence instead of fabricating measurements.

## Files

- `assets/heavy-app.html` - deterministic heavy web fixture. It paints once and exposes `window.__vitaPaintCounter`.
- `native/` - CMake native runner. It is dependency-probed and emits the same report schema as the TS harness.
- `src/report.ts` - strict report decoder, FPS/histogram evaluation, and engine recommendation logic.
- `src/run-measurement.ts` - wrapper that runs CEF first, then WPE if CEF does not pass.
- `src/report.test.ts` - regression tests for pass/fail decision logic and fail-closed report decoding.
- `RESULTS.md` - current measured status and recommendation.

## Local checks

```sh
npm --prefix spikes/cef-osr run typecheck
npm --prefix spikes/cef-osr test
```

The repo acceptance command remains:

```sh
npm run typecheck
```

## VMware GPU run

On the VMware Workstation Pro target with 3D acceleration enabled:

```sh
cd spikes/cef-osr
cmake -S native -B build/native -DCEF_ROOT=/opt/cef -DPSD_SPIKE_ENABLE_CEF=ON -DPSD_SPIKE_ENABLE_WPE=ON
cmake --build build/native --config Release
node --experimental-strip-types src/run-measurement.ts --native build/native/vita-cef-osr-spike --out artifacts/vmware-report.json --duration-ms 5000
```

The wrapper writes `artifacts/vmware-report.json` plus `artifacts/vmware-report.summary.md`. The summary is the artifact to paste into `RESULTS.md` after the VM run.

The decisive pass requires:

- `texture.mode == "shared-texture"`
- `motion.cpuReadbackFramesDuringMotion == 0`
- `motion.webPaintEventsAfter == motion.webPaintEventsBefore`
- `motion.contentTextureIdChanges == 0`
- measured FPS >= 60

CEF is recommended if it passes. WPE is recommended only if CEF is unavailable or misses budget and WPE passes.

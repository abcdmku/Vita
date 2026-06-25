# PSD-000 Results

Status: pending VMware GPU target run.

Date recorded: 2026-06-24

## Current Evidence

This authoring environment does not expose the VMware Workstation Pro GPU target, CEF SDK/runtime, WPE WebKit runtime, CMake, or a C++ compiler. No accelerated-OSR measurement was run here.

Implemented artifacts under `spikes/cef-osr/`:

- TypeScript report harness that validates native measurement JSON, computes FPS, builds frame-time histograms, proves no web repaint during compositor-only motion, rejects CPU-readback paths, and selects CEF or WPE.
- Heavy web fixture that paints once and exposes a paint counter for the native no-repaint proof.
- Native CMake runner scaffold that emits schema-compatible unavailable reports when the accelerated backends are absent.

## Measurement Table

| Engine | State | Shared texture | CPU readback during motion | FPS | No repaint proof | Screenshot | Verdict |
|---|---:|---:|---:|---:|---:|---|---|
| CEF accelerated OSR | pending | pending | pending | pending | pending | pending | pending |
| WPE WebKit fallback | pending | pending | pending | pending | pending | pending | pending |

## Recommendation

Engine recommendation: pending.

Decision rule: choose CEF if it delivers accelerated OSR with shared GPU texture reuse at >=60fps and no web repaint during compositor motion. If CEF is unavailable or misses budget, choose WPE only if the fallback path meets the same shared-texture, no-readback, no-repaint, and FPS budget.

## Required VMware Command

```sh
cd spikes/cef-osr
cmake -S native -B build/native -DCEF_ROOT=/opt/cef -DPSD_SPIKE_ENABLE_CEF=ON -DPSD_SPIKE_ENABLE_WPE=ON
cmake --build build/native --config Release
node --experimental-strip-types src/run-measurement.ts --native build/native/vita-cef-osr-spike --out artifacts/vmware-report.json --duration-ms 5000
```

After the VM run, copy the measured FPS, histogram, screenshot path, no-repaint counters, and final CEF/WPE verdict from `artifacts/vmware-report.summary.md` into this file.

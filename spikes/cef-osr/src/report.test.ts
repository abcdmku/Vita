import test from "node:test";
import assert from "node:assert/strict";
import { decodeReport, evaluateReport, type EngineRun, type SpikeReport } from "./report.ts";

const timestamp = "2026-06-24T00:00:00.000Z";

function measuredRun(engine: "cef" | "wpe", overrides: Partial<EngineRun> = {}): EngineRun {
  const base: EngineRun = {
    engine,
    state: "measured",
    timestamp,
    target: {
      os: "linux",
      gpu: "vmware-svga3d",
      vmware3d: true,
      driver: "mesa"
    },
    texture: {
      mode: "shared-texture",
      handleKind: "dma-buf",
      dimensions: { width: 1280, height: 720 },
      reusedAcrossMotionFrames: true,
      acceleratedPaintEvents: 1
    },
    motion: {
      compositedFrames: 360,
      durationMs: 5000,
      webPaintEventsBefore: 1,
      webPaintEventsAfter: 1,
      contentTextureIdChanges: 0,
      cpuReadbackFramesDuringMotion: 0
    },
    frameTimesMs: [13.8, 14.2, 14.1, 14.0, 13.9, 14.3],
    screenshot: {
      path: "artifacts/screenshot.png",
      sha256: "a".repeat(64)
    },
    notes: []
  };
  return { ...base, ...overrides };
}

function report(runs: readonly EngineRun[]): SpikeReport {
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    budgetFps: 60,
    runs,
    notes: []
  };
}

test("recommends CEF when accelerated shared-texture motion meets budget without repaint", () => {
  const evaluation = evaluateReport(report([measuredRun("cef")]));
  assert.equal(evaluation.verdict, "cef");
  assert.equal(evaluation.runs[0]?.status, "pass");
  assert.equal(evaluation.runs[0]?.noRepaintDuringMotion, true);
  assert.equal(evaluation.runs[0]?.sharedTextureReused, true);
});

test("falls back to WPE when CEF is unavailable and WPE passes", () => {
  const cefUnavailable = measuredRun("cef", {
    state: "unavailable",
    texture: {
      mode: "unavailable",
      handleKind: "none",
      dimensions: { width: 0, height: 0 },
      reusedAcrossMotionFrames: false,
      acceleratedPaintEvents: 0
    },
    motion: {
      compositedFrames: 0,
      durationMs: 1,
      webPaintEventsBefore: 0,
      webPaintEventsAfter: 0,
      contentTextureIdChanges: 0,
      cpuReadbackFramesDuringMotion: 0
    },
    frameTimesMs: []
  });
  const evaluation = evaluateReport(report([cefUnavailable, measuredRun("wpe")]));
  assert.equal(evaluation.verdict, "wpe");
  assert.equal(evaluation.runs[0]?.status, "unavailable");
  assert.equal(evaluation.runs[1]?.status, "pass");
});

test("fails a CPU-readback path even when frame rate is high", () => {
  const cpuReadback = measuredRun("cef", {
    texture: {
      mode: "cpu-readback",
      handleKind: "bitmap",
      dimensions: { width: 1280, height: 720 },
      reusedAcrossMotionFrames: false,
      acceleratedPaintEvents: 0
    },
    motion: {
      compositedFrames: 360,
      durationMs: 5000,
      webPaintEventsBefore: 1,
      webPaintEventsAfter: 1,
      contentTextureIdChanges: 0,
      cpuReadbackFramesDuringMotion: 360
    }
  });
  const evaluation = evaluateReport(report([cpuReadback]));
  assert.equal(evaluation.verdict, "none");
  assert.equal(evaluation.runs[0]?.status, "fail");
  assert.match(evaluation.runs[0]?.reasons.join("\n"), /shared texture/);
});

test("fails when web content repaints during compositor-only motion", () => {
  const repainting = measuredRun("cef", {
    motion: {
      compositedFrames: 360,
      durationMs: 5000,
      webPaintEventsBefore: 1,
      webPaintEventsAfter: 4,
      contentTextureIdChanges: 3,
      cpuReadbackFramesDuringMotion: 0
    }
  });
  const evaluation = evaluateReport(report([repainting]));
  assert.equal(evaluation.verdict, "none");
  assert.equal(evaluation.runs[0]?.noRepaintDuringMotion, false);
});

test("decoder rejects cyclic input without throwing", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const decoded = decodeReport(cyclic);
  assert.equal(decoded.ok, false);
  assert.match(decoded.ok ? "" : decoded.error, /cyclic/);
});

test("decoder rejects top-level accessor properties", () => {
  const input: { schemaVersion?: unknown } = {};
  Object.defineProperty(input, "schemaVersion", {
    enumerable: true,
    get() {
      return 1;
    }
  });
  const decoded = decodeReport(input);
  assert.equal(decoded.ok, false);
  assert.match(decoded.ok ? "" : decoded.error, /accessor/);
});

test("decoder rejects method-shadowing array properties", () => {
  const valid = report([measuredRun("cef")]);
  const hostileRuns = [valid.runs[0]];
  Object.defineProperty(hostileRuns, "includes", {
    value: () => true,
    enumerable: true
  });
  const decoded = decodeReport({ ...valid, runs: hostileRuns });
  assert.equal(decoded.ok, false);
  assert.match(decoded.ok ? "" : decoded.error, /unexpected array property/);
});

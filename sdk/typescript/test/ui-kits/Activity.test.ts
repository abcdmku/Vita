import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_METRICS_CAPABILITY,
  createActivityViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Activity.ts";
import type {
  ActivityClock,
  ActivityMetricsPort,
  ActivityMetricsProcessSample,
  ActivityMetricsRequest,
  ActivityMetricsSample,
} from "../../../../ui_kits/desktop/viewmodels/Activity.ts";
import type {
  DesktopHostError,
  DesktopHostResult,
} from "../../src/desktop-sdk/index.ts";

test("activity view-model refreshes metrics through the injected port and rolls aggregate samples", async () => {
  const calls: ActivityMetricsRequest[] = [];
  let nowMs = 1_000;
  const viewModel = createActivityViewModel({
    clock: manualClock(() => nowMs),
    maxSamples: 3,
    metrics: fakeMetricsPort(calls, [
      sample(20, 4_000, 16_000, [
        process(20, "Studio", 35, 600),
        process(10, "Shell", 12, 100),
      ]),
      sample(60, 8_000, 16_000, [
        process(20, "Studio", 15, 800),
        process(30, "Web", 15, 1_200),
      ]),
      sample(40, 12_000, 16_000, [
        process(30, "Web", 25, 1_300),
        process(20, "Studio", 5, 700),
      ]),
    ]),
    sampleWindowMs: 10_000,
  });

  assert.equal(viewModel.state.status, "idle");

  const first = await viewModel.refresh();

  assert.equal(first.ok, true);
  assert.deepEqual(calls, [
    {
      capability: ACTIVITY_METRICS_CAPABILITY,
    },
  ]);
  assert.equal(first.state.status, "ready");
  assert.equal(first.state.sampledAtMs, 1_000);
  assert.equal(first.state.cpuPercent, 20);
  assert.equal(first.state.cpuAveragePercent, 20);
  assert.equal(first.state.memory.percent, 25);
  assert.deepEqual(first.state.cpuHistory, [
    {
      sampledAtMs: 1_000,
      value: 20,
    },
  ]);
  assert.deepEqual(first.state.processes.map((entry) => entry.pid), [20, 10]);

  const selected = viewModel.selectProcess(10);

  assert.equal(selected.ok, true);
  assert.equal(requireProcess(selected.state.processes, 10).selected, true);

  nowMs = 2_000;
  const second = await viewModel.refresh();

  assert.equal(second.ok, true);
  assert.equal(second.state.selectedPid, null);
  assert.equal(second.state.cpuAveragePercent, 40);
  assert.equal(second.state.memory.averagePercent, 37.5);
  assert.deepEqual(second.state.cpuHistory.map((point) => point.value), [20, 60]);
  assert.deepEqual(second.state.memory.history.map((point) => point.value), [25, 50]);
  assert.deepEqual(second.state.processes.map((entry) => [
    entry.pid,
    entry.cpuPercent,
    entry.cpuAveragePercent,
    entry.memoryAverageBytes,
  ]), [
    [20, 15, 25, 700],
    [30, 15, 15, 1_200],
  ]);

  nowMs = 3_000;
  const third = await viewModel.refresh();

  assert.equal(third.ok, true);
  assert.equal(third.state.sampleCount, 3);
  assert.equal(third.state.cpuAveragePercent, 40);
  assert.deepEqual(third.state.processes.map((entry) => entry.pid), [30, 20]);
});

test("activity view-model sorts processes deterministically and toggles column direction", async () => {
  const viewModel = createActivityViewModel({
    clock: manualClock(() => 5_000),
    metrics: fakeMetricsPort([], [
      sample(50, 8_000, 16_000, [
        process(10, "Shell", 12, 100),
        process(20, "Studio", 35, 800),
        process(30, "Web", 35, 1_200),
      ]),
    ]),
  });

  const refreshed = await viewModel.refresh();

  assert.equal(refreshed.ok, true);
  assert.deepEqual(refreshed.state.processes.map((entry) => entry.pid), [20, 30, 10]);

  const memory = viewModel.sortBy("memory");

  assert.equal(memory.ok, true);
  assert.deepEqual(memory.state.sort, {
    column: "memory",
    direction: "desc",
  });
  assert.deepEqual(memory.state.processes.map((entry) => entry.pid), [30, 20, 10]);

  const memoryAscending = viewModel.sortBy("mem");

  assert.equal(memoryAscending.ok, true);
  assert.deepEqual(memoryAscending.state.sort, {
    column: "memory",
    direction: "asc",
  });
  assert.deepEqual(memoryAscending.state.processes.map((entry) => entry.pid), [10, 20, 30]);

  const byName = viewModel.sortBy("process");

  assert.equal(byName.ok, true);
  assert.deepEqual(byName.state.processes.map((entry) => entry.name), ["Shell", "Studio", "Web"]);

  const invalid = viewModel.sortBy("energy");

  assert.equal(invalid.ok, false);
  if (invalid.ok) {
    assert.fail("expected invalid sort column to fail closed");
  }
  assert.equal(invalid.error.code, "INVALID_SORT_COLUMN");
  assert.deepEqual(invalid.state.processes.map((entry) => entry.name), ["Shell", "Studio", "Web"]);
});

test("activity view-model selection rejects invalid and absent pids without mutating state", async () => {
  const viewModel = createActivityViewModel({
    clock: manualClock(() => 7_000),
    metrics: fakeMetricsPort([], [
      sample(20, 4_000, 8_000, [
        process(42, "kernel", 2, 64),
      ]),
    ]),
  });
  await viewModel.refresh();
  const before = viewModel.state;

  const malformed = viewModel.selectProcess(1.5);

  assert.equal(malformed.ok, false);
  if (malformed.ok) {
    assert.fail("expected malformed pid to fail closed");
  }
  assert.equal(malformed.error.code, "INVALID_PROCESS");
  assert.equal(viewModel.state, before);

  const absent = viewModel.selectProcess(99);

  assert.equal(absent.ok, false);
  if (absent.ok) {
    assert.fail("expected absent pid to fail closed");
  }
  assert.equal(absent.error.code, "UNKNOWN_PROCESS");
  assert.equal(viewModel.state, before);

  const selected = viewModel.selectProcess(42);

  assert.equal(selected.ok, true);
  assert.equal(selected.state.selectedPid, 42);
  assert.equal(requireProcess(selected.state.processes, 42).selected, true);
});

test("activity view-model fails closed without a metrics grant or when the metrics port rejects", async () => {
  const noPort = createActivityViewModel({
    clock: manualClock(() => 9_000),
  });

  const missing = await noPort.refresh();

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected missing metrics port to fail closed");
  }
  assert.equal(missing.error.code, "MISSING_CAPABILITY");
  assert.equal(missing.state.status, "forbidden");
  assert.deepEqual(missing.state.processes, []);
  assert.equal(missing.state.error?.code, "MISSING_CAPABILITY");

  const calls: ActivityMetricsRequest[] = [];
  const denied = createActivityViewModel({
    clock: manualClock(() => 10_000),
    metrics: rejectingMetricsPort(calls, {
      code: "MISSING_CAPABILITY",
      message: "package cannot read activity metrics.",
      path: "/capabilityGrants/metrics.read",
    }),
  });

  const result = await denied.refresh();

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected denied metrics grant to fail closed");
  }
  assert.deepEqual(calls, [
    {
      capability: ACTIVITY_METRICS_CAPABILITY,
    },
  ]);
  assert.equal(result.error.code, "MISSING_CAPABILITY");
  assert.equal(result.state.status, "forbidden");
  assert.equal(result.state.sampleCount, 0);
});

test("activity view-model catches throwing and malformed ports without keeping stale live samples", async () => {
  const throwing = createActivityViewModel({
    clock: manualClock(() => 11_000),
    metrics: throwingMetricsPort(),
  });

  const thrown = await throwing.refresh();

  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail("expected throwing metrics port to fail closed");
  }
  assert.equal(thrown.error.code, "METRICS_PORT_FAILED");
  assert.equal(thrown.state.status, "error");
  assert.deepEqual(thrown.state.cpuHistory, []);

  let getterReads = 0;
  const hostileSample = {
    get cpuPercent() {
      getterReads += 1;
      return 25;
    },
    memory: {
      totalBytes: 16_000,
      usedBytes: 4_000,
    },
    processes: [],
  } satisfies ActivityMetricsSample;
  const malformed = createActivityViewModel({
    clock: manualClock(() => 12_000),
    metrics: fakeMetricsPort([], [hostileSample]),
  });

  const rejected = await malformed.refresh();

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected accessor metrics sample to fail closed");
  }
  assert.equal(rejected.error.code, "MALFORMED_METRICS_SAMPLE");
  assert.equal(rejected.state.sampleCount, 0);
  assert.equal(getterReads, 0);
});

function manualClock(nowMs: () => number): ActivityClock {
  return Object.freeze({
    nowMs,
  });
}

function fakeMetricsPort(
  calls: ActivityMetricsRequest[],
  samples: readonly ActivityMetricsSample[],
): ActivityMetricsPort {
  let index = 0;

  return Object.freeze({
    sample(request: ActivityMetricsRequest): DesktopHostResult<ActivityMetricsSample> {
      calls.push(request);
      const value = samples[index] ?? samples[samples.length - 1];
      index += 1;

      if (value === undefined) {
        return {
          error: {
            code: "NO_SAMPLE",
            message: "fake metrics fixture is empty.",
            path: "/metrics/sample",
          },
          ok: false,
        };
      }

      return {
        ok: true,
        value,
      };
    },
  });
}

function rejectingMetricsPort(
  calls: ActivityMetricsRequest[],
  error: DesktopHostError,
): ActivityMetricsPort {
  return Object.freeze({
    sample(request: ActivityMetricsRequest): DesktopHostResult<ActivityMetricsSample> {
      calls.push(request);

      return {
        error,
        ok: false,
      };
    },
  });
}

function throwingMetricsPort(): ActivityMetricsPort {
  return Object.freeze({
    sample(): DesktopHostResult<ActivityMetricsSample> {
      throw new Error("configured metrics failure");
    },
  });
}

function sample(
  cpuPercent: number,
  usedBytes: number,
  totalBytes: number,
  processes: readonly ActivityMetricsProcessSample[],
): ActivityMetricsSample {
  return Object.freeze({
    cpuPercent,
    memory: Object.freeze({
      totalBytes,
      usedBytes,
    }),
    processes: Object.freeze([...processes]),
  });
}

function process(
  pid: number,
  name: string,
  cpuPercent: number,
  memoryBytes: number,
): ActivityMetricsProcessSample {
  return Object.freeze({
    cpuPercent,
    memoryBytes,
    name,
    pid,
  });
}

function requireProcess(
  processes: readonly { readonly pid: number }[],
  pid: number,
): { readonly pid: number; readonly selected?: boolean } {
  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index];

    if (process !== undefined && process.pid === pid) return process;
  }

  assert.fail(`missing process ${pid}`);
}

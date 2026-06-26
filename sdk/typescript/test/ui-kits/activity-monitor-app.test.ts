import assert from "node:assert/strict";
import { test } from "node:test";

import activityMonitorAppPackage, {
  ACTIVITY_MONITOR_APP_ENTRY,
  ACTIVITY_MONITOR_APP_ID,
  ACTIVITY_MONITOR_APP_PARTITION,
  ACTIVITY_MONITOR_APP_VERSION,
} from "../../../../apps/activity-monitor/manifest.ts";
import {
  ACTIVITY_MONITOR_STATS_REQUEST_APP_ID,
  createActivityMonitorAppViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/activity-monitor-app.ts";
import type {
  ActivityMonitorActionResult,
  ActivityMonitorAppState,
  ActivityMonitorStatsEntry,
  ActivityMonitorStatsPort,
  ActivityMonitorStatsRequest,
  ActivityMonitorStatsResult,
  ActivityMonitorStatsSnapshot,
  ActivityMonitorTotals,
} from "../../../../ui_kits/desktop/viewmodels/apps/activity-monitor-app.ts";
import {
  SDK_VERSION,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
} from "../../src/desktop-sdk/index.ts";

test("Activity Monitor manifest is a valid first-party web app package with no privileged grants", () => {
  const app = defineAppPackage(activityMonitorAppPackage);

  assert.equal(app.manifest.id, ACTIVITY_MONITOR_APP_ID);
  assert.equal(app.manifest.version, ACTIVITY_MONITOR_APP_VERSION);
  assert.equal(app.manifest.sdkVersion, SDK_VERSION);
  assert.equal(app.manifest.entry, ACTIVITY_MONITOR_APP_ENTRY);
  assert.deepEqual(app.manifest.capabilityGrants, []);

  const deniedCapabilities: readonly DesktopCapability[] = Object.freeze([
    "apps.launch",
    "apps.stop",
    "files.read",
    "files.write",
    "launcher.launch",
    "settings.read",
    "settings.write",
    "shell.notifications.post",
    "shell.tray.register",
  ]);

  for (let index = 0; index < deniedCapabilities.length; index += 1) {
    const capability = deniedCapabilities[index];

    if (capability !== undefined) {
      assert.equal(hasAppCapabilityGrant(app.manifest, capability), false, capability);
    }
  }

  assert.equal(JSON.stringify(app.manifest.capabilityGrants).includes("process"), false);
  assert.equal(JSON.stringify(app.manifest.capabilityGrants).includes("host"), false);
  assert.equal(app.descriptor.id, app.manifest.id);
  assert.equal(app.descriptor.title, "Activity Monitor");
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, ACTIVITY_MONITOR_APP_PARTITION);
  assert.equal(app.descriptor.defaultWindow?.mode, "floating");
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants), true);
  assert.equal(Object.isFrozen(app.descriptor.runtime), true);
});

test("Activity Monitor refresh pulls stats and applies deterministic default cpu sort", async () => {
  const calls: ActivityMonitorStatsRequest[] = [];
  const model = createActivityMonitorAppViewModel({
    stats: fakeStatsPort(calls, () => statsSnapshot([
      entry("shell", "Shell", "process", 12, 88, "running"),
      entry("b-studio", "Studio", "app", 52, 612, "running"),
      entry("a-web", "Web", "app", 52, 1_100, "running"),
      entry("compositor", "compositor", "process", 8, 140, "idle"),
    ], totals(72, 1_940))),
  });

  const initial = model.snapshot();

  assert.equal(initial.status, "idle");
  assert.deepEqual(initial.entries, []);
  assert.deepEqual(initial.totals, {
    cpuPercent: 0,
    memBytes: 0,
  });

  const refreshed = expectOk(await model.refresh());

  assert.deepEqual(calls, [
    {
      appId: ACTIVITY_MONITOR_STATS_REQUEST_APP_ID,
    },
  ]);
  assert.equal(model.snapshot(), refreshed);
  assert.equal(model.state, refreshed);
  assert.equal(refreshed.status, "ready");
  assert.deepEqual(ids(refreshed), ["a-web", "b-studio", "shell", "compositor"]);
  assert.deepEqual(refreshed.totals, {
    cpuPercent: 72,
    memBytes: 1_940,
  });
  assert.equal(refreshed.sort.key, "cpu");
  assert.equal(refreshed.sort.direction, "desc");
  assert.equal(refreshed.selectedEntry, null);
  assert.equal(refreshed.entries[0]?.selected, false);
  assert.equal(Object.isFrozen(refreshed), true);
  assert.equal(Object.isFrozen(refreshed.entries), true);
  assert.equal(Object.isFrozen(refreshed.entries[0]), true);
  assert.equal(Object.isFrozen(refreshed.totals), true);
});

test("Activity Monitor setSort and select update state deterministically", async () => {
  const model = createActivityMonitorAppViewModel({
    stats: fakeStatsPort([], () => statsSnapshot([
      entry("shell", "Shell", "process", 12, 88, "running"),
      entry("b-studio", "Studio", "app", 52, 612, "running"),
      entry("a-web", "Web", "app", 52, 1_100, "running"),
      entry("compositor", "compositor", "process", 8, 140, "idle"),
    ], totals(72, 1_940))),
  });

  expectOk(await model.refresh());

  const memorySort = expectOk(model.setSort("mem", "asc"));

  assert.equal(memorySort.sort.key, "mem");
  assert.equal(memorySort.sort.direction, "asc");
  assert.deepEqual(ids(memorySort), ["shell", "compositor", "b-studio", "a-web"]);

  const selected = expectOk(model.select("b-studio"));

  assert.equal(selected.selectedId, "b-studio");
  assert.equal(selected.selectedEntry?.id, "b-studio");
  assert.deepEqual(selected.entries.map((item) => [item.id, item.selected]), [
    ["shell", false],
    ["compositor", false],
    ["b-studio", true],
    ["a-web", false],
  ]);
  assert.equal(Object.isFrozen(selected.selectedEntry), true);

  const nameSort = expectOk(model.setSort("name", "desc"));

  assert.deepEqual(ids(nameSort), ["a-web", "b-studio", "shell", "compositor"]);
  assert.equal(nameSort.selectedEntry?.id, "b-studio");
  assert.equal(nameSort.entries[1]?.selected, true);

  const beforeMissingSelect = model.snapshot();
  const missing = model.select("missing");

  assert.equal(missing.ok, false);
  if (missing.ok) assert.fail("expected missing selection to fail closed");
  assert.equal(missing.error.code, "ACTIVITY_MONITOR_ENTRY_NOT_FOUND");
  assert.equal(missing.state, beforeMissingSelect);
});

test("Activity Monitor refresh fails closed when the stats port is absent or denied", async () => {
  const missingPort = createActivityMonitorAppViewModel();
  const missing = await missingPort.refresh();

  assert.equal(missing.ok, false);
  if (missing.ok) assert.fail("expected missing stats port to fail closed");
  assert.equal(missing.error.code, "ACTIVITY_MONITOR_STATS_UNAVAILABLE");
  assertFailClosedState(missing.state, "forbidden", "ACTIVITY_MONITOR_STATS_UNAVAILABLE");

  const calls: ActivityMonitorStatsRequest[] = [];
  const deniedPort = createActivityMonitorAppViewModel({
    stats: fakeStatsPort(calls, () => Object.freeze({
      error: Object.freeze({
        code: "AccessDenied",
        message: "stats are not granted",
        path: "/stats",
      }),
      ok: false,
    })),
  });
  const denied = await deniedPort.refresh();

  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail("expected denied stats port to fail closed");
  assert.deepEqual(calls, [
    {
      appId: ACTIVITY_MONITOR_STATS_REQUEST_APP_ID,
    },
  ]);
  assert.equal(denied.error.code, "AccessDenied");
  assertFailClosedState(denied.state, "forbidden", "AccessDenied");
});

test("Activity Monitor snapshots are frozen, stable, and detached from port-owned data", async () => {
  const mutableEntry = {
    cpuPercent: 1,
    id: "mutable",
    kind: "process",
    memBytes: 16,
    name: "Mutable",
    status: "running",
  };
  const mutableTotals = {
    cpuPercent: 1,
    memBytes: 16,
  };
  const model = createActivityMonitorAppViewModel({
    stats: fakeStatsPort([], () => Object.freeze({
      ok: true,
      value: Object.freeze({
        entries: Object.freeze([mutableEntry]),
        totals: mutableTotals,
      }),
    })),
  });

  const refreshed = expectOk(await model.refresh());

  mutableEntry.name = "Changed";
  mutableTotals.memBytes = 32;

  const first = model.snapshot();
  const second = model.snapshot();

  assert.equal(first, refreshed);
  assert.equal(second, first);
  assert.equal(first.entries[0]?.name, "Mutable");
  assert.equal(first.totals.memBytes, 16);
  assert.equal(Object.isFrozen(first.sort), true);
  assert.equal(Object.isFrozen(first.entries[0]), true);

  const malformed = createActivityMonitorAppViewModel({
    stats: Object.freeze({
      read(_request: ActivityMonitorStatsRequest): unknown {
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            totals: totals(1, 1),
          }),
        });
      },
    }),
  });
  const malformedResult = await malformed.refresh();

  assert.equal(malformedResult.ok, false);
  if (malformedResult.ok) assert.fail("expected malformed stats to fail closed");
  assert.equal(malformedResult.error.code, "ACTIVITY_MONITOR_STATS_MALFORMED");
  assertFailClosedState(malformed.snapshot(), "error", "ACTIVITY_MONITOR_STATS_MALFORMED");
});

function fakeStatsPort(
  calls: ActivityMonitorStatsRequest[],
  handler: (request: ActivityMonitorStatsRequest) => ActivityMonitorStatsResult,
): ActivityMonitorStatsPort {
  return Object.freeze({
    read(request: ActivityMonitorStatsRequest): ActivityMonitorStatsResult {
      calls.push(request);
      return handler(request);
    },
  });
}

function statsSnapshot(
  entries: readonly ActivityMonitorStatsEntry[],
  totalValue: ActivityMonitorTotals,
): ActivityMonitorStatsResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      entries: Object.freeze([...entries]),
      totals: Object.freeze({
        cpuPercent: totalValue.cpuPercent,
        memBytes: totalValue.memBytes,
      }),
    }),
  });
}

function entry(
  id: string,
  name: string,
  kind: string,
  cpuPercent: number,
  memBytes: number,
  status: string,
): ActivityMonitorStatsEntry {
  return Object.freeze({
    cpuPercent,
    id,
    kind,
    memBytes,
    name,
    status,
  });
}

function totals(cpuPercent: number, memBytes: number): ActivityMonitorTotals {
  return Object.freeze({
    cpuPercent,
    memBytes,
  });
}

function expectOk(result: ActivityMonitorActionResult): ActivityMonitorAppState {
  if (!result.ok) {
    assert.fail(`expected ok result, got ${result.error.code}`);
  }

  return result.state;
}

function ids(state: ActivityMonitorAppState): readonly string[] {
  return state.entries.map((item) => item.id);
}

function assertFailClosedState(
  state: ActivityMonitorAppState,
  status: "forbidden" | "error",
  code: string,
): void {
  assert.equal(state.status, status);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.totals, {
    cpuPercent: 0,
    memBytes: 0,
  });
  assert.equal(state.selectedId, null);
  assert.equal(state.selectedEntry, null);
  assert.equal(state.error?.code, code);
  assert.equal(Object.isFrozen(state), true);
}

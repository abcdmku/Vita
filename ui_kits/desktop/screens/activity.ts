import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createActivityViewModel,
} from "../viewmodels/Activity.ts";
import type {
  ActivityClock,
  ActivityMetricsPort,
  ActivityProcessView,
  ActivityViewModel,
  ActivityViewState,
} from "../viewmodels/Activity.ts";
import {
  datasetValue,
  formatBytes,
  formatPercent,
  optionalHostPort,
  textListItem,
} from "./shared.ts";

export interface ActivityScreenPorts {
  readonly clock: ActivityClock;
  readonly metrics?: ActivityMetricsPort;
}

const DEFAULT_CLOCK = Object.freeze({
  nowMs(): number {
    return 0;
  },
}) satisfies ActivityClock;

export const activityScreen = Object.freeze({
  actions: new Map<string, (viewModel: ActivityViewModel, context: VitaActionContext<ActivityViewState>) => DesktopMaybePromise<void>>([
    ["activity.refresh", async (viewModel) => {
      await viewModel.refresh();
    }],
    ["activity.sort", (viewModel, context) => {
      viewModel.sortBy(datasetValue(context.target, Object.freeze(["vitaSort"])) ?? "cpu");
    }],
    ["activity.select", (viewModel, context) => {
      const raw = datasetValue(context.target, Object.freeze(["vitaPid"]));
      const pid = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

      viewModel.selectProcess(pid);
    }],
  ]),
  binds: new Map<string, (snapshot: ActivityViewState) => string | boolean | readonly VitaListItem[]>([
    ["activity.status", (snapshot) => snapshot.status],
    ["activity.cpu", (snapshot) => formatPercent(snapshot.cpuPercent)],
    ["activity.cpuAverage", (snapshot) => formatPercent(snapshot.cpuAveragePercent)],
    ["activity.memory", (snapshot) => `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`],
    ["activity.memoryPercent", (snapshot) => formatPercent(snapshot.memory.percent)],
    ["activity.processCount", (snapshot) => `${snapshot.processCount} processes`],
    ["activity.sampleCount", (snapshot) => `${snapshot.sampleCount}`],
    ["activity.error", (snapshot) => snapshot.error?.message ?? ""],
    ["activity.sortCpu", (snapshot) => snapshot.sort.column === "cpu"],
    ["activity.sortMemory", (snapshot) => snapshot.sort.column === "memory"],
    ["activity.processes", (snapshot) => snapshot.processes.map(processItem)],
  ]),
  createViewModel(ports: ActivityScreenPorts): ActivityViewModel {
    const input: {
      clock: ActivityClock;
      metrics?: ActivityMetricsPort;
    } = {
      clock: ports.clock,
    };

    if (ports.metrics !== undefined) input.metrics = ports.metrics;

    return createActivityViewModel(input);
  },
  id: "desktop/activity",
  selectPorts(host: DesktopHost): ActivityScreenPorts {
    const metrics = optionalHostPort(host, "metrics", isActivityMetricsPort) ??
      optionalHostPort(host, "activityMetrics", isActivityMetricsPort);
    const clock = optionalHostPort(host, "activityClock", isActivityClock) ?? DEFAULT_CLOCK;
    const output: {
      clock: ActivityClock;
      metrics?: ActivityMetricsPort;
    } = {
      clock,
    };

    if (metrics !== undefined) output.metrics = metrics;

    return Object.freeze(output);
  },
}) satisfies ScreenModule<ActivityViewState, ActivityScreenPorts, ActivityViewModel>;

export default activityScreen;

function isActivityMetricsPort(value: unknown): value is ActivityMetricsPort {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "sample") === "function";
}

function isActivityClock(value: unknown): value is ActivityClock {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "nowMs") === "function";
}

function processItem(process: ActivityProcessView): VitaListItem {
  return textListItem({
    action: "activity.select",
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: process.selected,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-pid",
        value: process.pid,
      }),
    ]),
    key: `process:${process.pid}`,
    text: `${process.name}  ${formatPercent(process.cpuPercent)}  ${formatBytes(process.memoryBytes)}`,
  });
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

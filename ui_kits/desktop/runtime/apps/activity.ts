// Activity — a DARK live system monitor mounted into a managed window's body surface.
//
// VitaApp (see app-sdk.ts): renders CPU / memory / a process table from `ctx.host.metrics.sample`
// and POLLS every ~1.5s so the numbers stay live. The poll interval is cleared on window close via
// the `on("close")` cleanup (and the returned cleanup). Fully token-driven (dark).

import type {
  DesktopHost,
  DesktopHostResult,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";

interface MetricsPortLike {
  sample(request: { capability: string }): Promise<DesktopHostResult<unknown>>;
}

type ActivitySample = {
  readonly cpuPercent?: number;
  readonly memory?: { readonly usedBytes?: number; readonly totalBytes?: number };
  readonly processes?: readonly {
    readonly pid: number;
    readonly name: string;
    readonly cpuPercent: number;
    readonly memoryBytes: number;
  }[];
};

const POLL_INTERVAL_MS = 1_500;

// Config keys (Phase A2). Declaring these on the manifest is enough to get a generated settings form
// (right-click the dock tile → Properties). The app reads them through ctx.config.
const CONFIG_KEYS = Object.freeze({
  refreshSeconds: "refreshSeconds",
  showProcesses: "showProcesses",
});

export const activityApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["metrics.read"] as const),
    config: Object.freeze([
      Object.freeze({
        default: 1.5,
        description: "How often the monitor re-samples /proc.",
        key: CONFIG_KEYS.refreshSeconds,
        label: "Refresh interval (seconds)",
        type: "number" as const,
      }),
      Object.freeze({
        default: true,
        description: "Show the per-process table below the CPU / memory summary.",
        key: CONFIG_KEYS.showProcesses,
        label: "Show process table",
        type: "boolean" as const,
      }),
    ]),
    icon: "📊",
    id: "vita.app.activity",
    title: "Activity",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    const metrics = readMetricsPort(ctx.host);
    let disposed = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    root.style.cssText = "display:block;height:100%;background:var(--surface);color:var(--text)";

    if (metrics === undefined) {
      root.innerHTML = emptyState("The metrics backend is unavailable.");
      return () => {};
    }

    // Read config (defaults from the manifest schema; user overrides persisted via the host bridge).
    function showProcesses(): boolean {
      return ctx.config.get(CONFIG_KEYS.showProcesses) !== false;
    }

    function pollIntervalMs(): number {
      const seconds = ctx.config.get(CONFIG_KEYS.refreshSeconds);

      return typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : POLL_INTERVAL_MS;
    }

    async function refresh(): Promise<void> {
      let result: DesktopHostResult<unknown>;

      try {
        result = await metrics!.sample(Object.freeze({ capability: "metrics.read" }));
      } catch {
        if (!disposed) root.innerHTML = emptyState("The metrics backend failed closed.");
        return;
      }

      if (disposed) return;

      if (!result.ok) {
        root.innerHTML = emptyState(`${result.error.code}: ${result.error.message}`);
        return;
      }

      root.innerHTML = renderSample(result.value as ActivitySample, showProcesses());
    }

    function startPolling(): void {
      if (interval !== undefined) clearInterval(interval);
      interval = setInterval(() => void refresh(), pollIntervalMs());
    }

    root.innerHTML = renderLoading();
    void refresh();
    startPolling();

    const offClose = ctx.on("close", () => cleanup());
    // Live config: re-sample + restart the timer when the user changes settings (e.g. via Properties).
    const offConfig = ctx.config.onChange(() => {
      if (disposed) return;
      void refresh();
      startPolling();
    });

    function cleanup(): void {
      if (disposed) return;
      disposed = true;

      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }

      offConfig();
      offClose();
    }

    return cleanup;
  },
});

export default activityApp;

function readMetricsPort(host: DesktopHost): MetricsPortLike | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, "metrics");
    const value = descriptor?.value;

    if (value !== null && typeof value === "object" && typeof (value as { sample?: unknown }).sample === "function") {
      return value as MetricsPortLike;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function renderSample(sample: ActivitySample, showProcesses: boolean): string {
  const cpu = typeof sample.cpuPercent === "number" ? sample.cpuPercent : 0;
  const used = sample.memory?.usedBytes ?? 0;
  const total = sample.memory?.totalBytes ?? 0;
  const procs = (sample.processes ?? []).slice(0, 12);

  const header =
    `<div style="display:flex;gap:14px;padding:12px 16px;border-bottom:1px solid var(--hairline)">` +
    `<div style="flex:1"><div style="font-size:11px;color:var(--text-faint)">CPU Load</div>` +
    `<div style="font-size:22px;font-weight:600;color:var(--text)">${cpu.toFixed(1)}%</div></div>` +
    `<div style="flex:1"><div style="font-size:11px;color:var(--text-faint)">Memory</div>` +
    `<div style="font-size:22px;font-weight:600;color:var(--text)">${gib(used)} / ${gib(total)} GB</div></div></div>`;

  // The process table is config-gated (Properties → "Show process table").
  if (!showProcesses) {
    return `${header}<div style="padding:18px 16px;color:var(--text-faint);font-size:12px">Process table hidden (enable it in Properties).</div>`;
  }

  if (procs.length === 0) {
    return `${header}<div style="padding:18px 16px;color:var(--text-faint);font-size:12px">No processes reported yet (sampling…).</div>`;
  }

  const rows = procs.map((proc) =>
    `<div style="padding:7px 16px;border-top:1px solid var(--hairline);display:flex;gap:10px;color:var(--text)">` +
    `<span style="flex:1">${escapeHtml(proc.name)}</span>` +
    `<span style="width:48px;text-align:right;color:var(--text-muted)">${proc.cpuPercent.toFixed(1)}%</span>` +
    `<span style="width:80px;text-align:right;color:var(--text-faint)">${mib(proc.memoryBytes)} MB</span>` +
    `<span style="width:54px;text-align:right;color:var(--text-faint)">pid ${proc.pid}</span></div>`,
  ).join("");

  return `${header}<div style="padding:4px 16px;color:var(--text-faint);font-size:11px">` +
    `${procs.length} processes (live /proc · refreshes every ${(POLL_INTERVAL_MS / 1000).toFixed(1)}s)</div>${rows}`;
}

function renderLoading(): string {
  return `<div style="padding:22px 16px;color:var(--text-faint)">Sampling /proc via the host bridge…</div>`;
}

function emptyState(detail: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Activity unavailable</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

function gib(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1);
}

function mib(bytes: number): string {
  return Math.round(bytes / 1_048_576).toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

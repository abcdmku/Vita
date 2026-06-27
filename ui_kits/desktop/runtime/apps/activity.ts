// Activity — a DARK live system monitor mounted into a managed window's body surface.
//
// VitaApp (see app-sdk.ts): renders CPU / memory / a process table from `ctx.host.metrics.sample`
// and POLLS every ~1.5s so the numbers stay live. The poll interval is cleared on window close via
// the `on("close")` cleanup (and the returned cleanup). Fully token-driven (dark).
//
// LIVE-UPDATE STRATEGY (PSD polish): the static structure (header cells + process-table container)
// is rendered ONCE on mount. Each poll then does TARGETED, in-place updates — it writes the CPU% /
// memory cells' textContent and reconciles process rows BY PID — instead of replacing the whole
// body's innerHTML every 1.5s. Replacing innerHTML destroyed + recreated the entire DOM subtree on
// every tick, which flashed and janked (and would re-run any icon init). Targeted textContent writes
// don't touch unchanged nodes, so there is zero flash on a steady-state refresh. innerHTML is still
// used for one-shot transitions (loading / empty / error states), where a full swap is correct.

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
import type {
  WmElement,
} from "../window-manager.ts";

interface MetricsPortLike {
  sample(request: { capability: string }): Promise<DesktopHostResult<unknown>>;
}

type ActivityProcess = {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
};

type ActivitySample = {
  readonly cpuPercent?: number;
  readonly memory?: { readonly usedBytes?: number; readonly totalBytes?: number };
  readonly processes?: readonly ActivityProcess[];
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
    // The live view (header cell refs + the rows container) once the structure is mounted. While
    // this is non-null we do TARGETED updates; it is reset to null whenever we fall back to a
    // full-innerHTML state (loading / empty / error) so the next data tick re-mounts the structure.
    let view: ActivityView | null = null;

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

    // Drop any live structure so the next render rebuilds it (used by the loading/empty/error paths).
    function showFullState(html: string): void {
      view = null;
      root.innerHTML = html;
    }

    async function refresh(): Promise<void> {
      let result: DesktopHostResult<unknown>;

      try {
        result = await metrics!.sample(Object.freeze({ capability: "metrics.read" }));
      } catch {
        if (!disposed) showFullState(emptyState("The metrics backend failed closed."));
        return;
      }

      if (disposed) return;

      if (!result.ok) {
        showFullState(emptyState(`${result.error.code}: ${result.error.message}`));
        return;
      }

      // TARGETED update: mount the structure once, then patch values in place every tick.
      view = renderInto(root, view, result.value as ActivitySample, showProcesses());
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

// ---------------------------------------------------------------------------------------------
// Live (targeted) rendering. The structure is built ONCE; subsequent ticks patch textContent and
// reconcile process rows by pid — no innerHTML replacement of the whole body.
// ---------------------------------------------------------------------------------------------

interface ActivityView {
  readonly cpuCell: WmElement | null;
  readonly memCell: WmElement | null;
  readonly rowsHost: WmElement | null;
  // Whether the structure was built WITH a process table (config can toggle this; a change forces a
  // structural rebuild so the table appears/disappears).
  readonly withProcesses: boolean;
  // Last keyset (pids, in order) we built rows for — when it changes we rebuild the rows' skeleton.
  keyset: string;
}

// Render `sample` into `root`. If `view` is null or its shape no longer matches (process-table
// toggled), (re)build the static structure and return a fresh view. Otherwise patch the existing
// nodes in place and return the same view.
function renderInto(
  root: WmElement,
  view: ActivityView | null,
  sample: ActivitySample,
  withProcesses: boolean,
): ActivityView {
  if (view === null || view.withProcesses !== withProcesses) {
    return buildView(root, sample, withProcesses);
  }

  patchView(view, sample);
  return view;
}

function buildView(root: WmElement, sample: ActivitySample, withProcesses: boolean): ActivityView {
  root.innerHTML = structureHtml(withProcesses);

  const view: ActivityView = {
    cpuCell: safeQuery(root, "[data-activity-cpu]"),
    keyset: "",
    memCell: safeQuery(root, "[data-activity-mem]"),
    rowsHost: safeQuery(root, "[data-activity-rows]"),
    withProcesses,
  };

  patchView(view, sample);
  return view;
}

function patchView(view: ActivityView, sample: ActivitySample): void {
  const cpu = typeof sample.cpuPercent === "number" ? sample.cpuPercent : 0;
  const used = sample.memory?.usedBytes ?? 0;
  const total = sample.memory?.totalBytes ?? 0;

  setText(view.cpuCell, `${cpu.toFixed(1)}%`);
  setText(view.memCell, `${gib(used)} / ${gib(total)} GB`);

  if (!view.withProcesses || view.rowsHost === null) return;

  const procs = (sample.processes ?? []).slice(0, 12);
  const keyset = procs.map((proc) => proc.pid).join(",");

  // Rebuild the rows' skeleton only when the SET of processes (pids/order) actually changes — this
  // is the only path that touches innerHTML on a live tick, and it's rare (steady process set). The
  // common case below patches each row's value cells with textContent, so unchanged rows never flash.
  if (keyset !== view.keyset) {
    view.rowsHost.innerHTML = rowsSkeletonHtml(procs);
    view.keyset = keyset;
  }

  for (let index = 0; index < procs.length; index += 1) {
    const proc = procs[index];

    if (proc === undefined) continue;

    const row = safeQuery(view.rowsHost, `[data-activity-row="${proc.pid}"]`);

    if (row === null) continue;

    setText(safeQuery(row, "[data-activity-row-name]"), proc.name);
    setText(safeQuery(row, "[data-activity-row-cpu]"), `${proc.cpuPercent.toFixed(1)}%`);
    setText(safeQuery(row, "[data-activity-row-mem]"), `${mib(proc.memoryBytes)} MB`);
    setText(safeQuery(row, "[data-activity-row-pid]"), `pid ${proc.pid}`);
  }
}

// The static structure: header (CPU + Memory cells) + an empty rows container the patch step fills.
function structureHtml(withProcesses: boolean): string {
  const header =
    `<div style="display:flex;gap:14px;padding:12px 16px;border-bottom:1px solid var(--hairline)">` +
    `<div style="flex:1"><div style="font-size:11px;color:var(--text-faint)">CPU Load</div>` +
    `<div style="font-size:22px;font-weight:600;color:var(--text)" data-activity-cpu>0.0%</div></div>` +
    `<div style="flex:1"><div style="font-size:11px;color:var(--text-faint)">Memory</div>` +
    `<div style="font-size:22px;font-weight:600;color:var(--text)" data-activity-mem>0.0 / 0.0 GB</div></div></div>`;

  if (!withProcesses) {
    return `${header}<div style="padding:18px 16px;color:var(--text-faint);font-size:12px">Process table hidden (enable it in Properties).</div>`;
  }

  return (
    `${header}<div style="padding:4px 16px;color:var(--text-faint);font-size:11px">` +
    `Live /proc · refreshes every ${(POLL_INTERVAL_MS / 1000).toFixed(1)}s</div>` +
    `<div data-activity-rows></div>`
  );
}

// One row per process, keyed by pid. Value cells carry data-* hooks so the patch step can update
// their textContent without rebuilding the row.
function rowsSkeletonHtml(procs: readonly ActivityProcess[]): string {
  if (procs.length === 0) {
    return `<div style="padding:18px 16px;color:var(--text-faint);font-size:12px">No processes reported yet (sampling…).</div>`;
  }

  return procs.map((proc) =>
    `<div data-activity-row="${proc.pid}" style="padding:7px 16px;border-top:1px solid var(--hairline);display:flex;gap:10px;color:var(--text)">` +
    `<span data-activity-row-name style="flex:1"></span>` +
    `<span data-activity-row-cpu style="width:48px;text-align:right;color:var(--text-muted)"></span>` +
    `<span data-activity-row-mem style="width:80px;text-align:right;color:var(--text-faint)"></span>` +
    `<span data-activity-row-pid style="width:54px;text-align:right;color:var(--text-faint)"></span></div>`,
  ).join("");
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

function setText(element: WmElement | null, value: string): void {
  if (element === null) return;

  try {
    if (element.textContent !== value) element.textContent = value;
  } catch {
    // ignore — best-effort cell update.
  }
}

function safeQuery(root: WmElement, selector: string): WmElement | null {
  try {
    return root.querySelector?.(selector) ?? null;
  } catch {
    return null;
  }
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

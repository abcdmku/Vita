// Puter compat — the CONTROL-PLANE bridge the deploy/management console talks to.
//
// The data plane (fs/kv/auth) is a direct-HTTP surface the puter.js SDK already speaks (api-origin.ts).
// The CONTROL plane — list/start/stop capsules, node status/health, logs — is NOT something a browser
// can reach: on-device it lives behind agentd's unix socket (/run/vita-agent/agentd.sock, ADR-0008),
// reachable only by the local TS runtime with the right peer credentials. A sandboxed Puter web app
// has no socket and no peer creds.
//
// This module is the thin, capability-gated bridge that closes that gap. It defines:
//   1. The CONSOLE-FACING shape (`ConsoleAppView`, `NodeStatus`, `LogLine`) the web app consumes — a
//      stable, browser-friendly projection of agentd's surface.
//   2. The `AgentControlPlane` port — the minimal agentd RPC surface the bridge needs. Two impls ship:
//        - `createAgentHttpControlPlane`  → talks to the REAL agentd over its HTTP RPC (the on-device
//          host-proxy forwards these to the unix socket). This is what runs on a live node.
//        - `createStubControlPlane`       → an in-memory node with a few seeded capsules + a lifecycle
//          state machine, so the console is fully exercisable in a browser with NO VM boot.
//
// The api_origin (api-origin.ts) mounts this behind /control/* and gates every call on the `control`
// capability, exactly as fs/kv are gated. The web app never sees agentd; it sees /control/*.
//
// Mapping to the REAL agentd surface (agent/transport/server.go, agent/capabilities/capsule/*):
//   list installed   ← GET  /state            → capabilities["capsule.registry"].capsules  (CapsuleEntry[])
//   running status    ← GET  /read/capsule.execute → { last: ExecuteStatus }  (unit, dynamicUid, health, status)
//   node status/health← GET  /state + /healthz  (VITA-EVAL / STATE projection)
//   start             ← POST /apply  { operations:[{ capability:"capsule.execute", request:{ desired:{id,version,integrity} } }] }
//   stop              ← POST /apply  { operations:[{ capability:"capsule.lifecycle", request:{ desired:{op:"stop", id} } }] }
//   logs              ← (NO agentd HTTP endpoint today — journald per transient unit). The bridge
//                        defines GET /control/apps/:id/logs and the on-device impl will back it with a
//                        new agentd `capsule.logs` read (documented in CONTROL-PLANE.md). The stub
//                        synthesizes a realistic journal so the console's log view is exercisable now.

// ---------------------------------------------------------------------------------------------
// Console-facing projection (what the browser app consumes — stable + browser-friendly).
// ---------------------------------------------------------------------------------------------

// A capsule/app as the console shows it. Folds agentd's installed-registry entry together with its
// live execute status into one row the UI can render directly.
export interface ConsoleAppView {
  readonly id: string;
  readonly version: string;
  // SRI integrity of the installed capsule (sha256:...). Carried so start can echo it back to agentd.
  readonly integrity: string;
  // The installed-registry state: a capsule is "installed" (may be run) or "disabled".
  readonly installState: "installed" | "disabled";
  // Lifecycle, derived from the execute status: is a transient unit live for this capsule?
  readonly running: boolean;
  // Health from the capsule health checks: OK | unhealthy | unknown (mirrors WorkloadStatus.Health).
  readonly health: "OK" | "unhealthy" | "unknown";
  // The runtime kind (ts-service | wasm-service | oci-service). Informational for the UI.
  readonly runtime: string;
  // The live systemd transient unit name, when running (e.g. run-vita-<id>-uNNNN.service). Empty if not.
  readonly unit: string;
  // The ephemeral DynamicUser uid the unit runs as, when running. Empty if not.
  readonly dynamicUid: string;
}

// The node's overall control-plane status — the VITA-EVAL / STATE projection the console header shows.
export interface NodeStatus {
  // Is agentd reachable + ready (GET /healthz ok)?
  readonly ready: boolean;
  // The node's mode (headless | local-desktop | network-desktop) when known.
  readonly mode: string;
  // Counts for the header summary.
  readonly installedCount: number;
  readonly runningCount: number;
  // Free-form one-line eval summary (the latest VITA-EVAL outcome / a stub heartbeat).
  readonly evalSummary: string;
  // ISO timestamp this snapshot was taken.
  readonly observedAt: string;
}

export interface LogLine {
  // ISO timestamp.
  readonly ts: string;
  // syslog-ish level.
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

// The result of a lifecycle action (start/stop), mirroring agentd's apply outcome.
export interface LifecycleResult {
  readonly outcome: "committed" | "rejected" | "rolledBack" | "noop";
  // The capsule's view AFTER the action (so the UI can update without a refetch).
  readonly app: ConsoleAppView;
  // A sanitized reason on reject/rolledBack (matches VITA-CAPSULE-EXECUTE-REJECT reason).
  readonly reason?: string;
}

// ---------------------------------------------------------------------------------------------
// The control-plane PORT the bridge consumes. Implemented by the real agentd HTTP client and the stub.
// ---------------------------------------------------------------------------------------------

export interface AgentControlPlane {
  status(): Promise<NodeStatus>;
  listApps(): Promise<readonly ConsoleAppView[]>;
  getApp(id: string): Promise<ConsoleAppView | undefined>;
  start(id: string): Promise<LifecycleResult>;
  stop(id: string): Promise<LifecycleResult>;
  logs(id: string, limit: number): Promise<readonly LogLine[]>;
}

// ---------------------------------------------------------------------------------------------
// STUB control plane — an in-memory node the console is fully exercisable against (no VM, no socket).
//
// Models the real lifecycle: capsules are "installed" in a registry; starting one creates a transient
// unit + DynamicUser uid and flips running=true + health=OK; stopping tears it down. Logs are a
// realistic per-capsule journal that grows on lifecycle events. This is what the browser verification
// drives — every transition the UI triggers is a real state change in this model, observed back through
// the SAME AgentControlPlane port the live agentd client implements.
// ---------------------------------------------------------------------------------------------

interface StubCapsule {
  id: string;
  version: string;
  integrity: string;
  installState: "installed" | "disabled";
  runtime: string;
  running: boolean;
  health: "OK" | "unhealthy" | "unknown";
  unit: string;
  dynamicUid: string;
  log: LogLine[];
}

export interface StubControlPlaneOptions {
  // Inject a clock (tests / deterministic harness). Defaults to Date.now.
  readonly now?: () => number;
  // Seed capsules. Defaults to a representative set (a running ts-service, an installed wasm-service,
  // a disabled oci-service) so the console shows every state on first load.
  readonly seed?: readonly Partial<StubCapsule>[];
}

const DEFAULT_SEED: readonly Partial<StubCapsule>[] = Object.freeze([
  Object.freeze({
    id: "hello-web",
    version: "1.2.0",
    integrity: "sha256:9f2c1ab4e7d05b1c0a8e3f6d2b4c7a1e9d0f3b6c8a2e5d7f1b4c6a8e0d2f4b6c8",
    installState: "installed" as const,
    runtime: "ts-service",
    running: true,
    health: "OK" as const,
    unit: "run-vita-hello-web-u61408.service",
    dynamicUid: "61408",
  }),
  Object.freeze({
    id: "metrics-collector",
    version: "0.5.1",
    integrity: "sha256:1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b",
    installState: "installed" as const,
    runtime: "wasm-service",
    running: false,
    health: "unknown" as const,
    unit: "",
    dynamicUid: "",
  }),
  Object.freeze({
    id: "edge-cache",
    version: "2.0.0",
    integrity: "sha256:7e5d3c1b9a8f6e4d2c0b8a6f4e2d0c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d",
    installState: "disabled" as const,
    runtime: "oci-service",
    running: false,
    health: "unknown" as const,
    unit: "",
    dynamicUid: "",
  }),
]);

export function createStubControlPlane(options: StubControlPlaneOptions = {}): AgentControlPlane {
  const now = options.now ?? Date.now;
  const seed = options.seed ?? DEFAULT_SEED;
  let unitCounter = 61408;

  const iso = (): string => new Date(now()).toISOString();

  const capsules = new Map<string, StubCapsule>();

  for (const partial of seed) {
    const cap: StubCapsule = {
      id: partial.id ?? "unnamed",
      version: partial.version ?? "0.0.0",
      integrity: partial.integrity ?? "sha256:0",
      installState: partial.installState ?? "installed",
      runtime: partial.runtime ?? "ts-service",
      running: partial.running ?? false,
      health: partial.health ?? "unknown",
      unit: partial.unit ?? "",
      dynamicUid: partial.dynamicUid ?? "",
      log: [],
    };

    cap.log.push({ ts: iso(), level: "info", message: `capsule ${cap.id}@${cap.version} installed (${cap.runtime})` });

    if (cap.running) {
      cap.log.push({ ts: iso(), level: "info", message: `VITA-CAPSULE-EXECUTED id=${cap.id} unit=${cap.unit} uid=${cap.dynamicUid} health=OK status=OK` });
    }

    capsules.set(cap.id, cap);
  }

  function view(cap: StubCapsule): ConsoleAppView {
    return Object.freeze({
      id: cap.id,
      version: cap.version,
      integrity: cap.integrity,
      installState: cap.installState,
      running: cap.running,
      health: cap.health,
      runtime: cap.runtime,
      unit: cap.unit,
      dynamicUid: cap.dynamicUid,
    });
  }

  return Object.freeze({
    async status(): Promise<NodeStatus> {
      const all = [...capsules.values()];
      const running = all.filter((c) => c.running).length;

      return Object.freeze({
        ready: true,
        mode: "local-desktop",
        installedCount: all.filter((c) => c.installState === "installed").length,
        runningCount: running,
        evalSummary: `VITA-EVAL ok — ${running} running / ${all.length} installed, plan converged`,
        observedAt: iso(),
      });
    },

    async listApps(): Promise<readonly ConsoleAppView[]> {
      return Object.freeze([...capsules.values()].map(view));
    },

    async getApp(id: string): Promise<ConsoleAppView | undefined> {
      const cap = capsules.get(id);

      return cap === undefined ? undefined : view(cap);
    },

    async start(id: string): Promise<LifecycleResult> {
      const cap = capsules.get(id);

      if (cap === undefined) return rejected(id, "unknown_capsule");

      if (cap.installState !== "installed") {
        cap.log.push({ ts: iso(), level: "error", message: `VITA-CAPSULE-EXECUTE-REJECT id=${cap.id} reason=disabled` });
        return Object.freeze({ outcome: "rejected", app: view(cap), reason: "capsule is disabled" });
      }

      if (cap.running) {
        return Object.freeze({ outcome: "noop", app: view(cap), reason: "already running" });
      }

      unitCounter += 1;
      cap.running = true;
      cap.health = "OK";
      cap.dynamicUid = String(unitCounter);
      cap.unit = `run-vita-${cap.id}-u${unitCounter}.service`;
      cap.log.push({ ts: iso(), level: "info", message: `systemd-run: started transient unit ${cap.unit} (DynamicUser uid=${cap.dynamicUid})` });
      cap.log.push({ ts: iso(), level: "info", message: `VITA-CAPSULE-EXECUTED id=${cap.id} unit=${cap.unit} uid=${cap.dynamicUid} health=OK status=OK` });

      return Object.freeze({ outcome: "committed", app: view(cap) });
    },

    async stop(id: string): Promise<LifecycleResult> {
      const cap = capsules.get(id);

      if (cap === undefined) return rejected(id, "unknown_capsule");

      if (!cap.running) {
        return Object.freeze({ outcome: "noop", app: view(cap), reason: "not running" });
      }

      const stoppedUnit = cap.unit;

      cap.log.push({ ts: iso(), level: "info", message: `systemctl stop ${stoppedUnit}` });
      cap.running = false;
      cap.health = "unknown";
      cap.unit = "";
      cap.dynamicUid = "";
      cap.log.push({ ts: iso(), level: "info", message: `VITA-CAPSULE-STOPPED id=${cap.id} unit=${stoppedUnit}` });

      return Object.freeze({ outcome: "committed", app: view(cap) });
    },

    async logs(id: string, limit: number): Promise<readonly LogLine[]> {
      const cap = capsules.get(id);

      if (cap === undefined) return Object.freeze([]);

      const tail = cap.log.slice(Math.max(0, cap.log.length - limit));

      return Object.freeze(tail.map((l) => Object.freeze({ ...l })));
    },
  });

  function rejected(id: string, reason: string): LifecycleResult {
    const placeholder: ConsoleAppView = Object.freeze({
      id, version: "", integrity: "", installState: "disabled", running: false,
      health: "unknown", runtime: "", unit: "", dynamicUid: "",
    });

    return Object.freeze({ outcome: "rejected", app: placeholder, reason });
  }
}

// ---------------------------------------------------------------------------------------------
// REAL agentd HTTP control plane — talks to agentd's RPC surface (the on-device host-proxy forwards
// /control/* → the unix socket). Kept as a fetch-shaped client so it can run wherever fetch exists
// (the on-device api_origin host process). NOT used by the browser verification (no live node), but it
// is the production wiring the stub stands in for, written against the REAL agentd JSON shapes.
// ---------------------------------------------------------------------------------------------

export interface AgentHttpOptions {
  // The agentd base URL the host-proxy exposes (e.g. "http://127.0.0.1:8786" dev, or a unix-socket
  // proxy origin). The on-device adapter injects this.
  readonly baseUrl: string;
  // A fetch implementation (node:fetch / undici). Injected so this stays runtime-agnostic + testable.
  readonly fetch: typeof fetch;
}

// agentd's capsule.registry entry shape (agent/capabilities/capsule/capsule.go CapsuleEntry).
interface AgentCapsuleEntry {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly state: "installed" | "disabled";
}

// agentd's capsule.execute status shape (agent/capabilities/capsule/execute.go ExecuteStatus).
interface AgentExecuteStatus {
  readonly id: string;
  readonly version?: string;
  readonly unit: string;
  readonly dynamicUid: string;
  readonly health: string;
  readonly status: string;
}

export function createAgentHttpControlPlane(opts: AgentHttpOptions): AgentControlPlane {
  const { baseUrl, fetch: doFetch } = opts;

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, { method: "GET" });

    if (!res.ok) throw new Error(`agentd GET ${path} → ${res.status}`);

    return (await res.json()) as T;
  }

  async function readState(): Promise<{
    registry: readonly AgentCapsuleEntry[];
    execute: AgentExecuteStatus | undefined;
  }> {
    // GET /state returns all capability state; we pull the two capsule capabilities out of it.
    const state = await getJson<{ capabilities?: Record<string, unknown> }>("/state");
    const caps = state.capabilities ?? {};
    const registryState = caps["capsule.registry"] as { capsules?: AgentCapsuleEntry[] } | undefined;
    const executeState = caps["capsule.execute"] as { last?: AgentExecuteStatus } | undefined;

    return { registry: registryState?.capsules ?? [], execute: executeState?.last };
  }

  function viewFor(entry: AgentCapsuleEntry, exec: AgentExecuteStatus | undefined): ConsoleAppView {
    const running = exec !== undefined && exec.id === entry.id && exec.unit !== "";
    const health = running ? normalizeHealth(exec?.health) : "unknown";

    return Object.freeze({
      id: entry.id,
      version: entry.version,
      integrity: entry.integrity,
      installState: entry.state,
      running,
      health,
      runtime: "ts-service",
      unit: running ? (exec?.unit ?? "") : "",
      dynamicUid: running ? (exec?.dynamicUid ?? "") : "",
    });
  }

  async function apply(operations: unknown[]): Promise<{ outcome: string; error?: { message?: string } | null }> {
    const res = await doFetch(`${baseUrl}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations }),
    });

    return (await res.json()) as { outcome: string; error?: { message?: string } | null };
  }

  return Object.freeze({
    async status(): Promise<NodeStatus> {
      let ready = false;

      try {
        const health = await doFetch(`${baseUrl}/healthz`, { method: "GET" });

        ready = health.ok;
      } catch {
        ready = false;
      }

      const { registry, execute } = await readState();
      const installed = registry.filter((e) => e.state === "installed").length;
      const running = registry.filter((e) => execute?.id === e.id && execute?.unit !== "").length;

      return Object.freeze({
        ready,
        mode: "unknown",
        installedCount: installed,
        runningCount: running,
        evalSummary: ready ? `agentd ready — ${running} running / ${registry.length} installed` : "agentd unreachable",
        observedAt: new Date().toISOString(),
      });
    },

    async listApps(): Promise<readonly ConsoleAppView[]> {
      const { registry, execute } = await readState();

      return Object.freeze(registry.map((e) => viewFor(e, execute)));
    },

    async getApp(id: string): Promise<ConsoleAppView | undefined> {
      const { registry, execute } = await readState();
      const entry = registry.find((e) => e.id === id);

      return entry === undefined ? undefined : viewFor(entry, execute);
    },

    async start(id: string): Promise<LifecycleResult> {
      const { registry, execute } = await readState();
      const entry = registry.find((e) => e.id === id);

      if (entry === undefined) {
        return Object.freeze({ outcome: "rejected", app: emptyView(id), reason: "unknown_capsule" });
      }

      const result = await apply([
        { capability: "capsule.execute", request: { desired: { id: entry.id, version: entry.version, integrity: entry.integrity } } },
      ]);
      const app = viewFor(entry, await reread(id, execute));

      return lifecycleResult(normalizeOutcome(result.outcome), app, result.error?.message);
    },

    async stop(id: string): Promise<LifecycleResult> {
      const result = await apply([
        { capability: "capsule.lifecycle", request: { desired: { op: "stop", id } } },
      ]);
      const app = (await this.getApp(id)) ?? emptyView(id);

      return lifecycleResult(normalizeOutcome(result.outcome), app, result.error?.message);
    },

    async logs(id: string, limit: number): Promise<readonly LogLine[]> {
      // The on-device agentd exposes per-capsule journald via a `capsule.logs` read (see
      // CONTROL-PLANE.md "Logs endpoint"). Until that lands, return a single explanatory line so the
      // UI degrades gracefully against a live node rather than throwing.
      try {
        const lines = await getJson<{ lines?: LogLine[] }>(`/read/capsule.logs?id=${encodeURIComponent(id)}&limit=${limit}`);

        return Object.freeze(lines.lines ?? []);
      } catch {
        return Object.freeze([
          Object.freeze({ ts: new Date().toISOString(), level: "warn" as const, message: `capsule.logs endpoint not available on this agentd build for ${id}` }),
        ]);
      }
    },
  });

  async function reread(id: string, prior: AgentExecuteStatus | undefined): Promise<AgentExecuteStatus | undefined> {
    try {
      const exec = await getJson<{ last?: AgentExecuteStatus }>("/read/capsule.execute");

      return exec.last ?? prior;
    } catch {
      return prior;
    }
  }
}

function normalizeHealth(h: string | undefined): "OK" | "unhealthy" | "unknown" {
  if (h === "OK") return "OK";
  if (h === "unhealthy" || h === "down") return "unhealthy";

  return "unknown";
}

function normalizeOutcome(o: string): LifecycleResult["outcome"] {
  if (o === "committed" || o === "rejected" || o === "rolledBack") return o;

  return "noop";
}

function emptyView(id: string): ConsoleAppView {
  return Object.freeze({
    id, version: "", integrity: "", installState: "disabled", running: false,
    health: "unknown", runtime: "", unit: "", dynamicUid: "",
  });
}

// Build a LifecycleResult, OMITTING `reason` when there is none (exactOptionalPropertyTypes: a present
// `reason: undefined` is not assignable to the optional `reason?: string`).
function lifecycleResult(outcome: LifecycleResult["outcome"], app: ConsoleAppView, reason: string | undefined): LifecycleResult {
  return Object.freeze(reason === undefined ? { outcome, app } : { outcome, app, reason });
}

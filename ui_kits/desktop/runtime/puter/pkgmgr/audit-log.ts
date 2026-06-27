// Vita Package Manager — the capability AUDIT LOG (what each package actually did).
//
// The capability gate (capability.ts) decides ALLOW/DENY for every fs/kv/auth/ui/control/meta call a
// package makes. On its own that decision is invisible: the owner cannot SEE that an app tried to write
// the filesystem and was denied, or that it has been hammering kv all day. This module is the sink that
// makes capability activity VISIBLE — every gate decision (allow AND deny) is appended here, per-app, so
// the Package Manager's "Activity" view can show what a package is really doing and the meta-API can
// surface DENIALS (unexpected/malicious behavior) to the owner.
//
// Design:
//   - A small append-only ring buffer per app (bounded, so a noisy/hostile app can't exhaust memory).
//   - A `record(...)` the capability gate calls on every authorize() outcome.
//   - A `forApp(appId, limit)` the meta-API reads to project the tail for one package.
//   - Pure + in-memory (no I/O, no node import) — on-device this is fed from / mirrored to the agentd
//     gate log; here it is the live record of the in-process gate the platform service owns.
//
// This is intentionally NOT the heavyweight controller AuditEvent model (sdk/.../audit-event-model.ts);
// that is the on-device config-apply provenance ledger. This is the lightweight, per-capability-call
// activity stream scoped to the compat-surface gate — the thing the owner watches per app.

// One recorded capability decision. `outcome` is the gate's verdict; `code` carries the denial code
// (CAP_DENIED / UNAUTHENTICATED / UNKNOWN_INSTANCE) when denied, so the UI can flag malicious attempts.
export interface AuditEntry {
  // Monotonic per-log sequence (strictly increasing). Lets the UI detect gaps / order deterministically.
  readonly seq: number;
  // ms since epoch the decision was made.
  readonly at: number;
  readonly appId: string;
  // The capability the app tried to exercise (fs.read, kv.write, meta, …).
  readonly capability: string;
  // A short human label for the operation that triggered the check, when known (e.g. "fs.write /a.txt").
  readonly operation: string;
  readonly outcome: "allow" | "deny";
  // Present only on deny — the gate denial code (CAP_DENIED / UNAUTHENTICATED / UNKNOWN_INSTANCE).
  readonly code?: string;
  // Present only on deny — a sanitized reason.
  readonly reason?: string;
}

// What the gate hands the log on each decision (the log stamps seq + at).
export interface AuditRecordInput {
  readonly appId: string;
  readonly capability: string;
  readonly operation?: string;
  readonly outcome: "allow" | "deny";
  readonly code?: string;
  readonly reason?: string;
}

export interface AuditLog {
  // Append a decision. Called by the capability gate on every authorize() outcome (allow + deny).
  record(input: AuditRecordInput): AuditEntry;
  // The most recent `limit` entries for one app, oldest-first (so the UI renders a chronological tail).
  forApp(appId: string, limit?: number): readonly AuditEntry[];
  // The most recent `limit` entries across ALL apps (the global activity feed), oldest-first.
  recent(limit?: number): readonly AuditEntry[];
  // Count of DENIALS for one app (the "something is being blocked" badge).
  denialCount(appId: string): number;
  // Drop everything for one app (e.g. on uninstall). Pure bookkeeping.
  clear(appId: string): void;
}

export interface AuditLogOptions {
  // Max entries retained PER APP (ring buffer). Default 500 — enough to be useful, bounded so a hostile
  // app can't exhaust memory by spamming the gate.
  readonly perAppLimit?: number;
  // Inject a clock (tests / deterministic harness). Defaults to Date.now.
  readonly now?: () => number;
}

const DEFAULT_PER_APP_LIMIT = 500;
const DEFAULT_GLOBAL_LIMIT = 200;

export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const perAppLimit = Math.max(1, options.perAppLimit ?? DEFAULT_PER_APP_LIMIT);
  const now = options.now ?? Date.now;

  // appId → bounded entry buffer (oldest-first; we shift when over the cap).
  const byApp = new Map<string, AuditEntry[]>();
  let seq = 0;

  function bufferFor(appId: string): AuditEntry[] {
    let buf = byApp.get(appId);

    if (buf === undefined) {
      buf = [];
      byApp.set(appId, buf);
    }

    return buf;
  }

  return Object.freeze({
    clear(appId: string): void {
      byApp.delete(appId);
    },
    denialCount(appId: string): number {
      return (byApp.get(appId) ?? []).filter((e) => e.outcome === "deny").length;
    },
    forApp(appId: string, limit = perAppLimit): readonly AuditEntry[] {
      const buf = byApp.get(appId) ?? [];
      const n = Math.max(0, Math.min(limit, buf.length));

      return Object.freeze(buf.slice(buf.length - n));
    },
    recent(limit = DEFAULT_GLOBAL_LIMIT): readonly AuditEntry[] {
      const all: AuditEntry[] = [];

      for (const buf of byApp.values()) all.push(...buf);
      all.sort((a, b) => a.seq - b.seq);
      const n = Math.max(0, Math.min(limit, all.length));

      return Object.freeze(all.slice(all.length - n));
    },
    record(input: AuditRecordInput): AuditEntry {
      seq += 1;
      const entry: AuditEntry = Object.freeze({
        appId: input.appId,
        at: now(),
        capability: input.capability,
        operation: input.operation ?? input.capability,
        outcome: input.outcome,
        seq,
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      const buf = bufferFor(input.appId);

      buf.push(entry);
      if (buf.length > perAppLimit) buf.splice(0, buf.length - perAppLimit);

      return entry;
    },
  });
}

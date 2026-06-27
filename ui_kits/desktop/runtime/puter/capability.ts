// Puter compat — the capability gate at the api_origin boundary (token → app → grants).
//
// The data plane (fs/kv/auth) is reached over loopback HTTP by a sandboxed Puter app; the ui plane is
// reached by postMessage. BOTH must be gated: only a launched app with a known instance id + a valid
// opaque owner token may act, and only within the capabilities its registration granted. This module
// is the single fail-closed authority both planes consult.
//
// Posture (mirrors the platform permission-broker, spec §3.10 / CLAUDE.md §6): declared grants,
// default-deny, trust-on-host for the single owner. We DON'T re-implement the heavy package-contract
// broker here — this is a thin, auditable gate scoped to the compat surface, kept behind an interface
// so it can later DELEGATE to runtime/permission-broker when the api_origin moves on-device.
//
// "trust-on-host" (architecture/puter-compat-layer.md §Auth shim): on a single-owner device the token
// is an opaque bearer minted at launch; the api_origin accepts the token it minted and answers as the
// owner. There is no puter.com round-trip. The gate still enforces app-scoped capabilities so one app
// can't exceed its grant.

// The capabilities a compat app can be granted. A superset-friendly string union mapped from the
// VitaApp AppCapability set + the puter surfaces. Kept small + explicit (fail-closed on anything else).
export type PuterCapability =
  | "fs.read"
  | "fs.write"
  | "kv.read"
  | "kv.write"
  | "ui"
  | "auth"
  // The control plane (list/start/stop capsules, node status/health, logs) — gates /control/* on the
  // api_origin. Held by the deploy/management console; NOT granted to ordinary apps (default-deny).
  | "control"
  // PROCESS/EXEC — run a real command inside a hardened, cgroup-gated capsule and stream its
  // stdin/stdout/stderr over the /pty websocket (server.ts → exec-plane.ts). This is the "real machine
  // access" the product vision wants, deliberately the MOST privileged compat capability: it can spawn
  // a process on the node. Default-deny, fail-closed — only an app explicitly granted `exec` (the
  // Terminal) may open a /pty session; everything else is 401/403. NEVER granted by default to ordinary
  // Puter apps (the local kiosk session does NOT carry it unless the owner opts the Terminal in).
  | "exec";

// A launched-app session: the opaque token, the app it belongs to, the instance id the iframe carries,
// the owner identity, and the granted capability set. Minted by `mintAppSession` at launch.
export interface PuterAppSession {
  readonly token: string;
  readonly appId: string;
  readonly appInstanceId: string;
  readonly owner: PuterOwner;
  readonly grants: ReadonlySet<PuterCapability>;
  readonly domain: string;
}

export interface PuterOwner {
  readonly username: string;
  readonly uuid: string;
  readonly emailConfirmed: boolean;
}

// The result of a gate check — either an authorized session or a typed denial the caller maps to an
// HTTP status / postMessage error.
export type GateResult =
  | { readonly ok: true; readonly session: PuterAppSession }
  | { readonly ok: false; readonly code: GateDenialCode; readonly message: string; readonly status: number };

// Two distinct denial families (consistent with memory `vita-capability-denial-codes`: don't unify):
//  - UNAUTHENTICATED: the token is unknown/missing (HTTP 401).
//  - CAP_DENIED: the token is valid but the app lacks the capability for this action (HTTP 403).
export type GateDenialCode = "UNAUTHENTICATED" | "CAP_DENIED" | "UNKNOWN_INSTANCE";

// The registry of live app sessions. The api_origin + ui-broker share ONE registry so a token issued
// at launch is honored on both planes. In-memory for the spike; an on-device impl would persist it.
export interface PuterCapabilityRegistry {
  // Mint a session for a freshly-launched app. Returns the session (token included) the launcher
  // bakes into the iframe URL + hands the broker.
  mintAppSession(input: MintInput): PuterAppSession;
  // Resolve a bearer token to its session (data plane). Fail-closed if unknown.
  resolveToken(token: string | undefined): GateResult;
  // Resolve an app instance id to its session (ui plane). Fail-closed if unknown.
  resolveInstance(appInstanceId: string | undefined): GateResult;
  // Gate a specific capability against a resolved session.
  authorize(session: PuterAppSession, capability: PuterCapability): GateResult;
  // For tests/introspection — the live sessions.
  readonly sessions: readonly PuterAppSession[];
  revoke(appInstanceId: string): void;
}

// The pluggable AUTHORIZATION authority. The registry DELEGATES every capability decision here, so the
// gate's enforcement is not hard-coded to "the grant set baked into the session". Two implementations
// ship:
//   - the DEFAULT session-grant model (below): the decision is the session's declared grant set, but it
//     is still consulted at request time (so revoking/changing grants takes effect live).
//   - `createBrokerPermissionModel` (permission-model.ts): delegates to the REAL platform
//     `runtime/permission-broker` (`decideGrants`) against a per-app declared-grant policy, proving the
//     api_origin gate is enforced by the same broker the rest of the OS uses — fail-closed.
// A model decides ALLOW only when the app genuinely holds the capability; everything else is DENY.
export interface PuterPermissionModel {
  // Decide whether `appId` may exercise `capability`. Returns true to ALLOW; false/throw → DENY
  // (the registry maps a false/throw to CAP_DENIED / 403, fail-closed).
  decide(input: PermissionDecisionInput): boolean;
}

export interface PermissionDecisionInput {
  readonly appId: string;
  readonly appInstanceId: string;
  readonly capability: PuterCapability;
  // The session's declared grants — the default model uses these; a broker model may ignore them and
  // consult its own per-app policy keyed by appId.
  readonly declaredGrants: ReadonlySet<PuterCapability>;
}

// The default model: ALLOW iff the capability is in the session's declared grant set. (This is the
// spike behavior, but now routed through the delegation seam so it can be swapped for the broker.)
export function createSessionGrantModel(): PuterPermissionModel {
  return Object.freeze({
    decide(input: PermissionDecisionInput): boolean {
      return input.declaredGrants.has(input.capability);
    },
  });
}

export interface CapabilityRegistryOptions {
  // The authorization authority the registry delegates every `authorize` call to. Default: the
  // session-grant model. Pass a broker-backed model for REAL on-device enforcement.
  readonly permissionModel?: PuterPermissionModel;
}

export interface MintInput {
  readonly appId: string;
  readonly appInstanceId: string;
  readonly grants: readonly PuterCapability[];
  readonly owner?: Partial<PuterOwner>;
  readonly domain?: string;
  // Inject the token (tests / deterministic harness). Defaults to a random opaque token.
  readonly token?: string;
  // Inject the random source (tests). Defaults to a real CSPRNG when available.
  readonly randomToken?: () => string;
}

const DEFAULT_OWNER: PuterOwner = Object.freeze({
  emailConfirmed: true,
  username: "owner",
  uuid: "owner-0000-0000-0000-000000000000",
});

export function createCapabilityRegistry(options: CapabilityRegistryOptions = {}): PuterCapabilityRegistry {
  const byToken = new Map<string, PuterAppSession>();
  const byInstance = new Map<string, PuterAppSession>();
  const permissionModel = options.permissionModel ?? createSessionGrantModel();

  function denial(code: GateDenialCode, message: string, status: number): GateResult {
    return Object.freeze({ code, message, ok: false, status });
  }

  return Object.freeze({
    authorize(session: PuterAppSession, capability: PuterCapability): GateResult {
      // DELEGATE the decision to the pluggable permission model. Fail-closed: any false return OR thrown
      // error from the model is a denial (CAP_DENIED / 403), never an allow.
      let allowed = false;

      try {
        allowed = permissionModel.decide({
          appId: session.appId,
          appInstanceId: session.appInstanceId,
          capability,
          declaredGrants: session.grants,
        });
      } catch {
        allowed = false;
      }

      if (!allowed) {
        return denial("CAP_DENIED", `app '${session.appId}' lacks capability '${capability}'`, 403);
      }

      return Object.freeze({ ok: true, session });
    },
    mintAppSession(input: MintInput): PuterAppSession {
      const token = input.token ?? (input.randomToken ?? randomOpaqueToken)();
      const owner: PuterOwner = Object.freeze({
        emailConfirmed: input.owner?.emailConfirmed ?? DEFAULT_OWNER.emailConfirmed,
        username: input.owner?.username ?? DEFAULT_OWNER.username,
        uuid: input.owner?.uuid ?? DEFAULT_OWNER.uuid,
      });
      const session: PuterAppSession = Object.freeze({
        appId: input.appId,
        appInstanceId: input.appInstanceId,
        domain: input.domain ?? "localhost",
        grants: Object.freeze(new Set(input.grants)),
        owner,
        token,
      });

      byToken.set(token, session);
      byInstance.set(input.appInstanceId, session);
      return session;
    },
    resolveInstance(appInstanceId: string | undefined): GateResult {
      if (appInstanceId === undefined || appInstanceId === "") {
        return denial("UNKNOWN_INSTANCE", "missing app instance id", 400);
      }

      const session = byInstance.get(appInstanceId);

      if (session === undefined) return denial("UNKNOWN_INSTANCE", "unknown app instance id", 403);

      return Object.freeze({ ok: true, session });
    },
    resolveToken(token: string | undefined): GateResult {
      if (token === undefined || token === "") {
        return denial("UNAUTHENTICATED", "missing bearer token", 401);
      }

      const session = byToken.get(token);

      if (session === undefined) return denial("UNAUTHENTICATED", "unknown bearer token", 401);

      return Object.freeze({ ok: true, session });
    },
    revoke(appInstanceId: string): void {
      const session = byInstance.get(appInstanceId);

      if (session === undefined) return;

      byInstance.delete(appInstanceId);
      byToken.delete(session.token);
    },
    get sessions(): readonly PuterAppSession[] {
      return Object.freeze([...byToken.values()]);
    },
  });
}

// Parse a `Bearer <token>` Authorization header into the raw token. Pure.
export function parseBearer(header: string | undefined | null): string | undefined {
  if (typeof header !== "string") return undefined;

  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());

  return match?.[1];
}

// The default opaque-token source: 32 bytes of CSPRNG hex when crypto is available, else a
// time+counter fallback (still unguessable enough for a single-owner host spike; the real on-device
// minting uses the platform's token service).
let fallbackCounter = 0;

export function randomOpaqueToken(): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const getRandomValues = g.crypto?.getRandomValues;

  if (typeof getRandomValues === "function") {
    const bytes = new Uint8Array(32);

    getRandomValues.call(g.crypto, bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  fallbackCounter += 1;
  return `tok-${Date.now().toString(16)}-${fallbackCounter.toString(16)}-${Math.random().toString(16).slice(2)}`;
}

// Puter compat — the DUAL-FACE backend (node-only). ONE Vita backend, TWO reachability paths:
//
//   - LOOPBACK / KIOSK face  (127.0.0.1): trust-on-host. A stock kiosk browser on the local display
//     (cage + chromium --kiosk) reaches it with no owner token (the device is the trust boundary).
//   - NETWORK / REMOTE face  (0.0.0.0 or a chosen iface): a remote browser reaches it ONLY with the
//     opaque OWNER TOKEN over the connection (header `x-vita-owner` or `?vita_owner=`). Note: in
//     production this face MUST be behind TLS (the owner token is a bearer secret); the harness binds
//     plain HTTP on loopback-as-network for proof.
//
// BOTH faces share ONE store (the persisted PuterStore) and ONE capability registry (the per-app gate),
// so a file/kv written through the local face is read through the network face and vice-versa, and the
// SAME capability enforcement applies to both. The network owner-gate is an ADDITIONAL outer layer on
// top of the per-app capability gate (it authenticates the connection as the owner's; the inner gate
// still scopes each app to its grants).
//
// Node-only (starts node:http listeners via server.ts). Never import from the browser bundle.

import { createHash, timingSafeEqual } from "node:crypto";

import { createApiOrigin, type ApiOrigin, type ApiRequest } from "./api-origin.ts";
import { parseBearer, type PuterCapabilityRegistry } from "./capability.ts";
import type { AgentControlPlane } from "./control-plane.ts";
import type { ExecBackend } from "./exec-plane.ts";
import type { MetaPlane } from "./pkgmgr/meta-plane.ts";
import { startHarnessServer, type FaceGate, type HarnessServer } from "./server.ts";
import type { PuterStore } from "./store.ts";

export interface DualFaceDeps {
  readonly store: PuterStore;
  readonly capabilities: PuterCapabilityRegistry;
  // The CONTROL-PLANE bridge the deploy/management console talks to (/control/*). Optional: when absent
  // both faces are data-plane-only (/control/* answers 404). When present, the SAME bridge instance is
  // mounted on BOTH faces' single shared api_origin and gated on the `control` capability. On-device the
  // server-entry builds it as createAgentHttpControlPlane(...) over the agentd unix socket.
  readonly controlPlane?: AgentControlPlane;
  // Absolute dir served as static root (the entry page + vendored puter.js live under here / aliases).
  readonly staticRoot: string;
  readonly staticAliases?: Readonly<Record<string, string>>;
  readonly apiPrefix?: string;
  // The opaque OWNER token the network face requires. Mint a long random secret per device/session.
  readonly ownerToken: string;
  // Loopback face bind. Default host 127.0.0.1, port 0 (ephemeral).
  readonly localHost?: string;
  readonly localPort?: number;
  // Network face bind. Default host 0.0.0.0 (all ifaces), port 0 (ephemeral). For the harness we bind a
  // distinct loopback host (127.0.0.1 on a different port) so it is reachable yet test-safe.
  readonly networkHost?: string;
  readonly networkPort?: number;
  // TLS material (PEM cert+key) for the NETWORK face. The owner token is a bearer secret, so a
  // network face carrying it MUST be TLS in production (see server/tls.ts). When omitted the network
  // face binds plain HTTP — harness-only / explicit opt-out. The LOCAL face is always plain (loopback,
  // trust-on-host). Build this with `resolveTlsMaterial()` from server/tls.ts.
  readonly networkTls?: { readonly cert: string; readonly key: string };
  // LOCAL FACE ONLY: a provider for the minted local app-session token, handed to the loopback/kiosk
  // listener so it can serve `GET /session.js` (the in-browser puter.js authenticates to the local
  // api_origin with it). NEVER passed to the network listener — the local kiosk token is a
  // trust-on-host secret and must not be served to a remote client (the network face gates on the
  // separate owner token). Returns the current token, or undefined before it is minted.
  readonly localSessionToken?: () => string | undefined;
  // The PACKAGE-MANAGER meta plane (/meta/*). When present, mounted on the shared api_origin and gated on
  // the `meta` capability (Package Manager only). Absent → /meta/* answers 404. See pkgmgr/meta-plane.ts.
  readonly metaPlane?: MetaPlane;
  // LOCAL FACE ONLY: the EXEC backend powering the /pty websocket (the Terminal). When present, the
  // local/kiosk listener mounts /pty, gated on the `exec` capability via the SAME shared capability
  // registry. NEVER mounted on the network face here: the on-device Terminal is a trust-on-host loopback
  // app (the network/remote face does not expose a process-spawning pty). Absent → /pty is not mounted
  // (default-deny by omission). See server.ts + exec-plane.ts.
  readonly execBackend?: ExecBackend;
  // LOCAL FACE ONLY: extra dynamic GET routes (exact-path → {contentType, body}) served on the
  // trust-on-host loopback/kiosk listener BEFORE static serving. Used to serve the multi-window SHELL —
  // `/` + `/shell.html` (the shell page) and `/shell-session.js` (the per-app token map). NEVER mounted on
  // the network face: the shell session map carries trust-on-host per-app tokens, exactly like
  // `/session.js`, so a remote client must never receive them (the network face is owner-token gated and
  // serves the static kiosk-entry only). Absent → no extra routes (the legacy single-app kiosk path).
  readonly localExtraRoutes?: Readonly<Record<string, () => { readonly contentType: string; readonly body: string }>>;
}

export interface DualFaceBackend {
  readonly local: HarnessServer; // the trust-on-host loopback/kiosk face (no owner token)
  readonly network: HarnessServer; // the owner-authenticated remote face
  readonly ownerToken: string;
  close(): Promise<void>;
}

// Constant-time equality for two secret-bearing strings. The owner token is the SOLE remote-authn
// secret, so a naive `===` is a timing oracle (it returns on the first differing byte, leaking a prefix
// match). We compare in constant time AND avoid leaking the length: both sides are hashed to a
// fixed-width SHA-256 digest first, so `timingSafeEqual` always operates on equal-length (32-byte)
// buffers and there is NO early length-return path. (Hashing also means an attacker measuring time
// cannot learn the token length from a length-mismatch shortcut.) A non-string / empty candidate or an
// empty expected secret is rejected without calling timingSafeEqual.
function constantTimeEquals(candidate: string | undefined, expected: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0 || expected.length === 0) return false;

  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();

  // Both digests are 32 bytes, so timingSafeEqual never throws on a length mismatch and never returns
  // early on length — the comparison is over the full fixed width.
  return timingSafeEqual(a, b);
}

// Build the owner-token face gate for the network listener. Accept the token as `x-vita-owner` header,
// `Authorization: Bearer <ownerToken>` (when it equals the owner token), or `?vita_owner=` query.
//
// All token comparisons are CONSTANT-TIME (constantTimeEquals): the owner token is the sole remote
// authentication secret, so a `===` here would be a timing oracle. We do NOT short-circuit on the first
// matching source either — every candidate is compared the same way so the gate's timing does not reveal
// which header/query field carried the (in)correct token.
export function ownerTokenFaceGate(ownerToken: string): FaceGate {
  return (request: ApiRequest) => {
    const fromHeader = request.headers["x-vita-owner"];
    const fromBearer = parseBearer(request.headers["authorization"]);
    const fromQuery = request.query["vita_owner"];

    // A bearer token is only treated as the owner token when it constant-time-matches (the inner
    // pre-check that previously used `===`). Otherwise it is ignored (the bearer may be an app-session
    // token, not the owner token).
    const bearerIfOwner = constantTimeEquals(fromBearer, ownerToken) ? fromBearer : undefined;
    const presented = fromHeader ?? bearerIfOwner ?? fromQuery;

    if (constantTimeEquals(presented, ownerToken)) return undefined; // allow

    return {
      body: JSON.stringify({ code: "OWNER_UNAUTHENTICATED", error: { code: "OWNER_UNAUTHENTICATED", message: "network face requires the owner token" }, message: "network face requires the owner token", success: false }),
      status: 401,
    };
  };
}

// Start BOTH faces over ONE store + ONE capability registry + ONE api_origin handler.
export async function startDualFaceBackend(deps: DualFaceDeps): Promise<DualFaceBackend> {
  // ONE handler instance — both listeners route /api/* to it, so there is genuinely one backend. When a
  // control plane is supplied it is mounted on this single api_origin (so /control/* is served on both
  // faces, gated on the `control` capability exactly like fs/kv). The meta plane (/meta/*) is mounted the
  // same way and gated on `meta` (Package Manager only).
  const apiOrigin: ApiOrigin = createApiOrigin({
    capabilities: deps.capabilities,
    store: deps.store,
    ...(deps.controlPlane !== undefined ? { controlPlane: deps.controlPlane } : {}),
    ...(deps.metaPlane !== undefined ? { metaPlane: deps.metaPlane } : {}),
  });
  const apiPrefix = deps.apiPrefix ?? "/api";
  const aliases = deps.staticAliases;

  const local = await startHarnessServer({
    apiOrigin,
    apiPrefix,
    host: deps.localHost ?? "127.0.0.1",
    port: deps.localPort ?? 0,
    staticRoot: deps.staticRoot,
    ...(aliases !== undefined ? { staticAliases: aliases } : {}),
    // LOCAL FACE ONLY: serve /session.js carrying the minted app token (trust-on-host).
    ...(deps.localSessionToken !== undefined ? { localSessionToken: deps.localSessionToken } : {}),
    // LOCAL FACE ONLY: the SHELL page + per-app session map (trust-on-host; never on the network face).
    ...(deps.localExtraRoutes !== undefined ? { extraRoutes: deps.localExtraRoutes } : {}),
    // LOCAL FACE ONLY: the /pty exec websocket (the Terminal). Gated on `exec` via the shared registry.
    // Only mounted when an exec backend is wired; never on the network face. server.ts refuses the /pty
    // upgrade when execBackend/capabilities are absent (default-deny by omission).
    ...(deps.execBackend !== undefined ? { execBackend: deps.execBackend, capabilities: deps.capabilities } : {}),
    // No faceGate on the local face: trust-on-host.
  });

  const network = await startHarnessServer({
    apiOrigin,
    apiPrefix,
    faceGate: ownerTokenFaceGate(deps.ownerToken),
    host: deps.networkHost ?? "0.0.0.0",
    port: deps.networkPort ?? 0,
    staticRoot: deps.staticRoot,
    ...(aliases !== undefined ? { staticAliases: aliases } : {}),
    ...(deps.networkTls !== undefined ? { tls: deps.networkTls } : {}),
  });

  return Object.freeze({
    async close(): Promise<void> {
      await Promise.all([local.close(), network.close()]);
    },
    local,
    network,
    ownerToken: deps.ownerToken,
  });
}

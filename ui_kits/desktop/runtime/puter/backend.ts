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

import { createApiOrigin, type ApiOrigin, type ApiRequest } from "./api-origin.ts";
import { parseBearer, type PuterCapabilityRegistry } from "./capability.ts";
import { startHarnessServer, type FaceGate, type HarnessServer } from "./server.ts";
import type { PuterStore } from "./store.ts";

export interface DualFaceDeps {
  readonly store: PuterStore;
  readonly capabilities: PuterCapabilityRegistry;
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
}

export interface DualFaceBackend {
  readonly local: HarnessServer; // the trust-on-host loopback/kiosk face (no owner token)
  readonly network: HarnessServer; // the owner-authenticated remote face
  readonly ownerToken: string;
  close(): Promise<void>;
}

// Build the owner-token face gate for the network listener. Accept the token as `x-vita-owner` header,
// `Authorization: Bearer <ownerToken>` (when it equals the owner token), or `?vita_owner=` query.
export function ownerTokenFaceGate(ownerToken: string): FaceGate {
  return (request: ApiRequest) => {
    const fromHeader = request.headers["x-vita-owner"];
    const fromBearer = parseBearer(request.headers["authorization"]);
    const fromQuery = request.query["vita_owner"];
    const presented = fromHeader ?? (fromBearer === ownerToken ? fromBearer : undefined) ?? fromQuery;

    if (presented === ownerToken && ownerToken.length > 0) return undefined; // allow

    return {
      body: JSON.stringify({ code: "OWNER_UNAUTHENTICATED", error: { code: "OWNER_UNAUTHENTICATED", message: "network face requires the owner token" }, message: "network face requires the owner token", success: false }),
      status: 401,
    };
  };
}

// Start BOTH faces over ONE store + ONE capability registry + ONE api_origin handler.
export async function startDualFaceBackend(deps: DualFaceDeps): Promise<DualFaceBackend> {
  // ONE handler instance — both listeners route /api/* to it, so there is genuinely one backend.
  const apiOrigin: ApiOrigin = createApiOrigin({ capabilities: deps.capabilities, store: deps.store });
  const apiPrefix = deps.apiPrefix ?? "/api";
  const aliases = deps.staticAliases;

  const local = await startHarnessServer({
    apiOrigin,
    apiPrefix,
    host: deps.localHost ?? "127.0.0.1",
    port: deps.localPort ?? 0,
    staticRoot: deps.staticRoot,
    ...(aliases !== undefined ? { staticAliases: aliases } : {}),
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

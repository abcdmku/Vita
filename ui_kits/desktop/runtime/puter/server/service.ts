// Puter PLATFORM SERVER — the on-device, dual-face serving service (node-only).
//
// This is the CONSOLIDATED server spine: ONE in-process service that serves the Puter app platform
// for all three Vita modes (headless / local-desktop / network-desktop), backed by the REAL persistent
// `/var/lib/vita/apps` mount, gated by the platform permission-broker, with NO dependency on the
// compositor / CEF / window-manager. It composes the verified pieces:
//   - fs-store.ts            REAL file-backed persistence under <appsRoot>/<appId>
//   - permission-model.ts    REAL enforcement (delegates to runtime/permission-broker)
//   - capability.ts          the SINGLE SHARED registry (host mints owner+app tokens, api_origin honors)
//   - api-origin.ts          the fs/kv/auth REST surface the vendored puter.js talks to
//   - backend.ts             the DUAL-FACE bind (local trust-on-host + network owner-token)
//   - server/tls.ts          in-process native TLS for the network face
//
// SINGLE SHARED REGISTRY: this service owns the capability registry. `mintApp()` mints a per-app
// session token IN THIS PROCESS; the api_origin (same process) honors it. There is NO token injection
// across processes — the host and the api_origin are the same process. The owner token (network-face
// bearer) is minted here too and handed to the network-face gate.
//
// Node-only (node:http/https via backend.ts + server.ts, node:fs via fs-store.ts). NEVER import from
// the browser bundle.

import { resolve } from "node:path";

import { startDualFaceBackend, type DualFaceBackend } from "../backend.ts";
import { createCapabilityRegistry, randomOpaqueToken, type PuterCapability, type PuterCapabilityRegistry } from "../capability.ts";
import { openAppStore, DEFAULT_APPS_ROOT } from "../fs-store.ts";
import { createAppGrantRegistry, createBrokerPermissionModel, type AppGrantRegistry } from "../permission-model.ts";
import { resolveTlsMaterial, type TlsMaterial, type TlsSourceOptions } from "./tls.ts";

// The Vita mode the service runs in. Affects WHICH faces are exposed (see resolveFaces):
//   - "headless"        : network face ONLY (owner-token + TLS). No local kiosk browser on the box.
//   - "local-desktop"   : local face ONLY (loopback trust-on-host). A local kiosk browser renders it.
//   - "network-desktop" : BOTH faces — local kiosk browser AND remote owner-token access.
export type VitaMode = "headless" | "local-desktop" | "network-desktop";

// The served path the kiosk browser (and a remote browser) opens to load the Puter platform entry.
// Both faces serve it from the runtime static root; the network face requires the owner token first.
export const KIOSK_ENTRY_PATH = "/kiosk-entry.html";

export interface ServiceFacesConfig {
  // Loopback (kiosk/trust-on-host) face bind. Default 127.0.0.1.
  readonly localHost?: string;
  readonly localPort?: number;
  // Network (remote/owner-token) face bind. Default 0.0.0.0 (all ifaces).
  readonly networkHost?: string;
  readonly networkPort?: number;
}

export interface ServiceOptions {
  readonly mode: VitaMode;
  // The persistent apps root mount. Default `/var/lib/vita/apps` (the on-device persistent partition).
  // The dev harness overrides it with a temp dir.
  readonly appsRoot?: string;
  // The app whose store subtree is opened+served. (The platform serves one owner's app store; the
  // app-grant registry below scopes each appId's capabilities. Default "puter".)
  readonly storeAppId?: string;
  // The owner token for the NETWORK face (a bearer secret). Default: a freshly minted opaque token —
  // read it back from the returned PuterPlatformService.ownerToken (the launch unit prints/persists it).
  readonly ownerToken?: string;
  // TLS material source for the network face. Owner-provided cert+key paths win; otherwise a
  // self-signed cert is generated in-process (see server/tls.ts). Default: self-signed.
  readonly tls?: TlsSourceOptions;
  // Set true to bind the network face PLAIN (no TLS). ONLY for the harness / an explicit owner opt-out.
  // A plain network face leaks the owner bearer; refused unless explicitly set.
  readonly insecureNetworkPlaintext?: boolean;
  readonly faces?: ServiceFacesConfig;
  // The per-app declared grants the broker enforces. Keyed by appId. Empty/absent app → no grants
  // (fail-closed). The default grants the store app full fs+kv+auth (the owner's own app store).
  readonly appGrants?: Readonly<Record<string, readonly PuterCapability[]>>;
}

// A live app session the host minted in-process. The api_origin honors `token`; a sandboxed iframe
// (or native binding) carries it. `instanceId` is the launch instance.
export interface AppHandle {
  readonly appId: string;
  readonly instanceId: string;
  readonly token: string;
  readonly grants: readonly PuterCapability[];
}

export interface PuterPlatformService {
  readonly mode: VitaMode;
  readonly appsRoot: string;
  // The local (kiosk) face URL, if exposed in this mode. undefined in "headless".
  readonly localUrl: string | undefined;
  // The network (remote) face URL, if exposed in this mode. undefined in "local-desktop".
  readonly networkUrl: string | undefined;
  // The full URL the LOCAL kiosk browser opens (localUrl + KIOSK_ENTRY_PATH). undefined in "headless".
  readonly kioskUrl: string | undefined;
  // The owner token the network face requires (bearer secret). Persist/print at launch.
  readonly ownerToken: string;
  // The network-face TLS material actually used (undefined if the network face is plaintext/absent).
  readonly tls: TlsMaterial | undefined;
  // The SINGLE SHARED registry (host-side). `mintApp` mints a per-app session token in-process; the
  // api_origin (same process) honors it. No cross-process token injection.
  readonly capabilities: PuterCapabilityRegistry;
  readonly grants: AppGrantRegistry;
  // Mint a per-app session in-process. The app's declared grants MUST already be in the grant registry
  // (via appGrants or grants.declare) or the broker denies every call (fail-closed).
  mintApp(input: { readonly appId: string; readonly instanceId: string; readonly grants: readonly PuterCapability[]; readonly token?: string }): AppHandle;
  // Publish the LOCAL-face session token to the loopback/kiosk listener. After the boot entry mints the
  // well-known kiosk app session, it calls this so the local face's `GET /session.js` hands that token
  // to the in-browser puter.js SDK (which then authenticates to the local api_origin — no 401). The
  // token is NEVER published to the network face (that listener has no session-token provider).
  setLocalSessionToken(token: string | undefined): void;
  close(): Promise<void>;
}

// Which faces a mode exposes. headless → network only; local-desktop → local only; network-desktop → both.
function resolveFaces(mode: VitaMode): { readonly local: boolean; readonly network: boolean } {
  switch (mode) {
    case "headless":
      return { local: false, network: true };
    case "local-desktop":
      return { local: true, network: false };
    case "network-desktop":
      return { local: true, network: true };
    default:
      return { local: true, network: true };
  }
}

// Start the consolidated dual-face platform service. Opens the REAL persistent store, wires the broker
// permission model into the single shared registry, mints the owner token, resolves TLS for the
// network face, and binds the faces the mode calls for.
export async function startPuterPlatformService(options: ServiceOptions): Promise<PuterPlatformService> {
  const appsRoot = resolve(options.appsRoot ?? DEFAULT_APPS_ROOT);
  const storeAppId = options.storeAppId ?? "puter";
  const mode = options.mode;
  const faces = resolveFaces(mode);

  // ── single shared registry: host mints, api_origin honors, broker enforces ──
  const grants = createAppGrantRegistry(options.appGrants ?? { [storeAppId]: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  // ── REAL persistence: the owner's app store under <appsRoot>/<storeAppId> (persistent partition) ──
  const store = openAppStore({ appId: storeAppId, appsRoot });

  // ── owner token (network-face bearer secret) ──
  const ownerToken = options.ownerToken ?? randomOpaqueToken();

  // ── TLS for the network face (mandatory unless explicitly opted out) ──
  let tls: TlsMaterial | undefined;

  if (faces.network && !options.insecureNetworkPlaintext) {
    tls = resolveTlsMaterial(options.tls ?? {});
  }

  // ── static serving: the kiosk entry page + the vendored Apache-2.0 puter.js ──
  // staticRoot is the puter runtime dir (kiosk-entry.html lives directly under it). The kiosk browser
  // opens the served KIOSK_ENTRY_PATH ("/kiosk-entry.html"); the entry's
  // `<script src="/_vendor/puter/v2.js">` resolves via the `/_vendor` alias → ui_kits/desktop/_vendor.
  // Both faces serve the same files. (The launch contract, LAUNCH.md, points the kiosk URL at
  // KIOSK_ENTRY_PATH; the network face requires the owner token before serving any of it.)
  const runtimeDir = resolve(import.meta.dirname, "..");
  const vendorDir = resolve(runtimeDir, "../../_vendor");
  const staticAliases = {
    "/_vendor": vendorDir,
  };

  // ── LOCAL-face session token holder ──
  // The boot entry mints the well-known kiosk app session AFTER this service resolves, then calls
  // setLocalSessionToken() below. The local listener reads it live via this provider so /session.js
  // serves the current token. Never wired into the network listener (owner-token gated separately).
  let localSessionToken: string | undefined;
  const localSessionTokenProvider = (): string | undefined => localSessionToken;

  // ── bind the faces the mode calls for ──
  let backend: DualFaceBackend | undefined;
  let localUrl: string | undefined;
  let networkUrl: string | undefined;

  if (faces.local || faces.network) {
    backend = await startDualFaceBackend({
      capabilities,
      ownerToken,
      staticRoot: runtimeDir,
      staticAliases,
      ...(faces.local ? { localHost: options.faces?.localHost ?? "127.0.0.1", localPort: options.faces?.localPort ?? 0 } : { localHost: "127.0.0.1", localPort: 0 }),
      networkHost: options.faces?.networkHost ?? "0.0.0.0",
      networkPort: options.faces?.networkPort ?? 0,
      store,
      localSessionToken: localSessionTokenProvider,
      ...(tls !== undefined ? { networkTls: { cert: tls.cert, key: tls.key } } : {}),
    });

    if (faces.local) localUrl = backend.local.url;
    if (faces.network) networkUrl = backend.network.url;
  }

  const captured = backend;

  return Object.freeze({
    appsRoot,
    capabilities,
    async close(): Promise<void> {
      if (captured !== undefined) await captured.close();
    },
    grants,
    kioskUrl: localUrl !== undefined ? `${localUrl}${KIOSK_ENTRY_PATH}` : undefined,
    localUrl,
    mintApp(input: { readonly appId: string; readonly instanceId: string; readonly grants: readonly PuterCapability[]; readonly token?: string }): AppHandle {
      const token = input.token ?? randomOpaqueToken();

      // Ensure the broker knows this app's declared grants (fail-closed otherwise).
      if (!grants.has(input.appId)) grants.declare(input.appId, input.grants);
      capabilities.mintAppSession({ appId: input.appId, appInstanceId: input.instanceId, grants: input.grants, token });

      return Object.freeze({ appId: input.appId, grants: [...input.grants], instanceId: input.instanceId, token });
    },
    mode,
    networkUrl,
    ownerToken,
    setLocalSessionToken(token: string | undefined): void {
      localSessionToken = token;
    },
    tls,
  });
}

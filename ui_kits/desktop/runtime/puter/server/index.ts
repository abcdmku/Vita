// Puter PLATFORM SERVER — the consolidated, WM-free server spine (public barrel).
//
// This barrel is the SERVER SIDE of the Vita ⇄ puter.js platform: everything needed to SERVE the
// Puter app platform (the data plane + capability enforcement + persistence + dual-face binding + TLS
// + the on-device service runner), with NO dependency on the compositor / CEF / window-manager. It is
// the module the OS image's on-device service imports.
//
// Deliberately EXCLUDED from this server barrel:
//   - web-app-window.ts — imports ../window-manager.ts (WM-coupled). That is the ARCHIVED local-shell
//     path (mount a Puter app into a managed WM window). The local face now uses a STOCK kiosk browser
//     (KIOSK.md), so the WM mount is not part of the serving service. It stays importable from the
//     parent ../index.ts barrel for the archived path, but never from here.
//   - ui-broker.ts — the `puter.ui.*` postMessage PARENT. It is browser-portable (no WM/DOM-lib dep),
//     but it is a CLIENT/renderer-side concern, not part of the server that serves fs/kv/auth. It is
//     re-exported from the parent ../index.ts for the renderer; the server spine does not need it.
//
// Everything re-exported here is node-only or transport-agnostic and free of WM/compositor imports.
//
// Layers (request flow):
//   kiosk/remote browser → [ backend.ts dual-face ] → [ api-origin.ts REST ] → [ capability.ts gate
//     → permission-model.ts broker ] → [ store.ts / fs-store.ts persistence ]
//   native VitaApp (in-process) → [ native.ts ] → same gate + same store.

// ── the on-device service runner (the consolidated entrypoint) ──
export {
  KIOSK_ENTRY_PATH,
  startPuterPlatformService,
} from "./service.ts";

// ── the on-device host-proxy: agentd unix socket → /control/* bridge ──
export {
  createAgentdUnixFetch,
  createOnDeviceControlPlane,
  DEFAULT_AGENTD_SOCKET,
} from "./agentd-host-proxy.ts";
export type {
  AgentdHostProxyOptions,
} from "./agentd-host-proxy.ts";

// ── the control-plane bridge contract (the console-facing projection + the agentd client) ──
export {
  createAgentHttpControlPlane,
  createStubControlPlane,
} from "../control-plane.ts";
export type {
  AgentControlPlane,
  ConsoleAppView,
  LifecycleResult,
  LogLine,
  NodeStatus,
} from "../control-plane.ts";
export type {
  AppHandle,
  PuterPlatformService,
  ServiceFacesConfig,
  ServiceOptions,
  VitaMode,
} from "./service.ts";

// ── dual-face binding (local trust-on-host + network owner-token) ──
export {
  ownerTokenFaceGate,
  startDualFaceBackend,
} from "../backend.ts";
export type {
  DualFaceBackend,
  DualFaceDeps,
} from "../backend.ts";

// ── in-process native TLS for the network face ──
export {
  generateSelfSigned,
  resolveTlsMaterial,
} from "./tls.ts";
export type {
  TlsMaterial,
  TlsSourceOptions,
} from "./tls.ts";

// ── the node:http/https adapter (face server) ──
export {
  startHarnessServer,
} from "../server.ts";
export type {
  FaceGate,
  HarnessServer,
  HarnessServerDeps,
} from "../server.ts";

// ── the fs/kv/auth REST surface (transport-agnostic) ──
export {
  createApiOrigin,
  parseJsonBody,
  parseMultipartBatch,
  splitMultipart,
  VERIFIED_PUTER_BUNDLE_SHA256,
} from "../api-origin.ts";
export type {
  ApiOrigin,
  ApiOriginDeps,
  ApiRequest,
  ApiResponse,
} from "../api-origin.ts";

// ── the capability gate (token → app → grants), the SINGLE SHARED registry ──
export {
  createCapabilityRegistry,
  createSessionGrantModel,
  parseBearer,
  randomOpaqueToken,
} from "../capability.ts";
export type {
  CapabilityRegistryOptions,
  GateDenialCode,
  GateResult,
  PermissionDecisionInput,
  PuterAppSession,
  PuterCapability,
  PuterCapabilityRegistry,
  PuterOwner,
  PuterPermissionModel,
} from "../capability.ts";

// ── REAL enforcement: delegate to the platform permission-broker ──
export {
  createAppGrantRegistry,
  createBrokerPermissionModel,
} from "../permission-model.ts";
export type {
  AppGrantRegistry,
  BrokerPermissionModelDeps,
} from "../permission-model.ts";

// ── REAL persistence: file-backed store under <appsRoot>/<appId> ──
export {
  appDirSegment,
  appStoreDir,
  DEFAULT_APPS_ROOT,
  openAppStore,
} from "../fs-store.ts";
export type {
  OpenAppStoreOptions,
} from "../fs-store.ts";

// ── the shared fs+kv backing (interfaces + factories) ──
export {
  basename,
  createMemoryStore,
  createNodeFsStore,
  dirname,
  guessType,
  normalizePath,
  PuterStoreError,
} from "../store.ts";
export type {
  FsEntry,
  NodeFsStoreDeps,
  PuterFsStore,
  PuterKvStore,
  PuterStore,
  ReadResult,
} from "../store.ts";

// ── the in-process native binding (@vita/puter) — same store, same gate ──
export {
  createVitaPuter,
  NativeCapabilityError,
} from "../native.ts";
export type {
  NativeAuth,
  NativeBindingDeps,
  NativeFs,
  NativeKv,
  VitaPuter,
} from "../native.ts";

// ── launch-URL builder (the puter.* params an app iframe carries) ──
export {
  buildLaunchSearch,
  buildLaunchUrl,
  parseLaunchParams,
} from "../launch-url.ts";
export type {
  LaunchUrlParams,
} from "../launch-url.ts";

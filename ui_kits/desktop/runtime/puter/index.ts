// Puter compat layer — public barrel.
//
// The Vita ⇄ puter.js app-platform compat layer: run real Puter web apps AND native TS apps against
// ONE local, capability-gated backend, inside Vita's own shell. See architecture/puter-compat-layer.md
// and ui_kits/desktop/runtime/puter/README.md.
//
// Two front doors over one store:
//   - api-origin.ts  : the local HTTP REST surface sandboxed Puter apps reach (fs/kv/auth).
//   - native.ts      : the in-process `@vita/puter` binding native VitaApps use (same store, same gate).
// Plus: ui-broker.ts (the puter.ui.* postMessage parent), web-app-window.ts (mount a web app into a
// managed WM window), launch-url.ts (the puter.* launch params), capability.ts (the token→app→grants
// gate), store.ts (the shared fs+kv backing).

export {
  createApiOrigin,
  parseJsonBody,
  parseMultipartBatch,
  splitMultipart,
  VERIFIED_PUTER_BUNDLE_SHA256,
} from "./api-origin.ts";
export type {
  ApiOrigin,
  ApiOriginDeps,
  ApiRequest,
  ApiResponse,
} from "./api-origin.ts";

export {
  createCapabilityRegistry,
  createSessionGrantModel,
  parseBearer,
  randomOpaqueToken,
} from "./capability.ts";
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
} from "./capability.ts";

export {
  createAppGrantRegistry,
  createBrokerPermissionModel,
} from "./permission-model.ts";
export type {
  AppGrantRegistry,
  BrokerPermissionModelDeps,
} from "./permission-model.ts";

export {
  createMemoryStore,
  createNodeFsStore,
  PuterStoreError,
  basename,
  dirname,
  guessType,
  normalizePath,
} from "./store.ts";
export type {
  FsEntry,
  NodeFsStoreDeps,
  PuterFsStore,
  PuterKvStore,
  PuterStore,
  ReadResult,
} from "./store.ts";

export {
  asEnvelope,
  createUiBroker,
} from "./ui-broker.ts";
export type {
  AttachedAppTarget,
  BrokerSinks,
  BrokerWindow,
  UiBroker,
  UiBrokerDeps,
} from "./ui-broker.ts";

export {
  buildLaunchSearch,
  buildLaunchUrl,
  parseLaunchParams,
} from "./launch-url.ts";
export type {
  LaunchUrlParams,
} from "./launch-url.ts";

export {
  createWebAppWindowHost,
  genInstanceId,
  setWebAppWindowTitle,
} from "./web-app-window.ts";
export type {
  WebAppHandle,
  WebAppSpec,
  WebAppWindowHost,
  WebAppWindowHostDeps,
} from "./web-app-window.ts";

export {
  createVitaPuter,
  NativeCapabilityError,
} from "./native.ts";
export type {
  NativeAuth,
  NativeBindingDeps,
  NativeFs,
  NativeKv,
  VitaPuter,
} from "./native.ts";

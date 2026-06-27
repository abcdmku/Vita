// Vita app PACKAGER — public barrel (Phase D, v1).
//
// The owner's "even easier" authoring model: point the OS at an OS-allowed npm package and it GENERATES
// the app (desktop or cmd) automatically. The pieces:
//   • catalog.ts  — the typed allowlist (what the OS is allowed to package), SRI-pinned.
//   • generator.ts — THE CORE: package.json + catalog entry -> a registerable VitaApp (bin->cmd,
//                    ui->desktop, auto-introspect).
//   • register.ts — wire a generated app into the dock app set + the signed createAppRegistry catalog.
//   • loader.ts   — the offline-install / capsule hook seam (v1: in-memory; production: SRI-verify ->
//                    offline unpack -> capsule -> module namespace).
//   • samples/    — two in-repo allowed packages (a UI clock, a cmd echo) proving it end-to-end.
//
// `add <pkg>` END-TO-END (how the OS uses this):
//   1. catalog.resolve(name) -> the allowlist entry (or NOT_ALLOWED — the OS only packages what's listed).
//   2. loader.load(entry, pkg) -> the offline-install hook: SRI-verify + unpack into a capsule, return
//      the module namespace (v1: in-memory sample namespace; pure-bin packages return undefined).
//   3. generateApp(entry, pkg, loader) -> a VitaApp (cmd surface or desktop surface).
//   4. registerGeneratedApp(appSet, generated) + packagerRegistrySeed(generated) -> the app joins the
//      dock and the signed registry; the dock tile now launches it through the normal app-window-host.

export {
  createPackagerCatalog,
} from "./catalog.ts";
export {
  appIdFor,
  generateApp,
} from "./generator.ts";
export {
  inMemoryModuleLoader,
} from "./loader.ts";
export {
  packagerRegistrySeed,
  registerGeneratedApp,
  registryDescriptorForGeneratedApp,
} from "./register.ts";

export type {
  DesktopAppSet,
} from "./register.ts";
export type {
  PackageJsonBin,
  PackageJsonLike,
  PackageJsonVitaMeta,
  PackagerAppKind,
  PackagerCatalog,
  PackagerCatalogEntry,
  PackagerError,
  PackagerErrorCode,
  PackagerGenerateResult,
  PackagerGeneratedApp,
  PackagerGeneratedKind,
  PackagerModuleLoader,
  PackagerModuleNamespace,
  PackagerSurfaceRootLike,
  VitaPackageMount,
  VitaPackageMountCleanup,
  VitaPackageMountHost,
} from "./types.ts";

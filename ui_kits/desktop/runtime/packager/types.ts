// Vita app PACKAGER — typed contracts (Phase D, v1).
//
// THE OWNER MODEL ("even easier" authoring): instead of hand-writing a VitaApp, you point the OS at an
// OS-ALLOWED npm package and the OS GENERATES the app for you — a desktop app if the package exposes a
// UI, or a cmd app (a terminal command) if it ships a `bin`. The OS only packages what is on the
// curated ALLOWLIST (the catalog), and the catalog entry carries the SRI integrity + capability grants
// that scope what the generated app may do.
//
// This file is the stable, dependency-light seam for that pipeline. It deliberately re-uses the
// runtime's portable `*Like` style (no DOM `lib`) so `npm run typecheck` stays clean and the module
// can be bundled into the offline in-surface runtime. The deep backends (real offline install into a
// capsule, an out-of-process exec transport) are NOT wired in v1 — those hooks are typed here and the
// generator surfaces honest "not wired yet" states rather than faking them.

import type {
  AppCapability,
} from "../app-sdk.ts";

// ---------------------------------------------------------------------------------------------
// Catalog / allowlist model.
// ---------------------------------------------------------------------------------------------

// What KIND of app the OS should generate from a package.
//   "desktop" — force a desktop VitaApp (the package exposes a UI).
//   "cmd"     — force a terminal command app (the package ships a `bin`).
//   "auto"    — introspect the package.json: a `bin` => cmd, a UI entry => desktop.
export type PackagerAppKind = "desktop" | "cmd" | "auto";

// One curated, OS-allowed packageable npm package. The OS will ONLY generate an app for a package that
// has a matching catalog entry — this is the "OS allows" gate. The integrity (SRI) pins the exact
// bytes the OS is allowed to install; the capabilities are the grants the generated app inherits
// (advisory at the SDK layer, enforced by the host bridge / app-registry — same posture as AppManifest).
export interface PackagerCatalogEntry {
  // npm package name (e.g. "@vita/clock"); also the catalog key.
  readonly name: string;
  // Exact allowed version (the lockfile pin). v1 matches an exact string; ranges are a later layer.
  readonly version: string;
  // Subresource-integrity digest of the package tarball the OS is allowed to install (algorithm-digest,
  // e.g. "sha256-…"). Parsed/validated by the catalog; a malformed digest drops the entry fail-closed.
  readonly integrity: string;
  // Desktop / cmd / auto. See PackagerAppKind.
  readonly kind: PackagerAppKind;
  // The capability grants the generated app inherits. Same vocabulary as AppManifest.capabilities.
  readonly capabilities: readonly AppCapability[];
  // Optional human title override (else derived from package.json#vita.title / name).
  readonly title?: string;
  // Optional icon override (emoji/glyph) (else from package.json#vita.icon / a kind default).
  readonly icon?: string;
}

// The frozen catalog: a lookup over allowed entries keyed by package name. Entries with a malformed
// SRI integrity are dropped at construction (fail-closed) — the catalog never lists something the OS
// could not verify.
export interface PackagerCatalog {
  // Every allowed entry, deterministically ordered by name, frozen.
  list(): readonly PackagerCatalogEntry[];
  // The entry for a package name, or undefined when it is NOT on the allowlist.
  resolve(name: string): PackagerCatalogEntry | undefined;
  // Is this package name on the allowlist?
  allows(name: string): boolean;
}

// ---------------------------------------------------------------------------------------------
// package.json — the minimal structural shape the generator reads.
// ---------------------------------------------------------------------------------------------

// A package.json `bin` field: a single path (string) or a name→path map (object). npm allows both.
export type PackageJsonBin = string | Readonly<Record<string, string>>;

// Vita-specific metadata an allowlisted package MAY declare under a top-level `vita` key. None of it is
// required — the generator falls back to package.json basics + the catalog entry — but it lets a
// package author opt into nicer defaults and declare its UI/cmd surface explicitly.
export interface PackageJsonVitaMeta {
  // Override the generated app id (else derived from the package name).
  readonly id?: string;
  // Display title / icon for the dock + window title bar.
  readonly title?: string;
  readonly icon?: string;
  // Explicit surface kind hint (mirrors the catalog `kind`; the catalog wins when both are present and
  // disagree — the OS allowlist is authoritative).
  readonly kind?: PackagerAppKind;
  // For a UI package: the module export that mounts the UI. Defaults to "default". See the
  // "Vita-packageable UI" convention in generator.ts.
  readonly ui?: string;
  // For a UI package with no JS module (a plain web/HTML entry): a relative HTML path the generic web
  // host should load. The real load is an offline-install concern (stubbed in v1).
  readonly web?: string;
}

// The subset of package.json fields the generator reads. Extra fields are ignored.
export interface PackageJsonLike {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly bin?: PackageJsonBin;
  readonly main?: string;
  readonly module?: string;
  readonly browser?: string;
  readonly vita?: PackageJsonVitaMeta;
}

// ---------------------------------------------------------------------------------------------
// The "Vita-packageable UI" convention (documented; enforced structurally by the generator).
// ---------------------------------------------------------------------------------------------

// What a UI package's module MAY export so the OS can host it as a desktop app. The generator accepts,
// in priority order:
//   1. A VitaApp default export (`{ manifest, mount }`) — the package is already a first-class Vita app;
//      the generator just registers it (manifest/capabilities reconciled with the catalog entry).
//   2. A `mount(root, ctx?)` function (default export OR the export named by `vita.ui`) — the simplest
//      convention: the package paints into the desktop-provided element and optionally returns a
//      cleanup. THIS is the documented "even easier" path for a plain UI module.
//   3. (fallback) `vita.web` / `package.json#browser` — a plain HTML/web entry hosted by the generic
//      web fallback host (honest placeholder in v1; the real webview load is the offline-install layer).
//
// `VitaPackageMount` is convention (2): a function the desktop calls with the surface root element. It
// is intentionally looser than VitaApp.mount (no full AppContext required) so a package authored
// without importing the Vita SDK still works — the second arg is an OPTIONAL, narrow view of the host.
export interface VitaPackageMountHost {
  // The package capabilities the catalog granted (advisory; for the package to reason about itself).
  readonly capabilities: readonly AppCapability[];
  // The package title as resolved by the OS.
  readonly title: string;
}

export type VitaPackageMountCleanup = () => void;

export type VitaPackageMount = (
  root: PackagerSurfaceRootLike,
  host?: VitaPackageMountHost,
) => VitaPackageMountCleanup | void;

// The structural element a packaged UI paints into. A narrow subset of WmElement (no DOM `lib`
// dependency) so a package module need not import the runtime to be typed. The real surface root passed
// at mount time is the managed window body (a full WmElement), which is a superset of this.
export interface PackagerSurfaceRootLike {
  innerHTML: string;
  textContent: string | null;
  readonly style: { cssText: string };
  appendChild?(child: unknown): unknown;
  querySelector?(selector: string): unknown;
  addEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

// ---------------------------------------------------------------------------------------------
// Module loader seam (offline-install hook).
// ---------------------------------------------------------------------------------------------

// What an allowlisted package's installed module looks like once loaded. The generator never imports a
// package directly — it asks the loader for the already-installed module namespace. In v1 the samples
// supply this synchronously (in-repo, no network); the REAL implementation is the offline-install layer:
// verify the SRI, unpack the locked tarball (no lifecycle scripts) into a sandboxed capsule, and return
// the capsule-scoped module namespace. THAT hook plugs in here — see PackagerModuleLoader.
export type PackagerModuleNamespace = Readonly<Record<string, unknown>>;

// Loads the JS module namespace for an allowed package (the package's `main`/`module` entry). Returns
// undefined for a package that exposes NO loadable JS module (e.g. a pure-bin cmd package, or a plain
// web/HTML package). May be async (the real offline install is I/O); the generator awaits it.
//
// >>> THE OFFLINE-INSTALL / CAPSULE HOOK GOES HERE <<<
// v1 ships an in-repo `inMemoryModuleLoader` over the sample packages; production swaps in a loader
// that does: SRI-verify -> offline unpack (locked, no scripts) -> mount into a ts/WASM/OCI capsule ->
// return the capsule module namespace. The generator is agnostic to which loader it is handed.
export interface PackagerModuleLoader {
  load(entry: PackagerCatalogEntry, pkg: PackageJsonLike): Promise<PackagerModuleNamespace | undefined> | PackagerModuleNamespace | undefined;
}

// ---------------------------------------------------------------------------------------------
// Generator result.
// ---------------------------------------------------------------------------------------------

export type PackagerErrorCode =
  | "NOT_ALLOWED" // package is not on the catalog/allowlist
  | "VERSION_MISMATCH" // package.json version != the catalog-pinned version
  | "NAME_MISMATCH" // package.json name != the catalog entry name
  | "NO_SURFACE" // could not determine a cmd or ui surface to generate
  | "MODULE_LOAD_FAILED" // the module loader threw / failed closed
  | "BAD_UI_EXPORT"; // the package claims a UI but exports no usable mount/VitaApp

export interface PackagerError {
  readonly code: PackagerErrorCode;
  readonly message: string;
  readonly path: string;
}

// Which surface the generator produced (so callers / tests can assert the introspection result).
export type PackagerGeneratedKind = "cmd" | "desktop";

// A successful generation: the registerable VitaApp plus provenance (which package + which surface).
// `app` is a ready-to-register VitaApp (manifest + mount); register it with registerGeneratedApp() to
// add it to the dock/app set.
export interface PackagerGeneratedApp {
  readonly app: import("../app-sdk.ts").VitaApp;
  readonly kind: PackagerGeneratedKind;
  readonly entry: PackagerCatalogEntry;
  // True when the surface is wired to a real backend, false when it is an honest stub (e.g. a cmd app
  // with no exec port, or a web package with no offline-install webview). The app still mounts and
  // explains its state; this flag lets the OS badge it.
  readonly backendWired: boolean;
}

export type PackagerGenerateResult =
  | {
      readonly ok: true;
      readonly value: PackagerGeneratedApp;
    }
  | {
      readonly ok: false;
      readonly error: PackagerError;
    };

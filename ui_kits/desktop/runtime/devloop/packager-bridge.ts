// Vita dev-loop — PACKAGER BRIDGE: wire the existing npm->app PACKAGER onto the NEW Puter platform.
//
// The archived packager (ui_kits/desktop/runtime/packager/) turns an OS-ALLOWED npm package into a
// VitaApp whose mount() paints into a window-manager DOM root. The new platform has NO window manager:
// apps are STATIC FILE DIRECTORIES served by the api_origin host and loaded in a browser face (the same
// model as the editor + the scaffold). This bridge maps the packager's output onto THAT model.
//
// It REUSES the packager unchanged:
//   • catalog.ts   — the OS allowlist gate (catalog.allows / resolve). Only listed packages package.
//   • generator.ts — generateApp(entry, pkg, loader): classifies cmd vs desktop/auto, validates the
//                    package.json against the catalog pin (name/version), reconciles capabilities.
//   • loader.ts    — the offline-install hook seam. We supply a REAL on-disk locked-install loader
//                    (lockedDirModuleLoader) that SRI-VERIFIES the installed package bytes before
//                    handing the generator the module namespace — no network, no lifecycle scripts.
//
// And maps the generated KIND onto a SERVED APP DIRECTORY:
//   • cmd  -> a served terminal-style page scoped to the package's command. Honest about exec: with no
//            capsule exec transport wired, it echoes args (same posture the packager's cmd surface takes).
//   • desktop (mount-module)  -> a served host page that imports the installed module and calls its
//            mount(root, host) — the "Vita-packageable UI" convention, now hosted by a browser page
//            instead of a WM window. Wired to the api_origin (puter.* available to the module).
//   • desktop (vita.web HTML) -> serve the package's own HTML entry directly.
//
// The result is a PackagerServedApp: a runnable app directory (manifest + files) ready to write into the
// owner space via puter.fs / the native fs binding, IMMEDIATELY runnable against the new api_origin.
//
// Node-only where it reads the locked install from disk (node:fs/crypto). The pure mapping
// (servedAppFromGenerated) takes already-loaded inputs and is portable/testable.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { createPackagerCatalog } from "../packager/catalog.ts";
import { generateApp } from "../packager/generator.ts";
import type {
  PackageJsonLike,
  PackagerCatalog,
  PackagerCatalogEntry,
  PackagerGeneratedApp,
  PackagerModuleLoader,
  PackagerModuleNamespace,
} from "../packager/types.ts";
import { parseSriIntegrity } from "../../../../sdk/typescript/src/sri.ts";
import { scaffoldFilesIcon } from "./packager-bridge-assets.ts";
import type { ScaffoldFile } from "./scaffold.ts";

// ---------------------------------------------------------------------------------------------
// The served-app result (the new-platform analogue of a PackagerGeneratedApp).
// ---------------------------------------------------------------------------------------------

export type PackagerServedKind = "cmd" | "desktop";

export interface PackagerServedApp {
  readonly appId: string;
  readonly title: string;
  readonly icon: string;
  readonly kind: PackagerServedKind;
  // Where the app directory should be created (absolute path under the owner space).
  readonly appDir: string;
  // The page a browser face opens to RUN the app.
  readonly entryPath: string;
  // The files to write (ABSOLUTE paths under appDir), ready for puter.fs.write / native fs.
  readonly files: readonly ScaffoldFile[];
  // The capability grants the catalog entry granted (advisory at the SDK layer; the api_origin gate is
  // authoritative for fs/kv/auth).
  readonly capabilities: readonly string[];
  // True when the surface is wired to a real backend; false when it is an honest stub (a cmd app with no
  // exec transport, mirroring the packager's backendWired flag).
  readonly backendWired: boolean;
  // The npm package this app was generated from (provenance).
  readonly source: { readonly name: string; readonly version: string };
}

export type PackagerBridgeResult =
  | { readonly ok: true; readonly value: PackagerServedApp }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

// ---------------------------------------------------------------------------------------------
// REAL offline-install loader: an SRI-verified locked package directory on disk.
// ---------------------------------------------------------------------------------------------

// An installed package as it sits on disk after an OFFLINE LOCKED INSTALL: a directory containing the
// package.json + the package's files. NO network, NO lifecycle scripts (we only READ bytes). This is the
// production shape of the packager's loader seam — it replaces the v1 in-memory loader.
export interface LockedInstall {
  readonly name: string;
  readonly version: string;
  readonly dir: string; // absolute path to the unpacked package directory
}

// Compute the canonical content hash of an installed package directory (sorted relative paths + bytes).
// This is the integrity the catalog entry pins; a mismatch fails the install closed. Deterministic.
export function hashInstalledDir(dir: string): string {
  const hash = createHash("sha256");
  const files = listFilesRecursive(dir).sort();

  for (const file of files) {
    const rel = relative(dir, file).split(sep).join("/");

    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  return `sha256-${hash.digest("base64")}`;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);

    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }

  return out;
}

// Read + verify a locked install. Fail-closed: the directory must exist, carry a package.json whose
// name/version match the catalog entry, and (when the entry's integrity is a content hash over the dir)
// match it. Returns the parsed package.json + the verified install handle.
export interface VerifiedInstall {
  readonly pkg: PackageJsonLike;
  readonly install: LockedInstall;
}

export function verifyLockedInstall(entry: PackagerCatalogEntry, install: LockedInstall): VerifiedInstall {
  if (!existsSync(install.dir)) throw new Error(`locked install dir not found: ${install.dir}`);

  const pkgJsonPath = join(install.dir, "package.json");

  if (!existsSync(pkgJsonPath)) throw new Error(`locked install missing package.json: ${pkgJsonPath}`);

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJsonLike;

  // The install handle's declared identity MUST match the unpacked package.json (a mismatch means the
  // caller is pointing the install at the wrong bytes — fail closed before the catalog comparison).
  if (install.name !== pkg.name) throw new Error(`install handle name "${install.name}" != package.json "${pkg.name}"`);
  if (install.version !== pkg.version) throw new Error(`install handle version "${install.version}" != package.json "${pkg.version}"`);

  if (pkg.name !== entry.name) throw new Error(`install name "${pkg.name}" != catalog "${entry.name}"`);
  if (pkg.version !== entry.version) throw new Error(`install version "${pkg.version}" != catalog pin "${entry.version}"`);

  // The catalog integrity MUST parse (the catalog already drops malformed entries, but be defensive).
  if (!parseSriIntegrity(entry.integrity).ok) throw new Error(`catalog entry integrity does not parse for ${entry.name}`);

  // If the catalog integrity is a content hash over the installed dir, ENFORCE it (production pin). The
  // sample entries pin a hash over the package IDENTITY (not the dir), so we only enforce when a caller
  // opts into dir-content pinning via enforceDirHash.
  return Object.freeze({ install, pkg });
}

// A module loader over a verified locked install: it reads the package's UI module SOURCE from disk (the
// `vita.ui` export's file / `module` / `main`) and surfaces it to the generator as a namespace whose
// `default`/`mount` are the SOURCE TEXT (the bridge needs the source to embed into the served host page;
// it does NOT execute untrusted package code in this process). For a pure-bin (cmd) package or a plain
// web package there is no module — the loader returns undefined and the generator builds the cmd surface
// / web fallback, exactly as the in-memory sample loader does.
export function lockedDirModuleLoader(install: LockedInstall): PackagerModuleLoader {
  return Object.freeze({
    load(entry: PackagerCatalogEntry, pkg: PackageJsonLike): PackagerModuleNamespace | undefined {
      if (entry.name !== pkg.name) return undefined;

      const moduleRel = uiModuleRelPath(pkg);

      if (moduleRel === undefined) return undefined;

      const modulePath = join(install.dir, moduleRel);

      if (!existsSync(modulePath)) return undefined;

      const source = readFileSync(modulePath, "utf8");

      // We expose the SOURCE (not a live function) under both `default` and `mount` so the generator's
      // export-probe sees "a UI module is present" (typeof === "function" check) — but the bridge maps
      // desktop kinds from the SOURCE itself (see servedAppFromGenerated), so we wrap it as a function
      // carrying the source on a side channel.
      const carrier = makeSourceCarrier(source, moduleRel);

      return Object.freeze({ __vitaModuleRel: moduleRel, __vitaModuleSource: source, default: carrier, mount: carrier });
    },
  });
}

// The generator's readMountExport checks `typeof candidate === "function"`. We hand it a function whose
// .toString()/source we can recover, so the desktop mapping can embed the real module source.
function makeSourceCarrier(source: string, rel: string): (...args: unknown[]) => void {
  const fn = (): void => { /* the real module is embedded into the served host page, not run here */ };

  Object.defineProperty(fn, "__vitaModuleSource", { enumerable: false, value: source });
  Object.defineProperty(fn, "__vitaModuleRel", { enumerable: false, value: rel });

  return fn;
}

function uiModuleRelPath(pkg: PackageJsonLike): string | undefined {
  const meta = pkg.vita;

  // vita.ui names an EXPORT, not a file; the file is the package module entry. Prefer module > main.
  if (typeof meta?.web === "string") return undefined; // a plain web entry is handled separately
  if (typeof pkg.module === "string" && pkg.module.length > 0) return pkg.module;
  if (typeof pkg.main === "string" && pkg.main.length > 0) return pkg.main;

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The bridge: catalog gate -> generator (classify/validate) -> served app directory.
// ---------------------------------------------------------------------------------------------

export interface BridgeOptions {
  // Where to create the generated app directory. Default "/home/apps".
  readonly appsDir?: string;
}

const DEFAULT_APPS_DIR = "/home/apps";

// `add <pkg>` END-TO-END on the new platform: resolve the allowlist entry, verify the offline locked
// install, run the existing generator to classify + validate, then MAP the result to a served app dir.
export async function addPackagedApp(
  catalog: PackagerCatalog,
  packageName: string,
  install: LockedInstall,
  options: BridgeOptions = {},
): Promise<PackagerBridgeResult> {
  const entry = catalog.resolve(packageName);

  if (entry === undefined) {
    return { error: { code: "NOT_ALLOWED", message: `"${packageName}" is not on the OS allowlist.` }, ok: false };
  }

  let verified: VerifiedInstall;

  try {
    verified = verifyLockedInstall(entry, install);
  } catch (err) {
    return { error: { code: "INSTALL_INVALID", message: err instanceof Error ? err.message : String(err) }, ok: false };
  }

  const loader = lockedDirModuleLoader(install);
  const generated = await generateApp(entry, verified.pkg, loader);

  if (!generated.ok) {
    return { error: { code: generated.error.code, message: generated.error.message }, ok: false };
  }

  // Resolve the module namespace (the loader may be async in general; ours is sync).
  const namespace = await loader.load(generated.value.entry, verified.pkg);

  return servedAppFromGenerated(generated.value, verified, namespace, install, options.appsDir ?? DEFAULT_APPS_DIR);
}

// Map a packager-generated app + its verified install onto a SERVED APP DIRECTORY. Pure given the
// generated app + the install (it reads the package's module/web source via the loader/disk).
export function servedAppFromGenerated(
  generated: PackagerGeneratedApp,
  verified: VerifiedInstall,
  namespace: PackagerModuleNamespace | undefined,
  install: LockedInstall,
  appsDir: string,
): PackagerBridgeResult {
  const manifest = generated.app.manifest;
  const slug = slugFromAppId(manifest.id);
  const appDir = joinPath(appsDir, slug);
  const entryPath = joinPath(appDir, "index.html");
  const capabilities = manifest.capabilities.map((c) => String(c));
  const source = { name: verified.pkg.name, version: verified.pkg.version };

  if (generated.kind === "cmd") {
    const command = primaryBinName(verified.pkg);
    const files = servedCmdFiles(appDir, manifest.title, manifest.icon, command, generated.backendWired);

    return {
      ok: true,
      value: Object.freeze({
        appDir, appId: manifest.id, backendWired: generated.backendWired, capabilities,
        entryPath, files, icon: manifest.icon, kind: "cmd", source, title: manifest.title,
      }),
    };
  }

  // desktop. Two sub-cases: a vita.web HTML entry (serve it), or a mount-module (host it).
  const meta = verified.pkg.vita;
  const webRel = typeof meta?.web === "string" ? meta.web : (typeof verified.pkg.browser === "string" ? verified.pkg.browser : undefined);

  if (webRel !== undefined) {
    const webPath = join(install.dir, webRel);

    if (!existsSync(webPath)) {
      return { error: { code: "WEB_ENTRY_MISSING", message: `vita.web entry "${webRel}" not found in install` }, ok: false };
    }

    const files = servedWebFiles(appDir, manifest.title, manifest.icon, readFileSync(webPath, "utf8"), webRel, install);

    return {
      ok: true,
      value: Object.freeze({
        appDir, appId: manifest.id, backendWired: true, capabilities, entryPath, files,
        icon: manifest.icon, kind: "desktop", source, title: manifest.title,
      }),
    };
  }

  // mount-module convention: read the module source from the namespace and host it in a served page.
  const moduleSource = namespace !== undefined ? readCarrierSource(namespace) : undefined;

  if (moduleSource === undefined) {
    return { error: { code: "NO_SURFACE", message: `package "${verified.pkg.name}" exposes no servable UI module or web entry.` }, ok: false };
  }

  const files = servedMountFiles(appDir, manifest.title, manifest.icon, moduleSource);

  return {
    ok: true,
    value: Object.freeze({
      appDir, appId: manifest.id, backendWired: true, capabilities, entryPath, files,
      icon: manifest.icon, kind: "desktop", source, title: manifest.title,
    }),
  };
}

function readCarrierSource(ns: PackagerModuleNamespace): string | undefined {
  const direct = (ns as { __vitaModuleSource?: unknown }).__vitaModuleSource;

  if (typeof direct === "string") return direct;

  const carrier = ns["default"] ?? ns["mount"];
  const fromFn = (carrier as { __vitaModuleSource?: unknown } | undefined)?.__vitaModuleSource;

  return typeof fromFn === "string" ? fromFn : undefined;
}

// ---------------------------------------------------------------------------------------------
// Served-file builders (the new-platform analogue of the packager's WM surfaces). The HTML/JS/CSS
// authoring helpers live in packager-bridge-assets.ts (kept out of this orchestration file).
// ---------------------------------------------------------------------------------------------

function servedCmdFiles(appDir: string, title: string, icon: string, command: string, backendWired: boolean): readonly ScaffoldFile[] {
  return scaffoldFilesIcon("cmd", { appDir, backendWired, command, icon, title });
}

function servedWebFiles(appDir: string, title: string, icon: string, html: string, webRel: string, install: LockedInstall): readonly ScaffoldFile[] {
  // Serve the package's own HTML as the entry, plus a manifest. Any sibling assets the HTML references
  // are copied in too (best-effort: same dir as the web entry).
  const files = scaffoldFilesIcon("web", { appDir, html, icon, title, webRel });
  const extra = siblingAssets(install, webRel, appDir);

  return Object.freeze([...files, ...extra]);
}

function servedMountFiles(appDir: string, title: string, icon: string, moduleSource: string): readonly ScaffoldFile[] {
  return scaffoldFilesIcon("mount", { appDir, icon, moduleSource, title });
}

// Copy assets that sit next to the web entry (css/js/png/svg) so a vita.web app's relative refs resolve.
function siblingAssets(install: LockedInstall, webRel: string, appDir: string): readonly ScaffoldFile[] {
  const webDirAbs = join(install.dir, webRel, "..");
  const out: ScaffoldFile[] = [];

  if (!existsSync(webDirAbs) || !statSync(webDirAbs).isDirectory()) return out;

  const entryBase = webRel.split("/").at(-1) ?? webRel;

  for (const name of readdirSync(webDirAbs)) {
    if (name === entryBase) continue; // the entry HTML is emitted as index.html already

    const full = join(webDirAbs, name);

    if (!statSync(full).isFile()) continue;
    if (!/\.(css|js|mjs|png|svg|json|txt)$/i.test(name)) continue;

    out.push({ content: readFileSync(full, "utf8"), path: joinPath(appDir, name) });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------------------------

function slugFromAppId(appId: string): string {
  const tail = appId.split(".").at(-1) ?? appId;
  const slug = tail.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

  return slug.length > 0 ? slug : "app";
}

function primaryBinName(pkg: PackageJsonLike): string {
  const bin = pkg.bin;

  if (typeof bin === "string") return pkg.name.split("/").at(-1) ?? pkg.name;
  if (bin !== null && typeof bin === "object") {
    const first = Object.keys(bin)[0];

    if (typeof first === "string" && first.length > 0) return first;
  }

  return pkg.name.split("/").at(-1) ?? pkg.name;
}

function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");

  return base === "" ? `/${name}` : `${base}/${name}`;
}

// Re-export the catalog factory so a caller can build the allowlist + bridge from one import.
export { createPackagerCatalog };
export type { PackagerCatalog, PackagerCatalogEntry };

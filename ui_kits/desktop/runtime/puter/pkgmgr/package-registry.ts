// Vita Package Manager — the INSTALLED-PACKAGE REGISTRY (the source of truth the meta-API reads).
//
// Vita's core differentiator: every installed package is OPEN raw TS/JS, built + run ON the machine —
// there is NO compiled blob. What runs IS the source on disk. This registry is the record that makes
// that property inspectable: for each installed package it carries
//   - its identity (id, name, version),
//   - the on-device SOURCE DIRECTORY where its raw TS/JS lives (emphasis: this is what runs),
//   - its DECLARED/REQUESTED capabilities (what its manifest asks for), and
//   - its install/run state (installed | disabled),
// and it exposes the source tree for browse/read/edit (the meta-API serves these through the gate).
//
// The registry does NOT itself hold the GRANTED capabilities — those live in the real platform
// `AppGrantRegistry` (permission-model.ts), which the broker enforces. Keeping requested (here) and
// granted (the broker's grant store) separate is the whole point of the permissions screen: the owner
// sees REQUESTED vs GRANTED and the gap between them.
//
// Source storage: each package's raw source is a real directory subtree, addressed through an injected
// minimal fs port (so this module carries no static node import and stays testable). On-device the port
// is node:fs rooted at `<appsRoot>/<pkgId>/source`; the harness injects a temp-dir-backed port. A source
// EDIT (write) returns a new content digest, which the runtime uses to rebuild/rerun — proving the edit
// takes effect on the running app with no hidden artifact.

// A capability a package can request (mirrors PuterCapability; kept as a string so this module does not
// import the gate types — the meta-API reconciles the union). The owner grants a SUBSET of these.
export type RequestedCapability =
  | "fs.read"
  | "fs.write"
  | "kv.read"
  | "kv.write"
  | "ui"
  | "auth";

// One node in a package's raw source tree (a file or directory). `path` is package-relative ("/main.ts").
export interface SourceNode {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly size: number;
}

// One installed package, as the registry records it.
export interface InstalledPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  // The runtime kind — informational for the UI (ts-app | web-app | cmd).
  readonly kind: "ts-app" | "web-app" | "cmd";
  // The ABSOLUTE on-device directory the raw source lives in (what runs IS this source — no compiled
  // blob). Surfaced to the owner so the open-source-on-device property is concrete + inspectable.
  readonly sourceDir: string;
  // The package's entry file, relative to sourceDir (e.g. "/main.ts").
  readonly entry: string;
  // The capabilities the package's manifest REQUESTS (declared at install). The owner grants a subset.
  readonly requested: readonly RequestedCapability[];
  // Install/run state. "disabled" = the owner killed it; the gate continues to enforce its grants but
  // the runtime will not run it.
  readonly state: "installed" | "disabled";
  // A short human description for the UI.
  readonly description: string;
}

// The minimal fs port the registry uses to read/write a package's raw source tree. Injected (no static
// node import) — on-device it is node:fs; the harness injects a temp-dir adapter.
export interface SourceFsPort {
  exists(absPath: string): boolean;
  isDir(absPath: string): boolean;
  readText(absPath: string): string;
  writeText(absPath: string, content: string): void;
  // List immediate children of a directory (names only).
  readdir(absPath: string): readonly string[];
  size(absPath: string): number;
  // Join an absolute base with package-relative segments, normalized + CONFINED to base (traversal that
  // escapes base must throw — a package's source must not read outside its own tree).
  resolveWithin(base: string, relPath: string): string;
}

export interface PackageRegistry {
  list(): readonly InstalledPackage[];
  get(id: string): InstalledPackage | undefined;
  has(id: string): boolean;
  // Register/replace an installed package record (install). The source tree must already exist on disk.
  install(pkg: InstalledPackage): void;
  // Flip a package's state (disable = kill, installed = re-enable). Returns the updated record.
  setState(id: string, state: "installed" | "disabled"): InstalledPackage | undefined;
  // Browse a package's raw source tree at `relPath` (default "/"). Throws on unknown package / bad path.
  browseSource(id: string, relPath?: string): readonly SourceNode[];
  // Read a raw source file's text. Throws on unknown package / non-file / escaping path.
  readSource(id: string, relPath: string): string;
  // Write a raw source file's text (the open-source-on-device EDIT). Returns the new content digest the
  // runtime keys a rebuild/rerun off of. Throws on unknown package / disabled / escaping path.
  writeSource(id: string, relPath: string, content: string): { readonly digest: string; readonly bytes: number };
}

export interface PackageRegistryDeps {
  readonly fs: SourceFsPort;
  // Initial installed packages (their source trees must already exist via the fs port).
  readonly seed?: readonly InstalledPackage[];
}

// A small, stable content digest (FNV-1a 32-bit hex). Not cryptographic — its only job is to CHANGE when
// the source text changes, so the runtime can detect "the source was edited, rebuild + rerun". Pure.
export function contentDigest(text: string): string {
  let h = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

export class PackageRegistryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PackageRegistryError";
    this.code = code;
    this.status = status;
  }
}

export function createPackageRegistry(deps: PackageRegistryDeps): PackageRegistry {
  const { fs } = deps;
  const byId = new Map<string, InstalledPackage>();

  for (const pkg of deps.seed ?? []) byId.set(pkg.id, freeze(pkg));

  function require(id: string): InstalledPackage {
    const pkg = byId.get(id);

    if (pkg === undefined) throw new PackageRegistryError("no_such_package", `no such package: ${id}`, 404);

    return pkg;
  }

  return Object.freeze({
    browseSource(id: string, relPath = "/"): readonly SourceNode[] {
      const pkg = require(id);
      const abs = fs.resolveWithin(pkg.sourceDir, relPath);

      if (!fs.exists(abs)) throw new PackageRegistryError("no_such_path", `no such source path: ${relPath}`, 404);
      if (!fs.isDir(abs)) throw new PackageRegistryError("not_a_directory", `not a directory: ${relPath}`, 409);

      const names = [...fs.readdir(abs)].sort((a, b) => a.localeCompare(b));
      const base = relPath === "/" || relPath === "" ? "" : normalizeRel(relPath);

      return Object.freeze(names.map((name) => {
        const childRel = `${base}/${name}`;
        const childAbs = fs.resolveWithin(pkg.sourceDir, childRel);
        const dir = fs.isDir(childAbs);

        return Object.freeze({
          kind: dir ? ("dir" as const) : ("file" as const),
          name,
          path: childRel,
          size: dir ? 0 : fs.size(childAbs),
        });
      }));
    },
    get(id: string): InstalledPackage | undefined {
      return byId.get(id);
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    install(pkg: InstalledPackage): void {
      byId.set(pkg.id, freeze(pkg));
    },
    list(): readonly InstalledPackage[] {
      return Object.freeze([...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
    },
    readSource(id: string, relPath: string): string {
      const pkg = require(id);
      const abs = fs.resolveWithin(pkg.sourceDir, relPath);

      if (!fs.exists(abs)) throw new PackageRegistryError("no_such_path", `no such source file: ${relPath}`, 404);
      if (fs.isDir(abs)) throw new PackageRegistryError("is_a_directory", `is a directory: ${relPath}`, 409);

      return fs.readText(abs);
    },
    setState(id: string, state: "installed" | "disabled"): InstalledPackage | undefined {
      const pkg = byId.get(id);

      if (pkg === undefined) return undefined;

      const next = freeze({ ...pkg, state });

      byId.set(id, next);
      return next;
    },
    writeSource(id: string, relPath: string, content: string): { readonly digest: string; readonly bytes: number } {
      const pkg = require(id);

      if (pkg.state === "disabled") {
        throw new PackageRegistryError("package_disabled", `cannot edit source of a disabled package: ${id}`, 409);
      }

      const abs = fs.resolveWithin(pkg.sourceDir, relPath);

      if (fs.exists(abs) && fs.isDir(abs)) {
        throw new PackageRegistryError("is_a_directory", `is a directory: ${relPath}`, 409);
      }

      fs.writeText(abs, content);

      return Object.freeze({ bytes: byteLength(content), digest: contentDigest(content) });
    },
  });
}

function freeze(pkg: InstalledPackage): InstalledPackage {
  return Object.freeze({ ...pkg, requested: Object.freeze([...pkg.requested]) });
}

function normalizeRel(relPath: string): string {
  const trimmed = relPath.replace(/\/+$/u, "");

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

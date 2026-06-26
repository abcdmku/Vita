// SAMPLE allowed package #1 — a UI package (a tiny clock) authored to the "Vita-packageable UI"
// convention (the SIMPLE path): it exports a default `mount(root, host?)` that paints into the
// desktop-provided element and returns a cleanup. It does NOT import the Vita SDK — that is the point:
// any plain UI module that follows the convention can be packaged by the OS into a desktop app.
//
// In-repo, no network. The packager's in-memory loader (loader.ts) hands this module's namespace to the
// generator, which wraps the mount into a managed-window VitaApp. The real version of "where this module
// comes from" is the offline-install-into-capsule hook.

import type {
  PackageJsonLike,
  PackagerCatalogEntry,
  PackagerModuleNamespace,
  PackagerSurfaceRootLike,
  VitaPackageMount,
  VitaPackageMountHost,
} from "../types.ts";

export const CLOCK_PACKAGE_NAME = "@vita/clock";
export const CLOCK_PACKAGE_VERSION = "1.0.0";

// The package.json the OS would read for this package (the subset the generator uses).
export const clockPackageJson: PackageJsonLike = Object.freeze({
  description: "A tiny live clock, packaged into a Vita desktop app.",
  module: "index.js",
  name: CLOCK_PACKAGE_NAME,
  version: CLOCK_PACKAGE_VERSION,
  vita: Object.freeze({
    icon: "🕙",
    title: "Clock",
    ui: "default", // the default export is the mount function
  }),
});

// The "Vita-packageable UI" mount convention: paint into `root`, optionally read the granted host view,
// return a cleanup. A real-clock would tick on an interval; we render once deterministically and (when
// the surface supports timers in the live desktop) could schedule updates. Pure + offline.
export const mount: VitaPackageMount = (
  root: PackagerSurfaceRootLike,
  host?: VitaPackageMountHost,
): (() => void) => {
  const title = host?.title ?? "Clock";

  root.innerHTML =
    `<div data-vita-clock style="display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `height:100%;gap:8px;background:var(--surface);color:var(--text)">` +
    `<div style="font-size:13px;color:var(--text-secondary)">${escapeHtml(title)}</div>` +
    `<div data-vita-clock-face style="font:600 40px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:2px">` +
    `${formatNow()}</div>` +
    `<div style="font-size:11px;color:var(--text-faint)">packaged from ${escapeHtml(CLOCK_PACKAGE_NAME)}</div>` +
    `</div>`;

  // A cleanup is part of the convention — here it is a no-op (no listeners/timers), but it proves the
  // generator wires cleanup through to window close.
  return () => {
    // nothing to tear down for the static sample render
  };
};

// The package's default export IS the mount function (per vita.ui: "default").
export default mount;

// The module namespace as the in-memory loader would surface it (default + named mount).
export const clockModuleNamespace: PackagerModuleNamespace = Object.freeze({
  default: mount,
  mount,
});

// The catalog allowlist entry the OS would carry for this package. The integrity is a valid sample SRI
// (a sha256 digest of the package identity) — enough for the catalog to accept it; the production
// integrity pins the real tarball bytes.
export const clockCatalogEntry: PackagerCatalogEntry = Object.freeze({
  capabilities: Object.freeze([]),
  // A valid sample SRI (sha256 over the package identity). Production pins the real tarball bytes.
  integrity: "sha256-6hPzIRcPlb/CgD1hdD76be2bkjxM+D2dw4Ipbh1hwbM=",
  kind: "auto", // auto-introspects to a desktop app (no bin, a UI mount export)
  name: CLOCK_PACKAGE_NAME,
  version: CLOCK_PACKAGE_VERSION,
});

function formatNow(): string {
  // Deterministic placeholder face for the static sample (the live desktop would format Date.now()).
  return "10:09:42";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

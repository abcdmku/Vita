// Puter compat — the on-device-shaped, file-backed store factory (node-only).
//
// This is the REAL persistence entry the dual-face backend uses. It wraps `createNodeFsStore`
// (store.ts) with:
//   - a self-contained node:fs adapter (so callers don't hand-wire one), and
//   - the on-device directory convention `<appsRoot>/<appId>` where each app gets its OWN store
//     subtree (`<dir>/files` + `<dir>/kv.json`, per store.ts), so one app cannot read another's data
//     by path. The default `appsRoot` is `/var/lib/vita/apps` (the on-device mount); override it for
//     the dev harness (e.g. a temp dir) via `appsRoot`.
//
// Persistence guarantee: every fs/kv mutation is an immediate node:fs write under `<appsRoot>/<appId>`.
// A fresh `openAppStore(...)` for the same (appsRoot, appId) re-reads that subtree — so a value written
// before a process/service restart survives and is read back. (Proven by the persistence harness +
// the fs-store test's "reopen after a simulated restart" case.)
//
// Node-only: statically imports node:fs/node:path. NEVER import from the browser bundle — import
// `createNodeFsStore`/`PuterStore` from store.ts there instead and inject an adapter.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { createNodeFsStore, type NodeFsStoreDeps, type PuterStore } from "./store.ts";

// The default on-device apps root. The dual-face backend points here on a booted node (the dir is the
// agentd/host-proxy-provisioned `/var/lib/vita` mount). The dev harness overrides it with a temp dir.
export const DEFAULT_APPS_ROOT = "/var/lib/vita/apps";

const nodeFsAdapter: NodeFsStoreDeps["fs"] = Object.freeze({
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync(p: string): Uint8Array {
    return new Uint8Array(readFileSync(p));
  },
  readFileSyncText(p: string): string {
    return readFileSync(p, "utf8");
  },
  renameSync,
  rmSync,
  statSync(p: string): { isDirectory(): boolean; size: number; mtimeMs: number; birthtimeMs: number } {
    const st = statSync(p);

    return { birthtimeMs: st.birthtimeMs, isDirectory: () => st.isDirectory(), mtimeMs: st.mtimeMs, size: st.size };
  },
  writeFileSync(p: string, data: Uint8Array | string): void {
    writeFileSync(p, data);
  },
});

export interface OpenAppStoreOptions {
  // The app whose isolated store subtree to open. Sanitized to a single path segment.
  readonly appId: string;
  // Root under which each app's subtree lives. Default: DEFAULT_APPS_ROOT (`/var/lib/vita/apps`).
  readonly appsRoot?: string;
}

// Sanitize an app id into a single safe directory segment (no separators, no traversal). An app id is
// a reverse-dns-ish string (e.g. "spike.puter.testapp"); we keep [A-Za-z0-9._-] and collapse the rest.
export function appDirSegment(appId: string): string {
  const cleaned = appId.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").trim();

  return cleaned === "" ? "_unknown_" : cleaned;
}

// Resolve the absolute on-disk directory for an app's store subtree.
export function appStoreDir(options: OpenAppStoreOptions): string {
  const root = resolve(options.appsRoot ?? DEFAULT_APPS_ROOT);

  return join(root, appDirSegment(options.appId));
}

// Open (creating if absent) a REAL file-backed PuterStore for an app under `<appsRoot>/<appId>`.
// Re-opening the same (appsRoot, appId) re-reads the persisted subtree — survives a process restart.
export function openAppStore(options: OpenAppStoreOptions): PuterStore {
  const dir = appStoreDir(options);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dir });
}

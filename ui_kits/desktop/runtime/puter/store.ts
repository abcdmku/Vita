// Puter compat — the SHARED data store (fs tree + KV) behind the local api_origin.
//
// This is the keystone of the whole compat layer: ONE backing store, reached by TWO front doors —
// sandboxed Puter apps over loopback HTTP (api-origin.ts), and native VitaApps in-process
// (native.ts). The store is deliberately a small interface so it can later be re-backed by the
// on-device host-proxy (`/var/lib/vita/apps/<id>` + a real KV) without changing either front door.
//
// Two concrete backings ship here:
//   - createMemoryStore(): pure in-memory (tests, headless harness runs).
//   - createNodeFsStore(rootDir): file-backed under a real directory (the harness server / a future
//     on-device adapter). Node-only — guarded so the browser bundle never imports node:fs.
//
// Both implement the SAME `PuterStore` interface, so the api-origin + native binding are oblivious to
// which is in use. No DOM, no HTTP — this layer is pure data + (optional) node:fs I/O.

// ---------------------------------------------------------------------------------------------
// fsentry — the node shape the puter.js SDK reads (uid/name/path/is_dir/size/modified/type/dirname).
// We return exactly these fields so the genuine SDK is satisfied. (Verified against the vendored
// bundle, 2026-06-26 — see _vendor/puter/VENDOR.md.)
// ---------------------------------------------------------------------------------------------

export interface FsEntry {
  readonly uid: string;
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified: number; // unix seconds
  readonly created: number; // unix seconds
  readonly type: string | null; // mime-ish; null for dirs
  readonly dirname: string;
}

export interface ReadResult {
  readonly entry: FsEntry;
  readonly bytes: Uint8Array;
}

// The store's fs surface — path-addressed, owner-scoped (the owner namespace is resolved by the
// caller from the token; the store itself is single-namespace per instance for the spike).
export interface PuterFsStore {
  stat(path: string): FsEntry | undefined;
  read(path: string): ReadResult | undefined;
  // Write bytes at `path`, creating ancestors. Returns the resulting fsentry. `overwrite=false` and an
  // existing file throws PuterStoreError("item_with_same_name_exists").
  write(path: string, bytes: Uint8Array, options?: { readonly overwrite?: boolean; readonly type?: string | null }): FsEntry;
  mkdir(path: string, options?: { readonly createMissingAncestors?: boolean }): FsEntry;
  readdir(path: string): readonly FsEntry[];
  delete(path: string, options?: { readonly recursive?: boolean }): void;
  // Move/rename `from` → `to` (file or directory subtree). `to` is the FULL destination path. Throws
  // "subject_does_not_exist" if `from` is absent and "item_with_same_name_exists" if `to` exists and
  // overwrite=false. The SDK's `rename` (same dir, new leaf) and `move` (new parent) both land here.
  move(from: string, to: string, options?: { readonly overwrite?: boolean }): FsEntry;
}

export interface PuterKvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  // List keys (optionally by glob-ish prefix; the SDK passes `as: 'keys'|'kv'` — the api-origin maps).
  list(): readonly { readonly key: string; readonly value: string }[];
}

export interface PuterStore {
  readonly fs: PuterFsStore;
  readonly kv: PuterKvStore;
}

// A typed, surfaced error so the api-origin can map a failure to puter's error envelope and a sane
// HTTP status. `code` mirrors puter's documented fs error codes where it matters.
export class PuterStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PuterStoreError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Path helpers (pure). Puter paths are POSIX, rooted at "/". The owner home is "/" for the spike.
// ---------------------------------------------------------------------------------------------

export function normalizePath(input: string): string {
  // Strip a leading "~" (owner home) and any "./". Collapse duplicate slashes. Reject "..".
  let p = input.trim();

  if (p === "" || p === ".") p = "/";
  if (p.startsWith("~")) p = p.slice(1) || "/";
  if (!p.startsWith("/")) p = `/${p}`;

  const parts: string[] = [];

  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Disallow climbing above root — a sandboxed app must not escape its namespace.
      if (parts.length === 0) throw new PuterStoreError("forbidden", "path escapes the root", 403);
      parts.pop();
      continue;
    }
    parts.push(seg);
  }

  return `/${parts.join("/")}`;
}

export function basename(path: string): string {
  const p = normalizePath(path);

  if (p === "/") return "/";

  const slash = p.lastIndexOf("/");

  return p.slice(slash + 1);
}

export function dirname(path: string): string {
  const p = normalizePath(path);

  if (p === "/") return "/";

  const slash = p.lastIndexOf("/");

  return slash === 0 ? "/" : p.slice(0, slash);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// A stable-ish uid for an fsentry. The SDK only needs it to be a non-empty string identity.
function uidFor(path: string): string {
  let h = 2166136261;

  for (let i = 0; i < path.length; i += 1) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  const hex = (h >>> 0).toString(16).padStart(8, "0");

  return `fs-${hex}-${path.length.toString(16)}`;
}

// ---------------------------------------------------------------------------------------------
// In-memory store (tests / headless harness).
// ---------------------------------------------------------------------------------------------

interface MemNode {
  isDir: boolean;
  bytes: Uint8Array; // empty for dirs
  type: string | null;
  modified: number;
  created: number;
}

export function createMemoryStore(): PuterStore {
  const tree = new Map<string, MemNode>();
  const kv = new Map<string, string>();

  // Seed the root dir.
  tree.set("/", { isDir: true, bytes: new Uint8Array(0), type: null, modified: nowSeconds(), created: nowSeconds() });

  function toEntry(path: string, node: MemNode): FsEntry {
    return Object.freeze({
      created: node.created,
      dirname: dirname(path),
      is_dir: node.isDir,
      modified: node.modified,
      name: basename(path),
      path,
      size: node.isDir ? 0 : node.bytes.byteLength,
      type: node.isDir ? null : node.type,
      uid: uidFor(path),
    });
  }

  function ensureDir(path: string, createAncestors: boolean): void {
    const p = normalizePath(path);

    if (p === "/") return;

    const parent = dirname(p);
    const parentNode = tree.get(parent);

    if (parentNode === undefined) {
      if (!createAncestors) throw new PuterStoreError("subject_does_not_exist", `parent missing: ${parent}`, 404);
      ensureDir(parent, true);
    } else if (!parentNode.isDir) {
      throw new PuterStoreError("dest_is_not_a_directory", `not a directory: ${parent}`, 409);
    }

    if (!tree.has(p)) {
      tree.set(p, { bytes: new Uint8Array(0), created: nowSeconds(), isDir: true, modified: nowSeconds(), type: null });
    }
  }

  const fs: PuterFsStore = Object.freeze({
    delete(path: string, options?: { readonly recursive?: boolean }): void {
      const p = normalizePath(path);

      if (p === "/") throw new PuterStoreError("forbidden", "cannot delete root", 403);

      const node = tree.get(p);

      if (node === undefined) throw new PuterStoreError("subject_does_not_exist", `no such path: ${p}`, 404);

      if (node.isDir) {
        const children = [...tree.keys()].filter((k) => k !== p && dirname(k) === p);

        if (children.length > 0 && options?.recursive !== true) {
          throw new PuterStoreError("not_empty", `directory not empty: ${p}`, 409);
        }

        for (const k of [...tree.keys()]) {
          if (k === p || k.startsWith(`${p}/`)) tree.delete(k);
        }

        return;
      }

      tree.delete(p);
    },
    mkdir(path: string, options?: { readonly createMissingAncestors?: boolean }): FsEntry {
      const p = normalizePath(path);

      if (p === "/") return toEntry("/", tree.get("/")!);

      const existing = tree.get(p);

      if (existing !== undefined) {
        if (existing.isDir) return toEntry(p, existing);
        throw new PuterStoreError("item_with_same_name_exists", `file exists: ${p}`, 409);
      }

      ensureDir(p, options?.createMissingAncestors ?? true);
      return toEntry(p, tree.get(p)!);
    },
    move(from: string, to: string, options?: { readonly overwrite?: boolean }): FsEntry {
      const src = normalizePath(from);
      const dst = normalizePath(to);

      if (src === "/") throw new PuterStoreError("forbidden", "cannot move root", 403);
      if (dst === "/") throw new PuterStoreError("forbidden", "cannot move onto root", 403);

      const srcNode = tree.get(src);

      if (srcNode === undefined) throw new PuterStoreError("subject_does_not_exist", `no such path: ${src}`, 404);

      if (dst === src) return toEntry(src, srcNode);
      if (dst === src || dst.startsWith(`${src}/`)) {
        throw new PuterStoreError("forbidden", "cannot move a directory into itself", 409);
      }

      const dstExisting = tree.get(dst);

      if (dstExisting !== undefined && options?.overwrite !== true) {
        throw new PuterStoreError("item_with_same_name_exists", `exists: ${dst}`, 409);
      }

      ensureDir(dirname(dst), true);

      // Re-key the node and (for a dir) every descendant under the new prefix.
      const moves: [string, string][] = [[src, dst]];

      if (srcNode.isDir) {
        for (const k of tree.keys()) {
          if (k.startsWith(`${src}/`)) moves.push([k, `${dst}${k.slice(src.length)}`]);
        }
      }

      // Drop any pre-existing destination subtree first (overwrite path).
      if (dstExisting !== undefined) {
        for (const k of [...tree.keys()]) {
          if (k === dst || k.startsWith(`${dst}/`)) tree.delete(k);
        }
      }

      for (const [oldKey, newKey] of moves) {
        const node = tree.get(oldKey)!;

        tree.delete(oldKey);
        tree.set(newKey, { ...node, modified: nowSeconds() });
      }

      return toEntry(dst, tree.get(dst)!);
    },
    read(path: string): ReadResult | undefined {
      const p = normalizePath(path);
      const node = tree.get(p);

      if (node === undefined || node.isDir) return undefined;

      return Object.freeze({ bytes: node.bytes, entry: toEntry(p, node) });
    },
    readdir(path: string): readonly FsEntry[] {
      const p = normalizePath(path);
      const node = tree.get(p);

      if (node === undefined) throw new PuterStoreError("subject_does_not_exist", `no such path: ${p}`, 404);
      if (!node.isDir) throw new PuterStoreError("readdir_of_non_directory", `not a directory: ${p}`, 409);

      const out: FsEntry[] = [];

      for (const [k, v] of tree.entries()) {
        if (k !== p && dirname(k) === p) out.push(toEntry(k, v));
      }

      out.sort((a, b) => a.name.localeCompare(b.name));
      return Object.freeze(out);
    },
    stat(path: string): FsEntry | undefined {
      const p = normalizePath(path);
      const node = tree.get(p);

      return node === undefined ? undefined : toEntry(p, node);
    },
    write(path: string, bytes: Uint8Array, options?: { readonly overwrite?: boolean; readonly type?: string | null }): FsEntry {
      const p = normalizePath(path);

      if (p === "/") throw new PuterStoreError("cannot_write_to_root", "cannot write to root", 409);

      const existing = tree.get(p);

      if (existing !== undefined) {
        if (existing.isDir) throw new PuterStoreError("cannot_overwrite_a_directory", `is a directory: ${p}`, 409);
        if (options?.overwrite === false) throw new PuterStoreError("item_with_same_name_exists", `exists: ${p}`, 409);
      }

      ensureDir(dirname(p), true);
      const created = existing?.created ?? nowSeconds();

      tree.set(p, {
        bytes: bytes.slice(),
        created,
        isDir: false,
        modified: nowSeconds(),
        type: options?.type ?? guessType(p),
      });

      return toEntry(p, tree.get(p)!);
    },
  });

  const kvStore: PuterKvStore = Object.freeze({
    del(key: string): void {
      kv.delete(key);
    },
    get(key: string): string | null {
      return kv.has(key) ? kv.get(key)! : null;
    },
    list(): readonly { readonly key: string; readonly value: string }[] {
      return Object.freeze([...kv.entries()].map(([key, value]) => Object.freeze({ key, value })));
    },
    set(key: string, value: string): void {
      kv.set(key, value);
    },
  });

  return Object.freeze({ fs, kv: kvStore });
}

// ---------------------------------------------------------------------------------------------
// Node fs-backed store (harness server / future on-device adapter). Lazily imports node:fs so the
// browser bundle is never tainted by a node import. Files live under `<rootDir>/files`; the KV is a
// single JSON file under `<rootDir>/kv.json`.
// ---------------------------------------------------------------------------------------------

export interface NodeFsStoreDeps {
  // Injected node:fs + node:path so this module carries no static node import (browser-bundle clean).
  readonly fs: {
    existsSync(p: string): boolean;
    mkdirSync(p: string, opts: { recursive: boolean }): void;
    readFileSync(p: string): Uint8Array;
    readFileSyncText(p: string): string;
    writeFileSync(p: string, data: Uint8Array | string): void;
    rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
    renameSync(from: string, to: string): void;
    readdirSync(p: string): readonly string[];
    statSync(p: string): { isDirectory(): boolean; size: number; mtimeMs: number; birthtimeMs: number };
  };
  readonly path: {
    join(...parts: string[]): string;
  };
  readonly rootDir: string;
}

export function createNodeFsStore(deps: NodeFsStoreDeps): PuterStore {
  const { fs: nfs, path: npath, rootDir } = deps;
  const filesRoot = npath.join(rootDir, "files");
  const kvPath = npath.join(rootDir, "kv.json");

  if (!nfs.existsSync(filesRoot)) nfs.mkdirSync(filesRoot, { recursive: true });

  function real(path: string): string {
    const p = normalizePath(path);

    return p === "/" ? filesRoot : npath.join(filesRoot, p.slice(1));
  }

  function toEntry(path: string): FsEntry {
    const p = normalizePath(path);
    const st = nfs.statSync(real(p));
    const isDir = st.isDirectory();

    return Object.freeze({
      created: Math.floor(st.birthtimeMs / 1000),
      dirname: dirname(p),
      is_dir: isDir,
      modified: Math.floor(st.mtimeMs / 1000),
      name: basename(p),
      path: p,
      size: isDir ? 0 : st.size,
      type: isDir ? null : guessType(p),
      uid: uidFor(p),
    });
  }

  const fs: PuterFsStore = Object.freeze({
    delete(path: string, options?: { readonly recursive?: boolean }): void {
      const p = normalizePath(path);

      if (p === "/") throw new PuterStoreError("forbidden", "cannot delete root", 403);
      if (!nfs.existsSync(real(p))) throw new PuterStoreError("subject_does_not_exist", `no such path: ${p}`, 404);

      const st = nfs.statSync(real(p));

      if (st.isDirectory() && options?.recursive !== true && nfs.readdirSync(real(p)).length > 0) {
        throw new PuterStoreError("not_empty", `directory not empty: ${p}`, 409);
      }

      nfs.rmSync(real(p), { force: true, recursive: true });
    },
    mkdir(path: string, options?: { readonly createMissingAncestors?: boolean }): FsEntry {
      const p = normalizePath(path);

      if (p === "/") return toEntry("/");
      if (nfs.existsSync(real(p))) {
        if (nfs.statSync(real(p)).isDirectory()) return toEntry(p);
        throw new PuterStoreError("item_with_same_name_exists", `file exists: ${p}`, 409);
      }

      nfs.mkdirSync(real(p), { recursive: options?.createMissingAncestors ?? true });
      return toEntry(p);
    },
    move(from: string, to: string, options?: { readonly overwrite?: boolean }): FsEntry {
      const src = normalizePath(from);
      const dst = normalizePath(to);

      if (src === "/") throw new PuterStoreError("forbidden", "cannot move root", 403);
      if (dst === "/") throw new PuterStoreError("forbidden", "cannot move onto root", 403);
      if (!nfs.existsSync(real(src))) throw new PuterStoreError("subject_does_not_exist", `no such path: ${src}`, 404);

      if (dst === src) return toEntry(src);
      if (dst.startsWith(`${src}/`)) throw new PuterStoreError("forbidden", "cannot move a directory into itself", 409);

      if (nfs.existsSync(real(dst))) {
        if (options?.overwrite !== true) throw new PuterStoreError("item_with_same_name_exists", `exists: ${dst}`, 409);
        nfs.rmSync(real(dst), { force: true, recursive: true });
      }

      const parent = real(dirname(dst));

      if (!nfs.existsSync(parent)) nfs.mkdirSync(parent, { recursive: true });
      nfs.renameSync(real(src), real(dst));
      return toEntry(dst);
    },
    read(path: string): ReadResult | undefined {
      const p = normalizePath(path);

      if (!nfs.existsSync(real(p)) || nfs.statSync(real(p)).isDirectory()) return undefined;

      return Object.freeze({ bytes: nfs.readFileSync(real(p)), entry: toEntry(p) });
    },
    readdir(path: string): readonly FsEntry[] {
      const p = normalizePath(path);

      if (!nfs.existsSync(real(p))) throw new PuterStoreError("subject_does_not_exist", `no such path: ${p}`, 404);
      if (!nfs.statSync(real(p)).isDirectory()) throw new PuterStoreError("readdir_of_non_directory", `not a directory: ${p}`, 409);

      const names = nfs.readdirSync(real(p));
      const out = names.map((name) => toEntry(p === "/" ? `/${name}` : `${p}/${name}`));

      out.sort((a, b) => a.name.localeCompare(b.name));
      return Object.freeze(out);
    },
    stat(path: string): FsEntry | undefined {
      const p = normalizePath(path);

      return nfs.existsSync(real(p)) ? toEntry(p) : undefined;
    },
    write(path: string, bytes: Uint8Array, options?: { readonly overwrite?: boolean; readonly type?: string | null }): FsEntry {
      const p = normalizePath(path);

      if (p === "/") throw new PuterStoreError("cannot_write_to_root", "cannot write to root", 409);

      if (nfs.existsSync(real(p))) {
        if (nfs.statSync(real(p)).isDirectory()) throw new PuterStoreError("cannot_overwrite_a_directory", `is a directory: ${p}`, 409);
        if (options?.overwrite === false) throw new PuterStoreError("item_with_same_name_exists", `exists: ${p}`, 409);
      }

      const parent = real(dirname(p));

      if (!nfs.existsSync(parent)) nfs.mkdirSync(parent, { recursive: true });
      nfs.writeFileSync(real(p), bytes);
      return toEntry(p);
    },
  });

  const kvStore: PuterKvStore = Object.freeze({
    del(key: string): void {
      const map = loadKv();

      delete map[key];
      saveKv(map);
    },
    get(key: string): string | null {
      const map = loadKv();

      return Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : null;
    },
    list(): readonly { readonly key: string; readonly value: string }[] {
      const map = loadKv();

      return Object.freeze(Object.entries(map).map(([key, value]) => Object.freeze({ key, value })));
    },
    set(key: string, value: string): void {
      const map = loadKv();

      map[key] = value;
      saveKv(map);
    },
  });

  function loadKv(): Record<string, string> {
    if (!nfs.existsSync(kvPath)) return {};

    try {
      const parsed: unknown = JSON.parse(nfs.readFileSyncText(kvPath));

      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  function saveKv(map: Record<string, string>): void {
    nfs.writeFileSync(kvPath, JSON.stringify(map, null, 2));
  }

  return Object.freeze({ fs, kv: kvStore });
}

// A minimal content-type guess (the SDK reads .type but tolerates anything). Pure.
export function guessType(path: string): string | null {
  const lower = path.toLowerCase();

  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".js")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".md")) return "text/markdown";

  return "application/octet-stream";
}

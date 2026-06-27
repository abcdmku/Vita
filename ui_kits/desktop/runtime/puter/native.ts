// Puter compat — the NATIVE binding (`@vita/puter`): fs/kv for in-process native VitaApps.
//
// This is the P2 keystone proving the SHARED data model: a native VitaApp gets `fs`/`kv` backed by the
// SAME PuterStore the sandboxed Puter apps reach over HTTP — but IN-PROCESS (no iframe, no HTTP), and
// through the SAME capability gate. One backing, one gate, two front doors. A file the Puter app wrote
// over /batch is readable here by `puter.fs.read`, and vice-versa.
//
// The surface mirrors the puter.js client API closely enough that a native app reads like a Puter app:
//   puter.fs.write(path, data) / read(path) -> string / readdir(path) -> entries
//   puter.kv.set(k, v) / get(k) / del(k) / list()
//   puter.auth.whoami() -> owner
// Promises throughout (the puter.js fs/kv API is async), so native and web code share an ergonomic.
//
// Capability-gated: a native binding is minted for a specific app session (token/instance/grants), and
// every call checks the grant — a native app that wasn't granted fs.write is denied exactly as a web
// app would be at the api_origin.

import {
  type PuterAppSession,
  type PuterCapability,
  type PuterCapabilityRegistry,
} from "./capability.ts";
import {
  type FsEntry,
  type PuterStore,
  PuterStoreError,
} from "./store.ts";

export interface NativeFs {
  // Read a file's bytes as text (utf-8). Throws if absent or denied.
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array, options?: { readonly overwrite?: boolean }): Promise<FsEntry>;
  readdir(path: string): Promise<readonly FsEntry[]>;
  stat(path: string): Promise<FsEntry | undefined>;
  mkdir(path: string): Promise<FsEntry>;
  delete(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

export interface NativeKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  list(): Promise<readonly { readonly key: string; readonly value: string }[]>;
}

export interface NativeAuth {
  whoami(): Promise<{ readonly username: string; readonly uuid: string }>;
}

// The `@vita/puter` binding handed to a native app. Same shape feel as `window.puter` (fs/kv/auth).
export interface VitaPuter {
  readonly fs: NativeFs;
  readonly kv: NativeKv;
  readonly auth: NativeAuth;
  readonly appId: string;
  readonly appInstanceId: string;
}

export interface NativeBindingDeps {
  readonly store: PuterStore;
  readonly capabilities: PuterCapabilityRegistry;
  readonly session: PuterAppSession;
}

// A typed denial mirroring the api_origin's CAP_DENIED — native callers get the same fail-closed error.
export class NativeCapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeCapabilityError";
    this.code = code;
  }
}

export function createVitaPuter(deps: NativeBindingDeps): VitaPuter {
  const { capabilities, session, store } = deps;

  function require(capability: PuterCapability): void {
    const result = capabilities.authorize(session, capability);

    if (!result.ok) throw new NativeCapabilityError(result.code, result.message);
  }

  const fs: NativeFs = Object.freeze({
    async delete(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
      require("fs.write");
      store.fs.delete(path, { recursive: options?.recursive ?? true });
    },
    async mkdir(path: string): Promise<FsEntry> {
      require("fs.write");
      return store.fs.mkdir(path, { createMissingAncestors: true });
    },
    async read(path: string): Promise<string> {
      require("fs.read");
      const result = store.fs.read(path);

      if (result === undefined) throw new PuterStoreError("subject_does_not_exist", `no such file: ${path}`, 404);

      return new TextDecoder().decode(result.bytes);
    },
    async readBytes(path: string): Promise<Uint8Array> {
      require("fs.read");
      const result = store.fs.read(path);

      if (result === undefined) throw new PuterStoreError("subject_does_not_exist", `no such file: ${path}`, 404);

      return result.bytes;
    },
    async readdir(path: string): Promise<readonly FsEntry[]> {
      require("fs.read");
      return store.fs.readdir(path);
    },
    async stat(path: string): Promise<FsEntry | undefined> {
      require("fs.read");
      return store.fs.stat(path);
    },
    async write(path: string, data: string | Uint8Array, options?: { readonly overwrite?: boolean }): Promise<FsEntry> {
      require("fs.write");
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

      return store.fs.write(path, bytes, { overwrite: options?.overwrite ?? true });
    },
  });

  const kv: NativeKv = Object.freeze({
    async del(key: string): Promise<void> {
      require("kv.write");
      store.kv.del(key);
    },
    async get(key: string): Promise<string | null> {
      require("kv.read");
      return store.kv.get(key);
    },
    async list(): Promise<readonly { readonly key: string; readonly value: string }[]> {
      require("kv.read");
      return store.kv.list();
    },
    async set(key: string, value: string): Promise<void> {
      require("kv.write");
      store.kv.set(key, value);
    },
  });

  const auth: NativeAuth = Object.freeze({
    async whoami(): Promise<{ readonly username: string; readonly uuid: string }> {
      require("auth");
      return Object.freeze({ username: session.owner.username, uuid: session.owner.uuid });
    },
  });

  return Object.freeze({
    appId: session.appId,
    appInstanceId: session.appInstanceId,
    auth,
    fs,
    kv,
  });
}

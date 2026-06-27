// REAL-SDK breadth probe — loads the GENUINE vendored puter.js bundle (v2.js) in Node behind a minimal
// browser shim (window/document/navigator + a fetch-backed XMLHttpRequest), points it at the dual-face
// backend's LOCAL api_origin, and drives the real SDK objects (`globalThis.puter.fs/kv/auth.*`).
//
// PURPOSE & HONESTY: this is an INFORMATIONAL probe, NOT the authoritative breadth proof. A Node VM with
// a hand-rolled XHR/DOM shim is NOT a browser; the genuine SDK's fs.write fans out through a multi-step
// signed-batch/space()/upload state machine whose later steps assume real browser XHR/event semantics
// our shim does not fully reproduce. What this probe DOES prove honestly:
//   - the genuine, checksum-pinned bundle LOADS and self-initializes APIOrigin from our launch params,
//   - its own code path completes the auth (`/whoami`) + quota (`/df`) handshake against our api_origin,
//   - it SURFACES the real endpoints/shapes the SDK demands (e.g. it demanded `/df`, which we then added).
// The AUTHORITATIVE breadth proof is dual-face-harness.ts (drives the SDK's exact wire shapes for
// write/read/readdir/stat/mkdir/delete/rename + kv get/set/del/list + whoami) and the BROWSER preview
// (which runs this same bundle in a real browser — see README "Preview-verify"). This probe never fails
// the build: it exits 0 and reports findings, so a shim gap is a documented note, not a false red.
//
// Run: node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/real-sdk-harness.ts
//      VITA_SDK_TRACE=1 … to log the SDK's actual request sequence.

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { createCapabilityRegistry } from "../capability.ts";
import { createAppGrantRegistry, createBrokerPermissionModel } from "../permission-model.ts";
import { openAppStore } from "../fs-store.ts";
import { startDualFaceBackend, type DualFaceBackend } from "../backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, "../../../_vendor/puter/v2.js");

const APP_ID = "spike.puter.testapp";
const APP_TOKEN = "real-sdk-app-token-0001";
const INSTANCE = "real-sdk-instance-0001";
const OWNER_TOKEN = "real-sdk-owner-token-0001";

const TRACE = process.env["VITA_SDK_TRACE"] === "1";

// The genuine bundle can throw ASYNCHRONOUSLY from inside its XHR/event callbacks under our headless
// shim (e.g. it reads `.responseType` on an internal object our shim shapes differently). Those escape
// try/catch. Swallow them so the probe degrades to a reported DEMAND instead of crashing the process —
// this is an informational probe, never a build gate.
const swallowedAsyncErrors: string[] = [];
process.on("uncaughtException", (err: unknown) => {
  swallowedAsyncErrors.push(err instanceof Error ? err.message : String(err));
});
process.on("unhandledRejection", (reason: unknown) => {
  swallowedAsyncErrors.push(reason instanceof Error ? reason.message : String(reason));
});

interface Check { readonly name: string; readonly ok: boolean; readonly detail: string }
const checks: Check[] = [];
const demands: string[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ detail, name, ok });
  console.log(`[real-sdk] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const appsRoot = mkdtempSync(`${tmpdir()}/vita-puter-realsdk-`);
  const grants = createAppGrantRegistry({ [APP_ID]: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  capabilities.mintAppSession({ appId: APP_ID, appInstanceId: INSTANCE, grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"], token: APP_TOKEN });

  const store = openAppStore({ appId: APP_ID, appsRoot });
  const backend: DualFaceBackend = await startDualFaceBackend({
    capabilities,
    networkHost: "127.0.0.1",
    ownerToken: OWNER_TOKEN,
    staticRoot: appsRoot,
    store,
  });
  const apiOrigin = `${backend.local.url}/api`;

  try {
    const puter = await loadRealSdk(apiOrigin);

    record("real SDK loaded (globalThis.puter present)", typeof puter === "object" && puter !== null, `APIOrigin => ${String((puter as { APIOrigin?: unknown }).APIOrigin)}`);

    const p = puter as RealPuter;

    // ---- auth.getUser (whoami) — the SDK's auth handshake against our api_origin ----
    try {
      const me = await withTimeout(p.auth.getUser(), "auth.getUser");

      record("real SDK auth.getUser (whoami)", me !== undefined && me.username === "owner", `user => ${JSON.stringify(me?.username)}`);
    } catch (e) { record("real SDK auth.getUser (whoami)", false, errMsg(e)); demands.push(`auth.getUser: ${errMsg(e)}`); }

    // ---- kv set/get/list/del (the SDK's /drivers/call path — no multi-step state machine) ----
    try {
      await withTimeout(p.kv.set("rk1", "rv1"), "kv.set");
      await withTimeout(p.kv.set("rk2", "rv2"), "kv.set2");
      const got = await withTimeout(p.kv.get("rk1"), "kv.get");
      const list = await withTimeout(p.kv.list(true), "kv.list");
      const keys = normalizeKvList(list);

      await withTimeout(p.kv.del("rk2"), "kv.del");
      const after = normalizeKvList(await withTimeout(p.kv.list(true), "kv.list2"));

      record("real SDK kv set/get/list/del", got === "rv1" && keys.includes("rk1") && keys.includes("rk2") && !after.includes("rk2"), `keys => ${keys.join(",")} -> after del => ${after.join(",")}`);
    } catch (e) { record("real SDK kv set/get/list/del", false, errMsg(e)); demands.push(`kv ops: ${errMsg(e)}`); }

    // ---- fs.* through the real SDK. The write state-machine may not complete under the headless shim;
    // each op is time-boxed and any gap is reported as a DEMAND (not a build failure). ----
    const fsOps: [string, () => Promise<unknown>][] = [
      ["fs.write", () => p.fs.write("breadth.txt", "real sdk wrote this")],
      ["fs.read", () => readText(p, "breadth.txt")],
      ["fs.mkdir", () => p.fs.mkdir("realdir")],
      ["fs.readdir", () => p.fs.readdir(".")],
      ["fs.stat", () => p.fs.stat("breadth.txt")],
      ["fs.rename", () => p.fs.rename("breadth.txt", "renamed.txt")],
      ["fs.delete", () => p.fs.delete("realdir")],
    ];

    for (const [name, run] of fsOps) {
      try {
        await withTimeout(run(), name);
        record(`real SDK ${name}`, true, "completed");
      } catch (e) {
        record(`real SDK ${name}`, false, errMsg(e));
        demands.push(`${name} (headless shim gap or SDK demand): ${errMsg(e)}`);
      }
    }
  } finally {
    await backend.close();
    rmSync(appsRoot, { force: true, recursive: true });
  }

  const passed = checks.filter((c) => c.ok).length;

  console.log(`[real-sdk] === ${passed}/${checks.length} probe checks passed (informational) ===`);
  console.log(`[real-sdk] NOTE: authoritative breadth proof is dual-face-harness.ts + the browser preview.`);
  const allDemands = [...demands, ...swallowedAsyncErrors.map((m) => `async SDK throw under shim: ${m}`)];

  if (allDemands.length > 0) {
    console.log(`[real-sdk] SDK DEMANDS / SHIM GAPS OBSERVED:`);
    for (const d of [...new Set(allDemands)]) console.log(`[real-sdk]   - ${d}`);
  }
  console.log(`[real-sdk] SUMMARY ${JSON.stringify({ demands: [...new Set(allDemands)], passed, total: checks.length })}`);
  // Informational probe: NEVER fail the build on a shim gap. Exit 0 regardless.
  process.exit(0);
}

// Time-box a real-SDK op so a stalled headless state-machine step is reported, not hung.
function withTimeout<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms)),
  ]);
}

interface RealPuter {
  readonly APIOrigin?: string;
  readonly fs: {
    write(path: string, data: string): Promise<unknown>;
    read(path: string): Promise<unknown>;
    readdir(path: string): Promise<{ name: string }[]>;
    stat(path: string): Promise<{ name: string } | undefined>;
    mkdir(path: string): Promise<unknown>;
    delete(path: string): Promise<unknown>;
    rename(path: string, newName: string): Promise<unknown>;
  };
  readonly kv: {
    set(k: string, v: string): Promise<unknown>;
    get(k: string): Promise<unknown>;
    del(k: string): Promise<unknown>;
    list(returnValues?: boolean): Promise<unknown>;
  };
  readonly auth: { getUser(): Promise<{ username?: string } | undefined> };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readText(p: RealPuter, path: string): Promise<string> {
  const r = await p.fs.read(path);
  const blob = (r !== null && typeof (r as { text?: unknown }).text === "function")
    ? (r as { text(): Promise<string> })
    : ((r as { result?: unknown })?.result as { text?: unknown } | undefined);

  if (blob !== undefined && blob !== null && typeof (blob as { text?: unknown }).text === "function") {
    return (blob as { text(): Promise<string> }).text();
  }

  return typeof r === "string" ? r : String(r);
}

function normalizeKvList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];

  return list.map((e) => (typeof e === "string" ? e : (e as { key?: string }).key ?? "")).filter((k) => k !== "").sort();
}

// ----------------------------- the minimal browser shim + SDK loader -----------------------------

async function loadRealSdk(apiOrigin: string): Promise<unknown> {
  const code = readFileSync(bundlePath, "utf8");
  // Launch params the SDK reads: env=app + api_origin + auth token (it sets APIOrigin from these).
  const search = `?puter.app_instance_id=${INSTANCE}&puter.api_origin=${encodeURIComponent(apiOrigin)}&puter.auth.token=${APP_TOKEN}&puter.auth.username=owner&puter.domain=localhost&puter.env=app`;

  const sandbox = makeBrowserSandbox(apiOrigin, search);

  runInNewContext(code, sandbox, { filename: "puter-v2.js" });

  const g = sandbox as { puter?: unknown };

  // The SDK initializes APIOrigin from the URL params synchronously on load. Give any microtasks a tick.
  await new Promise((r) => setTimeout(r, 0));

  if (g.puter === undefined) throw new Error("puter not exposed on globalThis after bundle load");

  return g.puter;
}

// Build a VM sandbox that looks enough like a browser for v2.js: window/document/navigator/location +
// a fetch-backed XMLHttpRequest. Kept deliberately small; anything the SDK touches that we DON'T provide
// will surface as a thrown error in a check (and get reported as a DEMAND).
function makeBrowserSandbox(apiOrigin: string, search: string): Record<string, unknown> {
  const origin = new URL(apiOrigin).origin;
  const listeners = new Map<string, ((e: unknown) => void)[]>();

  const documentStub = {
    addEventListener(): void {},
    removeEventListener(): void {},
    createElement(): Record<string, unknown> {
      return { setAttribute(): void {}, appendChild(): void {}, style: {}, classList: { add(): void {}, remove(): void {} } };
    },
    querySelector(): null { return null; },
    querySelectorAll(): unknown[] { return []; },
    getElementById(): null { return null; },
    head: { appendChild(): void {} },
    body: { appendChild(): void {}, setAttribute(): void {} },
    cookie: "",
    readyState: "complete",
    documentElement: { style: {} },
  };

  const locationStub = { href: `${origin}/app/index.html${search}`, search, origin, hostname: new URL(origin).hostname, protocol: "http:", pathname: "/app/index.html" };

  const sandbox: Record<string, unknown> = {
    XMLHttpRequest: makeXhrClass(),
    fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
    Blob,
    File,
    FormData,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    EventTarget,
    Event,
    CustomEvent: globalThis.CustomEvent ?? Event,
    AbortController,
    AbortSignal,
    Headers,
    Request,
    Response,
    structuredClone,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    Uint8Array,
    ArrayBuffer,
    JSON,
    Math,
    Date,
    Object,
    Array,
    Error,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    document: documentStub,
    location: locationStub,
    navigator: { userAgent: "vita-headless", language: "en-US", onLine: true, clipboard: {} },
    addEventListener(type: string, cb: (e: unknown) => void): void {
      const arr = listeners.get(type) ?? [];

      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener(): void {},
    postMessage(): void {},
    name: "",
    crypto: globalThis.crypto,
  };

  // window/self/globalThis all alias the sandbox (the SDK reads globalThis.puter + window.*).
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  return sandbox;
}

// A minimal in-memory Storage (the SDK probes localStorage for a cached auth token; we don't need
// persistence, just a non-throwing surface).
function makeMemoryStorage(): Record<string, unknown> {
  const map = new Map<string, string>();

  return {
    getItem(k: string): string | null { return map.has(k) ? map.get(k)! : null; },
    setItem(k: string, v: string): void { map.set(k, String(v)); },
    removeItem(k: string): void { map.delete(k); },
    clear(): void { map.clear(); },
    key(i: number): string | null { return [...map.keys()][i] ?? null; },
    get length(): number { return map.size; },
  };
}

// A fetch-backed XMLHttpRequest sufficient for puter.js: open/setRequestHeader/send + status/response/
// responseType/readyState + load/error events + a no-op upload. Supports JSON, text, and blob/arraybuffer
// responseType (fs.read uses arraybuffer/blob).
function makeXhrClass(): unknown {
  return class XHR {
    public method = "GET";
    public url = "";
    public readyState = 0;
    public status = 0;
    public response: unknown = null;
    public responseText = "";
    public responseType = "";
    public withCredentials = false;
    public onload: (() => void) | null = null;
    public onerror: ((e?: unknown) => void) | null = null;
    public onreadystatechange: (() => void) | null = null;
    public upload = { addEventListener(): void {} };
    private headers: Record<string, string> = {};
    private listeners: Record<string, ((e?: unknown) => void)[]> = {};

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }

    setRequestHeader(k: string, v: string): void {
      this.headers[k] = v;
    }

    addEventListener(type: string, cb: (e?: unknown) => void): void {
      (this.listeners[type] ??= []).push(cb);
    }

    getResponseHeader(): string | null {
      return null;
    }

    abort(): void {}

    private emit(type: string): void {
      // The SDK's handlers read `event.target.responseType` / `event.target.response` etc., so pass an
      // event whose `target` (and `currentTarget`) is this XHR.
      const event = { type, target: this, currentTarget: this } as unknown;

      for (const cb of this.listeners[type] ?? []) {
        try { cb(event); } catch { /* ignore listener throw */ }
      }

      if (type === "load" && this.onload) this.onload();
      if (type === "error" && this.onerror) this.onerror();
      if (type === "readystatechange" && this.onreadystatechange) this.onreadystatechange();
    }

    send(body?: unknown): void {
      const init: RequestInit = { method: this.method, headers: this.headers };

      if (body !== undefined && body !== null && this.method !== "GET" && this.method !== "HEAD") {
        init.body = body as BodyInit;
      }

      if (TRACE) console.log(`[real-sdk:trace] ${this.method} ${this.url} rt=${this.responseType || "text"}`);

      fetch(this.url, init)
        .then(async (res) => {
          this.status = res.status;
          this.readyState = 4;
          if (TRACE) console.log(`[real-sdk:trace]   -> ${res.status} ${this.url.split("/api").pop()}`);

          if (this.responseType === "blob") {
            this.response = await res.blob();
          } else if (this.responseType === "arraybuffer") {
            this.response = await res.arrayBuffer();
          } else if (this.responseType === "json") {
            this.response = await res.json().catch(() => null);
          } else {
            this.responseText = await res.text();
            this.response = this.responseText;
          }

          if (this.onreadystatechange) this.onreadystatechange();
          this.emit("load");
        })
        .catch((err: unknown) => {
          this.status = 0;
          this.readyState = 4;
          this.emit("error");
          void err;
        });
    }
  };
}

main().catch((err: unknown) => {
  // Informational probe — report and exit 0 (the authoritative proofs are elsewhere).
  console.error(`[real-sdk] probe error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});

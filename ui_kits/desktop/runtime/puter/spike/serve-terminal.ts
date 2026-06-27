// serve-terminal — the Terminal preview harness. Stands up ONE local server that serves:
//   - the vendored xterm.js + css at /_vendor/xterm/*
//   - the vendored puter.js at /_vendor/puter/v2.js (the app doesn't need it for exec, but kept parallel)
//   - the Terminal app at /apps/terminal/index.html
//   - the LOCAL api_origin at /api/* (fs/kv/auth)
//   - the /pty EXEC websocket (gated on the `exec` capability), backed by the dev-sandbox exec backend
//
// Two pre-minted sessions let the browser verification prove BOTH paths against the SAME server:
//   - an `exec`-GRANTED token (the Terminal): /pty opens, real commands run.
//   - an UNGRANTED token (a notepad-like app): /pty upgrade is refused (403) — exec default-deny.
//
// Run:  node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/serve-terminal.ts [--port 7682] [--dir <path>]
// Then open the Terminal:
//   http://127.0.0.1:7682/apps/terminal/index.html?puter.api_origin=http://127.0.0.1:7682/api&puter.auth.token=<TERM_TOKEN>

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiOrigin } from "../api-origin.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { type ChildProcessLike, createDevExecBackend } from "../exec-plane.ts";
import { createNodeFsStore } from "../store.ts";
import { nodeFsAdapter } from "./node-fs-adapter.ts";
import { startHarnessServer } from "../server.ts";

const here = dirname(fileURLToPath(import.meta.url)); // .../runtime/puter/spike
const puterDir = resolve(here, ".."); // .../runtime/puter
const uiKitsDesktop = resolve(here, "../../.."); // ui_kits/desktop
const repoRoot = resolve(uiKitsDesktop, "../.."); // repo root

// Pre-minted tokens the verification + manual preview use (the harness owns the registry).
export const TERM_TOKEN = "term-owner-token-0001"; // granted `exec`
export const TERM_APP_ID = "vita.terminal";
export const TERM_INSTANCE = "term-instance-0001";
export const NOEXEC_TOKEN = "noexec-owner-token-0002"; // NOT granted `exec`

// Adapt node:child_process.spawn to the dev backend's injected ChildProcessLike.
const childProcess: ChildProcessLike = {
  spawn(command, args, options) {
    const child = spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, shell: false });

    return {
      stdout: { on: (_e, cb) => child.stdout.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stderr: { on: (_e, cb) => child.stderr.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stdin: { write: (d: string) => child.stdin.write(d), end: () => child.stdin.end() },
      on: (event, cb) => {
        if (event === "exit") child.on("exit", (code, signal) => (cb as (c: number | null, s: string | null) => void)(code, signal));
        else child.on("error", (err) => (cb as (e: Error) => void)(err));
      },
      kill: (signal?: string) => { child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM"); },
    };
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function startTerminalHarness(port: number, dataDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const store = createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dataDir });
  const capabilities = createCapabilityRegistry();

  capabilities.mintAppSession({ appId: TERM_APP_ID, appInstanceId: TERM_INSTANCE, grants: ["exec", "fs.read", "ui", "auth"], token: TERM_TOKEN });
  capabilities.mintAppSession({ appId: "vita.notepad", appInstanceId: "note-instance-0001", grants: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"], token: NOEXEC_TOKEN });

  const execBackend = createDevExecBackend({
    childProcess,
    makeCwd: () => mkdtempSync(join(tmpdir(), "vita-term-cwd-")),
    pathEnv: process.env["PATH"] ?? "",
    timeoutMs: 5000,
  });

  const vendorDir = resolve(uiKitsDesktop, "_vendor");
  const apiOrigin = createApiOrigin({ capabilities, store });
  const server = await startHarnessServer({
    apiOrigin,
    apiPrefix: "/api",
    capabilities,
    execBackend,
    host: "127.0.0.1",
    port,
    staticAliases: {
      "/_vendor": vendorDir,
      "/apps": resolve(puterDir, "apps"),
      "/vendor": vendorDir,
    },
    staticRoot: repoRoot,
  });

  return { url: server.url, close: () => server.close() };
}

async function main(): Promise<void> {
  const port = Number(arg("port") ?? "7682");
  const dataDir = arg("dir") ?? mkdtempSync(join(tmpdir(), "vita-term-data-"));
  const { url } = await startTerminalHarness(port, dataDir);
  const termUrl = `${url}/apps/terminal/index.html?puter.api_origin=${encodeURIComponent(`${url}/api`)}&puter.auth.token=${TERM_TOKEN}`;
  const deniedUrl = `${url}/apps/terminal/index.html?puter.api_origin=${encodeURIComponent(`${url}/api`)}&puter.auth.token=${NOEXEC_TOKEN}`;

  console.log("");
  console.log("  Vita Terminal harness");
  console.log("  ─────────────────────");
  console.log(`  server          : ${url}`);
  console.log(`  data dir        : ${dataDir}`);
  console.log("");
  console.log(`  Terminal (exec) : ${termUrl}`);
  console.log(`  Terminal (DENIED, no exec grant) : ${deniedUrl}`);
  console.log("");
  console.log("  Ctrl-C to stop.");

  process.on("SIGINT", () => { void Promise.resolve().then(() => process.exit(0)); });
}

// Only run the server when invoked directly (the verification imports startTerminalHarness).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[serve-terminal] FATAL ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}

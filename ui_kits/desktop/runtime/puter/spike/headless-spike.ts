// Headless spike runner — drives the LOCAL api_origin exactly as the puter.js SDK would, over real
// HTTP, against a running harness server. Proves fs.write/read/readdir + kv.set/get + whoami round-trip
// AND the P2 shared store (a native @vita/puter binding reads the SAME file the "Puter app" wrote),
// WITHOUT a browser. Captures console-log evidence.
//
// This mirrors the genuine SDK's request shapes (verified against the vendored bundle):
//   fs.write   -> POST /batch  (multipart: operation JSON + fileinfo JSON + file blob)
//   fs.read    -> POST /read   ({ path })
//   fs.readdir -> POST /readdir ({ path })
//   kv.*       -> POST /drivers/call ({ interface:'puter-kvstore', method, args })
//   whoami     -> GET  /whoami
//
// Run: node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/headless-spike.ts
// (the runner starts its own harness server on an ephemeral port).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiOrigin } from "../api-origin.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { createVitaPuter } from "../native.ts";
import { nodeFsAdapter } from "./node-fs-adapter.ts";
import { createNodeFsStore } from "../store.ts";
import { startHarnessServer } from "../server.ts";

const APP_ID = "spike.puter.testapp";
const TOKEN = "spike-owner-token-deadbeef";
const INSTANCE = "spike-instance-0001";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ detail, name, ok });
    console.log(`[headless-spike] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const dir = mkdtempSync(join(tmpdir(), "vita-puter-spike-"));
  const store = createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dir });
  const capabilities = createCapabilityRegistry();
  const session = capabilities.mintAppSession({
    appId: APP_ID,
    appInstanceId: INSTANCE,
    grants: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"],
    token: TOKEN,
  });
  const apiOrigin = createApiOrigin({ capabilities, store });
  const server = await startHarnessServer({ apiOrigin, apiPrefix: "/api", staticRoot: dir });
  const base = `${server.url}/api`;

  try {
    console.log(`[headless-spike] api_origin up at ${base}; store dir ${dir}`);

    // ---- fs.write via /batch (multipart, exactly like the SDK) ----
    {
      const res = await batchWrite(base, TOKEN, "/spike.txt", "hello from Vita");

      record("fs.write (/batch)", res.ok, `status ${res.status}`);
    }

    // ---- fs.read via /read ----
    {
      const res = await fetch(`${base}/read`, {
        body: JSON.stringify({ path: "/spike.txt" }),
        headers: authJson(TOKEN),
        method: "POST",
      });
      const text = await res.text();

      record("fs.read (/read)", res.ok && text === "hello from Vita", `=> ${JSON.stringify(text)}`);
    }

    // ---- fs.readdir via /readdir ----
    {
      const res = await fetch(`${base}/readdir`, {
        body: JSON.stringify({ path: "/" }),
        headers: authJson(TOKEN),
        method: "POST",
      });
      const entries = (await res.json()) as { name: string }[];
      const names = entries.map((e) => e.name);

      record("fs.readdir (/readdir)", res.ok && names.includes("spike.txt"), `entries => ${names.join(", ")}`);
    }

    // ---- kv.set + kv.get via /drivers/call ----
    {
      const setRes = await driversCall(base, TOKEN, "set", { key: "spike_key", value: "spike_val" });
      const getRes = await driversCall(base, TOKEN, "get", { key: "spike_key" });
      const got = (getRes.body as { result?: unknown }).result;

      record("kv.set+get (/drivers/call)", setRes.ok && getRes.ok && got === "spike_val", `get => ${JSON.stringify(got)}`);
    }

    // ---- kv.list ----
    {
      const listRes = await driversCall(base, TOKEN, "list", { as: "kv" });
      const result = (listRes.body as { result?: { key: string }[] }).result ?? [];

      record("kv.list (/drivers/call)", listRes.ok && result.some((e) => e.key === "spike_key"), `keys => ${result.map((e) => e.key).join(", ")}`);
    }

    // ---- whoami ----
    {
      const res = await fetch(`${base}/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const me = (await res.json()) as { username?: string };

      record("auth.whoami (/whoami)", res.ok && me.username === "owner", `user => ${JSON.stringify(me.username)}`);
    }

    // ---- capability fail-closed: bad token rejected ----
    {
      const res = await fetch(`${base}/readdir`, {
        body: JSON.stringify({ path: "/" }),
        headers: authJson("not-a-real-token"),
        method: "POST",
      });

      record("capability gate (bad token → 401)", res.status === 401, `status ${res.status}`);
    }

    // ---- P2: native binding reads the SAME file the "Puter app" wrote over HTTP ----
    {
      const puter = createVitaPuter({ capabilities, session, store });
      const text = await puter.fs.read("/spike.txt");
      const kvVal = await puter.kv.get("spike_key");

      record(
        "P2 shared store (native reads web-written file + kv)",
        text === "hello from Vita" && kvVal === "spike_val",
        `fs => ${JSON.stringify(text)}, kv => ${JSON.stringify(kvVal)}`,
      );

      // And the reverse: native writes, then HTTP read sees it.
      await puter.fs.write("/from-native.txt", "written by native VitaApp");
      const httpRes = await fetch(`${base}/read`, {
        body: JSON.stringify({ path: "/from-native.txt" }),
        headers: authJson(TOKEN),
        method: "POST",
      });
      const httpText = await httpRes.text();

      record(
        "P2 shared store (HTTP reads native-written file)",
        httpText === "written by native VitaApp",
        `http read => ${JSON.stringify(httpText)}`,
      );
    }
  } finally {
    await server.close();
    rmSync(dir, { force: true, recursive: true });
  }

  const passed = checks.filter((c) => c.ok).length;

  console.log(`[headless-spike] === ${passed}/${checks.length} checks passed ===`);
  console.log(`[headless-spike] SUMMARY ${JSON.stringify({ checks, passed, total: checks.length })}`);

  if (passed !== checks.length) process.exitCode = 1;
}

function authJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// Build the SDK's /batch multipart body for a single write and POST it. The genuine SDK sends `path` =
// the destination DIRECTORY and `name` = the leaf filename (verified against the bundle), so we mirror
// that shape exactly: split the target into parent + name.
async function batchWrite(base: string, token: string, path: string, content: string): Promise<{ ok: boolean; status: number }> {
  const name = path.split("/").pop() ?? path;
  const parent = path.slice(0, path.length - name.length).replace(/\/$/u, "") || "/";
  const form = new FormData();
  const operation = { name, op: "write", operation_id: "0", overwrite: true, path: parent };
  const fileinfo = { name, size: content.length, type: "text/plain" };

  form.append("operation", JSON.stringify(operation));
  form.append("fileinfo", JSON.stringify(fileinfo));
  form.append("file", new Blob([content], { type: "text/plain" }), path.split("/").pop());

  const res = await fetch(`${base}/batch`, {
    body: form,
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });

  return { ok: res.ok, status: res.status };
}

async function driversCall(base: string, token: string, method: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${base}/drivers/call`, {
    body: JSON.stringify({ args, interface: "puter-kvstore", method }),
    headers: authJson(token),
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));

  return { body, ok: res.ok, status: res.status };
}

main().catch((err: unknown) => {
  console.error(`[headless-spike] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});

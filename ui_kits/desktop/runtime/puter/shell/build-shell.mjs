#!/usr/bin/env node
// Bundle the multi-window shell entry (shell-entry.ts) into an offline ESM bundle (shell.js) that
// shell.html loads. Mirrors spike/build-preview.mjs: deno bundle, browser platform, ESM, no remote
// imports (offline-clean — the bundle must never reach a CDN/node/npm/jsr import).
//
// Usage:  node ui_kits/desktop/runtime/puter/shell/build-shell.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // .../puter/shell
const entry = resolve(here, "shell-entry.ts");
const out = resolve(here, "shell.js");

const denoBin = process.platform === "win32" ? "deno.exe" : "deno";
const args = ["bundle", "--no-check", "--platform", "browser", "--format", "esm", "--minify", entry, "-o", out];

console.log(`[build-shell] deno ${args.join(" ")}`);
const res = spawnSync(denoBin, args, { stdio: "inherit", cwd: here });

if (res.error) {
  console.error(`[build-shell] failed to launch deno: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[build-shell] deno bundle exited ${res.status}`);
  process.exit(res.status ?? 1);
}
if (!existsSync(out)) {
  console.error(`[build-shell] expected output missing: ${out}`);
  process.exit(1);
}

const code = readFileSync(out, "utf8");
const forbidden = [/\bfrom\s*["']https?:/, /\bfrom\s*["']node:/, /\bfrom\s*["']npm:/, /\bfrom\s*["']jsr:/];
const hits = forbidden.map((re) => code.match(re)).filter(Boolean);

if (hits.length > 0) {
  console.error("[build-shell] bundle contains remote/bare imports — not offline-clean");
  process.exit(1);
}

console.log(`[build-shell] wrote ${out} (${statSync(out).size} bytes, offline-clean)`);

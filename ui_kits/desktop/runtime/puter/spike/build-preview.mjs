#!/usr/bin/env node
// Bundle the spike desktop preview entry (preview-entry.ts) into an offline ESM bundle
// (spike-preview.js) the desktop.html page loads. Mirrors ui_kits/desktop/build.mjs: deno bundle,
// browser platform, ESM, no remote imports.
//
// Usage:  node ui_kits/desktop/runtime/puter/spike/build-preview.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // .../puter/spike
const entry = resolve(here, "preview-entry.ts");
const out = resolve(here, "spike-preview.js");

const denoBin = process.platform === "win32" ? "deno.exe" : "deno";
const args = ["bundle", "--no-check", "--platform", "browser", "--format", "esm", "--minify", entry, "-o", out];

console.log(`[build-preview] deno ${args.join(" ")}`);
const res = spawnSync(denoBin, args, { stdio: "inherit", cwd: here });

if (res.error) {
  console.error(`[build-preview] failed to launch deno: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[build-preview] deno bundle exited ${res.status}`);
  process.exit(res.status ?? 1);
}
if (!existsSync(out)) {
  console.error(`[build-preview] expected output missing: ${out}`);
  process.exit(1);
}

const code = readFileSync(out, "utf8");
const forbidden = [/\bfrom\s*["']https?:/, /\bfrom\s*["']node:/, /\bfrom\s*["']npm:/, /\bfrom\s*["']jsr:/];
const hits = forbidden.map((re) => code.match(re)).filter(Boolean);

if (hits.length > 0) {
  console.error("[build-preview] bundle contains remote/bare imports — not offline-clean");
  process.exit(1);
}

console.log(`[build-preview] wrote ${out} (${statSync(out).size} bytes, offline-clean)`);

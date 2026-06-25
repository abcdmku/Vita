#!/usr/bin/env node
// Reproducible build for the Vita flagship desktop in-surface runtime.
//
// Turns the TypeScript runtime (runtime/bootstrap.ts -> screens/* -> viewmodels/*
// -> @vita/desktop-sdk) into the single OFFLINE ES-module bundle that every screen
// HTML loads via `<script type="module" src="runtime/bootstrap.js">` (ADR 0013).
//
// Toolchain: `deno bundle` (Deno is the OS runtime; spec/ADR 0006). It resolves the
// relative TS import graph, strips types, tree-shakes, and emits one ESM file with
// NO remote imports. A bundle-time import map (runtime/.build/import-map.json)
// substitutes the Node-only `node:util` for an offline browser shim so the artifact
// runs in a plain browser / the CEF surface.
//
// Lucide is intentionally NOT bundled: hydrate.ts reads `globalThis.lucide`, and the
// HTML loads the vendored `../_vendor/lucide.min.js` before this module. Keep it external.
//
// Usage:  node ui_kits/desktop/build.mjs            (build)
//         node ui_kits/desktop/build.mjs --check    (build + assert offline/no remote imports)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // ui_kits/desktop
const entry = resolve(here, "runtime/bootstrap.ts");
const out = resolve(here, "runtime/bootstrap.js");
const importMap = resolve(here, "runtime/.build/import-map.json");

const denoBin = process.platform === "win32" ? "deno.exe" : "deno";

const args = [
  "bundle",
  "--no-check", // types are stripped; type-checking is the repo TS lane's job (npm run typecheck)
  "--platform",
  "browser",
  "--format",
  "esm",
  "--minify",
  "--import-map",
  importMap,
  entry,
  "-o",
  out,
];

console.log(`[build] deno ${args.join(" ")}`);
const res = spawnSync(denoBin, args, { stdio: "inherit", cwd: here });

if (res.error) {
  console.error(`[build] failed to launch deno: ${res.error.message}`);
  console.error("[build] install Deno (https://deno.com) — it is the Vita OS runtime.");
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[build] deno bundle exited ${res.status}`);
  process.exit(res.status ?? 1);
}
if (!existsSync(out)) {
  console.error(`[build] expected output missing: ${out}`);
  process.exit(1);
}

const code = readFileSync(out, "utf8");
const size = statSync(out).size;

// Vita rule: production artifacts contain NO remote imports and no unresolved
// bare/node specifiers. Assert the emitted module is self-contained.
const forbidden = [
  /\bfrom\s*["']https?:/,
  /\bimport\s*["']https?:/,
  /\bfrom\s*["']node:/,
  /\bfrom\s*["']npm:/,
  /\bfrom\s*["']jsr:/,
  /\brequire\s*\(/,
];
const hits = forbidden
  .map((re) => ({ re, m: code.match(re) }))
  .filter((x) => x.m);

if (hits.length > 0) {
  console.error("[build] OFFLINE CHECK FAILED — bundle contains non-self-contained imports:");
  for (const { re, m } of hits) console.error(`  ${re} -> ${m?.[0]}`);
  process.exit(2);
}

console.log(`[build] OK -> runtime/bootstrap.js (${(size / 1024).toFixed(1)} KB, offline, no remote/node/bare imports)`);

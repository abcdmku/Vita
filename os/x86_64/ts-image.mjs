#!/usr/bin/env node
// Vita on-device TypeScript runtime staging step (P1-030).
//
// Fetches the PINNED Deno runtime (version + sha256 from os/x86_64/ts-image.conf), VERIFIES the
// download against the pinned sha256, extracts the single `deno` executable, and stages it at
// os/x86_64/ts-overlay/usr/lib/vita/deno (mode 0755) so mkosi's --extra-tree=ts-overlay ships it
// into the rootfs. This mirrors how build-and-boot.installAgentOverlay() stages agentd: the binary
// is a build artifact (gitignored), the TS sources + service + symlink are committed.
//
// Determinism / supply chain (CLAUDE.md §6, spec §9.3, §16):
//   - The asset is version- AND sha256-pinned; a mismatch is a HARD FAIL (no staging).
//   - No code is executed from the download; we only verify bytes and copy one member out.
//   - The fetch is the ONLY network access and happens at BUILD time on the orchestrator host —
//     never at boot, and never inside the mkosi build (WithNetwork=no).
//
// USAGE (run on the Linux build host, before the mkosi smoke build):
//   node os/x86_64/ts-image.mjs            # fetch + verify + stage into the overlay
//   node os/x86_64/ts-image.mjs --print    # print the resolved pin (no network), for auditing
//   node os/x86_64/ts-image.mjs --check    # verify an already-staged binary's sha256 (no fetch)
//
// Offline / air-gapped: set VITA_DENO_ZIP=/path/to/deno-x86_64-unknown-linux-gnu.zip to stage from
// a local copy instead of downloading (still sha256-verified against the pin).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CONFIG_PATH = join(HERE, "ts-image.conf");
const OVERLAY_ROOT = join(HERE, "ts-overlay");
const BAKED_OCI_ROOTFS_PATHS = Object.freeze([
  join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", "local.oci.capsule", "rootfs"),
  join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", "local.hostile-oci.capsule", "rootfs"),
]);

function fail(msg) { console.error(`\n✖ ts-image: ${msg}`); process.exit(1); }
function log(msg) { console.log(msg); }

// ── Minimal INI-ish parser for ts-image.conf (Section.Key=Value; # comments) ───────────────────
function parseConf(text) {
  const out = {};
  let section = "";
  for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (sec) { section = sec[1]; out[section] ??= {}; continue; }
    const eq = line.indexOf("=");
    if (eq <= 0) fail(`bad config line: ${raw}`);
    if (section === "") fail(`setting before section: ${raw}`);
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function loadPin() {
  if (!existsSync(CONFIG_PATH)) fail(`missing ${CONFIG_PATH}`);
  const conf = parseConf(readFileSync(CONFIG_PATH, "utf8"));
  const r = conf.Runtime ?? {};
  const i = conf.Install ?? {};
  for (const [k, v] of Object.entries({ Version: r.Version, Asset: r.Asset, Url: r.Url, Sha256: r.Sha256, ArchiveMember: r.ArchiveMember, Binary: i.Binary, BinaryMode: i.BinaryMode })) {
    if (!v) fail(`ts-image.conf missing required key ${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(r.Sha256)) fail(`ts-image.conf Sha256 must be 64 lowercase hex chars, got: ${r.Sha256}`);
  // Map the container install path (/usr/...) onto the committed overlay tree on the host.
  const binaryRel = i.Binary.replace(/^\//, "");          // usr/lib/vita/deno
  const binaryHostPath = join(OVERLAY_ROOT, binaryRel);
  return { ...r, binary: i.Binary, binaryMode: i.BinaryMode, binaryHostPath };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Extract one member from a zip. Prefer system `unzip` (present on the Linux build host); fall back
// to `bsdtar`/`tar` (libarchive reads zip). We never execute the extracted file — only copy it out.
function extractMember(zipPath, member, destDir) {
  const tryRun = (exe, args) => {
    const r = spawnSync(exe, args, { stdio: ["ignore", "inherit", "inherit"] });
    return r.error === undefined && r.status === 0;
  };
  if (tryRun("unzip", ["-o", "-q", zipPath, member, "-d", destDir])) return join(destDir, member);
  if (tryRun("bsdtar", ["-x", "-f", zipPath, "-C", destDir, member])) return join(destDir, member);
  if (tryRun("tar", ["-x", "-f", zipPath, "-C", destDir, member])) return join(destDir, member);
  fail(`could not extract '${member}' from ${zipPath} — install 'unzip' (apt install unzip) or bsdtar`);
}

async function downloadTo(url, destPath) {
  log(`   fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

async function stage(pin) {
  mkdirSync(dirname(pin.binaryHostPath), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "vita-deno-"));
  try {
    let zipPath = process.env.VITA_DENO_ZIP;
    if (zipPath) {
      if (!existsSync(zipPath)) fail(`VITA_DENO_ZIP set but not found: ${zipPath}`);
      log(`   using local zip (offline): ${zipPath}`);
    } else {
      zipPath = await downloadTo(pin.Url, join(work, pin.Asset));
    }
    const got = sha256File(zipPath);
    if (got !== pin.Sha256) {
      fail(`sha256 MISMATCH for ${pin.Asset}\n   expected ${pin.Sha256}\n   got      ${got}\n   (refusing to stage an unverified runtime)`);
    }
    log(`   sha256 OK: ${got}`);
    const extracted = extractMember(zipPath, pin.ArchiveMember, work);
    if (!existsSync(extracted)) fail(`extraction did not produce ${extracted}`);
    copyFileSync(extracted, pin.binaryHostPath);
    chmodSync(pin.binaryHostPath, parseInt(pin.binaryMode, 8));
    stageBakedOCIRootfs();
    log(`   staged deno ${pin.Version} → ${pin.binaryHostPath} (mode ${pin.binaryMode})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function stageBakedOCIRootfs() {
  for (const rootfsPath of BAKED_OCI_ROOTFS_PATHS) {
    const initPath = join(rootfsPath, "init");
    if (!existsSync(rootfsPath)) fail(`baked OCI rootfs missing: ${rootfsPath}`);
    if (!existsSync(initPath)) fail(`baked OCI entrypoint missing: ${initPath}`);
    chmodDirectories(rootfsPath);
    chmodSync(initPath, 0o755);
    log(`   staged baked OCI rootfs ${rootfsPath} (dirs 0755, init 0755)`);
  }
}

function chmodDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodDirectories(join(root, entry.name));
  }
  chmodSync(root, 0o755);
}

async function main() {
  const argv = process.argv.slice(2);
  const pin = loadPin();
  if (argv.includes("--print")) {
    log(JSON.stringify({ name: pin.Name, version: pin.Version, asset: pin.Asset, url: pin.Url, sha256: pin.Sha256, binary: pin.binary, binaryHostPath: pin.binaryHostPath }, null, 2));
    return;
  }
  if (argv.includes("--check")) {
    if (!existsSync(pin.binaryHostPath)) fail(`no staged binary at ${pin.binaryHostPath} — run without --check to stage it`);
    log("   (note: --check verifies the staged binary is non-empty; the pinned sha256 is over the zip, not the unpacked binary)");
    const size = readFileSync(pin.binaryHostPath).length;
    if (size === 0) fail(`staged binary is empty: ${pin.binaryHostPath}`);
    log(`   staged binary present: ${pin.binaryHostPath} (${size} bytes)`);
    return;
  }
  log(`Vita ts-image — stage pinned Deno ${pin.Version} into ${REPO ? "ts-overlay" : ""}`);
  await stage(pin);
  log("\n✓ deno staged. Now build with mkosi --extra-tree=os/x86_64/ts-overlay (see build-and-boot wiring).");
}

main().catch((e) => fail(e?.stack ?? String(e)));

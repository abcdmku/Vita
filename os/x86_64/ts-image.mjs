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
// Offline / air-gapped: set VITA_DENO_ZIP=/path/to/deno-x86_64-unknown-linux-gnu.zip and/or
// VITA_WASMTIME_TARBALL=/path/to/wasmtime-v36.0.11-x86_64-linux.tar.xz to stage from local copies
// instead of downloading (still sha256-verified against the pins).

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
const OWNER_FIXTURE_DIR = join(OVERLAY_ROOT, "usr", "lib", "vita", "owner");
const OWNER_CREDENTIAL_PATH = join(OWNER_FIXTURE_DIR, "owner-credential.json");
const OWNER_ASSERTION_PATH = join(OWNER_FIXTURE_DIR, "owner-assertion.json");
const OWNER_FIXTURE_RP_ID = "owner.example.com";
const OWNER_FIXTURE_ACTION = "vita.owner.test-action";
const BAKED_OCI_ROOTFS_PATHS = Object.freeze([
  join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", "local.oci.capsule", "rootfs"),
  join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", "local.hostile-oci.capsule", "rootfs"),
]);
const BAKED_WASM_CAPSULES = Object.freeze([
  Object.freeze({
    id: "local.wasm.capsule",
    module: "component.wasm",
    // Deterministic wasm32-wasip1 binary matching local.wasm.capsule/component.wat.
    wasmBase64:
      "AGFzbQEAAAABEANgBH9/f38Bf2AAAX9gAAACSAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzELc2NoZWRfeWllbGQAAQMCAQIFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAgolASMAQQBBEDYCAEEEQR82AgBBAUEAQQFBCBAAGgNAEAEaDAALCwslAQBBEAsfVklUQS1XQVNNLUNBUFNVTEU6IHNlbnRpbmVsPU9LCg==",
  }),
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

function overlayHostPath(installPath) {
  return join(OVERLAY_ROOT, installPath.replace(/^\//, ""));
}

function requireKeys(block, section, keys) {
  for (const key of keys) {
    if (!block[key]) fail(`ts-image.conf missing required key ${section}.${key}`);
  }
}

function assertSha256(value, section) {
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`ts-image.conf ${section}.Sha256 must be 64 lowercase hex chars, got: ${value}`);
}

function loadPins() {
  if (!existsSync(CONFIG_PATH)) fail(`missing ${CONFIG_PATH}`);
  const conf = parseConf(readFileSync(CONFIG_PATH, "utf8"));
  const r = conf.Runtime ?? {};
  const i = conf.Install ?? {};
  const w = conf.Wasmtime ?? {};
  requireKeys(r, "Runtime", ["Version", "Asset", "Url", "Sha256", "ArchiveMember"]);
  requireKeys(i, "Install", ["Binary", "BinaryMode"]);
  requireKeys(w, "Wasmtime", ["Version", "Asset", "Url", "Sha256", "ArchiveMember", "Binary", "BinaryMode"]);
  assertSha256(r.Sha256, "Runtime");
  assertSha256(w.Sha256, "Wasmtime");
  return {
    deno: { ...r, binary: i.Binary, binaryMode: i.BinaryMode, binaryHostPath: overlayHostPath(i.Binary) },
    wasmtime: { ...w, binary: w.Binary, binaryMode: w.BinaryMode, binaryHostPath: overlayHostPath(w.Binary) },
  };
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

function extractTarMember(tarPath, member, destDir) {
  const tryRun = (exe, args) => {
    const r = spawnSync(exe, args, { stdio: ["ignore", "inherit", "inherit"] });
    return r.error === undefined && r.status === 0;
  };
  if (tryRun("bsdtar", ["-x", "-f", tarPath, "-C", destDir, member])) return join(destDir, member);
  if (tryRun("tar", ["-x", "-f", tarPath, "-C", destDir, member])) return join(destDir, member);
  fail(`could not extract '${member}' from ${tarPath} - install bsdtar or GNU tar with xz support`);
}

async function downloadTo(url, destPath) {
  log(`   fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

async function stageDeno(pin) {
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
    log(`   staged deno ${pin.Version} → ${pin.binaryHostPath} (mode ${pin.binaryMode})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function stageWasmtime(pin) {
  mkdirSync(dirname(pin.binaryHostPath), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "vita-wasmtime-"));
  try {
    let tarballPath = process.env.VITA_WASMTIME_TARBALL;
    if (tarballPath) {
      if (!existsSync(tarballPath)) fail(`VITA_WASMTIME_TARBALL set but not found: ${tarballPath}`);
      log(`   using local wasmtime tarball (offline): ${tarballPath}`);
    } else {
      tarballPath = await downloadTo(pin.Url, join(work, pin.Asset));
    }
    const got = sha256File(tarballPath);
    if (got !== pin.Sha256) {
      fail(`sha256 MISMATCH for ${pin.Asset}\n   expected ${pin.Sha256}\n   got      ${got}\n   (refusing to stage an unverified runtime)`);
    }
    log(`   sha256 OK: ${got}`);
    const extracted = extractTarMember(tarballPath, pin.ArchiveMember, work);
    if (!existsSync(extracted)) fail(`extraction did not produce ${extracted}`);
    copyFileSync(extracted, pin.binaryHostPath);
    chmodSync(pin.binaryHostPath, parseInt(pin.binaryMode, 8));
    log(`   staged wasmtime ${pin.Version} -> ${pin.binaryHostPath} (mode ${pin.binaryMode})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function stage(pins) {
  await stageDeno(pins.deno);
  await stageWasmtime(pins.wasmtime);
  stageOwnerFixture();
  stageBakedOCIRootfs();
  stageBakedWasmCapsules();
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

function stageBakedWasmCapsules() {
  for (const capsule of BAKED_WASM_CAPSULES) {
    const capsuleDir = join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", capsule.id);
    const modulePath = join(capsuleDir, capsule.module);
    const sourcePath = join(capsuleDir, "component.wat");
    if (!existsSync(capsuleDir)) fail(`baked WASM capsule missing: ${capsuleDir}`);
    if (!existsSync(sourcePath)) fail(`baked WASM source missing: ${sourcePath}`);
    const bytes = Buffer.from(capsule.wasmBase64, "base64");
    if (!WebAssembly.validate(bytes)) fail(`baked WASM module bytes are invalid for ${capsule.id}`);
    writeFileSync(modulePath, bytes);
    chmodSync(modulePath, 0o644);
    log(`   staged baked WASM capsule ${capsule.id}/${capsule.module} (${bytes.length} bytes, mode 0644)`);
  }
}

// --check MUST be read-only and deterministic: validate the tracked baked WASM WITHOUT writing or
// chmod-ing tracked overlay inputs. Rewriting/chmod-ing a tracked file during --check mutates the
// working tree (a non-deterministic, dirtying side effect). Staged executable/file modes are applied
// ONLY by the real build/pack path (stageBakedWasmCapsules), never by --check.
function checkBakedWasmCapsules() {
  for (const capsule of BAKED_WASM_CAPSULES) {
    const capsuleDir = join(OVERLAY_ROOT, "usr", "lib", "vita", "capsules", capsule.id);
    const modulePath = join(capsuleDir, capsule.module);
    const sourcePath = join(capsuleDir, "component.wat");
    if (!existsSync(capsuleDir)) fail(`baked WASM capsule missing: ${capsuleDir}`);
    if (!existsSync(sourcePath)) fail(`baked WASM source missing: ${sourcePath}`);
    const expected = Buffer.from(capsule.wasmBase64, "base64");
    if (!WebAssembly.validate(expected)) fail(`baked WASM module bytes are invalid for ${capsule.id}`);
    if (!existsSync(modulePath)) fail(`baked WASM module not staged: ${modulePath} — run without --check to stage it`);
    const staged = readFileSync(modulePath);
    if (!staged.equals(expected)) {
      fail(`baked WASM module out of date: ${modulePath} does not match expected bytes — run without --check to restage`);
    }
    log(`   verified baked WASM capsule ${capsule.id}/${capsule.module} (${staged.length} bytes, tracked input unchanged)`);
  }
}

function stageOwnerFixture() {
  if (!existsSync(OWNER_FIXTURE_DIR)) fail(`owner fixture directory missing: ${OWNER_FIXTURE_DIR}`);
  if (!existsSync(OWNER_CREDENTIAL_PATH)) fail(`owner public credential fixture missing: ${OWNER_CREDENTIAL_PATH}`);
  if (!existsSync(OWNER_ASSERTION_PATH)) fail(`owner assertion fixture missing: ${OWNER_ASSERTION_PATH}`);

  const credentialText = readFileSync(OWNER_CREDENTIAL_PATH, "utf8");
  const assertionText = readFileSync(OWNER_ASSERTION_PATH, "utf8");
  rejectInlineOwnerSecretMaterial(credentialText, OWNER_CREDENTIAL_PATH);
  rejectInlineOwnerSecretMaterial(assertionText, OWNER_ASSERTION_PATH);

  const credential = parseJSONFile(credentialText, OWNER_CREDENTIAL_PATH);
  const fixture = parseJSONFile(assertionText, OWNER_ASSERTION_PATH);
  validateOwnerCredentialFixture(credential);
  validateOwnerAssertionFixture(fixture, credential);
  log(`   verified owner public credential + pre-signed reject fixture`);
}

function parseJSONFile(text, path) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail(`invalid JSON in ${path}: ${cause?.message ?? String(cause)}`);
  }
}

function validateOwnerCredentialFixture(value) {
  if (!isPlainObject(value)) fail("owner credential fixture must be a JSON object");
  assertBase64URL(value.credentialId, "owner credential credentialId", 1, 1024);
  assertBase64URL(value.publicKeyCose, "owner credential publicKeyCose", 1, 4096);
  assertBase64URL(value.userHandle, "owner credential userHandle", 1, 64);
  if (value.rpId !== OWNER_FIXTURE_RP_ID) fail(`owner credential rpId must be ${OWNER_FIXTURE_RP_ID}`);
  if (!Number.isSafeInteger(value.signCount) || value.signCount < 0) fail("owner credential signCount must be a non-negative integer");
  if (value.aaguid !== undefined && typeof value.aaguid !== "string") fail("owner credential aaguid must be a string when present");
  if (value.transports !== undefined) {
    if (!Array.isArray(value.transports) || value.transports.length === 0) fail("owner credential transports must be a non-empty array when present");
    for (const transport of value.transports) {
      if (typeof transport !== "string" || transport.length === 0) fail("owner credential transports must contain strings");
    }
  }
}

function validateOwnerAssertionFixture(value, credential) {
  if (!isPlainObject(value)) fail("owner assertion fixture must be a JSON object");
  if (value.action !== OWNER_FIXTURE_ACTION) fail(`owner assertion fixture action must be ${OWNER_FIXTURE_ACTION}`);
  assertBase64URL(value.challenge, "owner assertion fixture challenge", 32, 32);
  const assertion = value.assertion;
  if (!isPlainObject(assertion)) fail("owner assertion fixture assertion must be a JSON object");
  if (assertion.credentialId !== credential.credentialId) fail("owner assertion fixture credentialId must match public credential");
  if (assertion.action !== OWNER_FIXTURE_ACTION) fail(`owner assertion action must be ${OWNER_FIXTURE_ACTION}`);
  assertBase64URL(assertion.authenticatorData, "owner assertion authenticatorData", 37, 4096);
  const clientDataJSON = assertBase64URL(assertion.clientDataJSON, "owner assertion clientDataJSON", 1, 8192).toString("utf8");
  assertBase64URL(assertion.signature, "owner assertion signature", 1, 512);
  const clientData = parseJSONFile(clientDataJSON, "owner assertion clientDataJSON");
  if (!isPlainObject(clientData)) fail("owner assertion clientDataJSON must decode to an object");
  if (
    clientData.type !== "webauthn.get" ||
    clientData.challenge !== value.challenge ||
    clientData.origin !== `https://${OWNER_FIXTURE_RP_ID}`
  ) {
    fail("owner assertion fixture clientDataJSON must match action challenge and origin");
  }
}

function assertBase64URL(value, label, minBytes, maxBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.includes("=")) {
    fail(`${label} must be base64url without padding`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length < minBytes || decoded.length > maxBytes) {
    fail(`${label} must decode to ${minBytes}..${maxBytes} bytes`);
  }
  return decoded;
}

function rejectInlineOwnerSecretMaterial(text, path) {
  const lowered = text.toLowerCase();
  for (const marker of ["-----begin", "private_key", "privatekey", "openssh private key", "age-secret-key", "seed phrase", "mnemonic"]) {
    if (lowered.includes(marker)) fail(`owner fixture ${path} contains private-key marker ${marker}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chmodDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodDirectories(join(root, entry.name));
  }
  chmodSync(root, 0o755);
}

async function main() {
  const argv = process.argv.slice(2);
  const pins = loadPins();
  if (argv.includes("--print")) {
    log(JSON.stringify({
      deno: { name: pins.deno.Name, version: pins.deno.Version, asset: pins.deno.Asset, url: pins.deno.Url, sha256: pins.deno.Sha256, binary: pins.deno.binary, binaryHostPath: pins.deno.binaryHostPath },
      wasmtime: { name: pins.wasmtime.Name, version: pins.wasmtime.Version, asset: pins.wasmtime.Asset, url: pins.wasmtime.Url, sha256: pins.wasmtime.Sha256, binary: pins.wasmtime.binary, binaryHostPath: pins.wasmtime.binaryHostPath },
    }, null, 2));
    return;
  }
  if (argv.includes("--check")) {
    checkStagedBinary(pins.deno);
    checkStagedBinary(pins.wasmtime);
    stageOwnerFixture();
    checkBakedWasmCapsules();
    return;
  }
  log(`Vita ts-image — stage pinned Deno ${pins.deno.Version} + Wasmtime ${pins.wasmtime.Version} into ${REPO ? "ts-overlay" : ""}`);
  await stage(pins);
  log("\n✓ runtimes staged. Now build with mkosi --extra-tree=os/x86_64/ts-overlay (see build-and-boot wiring).");
}

function checkStagedBinary(pin) {
  if (!existsSync(pin.binaryHostPath)) fail(`no staged binary at ${pin.binaryHostPath} — run without --check to stage it`);
  log("   (note: --check verifies the staged binary is non-empty; the pinned sha256 is over the archive, not the unpacked binary)");
  const size = readFileSync(pin.binaryHostPath).length;
  if (size === 0) fail(`staged binary is empty: ${pin.binaryHostPath}`);
  log(`   staged binary present: ${pin.binaryHostPath} (${size} bytes)`);
}

main().catch((e) => fail(e?.stack ?? String(e)));

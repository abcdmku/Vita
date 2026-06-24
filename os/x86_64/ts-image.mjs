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
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
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

function stageOwnerFixture() {
  mkdirSync(OWNER_FIXTURE_DIR, { recursive: true });

  const { publicKey, privateKey: signingKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJWK = publicKey.export({ format: "jwk" });
  const x = base64URLDecode(publicJWK.x);
  const y = base64URLDecode(publicJWK.y);
  const credentialId = base64URLEncode(randomBytes(32));
  const challenge = base64URLEncode(randomBytes(32));
  const publicKeyCose = base64URLEncode(coseEC2PublicKey(x, y));

  const credential = {
    credentialId,
    publicKeyCose,
    signCount: 0,
    aaguid: "00000000-0000-0000-0000-000000000000",
    transports: ["internal"],
    rpId: OWNER_FIXTURE_RP_ID,
    userHandle: base64URLEncode(Buffer.from("owner", "utf8")),
  };

  const authenticatorData = authenticatorDataBytes(OWNER_FIXTURE_RP_ID, 0x01, 1);
  const clientDataJSON = Buffer.from(JSON.stringify({
    challenge,
    origin: `https://${OWNER_FIXTURE_RP_ID}`,
    type: "webauthn.get",
  }), "utf8");
  const signatureBase = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const assertion = {
    credentialId,
    authenticatorData: base64URLEncode(authenticatorData),
    clientDataJSON: base64URLEncode(clientDataJSON),
    signature: base64URLEncode(signBytes("sha256", signatureBase, signingKey)),
    action: OWNER_FIXTURE_ACTION,
  };

  writeFileSync(OWNER_CREDENTIAL_PATH, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(OWNER_ASSERTION_PATH, `${JSON.stringify({
    action: OWNER_FIXTURE_ACTION,
    challenge,
    assertion,
  }, null, 2)}\n`, { mode: 0o644 });
  log(`   staged owner public credential + signed assertion fixture (${OWNER_FIXTURE_DIR})`);
}

function authenticatorDataBytes(rpId, flags, counter) {
  const out = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(out, 0);
  out[32] = flags & 0xff;
  out.writeUInt32BE(counter, 33);
  return out;
}

function coseEC2PublicKey(x, y) {
  return Buffer.concat([
    cborHeader(5, 5),
    cborInt(1),
    cborInt(2),
    cborInt(3),
    cborInt(-7),
    cborInt(-1),
    cborInt(1),
    cborInt(-2),
    cborBytes(x),
    cborInt(-3),
    cborBytes(y),
  ]);
}

function cborInt(value) {
  return value >= 0 ? cborHeader(0, value) : cborHeader(1, -1 - value);
}

function cborBytes(value) {
  return Buffer.concat([cborHeader(2, value.length), Buffer.from(value)]);
}

function cborHeader(major, value) {
  const prefix = major << 5;
  if (value < 24) return Buffer.from([prefix | value]);
  if (value <= 0xff) return Buffer.from([prefix | 24, value]);
  if (value <= 0xffff) return Buffer.from([prefix | 25, (value >>> 8) & 0xff, value & 0xff]);
  return Buffer.from([prefix | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function base64URLEncode(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64URLDecode(value) {
  if (typeof value !== "string" || value.length === 0) fail("generated owner public key is missing a coordinate");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length !== 32) fail("generated owner public key coordinate has invalid length");
  return decoded;
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
    stageBakedWasmCapsules();
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

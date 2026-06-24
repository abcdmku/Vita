#!/usr/bin/env node
// Vita arm64 TypeScript runtime staging step (P1-091).
//
// Fetches the pinned aarch64 Deno and Wasmtime release assets, verifies each
// archive against os/arm64/ts-image.conf, extracts the executable members, and
// stages only those binaries under os/arm64/ts-runtime-overlay. The TS source
// and service overlay is shared from os/x86_64/ts-overlay; generated binaries
// stay gitignored build artifacts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "ts-image.conf");
const RUNTIME_OVERLAY_ROOT = join(HERE, "ts-runtime-overlay");
const SHARED_TS_OVERLAY_ROOT = join(HERE, "..", "x86_64", "ts-overlay");

function fail(message) {
  console.error(`\nERROR: ts-image arm64: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(message);
}

function parseConf(text) {
  const output = {};
  let section = "";
  for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      output[section] ??= {};
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0 || section === "") {
      fail(`bad config line: ${raw}`);
    }
    output[section][line.slice(0, equalsIndex).trim()] = line.slice(equalsIndex + 1).trim();
  }
  return output;
}

function requireKeys(block, section, keys) {
  for (const key of keys) {
    if (typeof block[key] !== "string" || block[key].length === 0) {
      fail(`ts-image.conf missing required key ${section}.${key}`);
    }
  }
}

function assertSha256(value, section) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail(`ts-image.conf ${section}.Sha256 must be 64 lowercase hex chars, got: ${value}`);
  }
}

function overlayHostPath(installPath) {
  return join(RUNTIME_OVERLAY_ROOT, installPath.replace(/^\//, ""));
}

function loadPins() {
  if (!existsSync(CONFIG_PATH)) {
    fail(`missing ${CONFIG_PATH}`);
  }

  const config = parseConf(readFileSync(CONFIG_PATH, "utf8"));
  const runtime = config.Runtime ?? {};
  const wasmtime = config.Wasmtime ?? {};
  const install = config.Install ?? {};
  requireKeys(runtime, "Runtime", ["Name", "Version", "Asset", "Url", "Sha256", "ArchiveMember"]);
  requireKeys(wasmtime, "Wasmtime", [
    "Name",
    "Version",
    "Asset",
    "Url",
    "Sha256",
    "ArchiveMember",
    "Binary",
    "BinaryMode",
  ]);
  requireKeys(install, "Install", ["Binary", "BinaryMode"]);
  assertSha256(runtime.Sha256, "Runtime");
  assertSha256(wasmtime.Sha256, "Wasmtime");

  return {
    deno: {
      ...runtime,
      binary: install.Binary,
      binaryMode: install.BinaryMode,
      binaryHostPath: overlayHostPath(install.Binary),
      localEnv: "VITA_ARM64_DENO_ZIP",
      fallbackEnv: "VITA_DENO_ZIP",
    },
    wasmtime: {
      ...wasmtime,
      binary: wasmtime.Binary,
      binaryMode: wasmtime.BinaryMode,
      binaryHostPath: overlayHostPath(wasmtime.Binary),
      localEnv: "VITA_ARM64_WASMTIME_TARBALL",
      fallbackEnv: "VITA_WASMTIME_TARBALL",
    },
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tryRun(executable, args) {
  const result = spawnSync(executable, args, { stdio: ["ignore", "inherit", "inherit"] });
  return result.error === undefined && result.status === 0;
}

function extractZipMember(zipPath, member, destinationDirectory) {
  if (tryRun("unzip", ["-o", "-q", zipPath, member, "-d", destinationDirectory])) {
    return join(destinationDirectory, member);
  }
  if (tryRun("bsdtar", ["-x", "-f", zipPath, "-C", destinationDirectory, member])) {
    return join(destinationDirectory, member);
  }
  if (tryRun("tar", ["-x", "-f", zipPath, "-C", destinationDirectory, member])) {
    return join(destinationDirectory, member);
  }
  fail(`could not extract ${member} from ${zipPath}; install unzip or bsdtar`);
}

function extractTarMember(tarPath, member, destinationDirectory) {
  if (tryRun("bsdtar", ["-x", "-f", tarPath, "-C", destinationDirectory, member])) {
    return join(destinationDirectory, member);
  }
  if (tryRun("tar", ["-x", "-f", tarPath, "-C", destinationDirectory, member])) {
    return join(destinationDirectory, member);
  }
  fail(`could not extract ${member} from ${tarPath}; install bsdtar or GNU tar with xz support`);
}

async function downloadTo(url, destinationPath) {
  log(`   fetching ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    fail(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  writeFileSync(destinationPath, Buffer.from(await response.arrayBuffer()));
  return destinationPath;
}

async function stageArchive(pin, extractMember) {
  mkdirSync(dirname(pin.binaryHostPath), { recursive: true });
  const workDirectory = mkdtempSync(join(tmpdir(), `vita-arm64-${pin.Name}-`));
  try {
    let archivePath = process.env[pin.localEnv] ?? process.env[pin.fallbackEnv];
    if (archivePath !== undefined && archivePath.length > 0) {
      if (!existsSync(archivePath)) {
        fail(`${pin.localEnv} is set but not found: ${archivePath}`);
      }
      log(`   using local archive: ${archivePath}`);
    } else {
      archivePath = await downloadTo(pin.Url, join(workDirectory, pin.Asset));
    }

    const got = sha256File(archivePath);
    if (got !== pin.Sha256) {
      fail(`sha256 mismatch for ${pin.Asset}; expected ${pin.Sha256}, got ${got}`);
    }
    const extracted = extractMember(archivePath, pin.ArchiveMember, workDirectory);
    if (!existsSync(extracted)) {
      fail(`extraction did not produce ${extracted}`);
    }
    copyFileSync(extracted, pin.binaryHostPath);
    chmodSync(pin.binaryHostPath, Number.parseInt(pin.binaryMode, 8));
    log(`   staged ${pin.Name} ${pin.Version} -> ${pin.binaryHostPath}`);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

function assertSharedTsOverlay() {
  for (const relativePath of [
    "usr/lib/vita/ts/main.ts",
    "usr/lib/systemd/system/vita-ts.service",
    "usr/lib/systemd/system/multi-user.target.wants/vita-ts.service",
  ]) {
    const path = join(SHARED_TS_OVERLAY_ROOT, relativePath);
    if (!existsSync(path)) {
      fail(`shared TS overlay is missing ${path}`);
    }
  }
}

function checkStagedBinary(pin) {
  if (!existsSync(pin.binaryHostPath)) {
    fail(`no staged ${pin.Name} binary at ${pin.binaryHostPath}; run without --check to stage it`);
  }
  const size = readFileSync(pin.binaryHostPath).length;
  if (size === 0) {
    fail(`staged ${pin.Name} binary is empty: ${pin.binaryHostPath}`);
  }
  log(`   staged ${pin.Name} binary present: ${pin.binaryHostPath} (${size} bytes)`);
}

async function main() {
  const args = process.argv.slice(2);
  const pins = loadPins();

  if (args.includes("--print")) {
    log(JSON.stringify({
      deno: {
        version: pins.deno.Version,
        asset: pins.deno.Asset,
        url: pins.deno.Url,
        sha256: pins.deno.Sha256,
        binary: pins.deno.binary,
      },
      wasmtime: {
        version: pins.wasmtime.Version,
        asset: pins.wasmtime.Asset,
        url: pins.wasmtime.Url,
        sha256: pins.wasmtime.Sha256,
        binary: pins.wasmtime.binary,
      },
      sharedSourceOverlay: SHARED_TS_OVERLAY_ROOT,
      runtimeOverlay: RUNTIME_OVERLAY_ROOT,
    }, null, 2));
    return;
  }

  assertSharedTsOverlay();
  if (args.includes("--check")) {
    checkStagedBinary(pins.deno);
    checkStagedBinary(pins.wasmtime);
    return;
  }

  log("Vita arm64 ts-image: staging pinned aarch64 Deno and Wasmtime runtime binaries");
  await stageArchive(pins.deno, extractZipMember);
  await stageArchive(pins.wasmtime, extractTarMember);
  log("runtime binaries staged; mkosi can now apply --extra-tree=os/arm64/ts-runtime-overlay");
}

main().catch((error) => fail(error?.stack ?? String(error)));

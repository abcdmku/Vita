#!/usr/bin/env node
// Build the Vita compositor Rust binary inside the pinned Linux Rust container.
// Usage:
//   node tools/build/rust-in-docker.mjs
//   node tools/build/rust-in-docker.mjs --dir packages/compositor-core --out os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor
//
// The build runs as linux/amd64 regardless of the host, writes Cargo output under os/x86_64/out,
// and copies the release binary to the smoke overlay path that mkosi bakes into verification images.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_RUST_IMAGE = "rust:1.88.0-bookworm";
const DEFAULT_MODULE_DIR = "packages/compositor-core";
const DEFAULT_TARGET = "x86_64-unknown-linux-gnu";
const DEFAULT_BINARY_NAME = "vita-compositor-core";
const DEFAULT_OUTPUT = "os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor";
const DEFAULT_SOURCE_DATE_EPOCH = "1781308800";

let args = process.argv.slice(2);
let dir = DEFAULT_MODULE_DIR;
let out = DEFAULT_OUTPUT;
const extraEnv = [];

while (args[0] === "--dir" || args[0] === "--out" || args[0] === "--env") {
  const flag = args[0];
  const value = args[1] ?? "";
  if (flag === "--dir") {
    dir = value || DEFAULT_MODULE_DIR;
  } else if (flag === "--out") {
    out = value || DEFAULT_OUTPUT;
  } else {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      console.error(`--env expects KEY=VALUE, got: ${value}`);
      process.exit(2);
    }
    extraEnv.push("-e", value);
  }
  args = args.slice(2);
}

if (args.length !== 0) {
  console.error(
    "usage: node tools/build/rust-in-docker.mjs [--dir <subdir>] [--out <path>] [--env KEY=VALUE ...]",
  );
  process.exit(2);
}

const image = process.env.VITA_RUST_IMAGE || DEFAULT_RUST_IMAGE;
const cwd = process.cwd();
const normalizedDir = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const workdir = `/work/${normalizedDir}`;
const targetRoot = "/work/os/x86_64/out/rust/target";
const cargoArgs = [
  "build",
  "--release",
  "--locked",
  "--target",
  DEFAULT_TARGET,
  "--bin",
  DEFAULT_BINARY_NAME,
];

mkdirSync(join(cwd, "os", "x86_64", "out", "rust", "target"), { recursive: true });

const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--pull=never",
    "--network",
    "none",
    "-v",
    `${cwd}:/work`,
    "-w",
    workdir,
    "-e",
    `CARGO_TARGET_DIR=${targetRoot}`,
    "-e",
    "CARGO_INCREMENTAL=0",
    "-e",
    "CARGO_NET_OFFLINE=true",
    "-e",
    "CARGO_TERM_COLOR=never",
    "-e",
    "LC_ALL=C.UTF-8",
    "-e",
    `SOURCE_DATE_EPOCH=${DEFAULT_SOURCE_DATE_EPOCH}`,
    "-e",
    "TZ=UTC",
    "-e",
    "RUSTFLAGS=-C debuginfo=0 -C link-arg=-Wl,--build-id=none",
    ...extraEnv,
    image,
    "cargo",
    ...cargoArgs,
  ],
  { stdio: "inherit" },
);

if (run.error) {
  console.error(`docker spawn error: ${run.error.message}`);
  process.exit(1);
}
if ((run.status ?? 1) !== 0) {
  process.exit(run.status ?? 1);
}

const built = join(cwd, "os", "x86_64", "out", "rust", "target", DEFAULT_TARGET, "release", DEFAULT_BINARY_NAME);
const destination = resolve(cwd, out);
if (!existsSync(built)) {
  console.error(`cargo build did not produce ${built}`);
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(built, destination);
chmodSync(destination, 0o755);
console.log(`staged ${DEFAULT_BINARY_NAME} -> ${destination}`);

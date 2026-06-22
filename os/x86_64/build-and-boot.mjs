#!/usr/bin/env node
// Vita x86_64 — one-script build & boot orchestrator.
//
// Wires the in-repo deterministic PLANNERS (build-root / uki / image-layout) to a real Linux host: it derives
// the exact mkosi + ukify commands from those plans (single source of truth — never duplicated here), then
// fills the steps the planners leave gated (dm-verity, repart execution, Secure Boot signing, RAUC, QEMU) with
// host tooling. Run on a privileged Linux host; this is the executor the planners describe (spec §8.2: the
// plans stay pure/no-I/O, this script is the I/O boundary).
//
// USAGE:
//   node os/x86_64/build-and-boot.mjs --dry-run            # print the full derived pipeline, run nothing
//   node os/x86_64/build-and-boot.mjs --mode=smoke         # rootfs -> unsigned disk -> QEMU (fast, no verity)
//   node os/x86_64/build-and-boot.mjs --mode=full          # rootfs -> verity -> UKI -> A/B -> sign -> RAUC -> QEMU
//   node os/x86_64/build-and-boot.mjs --mode=full --no-boot # build everything, don't launch QEMU
//
// ENV (full mode):
//   VITA_SB_KEY   path to the Secure Boot signing key   (required for --mode=full unless --no-sign)
//   VITA_SB_CERT  path to the Secure Boot signing cert   (required for --mode=full unless --no-sign)
//   VITA_MKOSI_CACHE  dir for the Debian package cache (default: os/x86_64/.cache) — populated on first run
//   VITA_OVMF_CODE / VITA_OVMF_VARS  OVMF firmware paths for QEMU (defaults to common Debian locations)

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planRootBuild, PINNED_MKOSI_IMAGE } from "./build-root.mjs";
import { planUKI } from "./uki.mjs";
import { planImageLayout } from "./image-layout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };

const DRY = has("--dry-run");
const MODE = opt("--mode", "smoke");
const NO_BOOT = has("--no-boot");
const NO_SIGN = has("--no-sign");
const OUT = resolve(opt("--out", join(HERE, "out")));
const CACHE = resolve(process.env.VITA_MKOSI_CACHE ?? join(HERE, ".cache"));

if (!["smoke", "full"].includes(MODE)) fail(`--mode must be smoke|full, got ${MODE}`);

function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function log(msg) { console.log(msg); }

// Run a step: in --dry-run just print it; otherwise spawn and fail-fast on nonzero exit.
function run(label, executable, args, { cwd = REPO, env = process.env } = {}) {
  log(`\n── ${label}`);
  log(`   $ ${executable} ${args.join(" ")}`);
  if (DRY) return { status: 0, dryRun: true };
  const r = spawnSync(executable, args, { cwd, env, stdio: "inherit" });
  if (r.error) fail(`${label}: ${r.error.message}` + (r.error.code === "ENOENT" ? ` (install ${executable})` : ""));
  if (r.status !== 0) fail(`${label}: exited ${r.status}`);
  return r;
}

// ── Derive commands from the planners (the source of truth) ────────────────────────────────────────────────
function readConfig(p) { return readFileSync(join(REPO, p), "utf8"); }

const rootPlan = planRootBuild({
  commonConfigText: readConfig("os/common/mkosi.conf"),
  archConfigText: readConfig("os/x86_64/mkosi.conf"),
  workspacePath: REPO,
  outputPath: OUT,
});
const ukiPlan = planUKI();
const layoutPlan = planImageLayout();

const mkosiCmd = rootPlan.command;                                   // { executable:"docker", args:[…] }
const ukiStep = ukiPlan.steps.find((s) => s.id === "assemble-uki");  // { command:{ executable, args } }
if (!mkosiCmd?.args || !ukiStep?.command?.args) fail("planner shape changed — re-wire build-and-boot.mjs");

log(`Vita build-and-boot — mode=${MODE}${DRY ? " (dry-run)" : ""}`);
log(`  repo=${REPO}\n  out=${OUT}\n  cache=${CACHE}\n  mkosi=${PINNED_MKOSI_IMAGE}`);
if (!DRY) { mkdirSync(OUT, { recursive: true }); mkdirSync(CACHE, { recursive: true }); }

// ── Step 0: pull the pinned mkosi image (the plan uses --pull=never, so it must be present) ─────────────────
run("0 · pull mkosi image", "docker", ["pull", PINNED_MKOSI_IMAGE]);

// ── Step 1: build the read-only Debian rootfs ───────────────────────────────────────────────────────────────
// The planner's args are hermetic (--network none, --pull=never, ro mount). For a REAL build we must let
// packages in and let mkosi write/create devices: mount the cache, allow network for the fetch, and run
// privileged. We derive the planned `mkosi …` tail and re-wrap the docker invocation so the plan stays the
// source of truth for the mkosi flags while we adjust only the container execution policy.
const mkosiTail = mkosiCmd.args.slice(mkosiCmd.args.indexOf("mkosi")); // ["mkosi","--directory",…,"--output-dir",…]
const buildArgs = [
  "run", "--rm", "--privileged",
  "-v", `${REPO}:/work`,                       // rw (planner used :ro; a real build needs to write workspace caches)
  "-v", `${OUT}:/output`,
  "-v", `${CACHE}:/var/cache/mkosi`,           // persistent Debian package cache (populated on first run)
  "-w", "/work/os/x86_64",
  "-e", `SOURCE_DATE_EPOCH=${rootPlan.environment?.SOURCE_DATE_EPOCH ?? "1781308800"}`,
  "-e", "TZ=UTC", "-e", "LC_ALL=C.UTF-8",
  PINNED_MKOSI_IMAGE,
  ...mkosiTail,
  "--cache-dir", "/var/cache/mkosi",
];
run("1 · build rootfs (mkosi, privileged, cached)", "docker", buildArgs);

const rootfs = join(OUT, "vita-debian-trixie-x86_64-root");
log(`   rootfs → ${rootfs}`);

if (MODE === "smoke") {
  // ── Smoke: pack rootfs into a bootable disk (unsigned, no verity) and boot it. Fastest "see it run". ──────
  run("2s · pack bootable disk (mkosi --format disk, smoke)", "docker",
    ["run", "--rm", "--privileged", "-v", `${REPO}:/work`, "-v", `${OUT}:/output`, "-w", "/work/os/x86_64",
     PINNED_MKOSI_IMAGE, "mkosi", "--directory", "/work/os/x86_64", "--output-dir", "/output",
     "--format", "disk", "--bootable=yes", "-f"]);
  if (!NO_BOOT) bootQemu(join(OUT, "vita.raw"), { secureBoot: false });
  log("\n✓ smoke build complete." + (NO_BOOT ? "" : " (booted above)"));
  process.exit(0);
}

// ── FULL trusted-boot chain ─────────────────────────────────────────────────────────────────────────────────
// Step 2: dm-verity — NOT yet emitted by a planner (P1-017 blocked). Compute the hash tree over the read-only
// root and capture the root hash; it goes onto the kernel cmdline so the kernel verifies every block (spec §11).
const verityHash = join(OUT, "vita-root.verity");
log("\n── 2 · dm-verity (P1-017 not yet in a planner — host veritysetup; capture root hash)");
log(`   $ veritysetup format ${rootfs}.img ${verityHash}   # -> Root hash: <ROOTHASH>`);
let roothash = "<ROOTHASH-from-veritysetup>";
if (!DRY) {
  const r = run("2 · veritysetup format", "veritysetup", ["format", `${rootfs}.img`, verityHash]);
  const m = /Root hash:\s*([0-9a-f]+)/i.exec(r.stdout?.toString?.() ?? "");
  if (m) roothash = m[1]; else fail("could not parse veritysetup root hash — check the rootfs image step");
}

// Step 3: UKI — derived from the uki planner; inject roothash=<…> into the cmdline.
// NOTE: the planner's cmdline is still `root=LABEL=… ro` (not roothash-based) because P1-017/verity isn't
// wired yet, so this injection is a no-op until P1-017 makes the UKI cmdline roothash-bearing. Until then the
// UKI boots by label, not by verity root hash — i.e. NOT yet the tamper-evident boot (spec §11).
if (MODE === "full" && !ukiStep.command.args.some((a) => a.includes("roothash="))) {
  log("   ⚠ UKI cmdline is label-based; verity root-hash binding lands with P1-017 (boot is not yet verity-verified)");
}
const ukiArgs = ukiStep.command.args.map((a) => a.includes("roothash=") ? a.replace(/roothash=\S*/, `roothash=${roothash}`) : a);
run("3 · assemble UKI (ukify, verity-bound cmdline)", ukiStep.command.executable, ukiArgs);

// Step 4: A/B GPT layout — image-layout planner is declarative; materialize its repart config and run repart.
log("\n── 4 · GPT + RAUC A/B layout (systemd-repart from image-layout.mjs)");
log(`   partitions: ${(layoutPlan.partitions ?? []).map((p) => p.Name ?? p.id).join(", ") || "(see image-layout.mjs)"}`);
const imageRaw = join(OUT, "vita.raw");
run("4 · systemd-repart", "systemd-repart",
  ["--definitions", join(HERE, "repart.d"), "--empty=create", "--size=auto", imageRaw]);

// Step 5: sign the UKI (Secure Boot) — requires your keys (spec §16).
if (!NO_SIGN) {
  const key = process.env.VITA_SB_KEY, cert = process.env.VITA_SB_CERT;
  if (!key || !cert) fail("full mode needs VITA_SB_KEY + VITA_SB_CERT (or pass --no-sign for an unsigned trial)");
  run("5 · sign UKI (sbsign)", "sbsign",
    ["--key", key, "--cert", cert, "--output", join(OUT, "vita.efi.signed"), join(OUT, "vita.efi")]);
} else {
  log("\n── 5 · sign UKI — SKIPPED (--no-sign): image will not pass Secure Boot");
}

// Step 6: RAUC bundle for A/B updates.
run("6 · RAUC bundle", "rauc",
  ["bundle", "--cert", process.env.VITA_SB_CERT ?? "<cert>", "--key", process.env.VITA_SB_KEY ?? "<key>",
   join(OUT, "rauc-input"), join(OUT, "vita.raucb")]);

// Step 7: boot in QEMU (UEFI + Secure Boot vars).
if (!NO_BOOT) bootQemu(imageRaw, { secureBoot: !NO_SIGN });
log(`\n✓ full build complete → ${imageRaw}` + (NO_SIGN ? " (UNSIGNED)" : " (signed)"));

function bootQemu(image, { secureBoot }) {
  const ovmfCode = process.env.VITA_OVMF_CODE ?? "/usr/share/OVMF/OVMF_CODE.fd";
  const ovmfVars = process.env.VITA_OVMF_VARS ?? join(OUT, "OVMF_VARS.fd");
  run(`7 · QEMU boot (${secureBoot ? "Secure Boot" : "no SB"})`, "qemu-system-x86_64", [
    "-machine", "q35", "-m", "2048", "-cpu", "host", "-enable-kvm",
    "-drive", `if=pflash,format=raw,readonly=on,file=${ovmfCode}`,
    "-drive", `if=pflash,format=raw,file=${ovmfVars}`,
    "-drive", `file=${image},format=raw,if=virtio`,
    "-serial", "mon:stdio", "-nographic",
  ]);
}

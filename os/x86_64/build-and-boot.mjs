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
import { readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planRootBuild, PINNED_MKOSI_IMAGE } from "./build-root.mjs";
import { planUKI } from "./uki.mjs";
import { planImageLayout } from "./image-layout.mjs";
// NB: planVerity is imported dynamically in full mode only (verity.mjs pulls in a .ts helper) — see below.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };

const DRY = has("--dry-run");
const MODE = opt("--mode", "smoke");
const MKOSI = opt("--mkosi", process.env.VITA_MKOSI ?? "auto"); // auto | native | docker
const NO_BOOT = has("--no-boot");
const NO_SIGN = has("--no-sign");
const OUT = resolve(opt("--out", join(HERE, "out")));
const CACHE = resolve(process.env.VITA_MKOSI_CACHE ?? join(HERE, ".cache"));

if (!["smoke", "full"].includes(MODE)) fail(`--mode must be smoke|full, got ${MODE}`);

function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function log(msg) { console.log(msg); }

// Full mode imports verity.mjs, which pulls in a .ts helper (safeNormalize). Node ≥23.6 strips types by default;
// older needs --experimental-strip-types. Load planVerity HERE (before any build work), re-exec once under the
// flag if the .ts load fails, so the user's plain `node …` invocation keeps working. Smoke never loads verity.mjs.
let planVerity;
if (MODE === "full") {
  try {
    ({ planVerity } = await import("./verity.mjs"));
  } catch (e) {
    if (e?.code === "ERR_UNKNOWN_FILE_EXTENSION" && !process.env.VITA_STRIP_RETRY) {
      const r = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), ...argv],
        { stdio: "inherit", env: { ...process.env, VITA_STRIP_RETRY: "1" } });
      process.exit(r.status ?? 1);
    }
    throw e;
  }
}

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

// ── mkosi engine: native host `mkosi` (recommended — no registry) OR the pinned docker container ────────────
// We keep the planner as the source of truth for the mkosi FLAGS (mkosiTail) and adjust only the execution
// engine + container policy. The ghcr image pull is frequently `denied` (pinned digest not anonymously
// pullable), so native mkosi (`pipx install mkosi`) is the reliable path and the default when present.
const mkosiTail = mkosiCmd.args.slice(mkosiCmd.args.indexOf("mkosi")); // ["mkosi","--directory","/work/os/x86_64","--force","--output-dir","/out"]
const CONTAINER_OUT = mkosiTail[mkosiTail.indexOf("--output-dir") + 1] ?? "/out";
const mkosiPresent = !DRY && spawnSync("mkosi", ["--version"], { stdio: "ignore" }).error === undefined;
const useNative = MKOSI === "native" || (MKOSI === "auto" && mkosiPresent);

function dockerBuild(extra = []) {
  return [
    "run", "--rm", "--privileged",
    "-v", `${REPO}:/work`,                     // rw (planner used :ro; a real build writes workspace caches)
    "-v", `${OUT}:${CONTAINER_OUT}`,           // output at the planner's own --output-dir, so it lands on host
    "-v", `${CACHE}:/var/cache/mkosi`,         // persistent Debian package cache (populated on first run)
    "-w", "/work/os/x86_64",
    "-e", `SOURCE_DATE_EPOCH=${rootPlan.environment?.SOURCE_DATE_EPOCH ?? "1781308800"}`,
    "-e", "TZ=UTC", "-e", "LC_ALL=C.UTF-8",
    PINNED_MKOSI_IMAGE,
    ...mkosiTail, "--cache-dir", "/var/cache/mkosi",
    ...extra,
  ];
}
// Native: the SAME planner flags, container paths re-pointed to host paths.
function nativeArgs(extra = []) {
  return mkosiTail.slice(1)
    .map((a) => (a === "/work/os/x86_64" ? HERE : a === CONTAINER_OUT ? OUT : a))
    .concat(["--cache-dir", CACHE], extra);
}
// The committed config pins a snapshot.debian.org mirror for reproducibility, but exact-midnight snapshot
// timestamps often 404 (not real snapshot points). Smoke is non-reproducible by nature → default to the live
// Debian mirror so packages resolve; full keeps the committed config unless VITA_MIRROR is set. Always logged.
// NB: mkosi appends the archive name (/debian, /debian-debug, /debian-security), so this is the HOST root —
// NOT ".../debian" (that produced a 404ing .../debian/debian).
const MIRROR = process.env.VITA_MIRROR ?? (MODE === "smoke" ? "https://deb.debian.org" : "");
function runMkosi(label, extra = []) {
  const e = [...extra, ...(MIRROR ? ["--mirror", MIRROR] : [])];
  if (MIRROR) log(`   (mirror override: --mirror ${MIRROR})`);
  return useNative ? run(label, "mkosi", nativeArgs(e)) : run(label, "docker", dockerBuild(e));
}
// Discover the actual artifact mkosi produced (named after Output= [+ ImageVersion]); robust to mkosi's naming.
function findOutput(suffix) {
  if (DRY || !existsSync(OUT)) return join(OUT, `<mkosi-output${suffix}>`);
  const hit = readdirSync(OUT).find((f) => f.endsWith(suffix));
  if (!hit) fail(`no '${suffix}' artifact in ${OUT} — check the mkosi build step output`);
  return join(OUT, hit);
}

log(`  engine=${useNative ? "host-native mkosi" : `docker ${PINNED_MKOSI_IMAGE}`}`);

// ── Step 0: ensure the mkosi engine is available (docker pull only; native skips the registry) ─────────────
if (useNative) {
  log("\n── 0 · mkosi engine = host-native (no registry pull)");
} else {
  log("\n── 0 · pull mkosi image (docker engine)");
  log(`   $ docker pull ${PINNED_MKOSI_IMAGE}`);
  if (!DRY) {
    const r = spawnSync("docker", ["pull", PINNED_MKOSI_IMAGE], { stdio: "inherit" });
    if (r.status !== 0) fail(
      "mkosi image pull failed (ghcr 'denied' — the pinned digest isn't anonymously pullable). Fix EITHER:\n" +
      "     • host-native (recommended):  pipx install mkosi   (or: sudo apt install mkosi)  — then re-run; auto-detected\n" +
      "     • or docker:  docker login ghcr.io   with a GitHub PAT (read:packages), then re-run");
  }
}

if (MODE === "smoke") {
  // ── Smoke: ONE build straight to a bootable disk (overrides base Format=directory/Bootable=no), then boot.
  // Bake a serial console into the smoke UKI so the kernel/login is visible on QEMU's `-serial mon:stdio`
  // (-nographic). ttyS0 last = primary console (getty/login spawns there); tty0 kept for a VGA head too.
  // --autologin: passwordless root auto-login on the consoles (tty1/ttyS0/hvc0). Smoke is a throwaway test VM,
  // so this is the easy way in; the production/full image gets real auth, never autologin.
  runMkosi("1 · build bootable disk (mkosi --format disk, smoke)",
    ["--format", "disk", "--bootable=yes", "--autologin=yes", "--kernel-command-line", "console=tty0 console=ttyS0,115200 rw"]);
  const disk = findOutput(".raw");
  log(`   disk → ${disk}`);
  if (!NO_BOOT) bootQemu(disk, { secureBoot: false });
  log("\n✓ smoke build complete." + (NO_BOOT ? "" : " (booted above)"));
  process.exit(0);
}

// ── FULL: build the read-only Debian rootfs (the planner's canonical Format=directory build) ────────────────
runMkosi("1 · build rootfs (mkosi directory, privileged, cached)");
const rootfs = join(OUT, "vita-debian-trixie-x86_64-root");
log(`   rootfs → ${rootfs}/ (Format=directory)`);

// ── FULL trusted-boot chain ─────────────────────────────────────────────────────────────────────────────────
// Step 2: dm-verity — derived from the P1-017 planner (planVerity). For each A/B slot it emits the real
// `veritysetup format <root ext4 image> <hash tree> --format 1 --hash sha256 …` command and that slot's UKI
// cmdline (root=<verity-mapped device> roothash=<hex>, never root=LABEL). The root EXT4 image it formats is an
// external precondition from P1-014's rootfs→image conversion, which build-and-boot does not yet execute — so a
// REAL run stops here with that precise gap; --dry-run prints the full verity chain.
const verityPlan = planVerity();
log("\n── 2 · dm-verity (P1-017 planVerity — per-slot hash tree → root hash → UKI cmdline)");
for (const slot of verityPlan.slots) {
  const vs = slot.veritysetup;
  log(`   [${slot.slot}] $ ${vs.executable} ${vs.args.join(" ")}`);
  log(`   [${slot.slot}]   → captures "${vs.expectedStdoutField}" → cmdline: ${slot.uki.cmdline.template}`);
}
const verityRootImage = verityPlan.slots[0]?.dataImage?.path ?? "<root ext4 image>";
let roothash = "${slot.rootHash}"; // resolved from veritysetup's "Root hash:" once the ext4 image exists
if (!DRY) {
  fail("full mode stops at dm-verity: the verity plan is ready, but the root EXT4 image it formats\n" +
       `       (${verityRootImage}) comes from P1-014's rootfs→image conversion, which build-and-boot does not yet\n` +
       "       execute. NEXT WIRING STEP: convert the Format=directory rootfs → A/B ext4 images, then this step runs\n" +
       "       veritysetup, captures the root hash, and binds it into each slot's UKI cmdline. `--mode=smoke` boots now.");
}
// (dry-run falls through to print the remaining intended steps.)

// Step 3: UKI — derived from the uki planner. planVerity now supplies the verity-bound cmdline (root=<verity
// device> roothash=<hex>), but the planUKI assembly still carries planUKI's own cmdline; consuming planVerity's
// cmdline in planUKI (so the assembled UKI is roothash-bearing) is the P1-012↔P1-017 integration that follows
// the rootfs→ext4 conversion. Until then this UKI boots by label, NOT by verity root hash (spec §11).
if (MODE === "full" && !ukiStep.command.args.some((a) => a.includes("roothash="))) {
  log("   ⚠ planUKI cmdline is still label-based; bind planVerity's roothash cmdline into planUKI to complete verity boot");
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
  // Auto-detect OVMF firmware: Debian trixie ships ONLY the 4M variants; older Debian + other distros differ.
  const firstExisting = (paths) => paths.find((p) => existsSync(p)) ?? paths[0];
  const ovmfCode = process.env.VITA_OVMF_CODE ?? firstExisting([
    "/usr/share/OVMF/OVMF_CODE_4M.fd",     // Debian trixie / newer
    "/usr/share/OVMF/OVMF_CODE.fd",        // older Debian/Ubuntu
    "/usr/share/edk2/ovmf/OVMF_CODE.fd",   // Fedora/RHEL/Arch
  ]);
  const ovmfVarsTemplate = process.env.VITA_OVMF_VARS_TEMPLATE ?? firstExisting([
    "/usr/share/OVMF/OVMF_VARS_4M.fd",
    "/usr/share/OVMF/OVMF_VARS.fd",
    "/usr/share/edk2/ovmf/OVMF_VARS.fd",
  ]);
  const ovmfVars = process.env.VITA_OVMF_VARS ?? join(OUT, "OVMF_VARS.fd");
  // QEMU needs a WRITABLE copy of the UEFI vars; seed it from the read-only system template once.
  if (ovmfVars !== ovmfVarsTemplate) {
    if (DRY) {
      log(`   (seed writable UEFI vars: cp ${ovmfVarsTemplate} ${ovmfVars})`);
    } else if (!existsSync(ovmfVars)) {
      if (!existsSync(ovmfVarsTemplate))
        fail(`OVMF vars template not found at ${ovmfVarsTemplate} — \`apt install ovmf\` or set VITA_OVMF_VARS_TEMPLATE ` +
             `(newer Debian uses /usr/share/OVMF/OVMF_VARS_4M.fd + OVMF_CODE_4M.fd — set VITA_OVMF_CODE/VITA_OVMF_VARS_TEMPLATE)`);
      copyFileSync(ovmfVarsTemplate, ovmfVars);
    }
  }
  if (!DRY && !existsSync(ovmfCode))
    fail(`OVMF code not found at ${ovmfCode} — set VITA_OVMF_CODE (e.g. /usr/share/OVMF/OVMF_CODE_4M.fd on newer Debian)`);
  run(`7 · QEMU boot (${secureBoot ? "Secure Boot" : "no SB"})`, "qemu-system-x86_64", [
    "-machine", "q35", "-m", "2048", "-cpu", "host", "-enable-kvm",
    "-drive", `if=pflash,format=raw,readonly=on,file=${ovmfCode}`,
    "-drive", `if=pflash,format=raw,file=${ovmfVars}`,
    "-drive", `file=${image},format=raw,if=virtio`,
    "-serial", "mon:stdio", "-nographic",
  ]);
}

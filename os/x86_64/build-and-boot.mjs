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
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planRootBuild, PINNED_MKOSI_IMAGE } from "./build-root.mjs";
import { planUKI, TEST_KEY_PATH_ENV, TEST_CERT_PATH_ENV } from "./uki.mjs";
import { planImageLayout } from "./image-layout.mjs";
// NB: planVerity is imported dynamically in full mode only (verity.mjs pulls in a .ts helper) — see below.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };

const DRY = has("--dry-run");
const MODE = opt("--mode", "smoke");
// Three-mode INSTALL profile baked onto the cmdline as vita.mode= (distinct from --mode smoke|full,
// which selects the BUILD pipeline). headless (default) | desktop (local kiosk) | network (TLS face).
// The vita-mode generator enforces it at boot; here we just choose what to bake. Override: VITA_MODE.
const MODE_SELECT = process.env.VITA_MODE ?? opt("--install-mode", "headless");
const MKOSI = opt("--mkosi", process.env.VITA_MKOSI ?? "auto"); // auto | native | docker
const NO_BOOT = has("--no-boot");
const NO_SIGN = has("--no-sign");
const OUT = resolve(opt("--out", join(HERE, "out")));
const CACHE = resolve(process.env.VITA_MKOSI_CACHE ?? join(HERE, ".cache"));
// ARCHIVED (feat/os-three-modes): the bespoke local-rendering stack — the custom Rust compositor
// (packages/compositor-core), CEF/osr (spikes/cef-osr), and the WM/desktop-shell rendering path — is
// NO LONGER built into or booted by the image. The standard kiosk renderer (cage + chromium, shipped
// as Debian packages and launched by vita-kiosk.service in LOCAL DESKTOP mode) replaces it. The
// source stays in the repo (git-recoverable); only the image build + boot path drops it. The old
// VITA_CEF=1 overlay (installCefOverlay) + its libcef.so runtime package set are removed here.
// chromium's own runtime deps are resolved automatically by apt from the `chromium` package now in
// the allowlist — no hand-maintained DT_NEEDED list is needed.
const SMOKE_VERIFICATION_PACKAGES = ["--package=open-vm-tools"];

if (!["smoke", "full"].includes(MODE)) fail(`--mode must be smoke|full, got ${MODE}`);
if (!["headless", "desktop", "network"].includes(MODE_SELECT))
  fail(`install mode (VITA_MODE / --install-mode) must be headless|desktop|network, got ${MODE_SELECT}`);

function fail(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }
function log(msg) { console.log(msg); }

// Full mode imports the verity/rootfs-image planners, which pull in a .ts helper (safeNormalize). Older Node
// needs --experimental-strip-types — re-exec once under the flag if the .ts load fails. IMPORTANT: the build
// HOST's Node may lack TS support entirely (ERR_NO_TYPESCRIPT, even with the flag), so SMOKE must not import any
// .ts-bearing planner — the agentd build command is inlined in installAgentOverlay() for exactly that reason.
let planVerity, planRootfsImage;
if (MODE === "full") {
  try {
    ({ planVerity } = await import("./verity.mjs"));
    ({ planRootfsImage } = await import("./rootfs-image.mjs"));
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
if (!mkosiCmd?.args) fail("planner shape changed — re-wire build-and-boot.mjs (rootPlan.command)");
// planUKI is per-slot (P1-025): each slot carries its own ukify command + verity cmdline. Only full mode uses it
// (smoke uses mkosi's own UKI), so validate the per-slot shape only there — don't block smoke.
if (MODE === "full" && !(ukiPlan.slots?.length && ukiPlan.slots.every((s) => Array.isArray(s.command?.ukifyArgs)))) {
  fail("planner shape changed — re-wire build-and-boot.mjs (planUKI per-slot UKIs)");
}

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

const REPART_VERITY_DIR = join(HERE, "repart-verity");
const PLAIN_DATA_REPART_CONF = `# Vita smoke VERITY layout - persistent mutable /var data partition. The root partition stays
# dm-verity read-only; smoke-overlay/usr/lib/systemd/system/var.mount mounts this partition by
# filesystem label instead of relying on machine-id-derived Discoverable Partitions UUIDs.
[Partition]
Type=linux-generic
Label=vita-data
Format=ext4
# FileSystemLabel sets the ext4 LABEL (=> /dev/disk/by-label/vita-data), which var.mount resolves.
# (Label= above is only the GPT partition name => /dev/disk/by-partlabel/, which var.mount does NOT use.)
# Requires systemd-repart >= v257; the build host is systemd 259.
FileSystemLabel=vita-data
SizeMinBytes=512M
Weight=1000
FactoryReset=no
`;

const PLAIN_VAR_MOUNT_UNIT = `# Vita /var mount. Explicit because gpt-auto only mounts a DPS /var when its UUID is machine-id-keyed.
# The vita-data partition exists ONLY in VITA_VERITY builds (repart-verity). On a plain (non-verity) smoke image the
# device is absent, so ConditionPathExists SKIPS the unit entirely (condition unmet = success-skip, NOT a failure):
# a *failed* var.mount cascades to every RequiresMountsFor=/var/... dependent (e.g. vita-agentd's StateDirectory),
# cancelling them; a *skipped* var.mount does not, and those units fall back to /var on the rw root. nofail + a short
# device-timeout are belt-and-suspenders for the (shouldn't-happen) case where the node exists but is slow.
[Unit]
Description=Vita persistent data partition (/var)
DefaultDependencies=no
Before=local-fs.target umount.target
Conflicts=umount.target
ConditionPathExists=/dev/disk/by-label/vita-data

[Mount]
What=/dev/disk/by-label/vita-data
Where=/var
Type=ext4
Options=nofail,x-systemd.device-timeout=5s,x-systemd.growfs
`;

function prepareVerityRepartDirectory({ luksMode }) {
  if (luksMode) {
    return REPART_VERITY_DIR;
  }

  // The committed repart file now models the LUKS outer container. For VITA_LUKS=0,
  // generate the old plaintext ext4 data-partition definition so non-LUKS verity
  // images remain byte-compatible with P1-029.
  const plainDir = join(OUT, "repart-verity-plain");
  if (DRY) return plainDir;
  rmSync(plainDir, { recursive: true, force: true });
  mkdirSync(plainDir, { recursive: true });
  for (const name of readdirSync(REPART_VERITY_DIR)) {
    if (name.endsWith(".conf")) {
      copyFileSync(join(REPART_VERITY_DIR, name), join(plainDir, name));
    }
  }
  writeFileSync(join(plainDir, "40-data.conf"), PLAIN_DATA_REPART_CONF, { mode: 0o644 });
  return plainDir;
}

function prepareVerityOverlay({ luksMode }) {
  const overlay = join(HERE, "verity-overlay");
  if (luksMode) {
    return overlay;
  }

  // Keep VITA_LUKS=0 verity image contents identical to P1-029: no unlock unit,
  // no marker unit, and var.mount without LUKS ordering edges.
  const plainOverlay = join(OUT, "verity-overlay-plain");
  if (DRY) return plainOverlay;
  const systemdDir = join(plainOverlay, "usr", "lib", "systemd", "system");
  rmSync(plainOverlay, { recursive: true, force: true });
  mkdirSync(join(systemdDir, "local-fs.target.d"), { recursive: true });
  writeFileSync(join(systemdDir, "var.mount"), PLAIN_VAR_MOUNT_UNIT, { mode: 0o644 });
  copyFileSync(
    join(overlay, "usr", "lib", "systemd", "system", "local-fs.target.d", "10-vita-var.conf"),
    join(systemdDir, "local-fs.target.d", "10-vita-var.conf"),
  );
  return plainOverlay;
}

function stageLuksTestKeyOverlay(keyPath) {
  const overlay = join(OUT, "luks-overlay");
  if (DRY) return overlay;
  if (!existsSync(keyPath)) {
    fail(
      "VITA_LUKS=1 needs the TEST keyfile. Generate it (gitignored, throwaway, spec §16):\n" +
      "       bash tools/luks-test-keys.sh\n" +
      `     or set VITA_LUKS_TEST_KEY_PATH. Looked for:\n       ${keyPath}`);
  }

  const luksDir = join(overlay, "usr", "lib", "vita", "luks");
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(luksDir, { recursive: true });
  const stagedKey = join(luksDir, "data.key");
  copyFileSync(keyPath, stagedKey);
  chmodSync(stagedKey, 0o400);
  writeFileSync(join(luksDir, "enabled"), "VITA_LUKS=1 build-only TEST unlock enabled\n", { mode: 0o444 });
  writeFileSync(join(luksDir, "README.DO-NOT-SHIP.txt"),
    "DO-NOT-SHIP: build-only Vita LUKS TEST key overlay. Real TPM/recovery secrets are owner-held.\n",
    { mode: 0o444 });
  return overlay;
}

function runLuksPostprocess(label, executable, args) {
  log(`\n── ${label}`);
  log(`   $ ${executable} ${args.join(" ")}`);
  const r = spawnSync(executable, args, { cwd: REPO, stdio: "inherit" });
  if (r.error) throw new Error(`${label}: ${r.error.message}` + (r.error.code === "ENOENT" ? ` (install ${executable})` : ""));
  if (r.status !== 0) throw new Error(`${label}: exited ${r.status}`);
}

function captureLuksPostprocess(label, executable, args) {
  log(`\n── ${label}`);
  log(`   $ ${executable} ${args.join(" ")}`);
  const r = spawnSync(executable, args, { cwd: REPO, encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw new Error(`${label}: ${r.error.message}` + (r.error.code === "ENOENT" ? ` (install ${executable})` : ""));
  if (r.status !== 0) throw new Error(`${label}: exited ${r.status}`);
  return r.stdout ?? "";
}

function findLoopPartitionByPartLabel(loopDevice, partLabel) {
  const stdout = captureLuksPostprocess("LUKS · locate vita-data loop partition", "lsblk",
    ["-P", "-o", "PATH,PARTLABEL", loopDevice]);
  for (const line of stdout.split(/\r?\n/u)) {
    const m = /^PATH="([^"]+)" PARTLABEL="([^"]*)"$/.exec(line.trim());
    if (m && m[2] === partLabel && m[1] !== loopDevice) {
      return m[1];
    }
  }
  throw new Error(`LUKS: could not find loop partition with PARTLABEL=${partLabel} under ${loopDevice}`);
}

function cleanupLuksPostprocess(loopDevice, mapperName) {
  if (mapperName && spawnSync("cryptsetup", ["status", mapperName], { stdio: "ignore" }).status === 0) {
    const r = spawnSync("cryptsetup", ["luksClose", mapperName], { stdio: "inherit" });
    if (r.status !== 0) log(`   (cleanup warning: cryptsetup luksClose ${mapperName} exited ${r.status})`);
  }
  if (loopDevice) {
    const r = spawnSync("losetup", ["-d", loopDevice], { stdio: "inherit" });
    if (r.status !== 0) log(`   (cleanup warning: losetup -d ${loopDevice} exited ${r.status})`);
  }
}

function luksFormatDataPartition(disk, keyPath) {
  log("\n── LUKS · format vita-data as LUKS2 and create inner ext4 label");
  log("   (cryptsetup LUKS2 defaults are used for cipher/KDF; no production key material is generated)");
  if (DRY) {
    log(`   $ losetup --find --show --partscan ${disk}`);
    log("   $ cryptsetup luksFormat --type luks2 --batch-mode --key-file <TEST key> <vita-data partition>");
    log("   $ cryptsetup luksOpen --key-file <TEST key> <vita-data partition> <build mapper>");
    log("   $ mkfs.ext4 -F -L vita-data /dev/mapper/<build mapper>");
    return;
  }

  let loopDevice = "";
  const mapperName = `vita-data-build-${process.pid}`;
  let postprocessError;
  try {
    const loop = captureLuksPostprocess("LUKS · attach disk image", "losetup", ["--find", "--show", "--partscan", disk]);
    loopDevice = loop.trim().split(/\s+/u)[0] ?? "";
    if (!loopDevice) throw new Error("LUKS: losetup did not return a loop device");
    const dataPartition = findLoopPartitionByPartLabel(loopDevice, "vita-data");
    runLuksPostprocess("LUKS · wipe plaintext outer filesystem signatures", "wipefs", ["--all", "--force", dataPartition]);
    runLuksPostprocess("LUKS · luksFormat vita-data outer container", "cryptsetup",
      ["luksFormat", "--type", "luks2", "--batch-mode", "--key-file", keyPath, dataPartition]);
    runLuksPostprocess("LUKS · open vita-data mapper for inner ext4 formatting", "cryptsetup",
      ["luksOpen", "--key-file", keyPath, dataPartition, mapperName]);
    runLuksPostprocess("LUKS · mkfs inner ext4 filesystem label", "mkfs.ext4",
      ["-F", "-L", "vita-data", `/dev/mapper/${mapperName}`]);
  } catch (e) {
    postprocessError = e;
  } finally {
    cleanupLuksPostprocess(loopDevice, mapperName);
  }
  if (postprocessError) fail(postprocessError.message);
}

// Build the Vita agentd (P1-026) reproducibly via its plan's go-in-docker command, then stage the binary into
// the committed agent-overlay so mkosi's --extra-tree ships /usr/lib/vita/agentd + vita-agentd.service into the
// rootfs. planAgentImage is the deterministic spec; here we execute it. go-in-docker mounts cwd(=REPO) at /work,
// so the plan's `-o /work/os/x86_64/out/agent/agentd` lands at OUT/agent/agentd on the host. Returns the overlay
// path for --extra-tree (engine-mapped: host dir for native mkosi; the /work mount for docker).
function installAgentOverlay() {
  const overlayHost = join(HERE, "agent-overlay");
  // Mirrors planAgentImage() / agent-image.conf (the deterministic spec, pinned by os/x86_64/test/agent-image.test.ts).
  // Inlined rather than imported because build-and-boot runs on the build host, whose Node may lack TS support and
  // so cannot load the .ts-importing planner. go-in-docker mounts cwd(=REPO) at /work → the -o lands at OUT/agent/agentd.
  const buildArgs = [
    "tools/build/go-in-docker.mjs", "--dir", "agent",
    "--env", "CGO_ENABLED=0", "--env", "GOOS=linux", "--env", "GOARCH=amd64", "--env", "SOURCE_DATE_EPOCH=1781308800",
    "build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid=", "-o", "/work/os/x86_64/out/agent/agentd", "./cmd/agentd",
  ];
  run("1a · build vita agentd (reproducible static binary)", "node", buildArgs);
  if (!DRY) {
    const built = join(OUT, "agent", "agentd");
    if (!existsSync(built)) fail(`agentd build did not produce ${built} — check the go-in-docker step`);
    const binDest = join(overlayHost, "usr", "lib", "vita", "agentd");
    mkdirSync(dirname(binDest), { recursive: true });
    copyFileSync(built, binDest);
    log(`   staged agentd → ${binDest}`);
  }
  return useNative ? overlayHost : "/work/os/x86_64/agent-overlay";
}

// Stage the smoke overlay WITHOUT the bespoke renderer (feat/os-three-modes). The smoke overlay still
// carries the non-rendering boot-verification bits the smoke boot needs (the Secure Boot state probe,
// modules-load, open-vm-tools, the serial autologin getty), but the custom Rust compositor self-test
// (the bespoke local-rendering path) is ARCHIVED: we no longer build packages/compositor-core, and we
// strip vita-compositor-selftest.service + its multi-user.target.wants entry + the compositor binary
// dir from the staged copy so it is never enabled or shipped. Returns a FILTERED overlay dir in OUT.
function installSmokeOverlayWithoutRenderer() {
  const src = join(HERE, "smoke-overlay");
  if (DRY) return useNative ? src : "/work/os/x86_64/smoke-overlay-norender";
  const staged = join(OUT, "smoke-overlay-norender");
  rmSync(staged, { recursive: true, force: true });
  cpSync(src, staged, { recursive: true });
  // Drop the bespoke compositor self-test rendering service + its enablement + the binary dir.
  const sys = join(staged, "usr", "lib", "systemd", "system");
  rmSync(join(sys, "vita-compositor-selftest.service"), { force: true });
  rmSync(join(sys, "multi-user.target.wants", "vita-compositor-selftest.service"), { force: true });
  rmSync(join(staged, "usr", "lib", "vita", "compositor"), { recursive: true, force: true });
  log("   smoke overlay staged WITHOUT the bespoke compositor renderer (cage+chromium replaces it)");
  return useNative ? staged : "/work/os/x86_64/smoke-overlay-norender";
}

// Stage the three-mode overlay: the platform server unit (placeholder ExecStart), the cage+chromium
// LOCAL DESKTOP kiosk unit, the vita-mode generator (headless|desktop|network selection), the apps
// tmpfiles, and the *.target.wants enablement. Committed under mode-overlay/; here we only materialize
// the two wants entries as REAL relative symlinks on the staging tree (they are committed as plain
// text files for cross-platform checkout, mirroring the agentd/ts/cef overlays).
function installModeOverlay() {
  const overlayHost = join(HERE, "mode-overlay");
  if (DRY) return useNative ? overlayHost : "/work/os/x86_64/mode-overlay";
  const sys = join(overlayHost, "usr", "lib", "systemd", "system");
  const wants = [
    [join(sys, "multi-user.target.wants", "vita-platform.service"), "../vita-platform.service"],
    [join(sys, "multi-user.target.wants", "vita-owner-token.service"), "../vita-owner-token.service"],
    [join(sys, "multi-user.target.wants", "vita-platform-selftest.service"), "../vita-platform-selftest.service"],
    [join(sys, "graphical.target.wants", "vita-kiosk.service"), "../vita-kiosk.service"],
  ];
  for (const [link, target] of wants) {
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) rmSync(link, { force: true });
    if (!existsSync(link)) { mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link); }
  }
  return useNative ? overlayHost : "/work/os/x86_64/mode-overlay";
}

// Stage the PUTER PLATFORM RUNTIME into the image: the WM-free server spine + the api/store/capability
// modules + the on-device Deno boot entry (server/server-entry.ts) + the vendored Apache-2.0 puter.js,
// laid out so server.ts's relative path math resolves on-device:
//   server-entry.ts at /usr/lib/vita/puter/server/server-entry.ts
//     -> runtimeDir  = /usr/lib/vita/puter           (staticRoot; serves kiosk-entry.html)
//     -> vendorDir   = /usr/lib/vita/_vendor          (/_vendor alias -> the puter.js bundle)
// So we copy ui_kits/desktop/runtime/puter -> usr/lib/vita/puter and ui_kits/desktop/_vendor ->
// usr/lib/vita/_vendor, EXCLUDING the spike harnesses + *.test.ts (dev-only; not served on-device).
// The Deno runtime binary itself is staged separately by ts-image.mjs (ts-overlay/usr/lib/vita/deno);
// vita-platform.service invokes that same pinned binary. Returns a fresh overlay dir for --extra-tree.
function installPuterOverlay() {
  if (DRY) return useNative ? join(OUT, "puter-overlay") : "/work/os/x86_64/out/puter-overlay";
  const staged = join(OUT, "puter-overlay");
  const puterSrc = join(REPO, "ui_kits", "desktop", "runtime", "puter");
  const vendorSrc = join(REPO, "ui_kits", "desktop", "_vendor");
  if (!existsSync(puterSrc)) fail(`1e · puter runtime missing: ${puterSrc} (did the platform-server merge land?)`);
  if (!existsSync(join(vendorSrc, "puter", "v2.js"))) fail(`1e · vendored puter.js missing: ${join(vendorSrc, "puter", "v2.js")}`);
  const puterDst = join(staged, "usr", "lib", "vita", "puter");
  const vendorDst = join(staged, "usr", "lib", "vita", "_vendor");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(dirname(puterDst), { recursive: true });
  // Copy the runtime, dropping the dev-only spike dir + every *.test.ts (the on-device server never runs them).
  cpSync(puterSrc, puterDst, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(puterSrc.length);
      if (rel === "/spike" || rel.startsWith("/spike/")) return false;
      if (rel.endsWith(".test.ts")) return false;
      return true;
    },
  });
  cpSync(vendorSrc, vendorDst, { recursive: true });
  log(`   staged puter platform runtime → ${puterDst} (+ vendored puter.js → ${vendorDst})`);
  return useNative ? staged : "/work/os/x86_64/out/puter-overlay";
}

// ARCHIVED (feat/os-three-modes): installCefOverlay() — staged the CEF runtime + osr_host + flagship
// desktop assets (the bespoke embedded-web-engine renderer, ADR-0014 M4) into cef-overlay. The image
// no longer builds or boots CEF/osr; the standard `cage` + `chromium --kiosk` kiosk (vita-kiosk
// .service, LOCAL DESKTOP mode) renders the desktop instead. The committed cef-overlay/ source +
// spikes/cef-osr remain in the repo (git-recoverable) but are NOT wired into the build path. The full
// previous implementation is recoverable from git history on this branch's parent (origin/main).

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
  // Bake only the serial console into the smoke UKI so markers are visible on QEMU's `-serial mon:stdio`
  // (-nographic), while fbcon stays off the VMware GPU scanout used by the compositor demo.
  // Login: ship an explicit serial-getty autologin drop-in via --extra-tree (reliable across mkosi versions,
  // unlike --autologin), AND set a root password (root/vita) as a fallback. Smoke/test only — full image gets
  // real auth. The overlay path differs by engine (host dir for native mkosi; the /work mount for docker).
  const agentOverlay = installAgentOverlay();   // build + stage the Vita agent, then ship it via --extra-tree
  // De-wired renderer (feat/os-three-modes): the smoke overlay still ships the boot-verification markers
  // (Secure Boot probe, modules-load, open-vm-tools, serial autologin) but NO bespoke compositor self-test.
  const smokeOverlay = installSmokeOverlayWithoutRenderer();
  // Three-mode overlay: platform server (placeholder) + cage/chromium kiosk unit + vita-mode generator
  // (headless|desktop|network) + apps tmpfiles. Shipped in EVERY build; the generator selects per boot.
  const modeOverlay = installModeOverlay();
  // Puter platform runtime + vendored Apache-2.0 puter.js (the real server the platform unit runs on Deno).
  const puterOverlay = installPuterOverlay();
  // P1-030: stage the pinned Deno runtime into ts-overlay (ts-image.mjs fetches + sha256-verifies + extracts the
  // binary to ts-overlay/usr/lib/vita/deno), then ship the on-device TS runtime + entrypoint via --extra-tree.
  const tsOverlay = useNative ? join(HERE, "ts-overlay") : "/work/os/x86_64/ts-overlay";
  if (!DRY) run("1c · stage Deno runtime (ts-image.mjs)", "node", [join(HERE, "ts-image.mjs")]);
  // --incremental: mkosi caches the package-installed rootfs, so re-builds only re-apply the overlays/cmdline
  // (seconds) instead of re-installing all of Debian (~5 min). Smoke is iterate-fast; full keeps it off for
  // byte-reproducibility. Override with VITA_INCREMENTAL=0.
  const incremental = process.env.VITA_INCREMENTAL === "0" ? [] : ["--incremental=yes"];
  // VITA_BOOT_DEBUG=1 bakes systemd debug logging into the cmdline so a headless boot prints WHY it stalls
  // (job queue / unmet dependencies / device waits) to the serial — a one-shot diagnostic, off by default.
  // systemd.firstboot=off: skip the interactive First Boot Wizard (it waits forever on a headless console →
  // holds back sysinit → multi-user; confirmed via VITA_BOOT_DEBUG). Test/VM image is pre-seeded.
  // VITA_VERITY=1: build a dm-verity-protected root (mkosi-native, unsigned `hash` — no keys; signing = step 4).
  // A verity root is read-only, so systemd.volatile=overlay gives a writable / overlay. The deterministic
  // verity/uki/image-layout planners remain the SPEC; mkosi does the actual verity build (it runs on the host,
  // unlike the .ts-importing planners). This is step 2's pragmatic path.
  // VITA_VERITY=1: build a dm-verity-protected root. --verity=hash alone is a NO-OP — mkosi needs explicit
  // root(Verity=data) + root-verity(Verity=hash) partition defs, supplied via --repart-directory pointing at
  // os/x86_64/repart-verity/ (kept out of the DEFAULT layout so smoke/SB are unaffected). mkosi builds the
  // hash tree + bakes roothash= onto the UKI cmdline; the root is read-only so volatile=overlay gives writable /.
  const verityMode = process.env.VITA_VERITY === "1";
  // Native mkosi only: --repart-directory is a HOST path the docker mkosi container would not see (REPO mounts
  // at /work). Fail fast rather than silently build a non-verity image. (useNative is true on the build host.)
  if (verityMode && !DRY && !useNative)
    fail("VITA_VERITY=1 requires the native mkosi engine — --repart-directory is a host path not mounted into " +
         "the docker mkosi container. Install mkosi on PATH or set VITA_MKOSI=native.");
  const luksMode = process.env.VITA_LUKS === "1";
  if (luksMode && !verityMode) {
    fail("VITA_LUKS=1 requires VITA_VERITY=1: the encrypted data partition is only present in repart-verity.");
  }
  if (luksMode && !DRY && !useNative) {
    fail("VITA_LUKS=1 requires the native mkosi engine — LUKS post-processing uses host loop devices.");
  }
  const verityRepartDir = verityMode ? prepareVerityRepartDirectory({ luksMode }) : "";
  const verity = verityMode ? ["--verity=hash", `--repart-directory=${verityRepartDir}`] : [];
  // Verity root is read-only + PERSISTENT (P1-029): with VITA_LUKS=0 var.mount mounts the generated plaintext
  // ext4 /dev/disk/by-label/vita-data; with VITA_LUKS=1 the committed overlay hard-depends on unlock and mounts
  // /dev/mapper/vita-data so a wrong or missing key cannot fall open to a raw labelled partition.
  // So NO systemd.volatile=overlay (that tmpfs-overlays / and would shadow the persistent /var).
  // var.mount + its local-fs drop-in live in a VERITY-ONLY overlay: on a plain (non-verity) image the vita-data
  // device never exists, and a present-but-failed var.mount cascades through RequiresMountsFor=/var/... to cancel
  // vita-agentd (StateDirectory=vita-agent) — breaking the agentd socket. So ship those units ONLY when VITA_VERITY=1.
  const verityOverlay = verityMode ? prepareVerityOverlay({ luksMode }) : "";
  const verityTree = verityMode ? [`--extra-tree=${verityOverlay}`] : [];
  const luksKey = resolve(process.env.VITA_LUKS_TEST_KEY_PATH ?? join(HERE, ".luks", "data.key"));
  const luksTree = luksMode ? [`--extra-tree=${stageLuksTestKeyOverlay(luksKey)}`] : [];
  const rootOpts = verityMode ? "ro" : "rw";
  // VITA_SECURE_BOOT=1: sign the mkosi-built smoke UKI with our TEST db key (--bootloader=uki so the
  // UKI itself — kernel inside .linux — is the signed boot artifact, installed as /EFI/BOOT/BOOTX64.EFI).
  // Enrollment is OFFLINE via virt-fw-vars (PK=KEK=db from db.crt into the OVMF varstore) — NOT mkosi
  // --secure-boot-auto-enroll, which is a systemd-boot feature and is dead here (--bootloader=uki removes
  // sd-boot; proven empirically: it staged no /loader/keys). Gated to SMOKE only — full mode signs
  // per-slot UKIs via the explicit sbsign step (VITA_SB_KEY/VITA_SB_CERT); enabling mkosi --secure-boot
  // there would double-sign. Reuses uki.mjs's TEST key env contract (VITA_TEST_SECUREBOOT_KEY_PATH/_CERT_PATH).
  const secureBoot = process.env.VITA_SECURE_BOOT === "1";
  const SB_DIR = join(HERE, ".secureboot");
  const sbKey = process.env[TEST_KEY_PATH_ENV] ?? join(SB_DIR, "db.key");
  const sbCert = process.env[TEST_CERT_PATH_ENV] ?? join(SB_DIR, "db.crt");
  let sb = [];
  let bootloaderPin = [];
  if (secureBoot) {
    // mkosi must be the NATIVE engine for SB: --secure-boot-key/-certificate are HOST paths the docker
    // mkosi container would not see (REPO mounts at /work, not these paths). Fail fast rather than silently
    // produce an unsigned image. (useNative is true on the build host; set VITA_MKOSI=native otherwise.)
    if (!DRY && !useNative)
      fail("VITA_SECURE_BOOT=1 requires the native mkosi engine — the SB key/cert are host paths not mounted " +
           "into the docker mkosi container. Install mkosi on PATH or set VITA_MKOSI=native.");
    // Pin the artifact shape: force a single UKI so the KERNEL (inside the UKI's .linux PE section)
    // is what gets signed — mkosi's default could otherwise ship a bare vmlinuz + signed sd-boot,
    // leaving the kernel unsigned and the whole "sign the UKI" premise moot.
    bootloaderPin = ["--bootloader=uki"];
    if (!DRY && (!existsSync(sbKey) || !existsSync(sbCert))) {
      fail(
        "VITA_SECURE_BOOT=1 needs the TEST keystore. Generate it (gitignored, throwaway, spec §16):\n" +
        "       bash tools/secureboot-test-keys.sh\n" +
        `     or set ${TEST_KEY_PATH_ENV}/${TEST_CERT_PATH_ENV}. Looked for:\n       ${sbKey}\n       ${sbCert}`);
    }
    sb = [
      "--secure-boot=yes",
      `--secure-boot-key=${sbKey}`,
      `--secure-boot-certificate=${sbCert}`,
      "--secure-boot-sign-tool=sbsign",
    ];
    log(`   (Secure Boot: sign UKI with TEST db key ${sbKey}; enrollment is offline via virt-fw-vars)`);
  }
  // Three-mode selection: bake vita.mode= onto the cmdline. The vita-mode generator reads it at boot
  // and enables/masks the local kiosk + display path accordingly (headless|desktop|network). Default
  // headless (no display stack) so a bare boot stays minimal; override with VITA_MODE.
  const cmdline = `console=ttyS0,115200 ${rootOpts} systemd.firstboot=off systemd.mask=getty@tty1.service` +
    ` vita.mode=${MODE_SELECT}` +
    (process.env.VITA_SB_NONCE ? ` vita.sbnonce=${process.env.VITA_SB_NONCE}` : "") +
    (process.env.VITA_BOOT_DEBUG === "1" ? " systemd.log_level=debug systemd.log_target=console systemd.show_status=1" : "");
  runMkosi("1 · build bootable disk (mkosi --format disk, smoke)",
    ["--format", "disk", "--bootable=yes", ...SMOKE_VERIFICATION_PACKAGES,
     ...incremental, ...verity, ...bootloaderPin, ...sb,
     `--extra-tree=${smokeOverlay}`, `--extra-tree=${agentOverlay}`, `--extra-tree=${tsOverlay}`,
     `--extra-tree=${modeOverlay}`, `--extra-tree=${puterOverlay}`, ...verityTree, ...luksTree,
     "--root-password=vita", "--kernel-command-line", cmdline]);
  const disk = findOutput(".raw");
  if (luksMode) luksFormatDataPartition(disk, luksKey);
  log(`   disk → ${disk}`);
  if (!NO_BOOT) bootQemu(disk, { secureBoot, sbCert });
  log("\n✓ smoke build complete." + (NO_BOOT ? "" : " (booted above)"));
  process.exit(0);
}

// ── FULL: build the read-only Debian rootfs (the planner's canonical Format=directory build) ────────────────
runMkosi("1 · build rootfs (mkosi directory, privileged, cached)");
const rootfs = join(OUT, "vita-debian-trixie-x86_64-root");
log(`   rootfs → ${rootfs}/ (Format=directory)`);

// ── FULL trusted-boot chain ─────────────────────────────────────────────────────────────────────────────────
// Step 1.5: convert the Format=directory rootfs → deterministic per-slot ext4 images (P1-024 planRootfsImage) —
// the images planVerity formats + planImageLayout places in the A/B partitions. The planner emits CONTAINER paths;
// map them to host paths (rootfs from step 1; outputs under out/converted; the pinned mke2fs.conf from the repo).
const convertedDir = join(OUT, "converted");
const mapHost = (p) => p
  .replace("/external/p1-011/vita-debian-trixie-x86_64-root", rootfs)
  .replace("/external/p1-014/converted", convertedDir)
  .replace("/out/verity", join(OUT, "verity"))   // planVerity's hash-tree output dir (container /out → host OUT)
  .replace("/work/os/x86_64", join(REPO, "os/x86_64"));
const rootfsImagePlan = planRootfsImage();
log("\n── 1.5 · convert rootfs → ext4 images (mkfs.ext4 -d, deterministic, P1-024)");
if (!DRY) mkdirSync(convertedDir, { recursive: true });
for (const step of rootfsImagePlan.steps) {
  const args = step.command.args.map(mapHost);
  const env = { ...process.env, ...step.command.environment, MKE2FS_CONFIG: mapHost(step.command.environment.MKE2FS_CONFIG) };
  run(`1.5 · ${step.id}`, step.command.executable, args, { env });
}

// Step 2: dm-verity (P1-017 planVerity) — run `veritysetup format <ext4> <hashtree> --format 1 …` over the
// step-1.5 images and CAPTURE each slot's root hash (stdout piped); the slot cmdline is
// root=<verity-mapped device> roothash=<hex> (never root=LABEL).
const verityPlan = planVerity();
log("\n── 2 · dm-verity (veritysetup format over the ext4 images, capture root hash)");
if (!DRY) mkdirSync(join(OUT, "verity"), { recursive: true });
const slotRootHashes = {};   // slot.slot ("root-a"/"root-b") -> captured verity root hash hex
for (const slot of verityPlan.slots) {
  const vs = slot.veritysetup;
  const args = vs.args.map(mapHost);
  log(`   [${slot.slot}] $ ${vs.executable} ${args.join(" ")}`);
  log(`   [${slot.slot}]   cmdline → ${slot.uki.cmdline.template}`);
  if (!DRY) {
    const r = spawnSync(vs.executable, args, { cwd: REPO, stdio: ["inherit", "pipe", "inherit"] });
    if (r.error) fail(`2 · ${slot.slot} ${vs.executable}: ${r.error.message}` + (r.error.code === "ENOENT" ? " (install cryptsetup-bin)" : ""));
    if (r.status !== 0) fail(`2 · ${slot.slot} veritysetup format: exited ${r.status}`);
    const out = r.stdout?.toString?.() ?? "";
    process.stdout.write(out);
    const m = /Root hash:\s*([0-9a-f]+)/i.exec(out);
    if (!m) fail(`2 · ${slot.slot}: could not parse "Root hash:" from veritysetup output`);
    slotRootHashes[slot.slot] = m[1];
    log(`   [${slot.slot}] root hash = ${m[1]}`);
  }
}

// Step 3: assemble the PER-SLOT verity-bearing UKIs (P1-025 planUKI). Each slot's ukify --cmdline is
// root=/dev/mapper/vita-root-<slot>-verity roothash=<the captured hash> — substitute the captured hash into the
// cmdline's `${name.rootHash}` placeholder (this is the verity binding). NOTE: ukify also needs the kernel/initrd
// (+ systemd-boot stub) external inputs (P1-012 preconditions); build-and-boot does not yet EXTRACT them from the
// built rootfs, so a REAL run stops here — `--dry-run` prints the full per-slot UKI chain.
log("\n── 3 · assemble per-slot verity UKIs (ukify, P1-025)");
for (const slot of ukiPlan.slots) {
  const hex = slotRootHashes[slot.slot] ?? `\${${slot.name}.rootHash}`;
  const ukifyArgs = slot.command.args.map((a) => mapHost(a).split(`\${${slot.name}.rootHash}`).join(hex));
  log(`   [${slot.slot}] $ ${slot.command.executable} ${ukifyArgs.join(" ")}`);
}
if (!DRY) {
  fail("full mode: ext4 + verity root hashes captured ✓; per-slot verity UKIs ready (shown via --dry-run). The\n" +
       "       verity binding (root hash → UKI cmdline) is now wired. NEXT GAP: extract the kernel/initrd (+ stub)\n" +
       "       from the built rootfs for ukify, then Secure Boot sign (VITA_SB_KEY).");
}

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

function bootQemu(image, { secureBoot, sbCert }) {
  // Auto-detect OVMF firmware: Debian trixie ships ONLY the 4M variants; older Debian + other distros differ.
  const firstExisting = (paths) => paths.find((p) => existsSync(p)) ?? paths[0];
  // Secure Boot REQUIRES the .secboot OVMF code build — the plain OVMF_CODE_4M.fd does NOT enforce SB
  // even with SB vars enrolled, so an SB row booting on it is a silent false positive. Select the
  // .secboot code whenever secureBoot is set and the orchestrator hasn't pinned VITA_OVMF_CODE.
  const ovmfCode = process.env.VITA_OVMF_CODE ?? firstExisting(secureBoot ? [
    "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd",   // Debian trixie SB-enforcing
    "/usr/share/edk2/ovmf/OVMF_CODE.secboot.fd", // Fedora/RHEL/Arch
  ] : [
    "/usr/share/OVMF/OVMF_CODE_4M.fd",     // Debian trixie / newer
    "/usr/share/OVMF/OVMF_CODE.fd",        // older Debian/Ubuntu
    "/usr/share/edk2/ovmf/OVMF_CODE.fd",   // Fedora/RHEL/Arch
  ]);
  // The BLANK template (never *.ms.fd / *.snakeoil.fd — those already carry a FOREIGN PK). For SB we
  // enroll OUR cert into a fresh copy of this base with virt-fw-vars (below).
  const ovmfVarsTemplate = process.env.VITA_OVMF_VARS_TEMPLATE ?? firstExisting([
    "/usr/share/OVMF/OVMF_VARS_4M.fd",
    "/usr/share/OVMF/OVMF_VARS.fd",
    "/usr/share/edk2/ovmf/OVMF_VARS.fd",
  ]);
  // SB uses a DISTINCT, ALWAYS-rebuilt vars file so a prior (non-SB or stale) OVMF_VARS.fd can never leak
  // its state into an SB boot; the plain path keeps the seed-once default.
  const ovmfVars = process.env.VITA_OVMF_VARS ?? join(OUT, secureBoot ? "OVMF_VARS.sb.fd" : "OVMF_VARS.fd");

  if (secureBoot) {
    // Load-bearing guards: the code MUST be a .secboot build (plain code does NOT enforce SB), and the
    // vars base MUST NOT be a pre-enrolled MS/snakeoil store (we enroll OUR key into the blank base).
    if (!/secboot/i.test(ovmfCode))
      fail(`Secure Boot needs the .secboot OVMF code (got ${ovmfCode}). Install ovmf / set VITA_OVMF_CODE ` +
           `to /usr/share/OVMF/OVMF_CODE_4M.secboot.fd — the plain code does NOT enforce SB.`);
    if (/\.(ms|snakeoil)\.fd$/i.test(ovmfVarsTemplate))
      fail(`Secure Boot vars base must be the blank store, not ${ovmfVarsTemplate} ` +
           `(*.ms.fd/*.snakeoil.fd already carry a foreign PK — enroll OUR key into the blank OVMF_VARS_4M.fd).`);
  }

  // Build the writable UEFI vars. SB: enroll OUR cert (PK=KEK=db) into a fresh copy of the blank base with
  // virt-fw-vars — the OFFLINE replacement for sd-boot auto-enroll (which --bootloader=uki removes). Setting
  // PK flips the firmware Setup->User Mode = enforcing, OUR key as root of trust. Non-SB: seed once.
  const SB_OWNER_GUID = "11111111-1111-1111-1111-111111111111";   // arbitrary TEST signature-owner GUID
  if (DRY) {
    if (secureBoot)
      log(`   (enroll vars: virt-fw-vars -i ${ovmfVarsTemplate} -o ${ovmfVars} --set-pk/--add-kek/--add-db ${sbCert} --sb)`);
    else if (ovmfVars !== ovmfVarsTemplate)
      log(`   (seed writable UEFI vars: cp ${ovmfVarsTemplate} ${ovmfVars})`);
  } else if (secureBoot) {
    if (!existsSync(ovmfVarsTemplate)) fail(`OVMF vars base not found at ${ovmfVarsTemplate} — \`apt install ovmf\``);
    if (!existsSync(sbCert)) fail(`Secure Boot cert not found at ${sbCert}`);
    if (spawnSync("virt-fw-vars", ["--help"], { stdio: "ignore" }).error)
      fail("Secure Boot enrollment needs virt-fw-vars — `apt install python3-virt-firmware`");
    run("6 · enroll db key into OVMF vars (virt-fw-vars, offline)", "virt-fw-vars", [
      "-i", ovmfVarsTemplate, "-o", ovmfVars,
      "--set-pk", SB_OWNER_GUID, sbCert, "--add-kek", SB_OWNER_GUID, sbCert, "--add-db", SB_OWNER_GUID, sbCert, "--sb",
    ]);
  } else if (ovmfVars !== ovmfVarsTemplate && !existsSync(ovmfVars)) {
    if (!existsSync(ovmfVarsTemplate))
      fail(`OVMF vars template not found at ${ovmfVarsTemplate} — \`apt install ovmf\` or set VITA_OVMF_VARS_TEMPLATE`);
    copyFileSync(ovmfVarsTemplate, ovmfVars);
  }
  if (!DRY && !existsSync(ovmfCode))
    fail(`OVMF code not found at ${ovmfCode} — set VITA_OVMF_CODE (e.g. /usr/share/OVMF/OVMF_CODE_4M.secboot.fd on newer Debian)`);
  if (DRY || secureBoot) log(`   (OVMF code=${ovmfCode} vars=${ovmfVars} template=${ovmfVarsTemplate})`);

  // -cpu host -enable-kvm needs /dev/kvm; fall back to TCG so a KVM-less host doesn't abort QEMU
  // (an abort = no markers, which the SB matrix would otherwise mis-score). Override with VITA_QEMU_ACCEL.
  const kvm = !DRY && existsSync("/dev/kvm");
  const accel = process.env.VITA_QEMU_ACCEL ?? (kvm ? "kvm" : "tcg");
  const cpu = accel === "kvm" ? ["-cpu", "host", "-enable-kvm"] : ["-cpu", "max"];
  run(`7 · QEMU boot (${secureBoot ? "Secure Boot" : "no SB"}, accel=${accel})`, "qemu-system-x86_64", [
    "-machine", "q35", "-m", "2048", ...cpu,
    "-drive", `if=pflash,format=raw,readonly=on,file=${ovmfCode}`,
    "-drive", `if=pflash,format=raw,file=${ovmfVars}`,
    "-drive", `file=${image},format=raw,if=virtio`,
    "-serial", "mon:stdio", "-nographic",
  ]);
}

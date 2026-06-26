#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VMRUN =
  "C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe";
const DEFAULT_WSL_DISTRO = "Ubuntu";
const DEFAULT_MARKER_TIMEOUT_SECONDS = 180;
const DEFAULT_START_TIMEOUT_SECONDS = 60;
const DEFAULT_SCREENSHOT_TIMEOUT_SECONDS = 30;
const USERSPACE_RE =
  /Reached target[^|]*Multi-User|Startup finished in|root@localhost|bash-5\.[0-9]+[#$]/;

function usage() {
  return `Usage:
  node tools/vmware-verify.mjs --image <disk.raw> --markers "VITA-COMPOSITOR,VITA-FOO" [options]
  node tools/vmware-verify.mjs --self-check

Options:
  --image <raw>              Vita raw disk image to boot.
  --markers <csv>            Comma-separated markers required in the serial log.
  --secure-boot <on|off>     Render VMware UEFI secure boot on/off (default: off).
  --firmware <efi|bios>      VMware firmware mode (default: efi).
  --keep                     Keep the generated VM files after stopping the VM.
  --out-dir <dir>            Directory for the generated vmdk/vmx/log/screenshot.
  --screenshot <png>         Screenshot output path (default: <out-dir>/screen.png).
  --vmrun <path>             vmrun.exe path (or VITA_VMRUN/VMRUN env).
  --qemu-img <path>          Native qemu-img path (or VITA_QEMU_IMG/QEMU_IMG env).
  --wsl-distro <name>        WSL distro for default qemu-img (default: Ubuntu).
  --start-timeout <seconds>  Timeout for vmrun start (default: 60).
  --timeout <seconds>        Timeout for serial marker wait (default: 180).
  --self-check               Probe host tools and exercise template/marker fixtures only.
`;
}

function parseArgs(argv) {
  const opts = {
    firmware: "efi",
    keep: false,
    markerTimeoutSeconds: DEFAULT_MARKER_TIMEOUT_SECONDS,
    secureBoot: false,
    selfCheck: false,
    startTimeoutSeconds: DEFAULT_START_TIMEOUT_SECONDS,
    wslDistro: process.env.VITA_WSL_DISTRO || DEFAULT_WSL_DISTRO,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${raw}`);
    }

    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    let inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    const needValue = () => {
      if (inlineValue !== undefined) {
        const value = inlineValue;
        inlineValue = undefined;
        return value;
      }
      i += 1;
      if (i >= argv.length || argv[i].startsWith("--")) {
        throw new Error(`${key} requires a value`);
      }
      return argv[i];
    };

    switch (key) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--self-check":
        opts.selfCheck = true;
        break;
      case "--image":
        opts.image = needValue();
        break;
      case "--markers":
        opts.markers = parseMarkerCsv(needValue());
        break;
      case "--keep":
        opts.keep = true;
        break;
      case "--secure-boot": {
        const value = needValue().toLowerCase();
        if (value !== "on" && value !== "off") {
          throw new Error("--secure-boot must be 'on' or 'off'");
        }
        opts.secureBoot = value === "on";
        break;
      }
      case "--firmware": {
        const value = needValue().toLowerCase();
        if (value !== "efi" && value !== "bios") {
          throw new Error("--firmware must be 'efi' or 'bios'");
        }
        opts.firmware = value;
        break;
      }
      case "--out-dir":
        opts.outDir = needValue();
        break;
      case "--screenshot":
        opts.screenshot = needValue();
        break;
      case "--guest-file": {
        // Format: <guestPath>:<hostPath> — copy a file out of the guest after markers pass.
        const raw = needValue();
        // Split on the FIRST colon: the guest path is POSIX (no colon), the host may be a
        // Windows path with a drive colon (C:\...), so the first colon is the separator.
        const sep = raw.indexOf(":");
        if (sep <= 0) {
          throw new Error("--guest-file expects <guestPath>:<hostPath>");
        }
        opts.guestFile = { guest: raw.slice(0, sep), host: path.resolve(raw.slice(sep + 1)) };
        break;
      }
      case "--vmrun":
        opts.vmrun = needValue();
        break;
      case "--qemu-img":
        opts.qemuImg = needValue();
        break;
      case "--wsl-distro":
        opts.wslDistro = needValue();
        break;
      case "--timeout":
        opts.markerTimeoutSeconds = parsePositiveInt(
          needValue(),
          "--timeout",
        );
        break;
      case "--start-timeout":
        opts.startTimeoutSeconds = parsePositiveInt(
          needValue(),
          "--start-timeout",
        );
        break;
      default:
        throw new Error(`unknown option: ${key}`);
    }
  }

  if (!opts.selfCheck && !opts.help) {
    if (!opts.image) {
      throw new Error("--image is required outside --self-check");
    }
    if (!opts.markers || opts.markers.length === 0) {
      throw new Error("--markers is required outside --self-check");
    }
  }

  return opts;
}

function parsePositiveInt(value, flag) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} is too large`);
  }
  return parsed;
}

function parseMarkerCsv(value) {
  const markers = value
    .split(",")
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0);
  if (markers.length === 0) {
    throw new Error("--markers must name at least one marker");
  }
  for (const marker of markers) {
    if (/[\0\r\n]/.test(marker)) {
      throw new Error(`invalid marker contains a control character: ${marker}`);
    }
  }
  return markers;
}

function resolveVmrun(opts) {
  return opts.vmrun || process.env.VITA_VMRUN || process.env.VMRUN || DEFAULT_VMRUN;
}

function resolveQemuImg(opts) {
  const direct = opts.qemuImg || process.env.VITA_QEMU_IMG || process.env.QEMU_IMG;
  if (direct) {
    return { args: [], command: direct, kind: "native" };
  }
  if (process.platform === "win32") {
    return {
      args: ["-d", opts.wslDistro, "-u", "root", "--", "qemu-img"],
      command: "wsl",
      kind: "wsl",
    };
  }
  return { args: [], command: "qemu-img", kind: "native" };
}

function describeCommand(spec, extraArgs = []) {
  return [spec.command, ...spec.args, ...extraArgs]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

async function spawnCapture(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;

  return await new Promise((resolve) => {
    let done = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let timer;
    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) {
        return current;
      }
      const next = current + chunk.toString("utf8");
      return next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        code: null,
        error,
        signal: null,
        stderr,
        stdout,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      finish({ code, error: null, signal, stderr, stdout, timedOut });
    });
  });
}

async function runChecked(label, command, args, timeoutMs) {
  const result = await spawnCapture(command, args, { timeoutMs });
  if (result.code !== 0) {
    const detail = [
      result.error ? result.error.message : undefined,
      result.timedOut ? "timed out" : undefined,
      result.stderr.trim(),
      result.stdout.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${label} failed\n${detail}`);
  }
  return result;
}

async function probeVmrun(vmrunPath) {
  try {
    await fs.access(vmrunPath, fsConstants.X_OK);
    return { ok: true, message: `found ${vmrunPath}` };
  } catch (error) {
    return {
      ok: false,
      message: `missing ${vmrunPath} (${error.code || error.message})`,
    };
  }
}

async function probeQemuImg(qemuImg) {
  const result = await spawnCapture(qemuImg.command, [...qemuImg.args, "--version"], {
    timeoutMs: 5_000,
  });
  if (result.code === 0) {
    const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0] || "ok";
    return { ok: true, message: `${describeCommand(qemuImg)} -> ${firstLine}` };
  }
  if (result.error) {
    return {
      ok: false,
      message: `${describeCommand(qemuImg)} -> ${result.error.message}`,
    };
  }
  return {
    ok: false,
    message: `${describeCommand(qemuImg)} -> exit ${result.code}${
      result.timedOut ? " (timeout)" : ""
    }`,
  };
}

function toWslPath(hostPath) {
  const resolved = path.resolve(hostPath);
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!driveMatch) {
    throw new Error(`cannot translate non-drive Windows path for WSL: ${resolved}`);
  }
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function qemuPath(qemuImg, hostPath) {
  return qemuImg.kind === "wsl" ? toWslPath(hostPath) : hostPath;
}

async function isUpToDate(source, target) {
  const sourceStat = await fs.stat(source);
  try {
    const targetStat = await fs.stat(target);
    return targetStat.size > 0 && targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function convertRawToVmdk(rawPath, vmdkPath, qemuImg) {
  await fs.mkdir(path.dirname(vmdkPath), { recursive: true });
  if (await isUpToDate(rawPath, vmdkPath)) {
    console.log(`convert: skip, up to date: ${vmdkPath}`);
    return;
  }

  const args = [
    ...qemuImg.args,
    "convert",
    "-O",
    "vmdk",
    qemuPath(qemuImg, rawPath),
    qemuPath(qemuImg, vmdkPath),
  ];
  console.log(`convert: ${describeCommand(qemuImg, args.slice(qemuImg.args.length))}`);
  await runChecked("qemu-img convert", qemuImg.command, args, 30 * 60 * 1000);
}

function vmxString(value) {
  return `"${String(value).replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

function boolString(value) {
  return value ? "TRUE" : "FALSE";
}

function renderVmx(config) {
  const firmwareLines =
    config.firmware === "efi"
      ? [
          `firmware = "efi"`,
          `uefi.secureBoot.enabled = "${boolString(config.secureBoot)}"`,
        ]
      : [`firmware = "bios"`];

  const lines = [
    `.encoding = "UTF-8"`,
    `config.version = "8"`,
    `virtualHW.version = "20"`,
    `displayName = ${vmxString(config.displayName)}`,
    `guestOS = "debian12-64"`,
    ...firmwareLines,
    `numvcpus = "${config.cpus}"`,
    `cpuid.coresPerSocket = "${config.cpus}"`,
    `memsize = "${config.memoryMb}"`,
    `sata0.present = "TRUE"`,
    `sata0.virtualDev = "ahci"`,
    `sata0:0.present = "TRUE"`,
    `sata0:0.fileName = ${vmxString(config.vmdkPath)}`,
    `sata0:0.deviceType = "disk"`,
    `sata0:0.redo = ""`,
    `serial0.present = "TRUE"`,
    `serial0.fileType = "file"`,
    `serial0.fileName = ${vmxString(config.serialPath)}`,
    `serial0.tryNoRxLoss = "FALSE"`,
    `mks.enable3d = "TRUE"`,
    `svga.present = "TRUE"`,
    `svga.autodetect = "FALSE"`,
    `svga.vramSize = "268435456"`,
    `svga.graphicsMemoryKB = "262144"`,
    // PSD-503: pin the SVGA panel to 1920x1440 (min == max) so the vmwgfx connector advertises
    // 1920x1440 as an available mode and the guest selects it. The previous maxHeight=1080 capped
    // the panel BELOW the 1920x1440 target (the vmwgfx ladder has no 1920x1080), which is part of
    // why the desktop fell back to the small 1280x800 default. Pinning min==max forces a single
    // fixed mode that the compositor's pick_best_mode (largest <= 1920 wide) resolves to 1920x1440,
    // and disables VMware's autofit so the host window does not renegotiate it.
    `svga.minWidth = "1920"`,
    `svga.maxWidth = "1920"`,
    `svga.minHeight = "1440"`,
    `svga.maxHeight = "1440"`,
    `vmotion.checkpointFBSize = "134217728"`,
    `vmotion.checkpointSVGAPrimarySize = "268435456"`,
    `ethernet0.present = "FALSE"`,
    `usb.present = "FALSE"`,
    `sound.present = "FALSE"`,
    `floppy0.present = "FALSE"`,
    `tools.remindInstall = "FALSE"`,
    `msg.autoAnswer = "TRUE"`,
    `uuid.action = "create"`,
    `checkpoint.vmState = ""`,
    `isolation.tools.copy.disable = "TRUE"`,
    `isolation.tools.paste.disable = "TRUE"`,
    `isolation.tools.hgfs.disable = "TRUE"`,
  ];
  return `${lines.join("\n")}\n`;
}

async function writeVmx(vmxPath, config) {
  await fs.mkdir(path.dirname(vmxPath), { recursive: true });
  await fs.writeFile(vmxPath, renderVmx(config), "utf8");
}

function analyzeSerialText(text, markers) {
  const missingMarkers = [];
  const foundMarkers = [];
  for (const marker of markers) {
    if (text.includes(marker)) {
      foundMarkers.push(marker);
    } else {
      missingMarkers.push(marker);
    }
  }
  const userspaceUp = USERSPACE_RE.test(text);
  return {
    foundMarkers,
    missingMarkers,
    ok: userspaceUp && missingMarkers.length === 0,
    userspaceUp,
  };
}

async function analyzeSerialFile(serialPath, markers) {
  let text = "";
  try {
    text = await fs.readFile(serialPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return analyzeSerialText(text, markers);
}

async function waitForMarkers(serialPath, markers, timeoutSeconds) {
  const started = Date.now();
  let last = analyzeSerialText("", markers);
  while (Date.now() - started < timeoutSeconds * 1000) {
    last = await analyzeSerialFile(serialPath, markers);
    if (last.ok) {
      return last;
    }
    await sleep(1000);
  }
  return last;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function tailFile(filePath, lines) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") {
      return `<missing: ${filePath}>`;
    }
    throw error;
  }
}

function buildWorkspace(rawImage, opts) {
  const image = path.resolve(rawImage);
  const stem = path.basename(image, path.extname(image));
  const outDir = path.resolve(opts.outDir || path.join(path.dirname(image), `${stem}.vmware`));
  return {
    displayName: opts.name || `vita-${stem}`,
    image,
    outDir,
    screenshot: path.resolve(opts.screenshot || path.join(outDir, "screen.png")),
    serial: path.join(outDir, "serial.log"),
    vmdk: path.join(outDir, `${stem}.vmdk`),
    vmx: path.join(outDir, `${stem}.vmx`),
  };
}

async function startVm(vmrun, vmxPath, timeoutSeconds) {
  console.log(`vmrun: start ${vmxPath}`);
  await runChecked(
    "vmrun start",
    vmrun,
    ["-T", "ws", "start", vmxPath, "nogui"],
    timeoutSeconds * 1000,
  );
}

async function stopVm(vmrun, vmxPath) {
  console.log(`vmrun: stop ${vmxPath}`);
  const result = await spawnCapture(
    vmrun,
    ["-T", "ws", "stop", vmxPath, "hard"],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    console.error(`WARN: vmrun stop failed: ${result.stderr.trim() || result.error?.message || result.code}`);
  }
}

async function deleteVm(vmrun, vmxPath) {
  console.log(`vmrun: deleteVM ${vmxPath}`);
  const result = await spawnCapture(vmrun, ["-T", "ws", "deleteVM", vmxPath], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    console.error(`WARN: vmrun deleteVM failed: ${result.stderr.trim() || result.error?.message || result.code}`);
  }
}

async function captureScreen(vmrun, vmxPath, screenshotPath) {
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  console.log(`vmrun: captureScreen ${screenshotPath}`);
  // captureScreen is a guest op: needs VMware Tools (vmtoolsd) running + a guest login.
  // The verification image sets a known verification-only root password (root/vita).
  await runChecked(
    "vmrun captureScreen",
    vmrun,
    ["-T", "ws", "-gu", "root", "-gp", "vita", "captureScreen", vmxPath, screenshotPath],
    DEFAULT_SCREENSHOT_TIMEOUT_SECONDS * 1000,
  );
}

async function copyFileFromGuest(vmrun, vmxPath, guestPath, hostPath) {
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  console.log(`vmrun: copyFileFromGuestToHost ${guestPath} -> ${hostPath}`);
  // Guest op: needs vmtoolsd running + guest login (verification-only root/vita).
  await runChecked(
    "vmrun copyFileFromGuestToHost",
    vmrun,
    ["-T", "ws", "-gu", "root", "-gp", "vita", "copyFileFromGuestToHost", vmxPath, guestPath, hostPath],
    DEFAULT_SCREENSHOT_TIMEOUT_SECONDS * 1000,
  );
}

async function runLive(opts) {
  const workspace = buildWorkspace(opts.image, opts);
  const vmrun = resolveVmrun(opts);
  const qemuImg = resolveQemuImg(opts);
  let started = false;
  let markerResult = null;

  await fs.access(workspace.image, fsConstants.R_OK);
  await convertRawToVmdk(workspace.image, workspace.vmdk, qemuImg);
  await fs.writeFile(workspace.serial, "", "utf8");
  await writeVmx(workspace.vmx, {
    cpus: 2,
    displayName: workspace.displayName,
    firmware: opts.firmware,
    memoryMb: 2048,
    secureBoot: opts.secureBoot,
    serialPath: workspace.serial,
    vmdkPath: workspace.vmdk,
  });
  console.log(`vmx: ${workspace.vmx}`);

  try {
    await startVm(vmrun, workspace.vmx, opts.startTimeoutSeconds);
    started = true;
    markerResult = await waitForMarkers(
      workspace.serial,
      opts.markers,
      opts.markerTimeoutSeconds,
    );
    try {
      await captureScreen(vmrun, workspace.vmx, workspace.screenshot);
    } catch (error) {
      // Screenshot is BEST-EFFORT: vmrun captureScreen needs VMware Tools / a guest login in the
      // image. The serial-marker check is the verification gate, so a screenshot failure must NOT
      // fail a boot whose markers passed (GPU visual checks come with a desktop image + VMware Tools).
      console.error(`WARN: screenshot capture failed (needs VMware Tools/guest login in the image): ${error.message}`);
    }

    // Optional: copy a guest-rendered file out (e.g. the compositor's in-guest GPU-readback PNG),
    // which captures exactly what the compositor rendered — independent of the VMware display path.
    if (opts.guestFile) {
      try {
        await copyFileFromGuest(vmrun, workspace.vmx, opts.guestFile.guest, opts.guestFile.host);
        console.log(`guest-file: ${opts.guestFile.host}`);
      } catch (error) {
        console.error(`WARN: guest-file copy failed: ${error.message}`);
      }
    }

    if (!markerResult.ok) {
      console.error("RESULT: FAIL");
      console.error(`userspace-up=${markerResult.userspaceUp ? "yes" : "no"}`);
      console.error(`missing markers: ${markerResult.missingMarkers.join(", ") || "<none>"}`);
      console.error("----- serial.log tail -----");
      console.error(await tailFile(workspace.serial, 30));
      return 1;
    }

    console.log("RESULT: PASS");
    console.log(`markers: ${markerResult.foundMarkers.join(", ")}`);
    console.log(`screenshot: ${workspace.screenshot}`);
    return 0;
  } finally {
    if (started) {
      await stopVm(vmrun, workspace.vmx);
    }
    if (!opts.keep) {
      await deleteVm(vmrun, workspace.vmx);
    } else {
      console.log(`keep: generated VM files left in ${workspace.outDir}`);
    }
  }
}

async function runSelfCheck() {
  console.log("===== VMware verify self-check =====");
  const fixtureImage = path.join("fixtures", "vita.raw");
  const opts = parseArgs([
    "--image",
    fixtureImage,
    "--markers",
    "VITA-COMPOSITOR,VITA-FOO",
    "--secure-boot",
    "off",
    "--keep",
  ]);
  assert.equal(opts.image, fixtureImage);
  assert.deepEqual(opts.markers, ["VITA-COMPOSITOR", "VITA-FOO"]);
  assert.equal(opts.secureBoot, false);
  assert.equal(opts.keep, true);
  console.log("arg parsing: ok");

  const vmrun = resolveVmrun(opts);
  const qemuImg = resolveQemuImg(opts);
  const [vmrunProbe, qemuProbe] = await Promise.all([
    probeVmrun(vmrun),
    probeQemuImg(qemuImg),
  ]);
  console.log(`vmrun: ${vmrunProbe.ok ? "FOUND" : "MISSING"} - ${vmrunProbe.message}`);
  console.log(`qemu-img: ${qemuProbe.ok ? "FOUND" : "MISSING"} - ${qemuProbe.message}`);
  if (!vmrunProbe.ok || !qemuProbe.ok) {
    console.log("host tools: reported only; live verification requires both tools");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vita-vmware-self-"));
  try {
    const serialPath = path.join(tempDir, "serial.log");
    const vmdkPath = path.join(tempDir, "vita.vmdk");
    const vmx = renderVmx({
      cpus: 2,
      displayName: "vita-self-check",
      firmware: "efi",
      memoryMb: 2048,
      secureBoot: false,
      serialPath,
      vmdkPath,
    });
    assert.match(vmx, /firmware = "efi"/);
    assert.match(vmx, /uefi\.secureBoot\.enabled = "FALSE"/);
    assert.match(vmx, /serial0\.fileType = "file"/);
    assert.match(vmx, /serial0\.fileName = ".+serial\.log"/);
    assert.match(vmx, /mks\.enable3d = "TRUE"/);
    assert.match(vmx, /vmotion\.checkpointFBSize = "134217728"/);
    assert.match(vmx, /svga\.graphicsMemoryKB = "262144"/);
    assert.match(vmx, /sata0:0\.fileName = ".+vita\.vmdk"/);
    console.log("vmx template: ok");

    await fs.writeFile(
      serialPath,
      [
        "[ OK ] Reached target Multi-User System.",
        "VITA-COMPOSITOR: frame=1 status=OK",
        "VITA-FOO: status=OK",
      ].join("\n"),
      "utf8",
    );
    const pass = await analyzeSerialFile(serialPath, opts.markers);
    assert.equal(pass.ok, true);
    assert.equal(pass.userspaceUp, true);
    assert.deepEqual(pass.missingMarkers, []);

    await fs.writeFile(
      serialPath,
      [
        "[ OK ] Reached target Multi-User System.",
        "VITA-COMPOSITOR: frame=1 status=OK",
      ].join("\n"),
      "utf8",
    );
    const fail = await analyzeSerialFile(serialPath, opts.markers);
    assert.equal(fail.ok, false);
    assert.equal(fail.userspaceUp, true);
    assert.deepEqual(fail.missingMarkers, ["VITA-FOO"]);
    console.log("marker fixtures: ok");
  } finally {
    await removeSelfCheckTemp(tempDir);
  }

  console.log("SELF-CHECK PASS");
}

async function removeSelfCheckTemp(tempDir) {
  const realTemp = await fs.realpath(os.tmpdir());
  const realTarget = await fs.realpath(tempDir).catch(() => "");
  const base = path.basename(realTarget);
  if (
    realTarget &&
    realTarget.startsWith(`${realTemp}${path.sep}`) &&
    base.startsWith("vita-vmware-self-")
  ) {
    await fs.rm(realTarget, { force: true, recursive: true });
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (opts.selfCheck) {
    await runSelfCheck();
    return 0;
  }
  return await runLive(opts);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
// Deterministic agentd rootfs-integration planner (P1-026).
//
// planAgentImage() is pure and I/O-free: given the committed agent-image.conf text (and the
// host mount roots), it returns the normalized plan that (a) reproducibly builds the privileged
// Go agent (agent/cmd/agentd) via tools/build/go-in-docker.mjs with fixed flags + SOURCE_DATE_EPOCH
// so the same source yields a byte-identical binary, and (b) the install manifest that stages the
// binary + symlink + state dir + enabled systemd unit + tmpfiles into the rootfs overlay applied
// by mkosi --extra-tree. Same source -> byte-identical binary -> stable verity root hash.
//
// Mirrors the neighbouring planners (verity.mjs, rootfs-image.mjs): same config grammar, the same
// safeNormalize trust-boundary, the same canonical-POSIX-path validation, the same stableStringify.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeNormalize } from "../../sdk/typescript/src/safe-normalize.ts";

export const DEFAULT_AGENT_IMAGE_GO_IMAGE = "golang:1.26";
export const DEFAULT_AGENT_IMAGE_MODULE_DIR = "agent";
export const DEFAULT_AGENT_IMAGE_BUILD_TARGET = "./cmd/agentd";
export const DEFAULT_AGENT_IMAGE_OUTPUT = "/work/os/x86_64/out/agent/agentd";
export const DEFAULT_AGENT_IMAGE_LDFLAGS = "-s -w -buildid=";
export const DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH = "1781308800";
export const DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS = "127.0.0.1:8786";
export const DEFAULT_AGENT_IMAGE_CONFIG_TEXT = `# Vita x86_64 deterministic agentd rootfs-integration plan (P1-026).
# Pins the reproducible Go build of the privileged system agent (agent/cmd/agentd) and the
# install manifest that stages it into the rootfs via the mkosi --extra-tree overlay.
# Same agent source -> byte-identical binary, so the verity root hash stays stable.

[Paths]
WorkRoot=/work
SourceRoot=/work/agent
OutputRoot=/work/os/x86_64/out/agent
OverlayRoot=/work/os/x86_64/agent-overlay
Config=/work/os/x86_64/agent-image.conf

[Build]
Builder=tools/build/go-in-docker.mjs
Image=golang:1.26
ModuleDir=agent
Command=build
Target=./cmd/agentd
Output=/work/os/x86_64/out/agent/agentd
CgoEnabled=0
GoOS=linux
GoArch=amd64
Trimpath=true
BuildVcs=false
Ldflags=-s -w -buildid=
SourceDateEpoch=1781308800
Network=build-time-module-fetch-only

[Install]
Binary=/usr/lib/vita/agentd
BinaryMode=0755
BinaryOwner=root:root
Symlink=/usr/bin/vita-agentd
SymlinkTarget=/usr/lib/vita/agentd
StateDir=/var/lib/vita-agent
StateDirMode=0700
StateDirOwner=root:root

[Service]
Unit=vita-agentd.service
UnitPath=/usr/lib/systemd/system/vita-agentd.service
WantedBy=multi-user.target
EnablePath=/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service
EnableTarget=../vita-agentd.service
ExecStart=/usr/lib/vita/agentd
Type=simple
AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN CAP_SYS_TIME
ListenAddress=127.0.0.1:8786

[Tmpfiles]
ConfPath=/usr/lib/tmpfiles.d/vita-agent.conf
Entry=d /var/lib/vita-agent 0700 root root -
`;

const DEFAULT_AGENT_IMAGE_PLAN_INPUT = Object.freeze({
  configText: DEFAULT_AGENT_IMAGE_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    outputHostPath: "/repo/os/x86_64/out/agent",
  }),
});

const AGENT_IMAGE_CONFIG_PATH = "os/x86_64/agent-image.conf";
const AGENT_IMAGE_BUILDER = "tools/build/go-in-docker.mjs";
const AGENT_OVERLAY_RELATIVE_PATH = "os/x86_64/agent-overlay";
const AGENT_AMBIENT_CAPABILITIES = Object.freeze(["CAP_NET_ADMIN", "CAP_SYS_ADMIN", "CAP_SYS_TIME"]);
const CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "u");
const PATH_CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001F\\u007F]", "u");

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planAgentImage(input = DEFAULT_AGENT_IMAGE_PLAN_INPUT) {
  const normalizedInput = normalizeAgentImagePlanInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, AGENT_IMAGE_CONFIG_PATH);
  const resolvedConfig = resolveAgentImageConfig(config);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const mounts = buildMounts(normalizedInput.value.mountRoots, resolvedConfig.paths);
  const buildCommand = buildAgentdBuildCommand(resolvedConfig.build);
  const install = buildInstallManifest(resolvedConfig);

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: AGENT_IMAGE_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
    },
    mounts,
    tool: {
      builder: resolvedConfig.build.builder,
      image: resolvedConfig.build.image,
      moduleDir: resolvedConfig.build.moduleDir,
      language: "go",
      reproducible: true,
      network: "build-time-module-fetch-only",
      runtimeCorrectness: "pending-build-and-boot-smoke",
    },
    build: buildCommand,
    install,
    overlay: {
      relativePath: AGENT_OVERLAY_RELATIVE_PATH,
      extraTree: AGENT_OVERLAY_RELATIVE_PATH,
      stages: [
        {
          kind: "binary",
          from: resolvedConfig.build.output,
          to: install.binary.path,
          mode: install.binary.mode,
          owner: install.binary.owner,
        },
        {
          kind: "symlink",
          path: install.symlink.path,
          target: install.symlink.target,
        },
        {
          kind: "systemd-unit",
          path: install.service.unitPath,
          enabledBy: install.service.enablePath,
        },
        {
          kind: "tmpfiles",
          path: install.tmpfiles.path,
          entry: install.tmpfiles.entry,
        },
      ],
    },
    inputs: {
      source: {
        name: "vita-agentd-source",
        kind: "go-module-command",
        module: "github.com/vita/agent",
        moduleDir: resolvedConfig.build.moduleDir,
        target: resolvedConfig.build.target,
        path: resolvedConfig.paths.sourceRoot,
      },
    },
    outputs: {
      binary: {
        name: "vita-agentd",
        kind: "go-binary",
        source: "go-in-docker-build-output",
        path: resolvedConfig.build.output,
        os: resolvedConfig.build.goOS,
        arch: resolvedConfig.build.goArch,
        reproducible: true,
      },
    },
    steps: [
      {
        id: "build-agentd",
        kind: "go-build-plan",
        status: "ready",
        executable: false,
        upstreamPrivileged: false,
        network: "build-time-module-fetch-only",
        command: buildCommand,
        output: resolvedConfig.build.output,
        blocks: ["stage-agentd-overlay"],
      },
      {
        id: "stage-agentd-overlay",
        kind: "rootfs-overlay-stage-plan",
        status: "blocked",
        executable: false,
        upstreamPrivileged: false,
        network: "none",
        gatedBy: ["build-agentd"],
        input: resolvedConfig.build.output,
        extraTree: AGENT_OVERLAY_RELATIVE_PATH,
        install,
        blocks: ["assemble-image"],
      },
    ],
  };
}

export function serializeAgentImagePlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeAgentImagePlanInput(input) {
  const normalized = safeNormalize(input, { maxDepth: 64, maxNodes: 10_000 });
  if (!normalized.ok) {
    return { ok: false, error: `agent image plan input normalization failed: ${normalized.reason}` };
  }
  if (!isPlainRecord(normalized.value)) {
    return { ok: false, error: "agent image plan input must be a plain object" };
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(normalized.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `agent image plan input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(normalized.value, "configText")) {
    return { ok: false, error: "agent image plan input missing required field configText" };
  }
  if (!Object.hasOwn(normalized.value, "mountRoots")) {
    return { ok: false, error: "agent image plan input missing required field mountRoots" };
  }

  const configText = normalized.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "agent image plan input field configText must be a non-empty string" };
  }

  const mountRoots = normalizeMountRoots(normalized.value.mountRoots);
  if (!mountRoots.ok) {
    return mountRoots;
  }

  return {
    ok: true,
    value: {
      configText,
      mountRoots: mountRoots.value,
    },
  };
}

function normalizeMountRoots(input) {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "agent image mount roots must be a plain object" };
  }

  const requiredKeys = ["workspaceHostPath", "outputHostPath"];
  const allowedKeys = new Set(requiredKeys);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `agent image mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      return { ok: false, error: `agent image mount roots missing required field ${key}` };
    }
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `agent image mount roots field ${key} must be a non-empty string` };
    }
    rawValues[key] = value;
  }

  const workspaceHostPath = validateCanonicalPosixPath(rawValues.workspaceHostPath, {
    label: "mountRoots.workspaceHostPath",
    root: "/",
    allowRoot: false,
  });
  const outputHostPath = validateCanonicalPosixPath(rawValues.outputHostPath, {
    label: "mountRoots.outputHostPath",
    root: workspaceHostPath,
    allowRoot: false,
  });

  return {
    ok: true,
    value: {
      workspaceHostPath,
      outputHostPath,
    },
  };
}

function parseKeyValueConfig(text, label) {
  const sections = new Map();
  let currentSection = "";
  const lines = text.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1];
      if (sections.has(sectionName)) {
        throw new ConfigValidationError(`${label}:${lineNumber} repeats section [${sectionName}]`);
      }
      sections.set(sectionName, new Map());
      currentSection = sectionName;
      continue;
    }

    if (currentSection === "") {
      throw new ConfigValidationError(`${label}:${lineNumber} setting appears before a section`);
    }
    if (/^\s/.test(rawLine)) {
      throw new ConfigValidationError(`${label}:${lineNumber} must not use continuation lines`);
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw new ConfigValidationError(`${label}:${lineNumber} must be a Key=Value setting`);
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} has invalid key ${key}`);
    }
    if (CONTROL_CHAR_PATTERN.test(value)) {
      throw new ConfigValidationError(`${label}:${lineNumber} ${currentSection}.${key} must not contain control characters`);
    }
    assertNoKeyMaterial(value, `${label}:${lineNumber} ${currentSection}.${key}`);

    const section = sections.get(currentSection);
    if (section.has(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} repeats setting ${currentSection}.${key}`);
    }
    section.set(key, value);
  }

  return { label, sections };
}

function resolveAgentImageConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "SourceRoot", "OutputRoot", "OverlayRoot", "Config"],
    Build: [
      "Builder",
      "Image",
      "ModuleDir",
      "Command",
      "Target",
      "Output",
      "CgoEnabled",
      "GoOS",
      "GoArch",
      "Trimpath",
      "BuildVcs",
      "Ldflags",
      "SourceDateEpoch",
      "Network",
    ],
    Install: [
      "Binary",
      "BinaryMode",
      "BinaryOwner",
      "Symlink",
      "SymlinkTarget",
      "StateDir",
      "StateDirMode",
      "StateDirOwner",
    ],
    Service: [
      "Unit",
      "UnitPath",
      "WantedBy",
      "EnablePath",
      "EnableTarget",
      "ExecStart",
      "Type",
      "AmbientCapabilities",
      "ListenAddress",
    ],
    Tmpfiles: ["ConfPath", "Entry"],
  });

  const paths = resolvePaths(config);
  const build = resolveBuild(config, paths);
  const install = resolveInstall(config);
  const service = resolveService(config, install);
  const tmpfiles = resolveTmpfiles(config, install);

  return {
    paths,
    build,
    install,
    service,
    tmpfiles,
  };
}

function resolvePaths(config) {
  const workRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "WorkRoot"), {
    label: "Paths.WorkRoot",
    root: "/",
    allowRoot: false,
  });
  const sourceRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "SourceRoot"), {
    label: "Paths.SourceRoot",
    root: workRoot,
    allowRoot: false,
  });
  const outputRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "OutputRoot"), {
    label: "Paths.OutputRoot",
    root: workRoot,
    allowRoot: false,
  });
  const overlayRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "OverlayRoot"), {
    label: "Paths.OverlayRoot",
    root: workRoot,
    allowRoot: false,
  });
  const configPath = validateCanonicalPosixPath(getSingleValue(config, "Paths", "Config"), {
    label: "Paths.Config",
    root: workRoot,
    allowRoot: false,
  });

  assertExpected(workRoot, "/work", "Paths.WorkRoot");
  assertExpected(sourceRoot, "/work/agent", "Paths.SourceRoot");
  assertExpected(outputRoot, "/work/os/x86_64/out/agent", "Paths.OutputRoot");
  assertExpected(overlayRoot, "/work/os/x86_64/agent-overlay", "Paths.OverlayRoot");
  assertExpected(configPath, "/work/os/x86_64/agent-image.conf", "Paths.Config");

  return {
    workRoot,
    sourceRoot,
    outputRoot,
    overlayRoot,
    configPath,
  };
}

function resolveBuild(config, paths) {
  const builder = getSingleValue(config, "Build", "Builder");
  assertExpected(builder, AGENT_IMAGE_BUILDER, "Build.Builder");

  const image = getSingleValue(config, "Build", "Image");
  assertExpected(image, DEFAULT_AGENT_IMAGE_GO_IMAGE, "Build.Image");

  const moduleDir = getSingleValue(config, "Build", "ModuleDir");
  assertExpected(moduleDir, DEFAULT_AGENT_IMAGE_MODULE_DIR, "Build.ModuleDir");

  const command = getSingleValue(config, "Build", "Command");
  assertExpected(command, "build", "Build.Command");

  const target = getSingleValue(config, "Build", "Target");
  assertExpected(target, DEFAULT_AGENT_IMAGE_BUILD_TARGET, "Build.Target");

  const output = validateCanonicalPosixPath(getSingleValue(config, "Build", "Output"), {
    label: "Build.Output",
    root: paths.outputRoot,
    allowRoot: false,
  });
  assertExpected(output, DEFAULT_AGENT_IMAGE_OUTPUT, "Build.Output");

  const cgoEnabled = getSingleValue(config, "Build", "CgoEnabled");
  assertExpected(cgoEnabled, "0", "Build.CgoEnabled");

  const goOS = getSingleValue(config, "Build", "GoOS");
  assertExpected(goOS, "linux", "Build.GoOS");

  const goArch = getSingleValue(config, "Build", "GoArch");
  assertExpected(goArch, "amd64", "Build.GoArch");

  const trimpath = getBoolean(config, "Build", "Trimpath");
  if (trimpath !== true) {
    throw new ConfigValidationError("Build.Trimpath must be true for reproducible builds");
  }

  const buildVcs = getBoolean(config, "Build", "BuildVcs");
  if (buildVcs !== false) {
    throw new ConfigValidationError("Build.BuildVcs must be false for reproducible builds");
  }

  const ldflags = getSingleValue(config, "Build", "Ldflags");
  assertExpected(ldflags, DEFAULT_AGENT_IMAGE_LDFLAGS, "Build.Ldflags");
  if (!ldflags.includes("-buildid=")) {
    throw new ConfigValidationError("Build.Ldflags must clear the build id with -buildid=");
  }

  const sourceDateEpoch = getSingleValue(config, "Build", "SourceDateEpoch");
  assertExpected(sourceDateEpoch, DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH, "Build.SourceDateEpoch");
  if (!/^[0-9]+$/.test(sourceDateEpoch)) {
    throw new ConfigValidationError("Build.SourceDateEpoch must be a base-10 epoch");
  }

  const network = getSingleValue(config, "Build", "Network");
  assertExpected(network, "build-time-module-fetch-only", "Build.Network");

  return {
    builder,
    image,
    moduleDir,
    command,
    target,
    output,
    cgoEnabled,
    goOS,
    goArch,
    trimpath,
    buildVcs,
    ldflags,
    sourceDateEpoch,
    network,
  };
}

function resolveInstall(config) {
  const binaryPath = validateCanonicalPosixPath(getSingleValue(config, "Install", "Binary"), {
    label: "Install.Binary",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(binaryPath, "/usr/lib/vita/agentd", "Install.Binary");

  const binaryMode = validateMode(getSingleValue(config, "Install", "BinaryMode"), "Install.BinaryMode");
  assertExpected(binaryMode, "0755", "Install.BinaryMode");

  const binaryOwner = validateOwner(getSingleValue(config, "Install", "BinaryOwner"), "Install.BinaryOwner");
  assertExpected(binaryOwner, "root:root", "Install.BinaryOwner");

  const symlinkPath = validateCanonicalPosixPath(getSingleValue(config, "Install", "Symlink"), {
    label: "Install.Symlink",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(symlinkPath, "/usr/bin/vita-agentd", "Install.Symlink");

  const symlinkTarget = validateCanonicalPosixPath(getSingleValue(config, "Install", "SymlinkTarget"), {
    label: "Install.SymlinkTarget",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(symlinkTarget, binaryPath, "Install.SymlinkTarget");

  const stateDir = validateCanonicalPosixPath(getSingleValue(config, "Install", "StateDir"), {
    label: "Install.StateDir",
    root: "/var",
    allowRoot: false,
  });
  assertExpected(stateDir, "/var/lib/vita-agent", "Install.StateDir");

  const stateDirMode = validateMode(getSingleValue(config, "Install", "StateDirMode"), "Install.StateDirMode");
  assertExpected(stateDirMode, "0700", "Install.StateDirMode");

  const stateDirOwner = validateOwner(getSingleValue(config, "Install", "StateDirOwner"), "Install.StateDirOwner");
  assertExpected(stateDirOwner, "root:root", "Install.StateDirOwner");

  return {
    binary: {
      kind: "binary",
      path: binaryPath,
      mode: binaryMode,
      owner: binaryOwner,
    },
    symlink: {
      kind: "symlink",
      path: symlinkPath,
      target: symlinkTarget,
    },
    stateDir: {
      kind: "directory",
      path: stateDir,
      mode: stateDirMode,
      owner: stateDirOwner,
    },
  };
}

function resolveService(config, install) {
  const unit = getSingleValue(config, "Service", "Unit");
  assertExpected(unit, "vita-agentd.service", "Service.Unit");

  const unitPath = validateCanonicalPosixPath(getSingleValue(config, "Service", "UnitPath"), {
    label: "Service.UnitPath",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(unitPath, "/usr/lib/systemd/system/vita-agentd.service", "Service.UnitPath");

  const wantedBy = getSingleValue(config, "Service", "WantedBy");
  assertExpected(wantedBy, "multi-user.target", "Service.WantedBy");

  const enablePath = validateCanonicalPosixPath(getSingleValue(config, "Service", "EnablePath"), {
    label: "Service.EnablePath",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(
    enablePath,
    "/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service",
    "Service.EnablePath",
  );

  const enableTarget = getSingleValue(config, "Service", "EnableTarget");
  assertExpected(enableTarget, "../vita-agentd.service", "Service.EnableTarget");

  const execStart = validateCanonicalPosixPath(getSingleValue(config, "Service", "ExecStart"), {
    label: "Service.ExecStart",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(execStart, install.binary.path, "Service.ExecStart");

  const type = getSingleValue(config, "Service", "Type");
  assertExpected(type, "simple", "Service.Type");

  const ambientCapabilities = getSpaceList(config, "Service", "AmbientCapabilities");
  assertArrayEquals(ambientCapabilities, AGENT_AMBIENT_CAPABILITIES, "Service.AmbientCapabilities");

  const listenAddress = getSingleValue(config, "Service", "ListenAddress");
  assertExpected(listenAddress, DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS, "Service.ListenAddress");
  assertLoopback(listenAddress, "Service.ListenAddress");

  return {
    unit,
    unitPath,
    wantedBy,
    enablePath,
    enableTarget,
    execStart,
    type,
    ambientCapabilities,
    listenAddress,
  };
}

function resolveTmpfiles(config, install) {
  const confPath = validateCanonicalPosixPath(getSingleValue(config, "Tmpfiles", "ConfPath"), {
    label: "Tmpfiles.ConfPath",
    root: "/usr",
    allowRoot: false,
  });
  assertExpected(confPath, "/usr/lib/tmpfiles.d/vita-agent.conf", "Tmpfiles.ConfPath");

  const entry = getSingleValue(config, "Tmpfiles", "Entry");
  const expectedEntry = `d ${install.stateDir.path} ${install.stateDir.mode} root root -`;
  assertExpected(entry, expectedEntry, "Tmpfiles.Entry");

  return {
    confPath,
    entry,
  };
}

function buildAgentdBuildCommand(build) {
  // Forward the reproducibility-relevant env INTO the container via go-in-docker's --env passthrough.
  // go-in-docker only sets GOFLAGS by default; without --env these are silently dropped and the binary
  // builds with the container defaults (CGO on → dynamically linked, unpinned timestamps → not reproducible).
  const containerEnv = {
    CGO_ENABLED: build.cgoEnabled,
    GOOS: build.goOS,
    GOARCH: build.goArch,
    SOURCE_DATE_EPOCH: build.sourceDateEpoch,
  };
  const envFlags = Object.entries(containerEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const builderArgs = [
    "--dir",
    build.moduleDir,
    ...envFlags,
    build.command,
    "-trimpath",
    "-buildvcs=false",
    "-ldflags",
    build.ldflags,
    "-o",
    build.output,
    build.target,
  ];

  return {
    executable: "node",
    script: build.builder,
    args: [build.builder, ...builderArgs],
    builderArgs,
    image: build.image,
    moduleDir: build.moduleDir,
    target: build.target,
    output: build.output,
    environment: {
      ...containerEnv,
      GOFLAGS: "-buildvcs=false",
    },
    reproducible: true,
    network: "build-time-module-fetch-only",
  };
}

function buildInstallManifest(resolvedConfig) {
  return {
    binary: resolvedConfig.install.binary,
    symlink: resolvedConfig.install.symlink,
    stateDir: resolvedConfig.install.stateDir,
    service: {
      unit: resolvedConfig.service.unit,
      unitPath: resolvedConfig.service.unitPath,
      type: resolvedConfig.service.type,
      execStart: resolvedConfig.service.execStart,
      wantedBy: resolvedConfig.service.wantedBy,
      enablePath: resolvedConfig.service.enablePath,
      enableTarget: resolvedConfig.service.enableTarget,
      ambientCapabilities: resolvedConfig.service.ambientCapabilities,
      listenAddress: resolvedConfig.service.listenAddress,
      enabled: true,
    },
    tmpfiles: {
      path: resolvedConfig.tmpfiles.confPath,
      entry: resolvedConfig.tmpfiles.entry,
    },
  };
}

function buildMounts(mountRoots, paths) {
  return [
    {
      name: "source-tree",
      hostPath: mountRoots.workspaceHostPath,
      containerPath: paths.workRoot,
      readOnly: true,
    },
    {
      name: "agentd-build-output",
      hostPath: mountRoots.outputHostPath,
      containerPath: paths.outputRoot,
      readOnly: false,
    },
  ];
}

function assertAllowedSettings(config, allowed) {
  for (const sectionName of config.sections.keys()) {
    if (!Object.hasOwn(allowed, sectionName)) {
      throw new ConfigValidationError(`${config.label} contains unsupported section [${sectionName}]`);
    }

    const allowedKeys = new Set(allowed[sectionName]);
    const section = config.sections.get(sectionName);
    for (const key of section.keys()) {
      if (!allowedKeys.has(key)) {
        throw new ConfigValidationError(`${config.label} contains unsupported setting ${sectionName}.${key}`);
      }
    }
  }
}

function getSingleValue(config, sectionName, key) {
  const section = config.sections.get(sectionName);
  if (section === undefined) {
    throw new ConfigValidationError(`${config.label} missing section [${sectionName}]`);
  }
  const value = section.get(key);
  if (value === undefined || value === "") {
    throw new ConfigValidationError(`${config.label} missing setting ${sectionName}.${key}`);
  }
  return value;
}

function getBoolean(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigValidationError(`${sectionName}.${key} must be true or false`);
}

function getSpaceList(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  const entries = value.split(/\s+/).filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new ConfigValidationError(`${sectionName}.${key} must contain at least one entry`);
  }
  return entries;
}

function validateMode(value, label) {
  if (!/^0[0-7]{3}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a 4-digit octal mode (e.g. 0755)`);
  }
  return value;
}

function validateOwner(value, label) {
  if (!/^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a user:group owner pair`);
  }
  return value;
}

function assertLoopback(value, label) {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) {
    throw new ConfigValidationError(`${label} must be host:port`);
  }
  const host = value.slice(0, lastColon);
  const port = value.slice(lastColon + 1);
  if (host !== "127.0.0.1") {
    throw new ConfigValidationError(`${label} must bind loopback 127.0.0.1, not ${host}`);
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new ConfigValidationError(`${label} must use a valid TCP port`);
  }
}

function validateCanonicalPosixPath(path, options) {
  if (typeof path !== "string" || path.length === 0) {
    throw new ConfigValidationError(`${options.label} must be a non-empty POSIX path`);
  }
  const canonicalPath = parseCanonicalAbsolutePosixPath(path, options.label);
  const canonicalRoot = parseCanonicalAbsolutePosixPath(options.root, `${options.label} mount root`);
  if (canonicalRoot === "/") {
    if (canonicalPath === "/") {
      if (options.allowRoot) {
        return canonicalPath;
      }
      throw new ConfigValidationError(`${options.label} must be inside /, not the mount root itself`);
    }
    return canonicalPath;
  }
  if (canonicalPath === canonicalRoot) {
    if (options.allowRoot) {
      return canonicalPath;
    }
    throw new ConfigValidationError(`${options.label} must be inside ${canonicalRoot}, not the mount root itself`);
  }
  if (!canonicalPath.startsWith(`${canonicalRoot}/`)) {
    throw new ConfigValidationError(`${options.label} must stay within mount root ${canonicalRoot}`);
  }
  return canonicalPath;
}

function parseCanonicalAbsolutePosixPath(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new ConfigValidationError(`${label} must be a non-empty POSIX path`);
  }
  if (PATH_CONTROL_CHAR_PATTERN.test(path)) {
    throw new ConfigValidationError(`${label} must not contain control characters`);
  }
  if (path.includes("\\")) {
    throw new ConfigValidationError(`${label} must use POSIX separators`);
  }
  if (!path.startsWith("/")) {
    throw new ConfigValidationError(`${label} must be absolute`);
  }
  if (path === "/") {
    return "/";
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new ConfigValidationError(`${label} must not have a trailing slash`);
  }

  const parts = path.split("/");
  if (parts[0] !== "") {
    throw new ConfigValidationError(`${label} must be absolute`);
  }
  if (parts.length === 1) {
    return "/";
  }

  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "") {
      throw new ConfigValidationError(`${label} must not contain empty or duplicate-slash segments`);
    }
    if (part === "." || part === "..") {
      throw new ConfigValidationError(`${label} must not contain . or .. segments`);
    }
  }

  return parts.length === 2 && parts[1] === "" ? "/" : `/${parts.slice(1).join("/")}`;
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) {
    throw new ConfigValidationError(`${label} expected ${expected}, found ${actual}`);
  }
}

function assertArrayEquals(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new ConfigValidationError(`${label} expected ${expected.length} entries, found ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new ConfigValidationError(`${label}[${index}] expected ${expected[index]}, found ${actual[index]}`);
    }
  }
}

function assertNoKeyMaterial(value, label) {
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|PUBLIC KEY|CERTIFICATE)-----/u.test(value)) {
    throw new ConfigValidationError(`${label} must reference key material, not embed it`);
  }
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

function readAgentImageInput(repoRoot) {
  return {
    configText: readFileSync(join(repoRoot, AGENT_IMAGE_CONFIG_PATH), "utf8"),
    mountRoots: DEFAULT_AGENT_IMAGE_PLAN_INPUT.mountRoots,
  };
}

function printUsage() {
  console.error("usage: node --experimental-strip-types os/x86_64/agent-image.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = dirname(dirname(dirname(scriptPath)));
    process.stdout.write(serializeAgentImagePlan(planAgentImage(readAgentImageInput(repoRoot))));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

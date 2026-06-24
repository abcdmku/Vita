#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PINNED_MKOSI_IMAGE =
  "ghcr.io/systemd/mkosi@sha256:8b3870c154f085ba3428afa82799be2138ec2ca339d84a9f3802e02c342b31b2";
export const DEFAULT_DEBIAN_SNAPSHOT = "20260613T000000Z";
export const DEFAULT_SOURCE_DATE_EPOCH = "1781308800";
export const DEFAULT_PACKAGE_ALLOWLIST = Object.freeze([
  "bash",
  "ca-certificates",
  "coreutils",
  "cryptsetup-bin",
  "dbus",
  "initramfs-tools",
  "iproute2",
  "kmod",
  "linux-image-amd64",
  "nftables",
  "systemd",
  "systemd-boot",
  "systemd-boot-efi",
  "systemd-sysv",
  "udev",
  "util-linux",
]);

const COMMON_CONFIG_TEXT = `# Vita immutable Debian root baseline.
# Vita-ImmutableRoot=read-only
# Keep this package allowlist in lockstep with os/x86_64/test/root-determinism.test.ts.

[Distribution]
Distribution=debian
Release=trixie
Mirror=https://snapshot.debian.org/archive/debian/20260613T000000Z/
Repositories=main

[Output]
Format=directory
ImageVersion=0.1-bootstrap

[Content]
BasePackages=no
Bootable=no
CleanPackageMetadata=yes
WithNetwork=no
Packages=
    bash
    ca-certificates
    coreutils
    dbus
    initramfs-tools
    iproute2
    kmod
    linux-image-amd64
    nftables
    systemd
    systemd-boot
    systemd-boot-efi
    systemd-sysv
    udev
    util-linux
Environment=
    SOURCE_DATE_EPOCH=1781308800
    TZ=UTC
    LC_ALL=C.UTF-8
`;

const X86_64_CONFIG_TEXT = `[Include]
Include=../common/mkosi.conf

[Distribution]
Architecture=x86-64

[Output]
Output=vita-debian-trixie-x86_64-root

[Content]
Packages=
    bash
    ca-certificates
    coreutils
    cryptsetup-bin
    dbus
    initramfs-tools
    iproute2
    kmod
    linux-image-amd64
    nftables
    systemd
    systemd-boot
    systemd-boot-efi
    systemd-sysv
    udev
    util-linux
`;

const DEFAULT_ROOT_BUILD_INPUT = Object.freeze({
  commonConfigText: COMMON_CONFIG_TEXT,
  archConfigText: X86_64_CONFIG_TEXT,
  workspacePath: "/workspace/vita",
  outputPath: "/workspace/vita/os/x86_64/out",
});

const COMMON_CONFIG_PATH = "os/common/mkosi.conf";
const ARCH_CONFIG_PATH = "os/x86_64/mkosi.conf";
const COMMON_CONTAINER_PATH = "/work/os/common/mkosi.conf";
const ARCH_CONTAINER_PATH = "/work/os/x86_64/mkosi.conf";
const ARCH_DIRECTORY = "/work/os/x86_64";
const OUTPUT_DIRECTORY = "/out";
const EXPECTED_COMMON_INCLUDE = "../common/mkosi.conf";

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planRootBuild(input = DEFAULT_ROOT_BUILD_INPUT) {
  const normalizedInput = normalizeRootBuildInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const commonConfig = parseMkosiConfig(normalizedInput.value.commonConfigText, COMMON_CONFIG_PATH);
  const archConfig = parseMkosiConfig(normalizedInput.value.archConfigText, ARCH_CONFIG_PATH);
  const resolvedConfig = resolveMkosiConfig(commonConfig, archConfig);
  const sourceDateEpoch = resolvedConfig.environment.SOURCE_DATE_EPOCH;

  const workspacePath = normalizeHostPath(normalizedInput.value.workspacePath);
  const outputPath = normalizeHostPath(normalizedInput.value.outputPath);
  const dockerArgs = [
    "run",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "-v",
    `${workspacePath}:/work:ro`,
    "-v",
    `${outputPath}:${OUTPUT_DIRECTORY}`,
    "-w",
    ARCH_DIRECTORY,
    "-e",
    `SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
    "-e",
    "TZ=UTC",
    "-e",
    "LC_ALL=C.UTF-8",
    PINNED_MKOSI_IMAGE,
    "mkosi",
    "--directory",
    ARCH_DIRECTORY,
    "--force",
    "--output-dir",
    OUTPUT_DIRECTORY,
  ];

  return {
    schemaVersion: 1,
    target: "x86_64",
    builder: {
      engine: "docker",
      image: PINNED_MKOSI_IMAGE,
      pullPolicy: "never",
      network: "none",
      workdir: ARCH_DIRECTORY,
    },
    config: {
      commonPath: COMMON_CONFIG_PATH,
      archPath: ARCH_CONFIG_PATH,
      includeChain: [
        {
          name: "common",
          hostPath: COMMON_CONFIG_PATH,
          containerPath: COMMON_CONTAINER_PATH,
          digest: sha256Text(normalizedInput.value.commonConfigText),
        },
        {
          name: "x86_64",
          hostPath: ARCH_CONFIG_PATH,
          containerPath: ARCH_CONTAINER_PATH,
          includes: [resolvedConfig.include],
          resolvedIncludes: [COMMON_CONTAINER_PATH],
          digest: sha256Text(normalizedInput.value.archConfigText),
        },
      ],
      distribution: resolvedConfig.distribution,
      release: resolvedConfig.release,
      snapshot: DEFAULT_DEBIAN_SNAPSHOT,
      mirror: resolvedConfig.mirror,
      repositories: resolvedConfig.repositories,
      architecture: "x86_64",
      mkosiArchitecture: resolvedConfig.architecture,
      outputFormat: resolvedConfig.outputFormat,
      output: resolvedConfig.output,
      imageVersion: resolvedConfig.imageVersion,
      immutableRoot: true,
      basePackages: resolvedConfig.basePackages,
      bootable: resolvedConfig.bootable,
      cleanPackageMetadata: resolvedConfig.cleanPackageMetadata,
      withNetwork: resolvedConfig.withNetwork,
      packages: resolvedConfig.packages,
      sourceDateEpoch,
    },
    environment: resolvedConfig.environment,
    command: {
      executable: "docker",
      args: dockerArgs,
      mkosiArgs: dockerArgs.slice(dockerArgs.indexOf("mkosi") + 1),
    },
  };
}

export function serializeRootBuildPlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeRootBuildInput(input) {
  const snapshot = snapshotPlainObject(input, "root build input");
  if (!snapshot.ok) {
    return snapshot;
  }

  const allowedKeys = new Set(["commonConfigText", "archConfigText", "workspacePath", "outputPath"]);
  const requiredKeys = ["commonConfigText", "archConfigText", "workspacePath", "outputPath"];
  for (const key of Object.keys(snapshot.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `root build input has unsupported field ${key}` };
    }
  }

  const values = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot.value, key)) {
      return { ok: false, error: `root build input missing required field ${key}` };
    }
    const value = snapshot.value[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `root build input field ${key} must be a non-empty string` };
    }
    values[key] = value;
  }

  return {
    ok: true,
    value: {
      commonConfigText: values.commonConfigText,
      archConfigText: values.archConfigText,
      workspacePath: values.workspacePath,
      outputPath: values.outputPath,
    },
  };
}

function snapshotPlainObject(input, label) {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: `${label} must be a plain object` };
  }

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(input);
    ownKeys = Reflect.ownKeys(input);
  } catch {
    return { ok: false, error: `${label} must not be a proxy or exotic object` };
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, error: `${label} must be a plain object` };
  }

  const snapshot = {};
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return { ok: false, error: `${label} must not contain symbol keys` };
    }

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      return { ok: false, error: `${label} has unreadable property ${key}` };
    }

    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return { ok: false, error: `${label} property ${key} must be a data property` };
    }
    snapshot[key] = descriptor.value;
  }

  return { ok: true, value: snapshot };
}

function parseMkosiConfig(text, label) {
  const sections = new Map();
  let currentSection = "";
  let currentKey = "";
  const lines = text.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    if (/^\s/.test(rawLine) && currentSection !== "" && currentKey !== "") {
      if (trimmed.includes("=") || trimmed.length > 0) {
        sections.get(currentSection).get(currentKey).push(trimmed);
        continue;
      }
    }

    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1];
      if (sections.has(sectionName)) {
        throw new ConfigValidationError(`${label}:${lineNumber} repeats section [${sectionName}]`);
      }
      sections.set(sectionName, new Map());
      currentSection = sectionName;
      currentKey = "";
      continue;
    }

    if (currentSection === "") {
      throw new ConfigValidationError(`${label}:${lineNumber} setting appears before a section`);
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw new ConfigValidationError(`${label}:${lineNumber} must be a Key=Value setting`);
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} has invalid key ${key}`);
    }

    const section = sections.get(currentSection);
    if (section.has(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} repeats setting ${currentSection}.${key}`);
    }
    section.set(key, value === "" ? [] : [value]);
    currentKey = key;
  }

  return { label, sections };
}

function resolveMkosiConfig(commonConfig, archConfig) {
  assertAllowedSettings(commonConfig, {
    Distribution: ["Distribution", "Release", "Mirror", "Repositories"],
    Output: ["Format", "ImageVersion"],
    Content: [
      "BasePackages",
      "Bootable",
      "CleanPackageMetadata",
      "WithNetwork",
      "Packages",
      "Environment",
    ],
  });
  assertAllowedSettings(archConfig, {
    Include: ["Include"],
    Distribution: ["Architecture"],
    Output: ["Output"],
    Content: ["Packages"],
  });

  const include = getSingleValue(archConfig, "Include", "Include");
  if (include !== EXPECTED_COMMON_INCLUDE) {
    throw new ConfigValidationError(
      `${ARCH_CONFIG_PATH} must include ${EXPECTED_COMMON_INCLUDE}; found ${include}`,
    );
  }

  const distribution = getSingleValue(commonConfig, "Distribution", "Distribution");
  const release = getSingleValue(commonConfig, "Distribution", "Release");
  const mirror = getSingleValue(commonConfig, "Distribution", "Mirror");
  const repositories = getListValue(commonConfig, "Distribution", "Repositories");
  const architecture = getSingleValue(archConfig, "Distribution", "Architecture");
  const outputFormat = getSingleValue(commonConfig, "Output", "Format");
  const imageVersion = getSingleValue(commonConfig, "Output", "ImageVersion");
  const output = getSingleValue(archConfig, "Output", "Output");
  const basePackages = getNoBoolean(commonConfig, "Content", "BasePackages");
  const bootable = getNoBoolean(commonConfig, "Content", "Bootable");
  const cleanPackageMetadata = getYesBoolean(commonConfig, "Content", "CleanPackageMetadata");
  const withNetwork = getNoBoolean(commonConfig, "Content", "WithNetwork");
  const packages = getOptionalListValue(archConfig, "Content", "Packages") ??
    getListValue(commonConfig, "Content", "Packages");
  const environment = getEnvironment(commonConfig);

  assertEquals(distribution, "debian", "Distribution.Distribution");
  assertEquals(release, "trixie", "Distribution.Release");
  assertEquals(mirror, "https://snapshot.debian.org/archive/debian/20260613T000000Z/", "Distribution.Mirror");
  assertArrayEquals(repositories, ["main"], "Distribution.Repositories");
  assertEquals(architecture, "x86-64", "Distribution.Architecture");
  assertEquals(outputFormat, "directory", "Output.Format");
  assertEquals(imageVersion, "0.1-bootstrap", "Output.ImageVersion");
  assertEquals(output, "vita-debian-trixie-x86_64-root", "Output.Output");
  assertArrayEquals(packages, DEFAULT_PACKAGE_ALLOWLIST, "Content.Packages");
  assertEquals(environment.SOURCE_DATE_EPOCH, DEFAULT_SOURCE_DATE_EPOCH, "Content.Environment.SOURCE_DATE_EPOCH");
  assertEquals(environment.TZ, "UTC", "Content.Environment.TZ");
  assertEquals(environment.LC_ALL, "C.UTF-8", "Content.Environment.LC_ALL");

  return {
    include,
    distribution,
    release,
    mirror,
    repositories,
    architecture,
    outputFormat,
    imageVersion,
    output,
    basePackages,
    bootable,
    cleanPackageMetadata,
    withNetwork,
    packages,
    environment,
  };
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
  const values = getRawValues(config, sectionName, key);
  if (values.length !== 1 || values[0] === "") {
    throw new ConfigValidationError(`${config.label} requires exactly one value for ${sectionName}.${key}`);
  }
  return values[0];
}

function getListValue(config, sectionName, key) {
  const values = getRawValues(config, sectionName, key);
  const tokens = [];
  for (const value of values) {
    const parts = value.split(/\s+/).filter((part) => part.length > 0);
    for (const part of parts) {
      tokens.push(part);
    }
  }
  if (tokens.length === 0) {
    throw new ConfigValidationError(`${config.label} requires at least one value for ${sectionName}.${key}`);
  }
  return tokens;
}

function getOptionalListValue(config, sectionName, key) {
  const section = config.sections.get(sectionName);
  if (section === undefined || !section.has(key)) {
    return undefined;
  }
  return getListValue(config, sectionName, key);
}

function getRawValues(config, sectionName, key) {
  const section = config.sections.get(sectionName);
  if (section === undefined) {
    throw new ConfigValidationError(`${config.label} missing section [${sectionName}]`);
  }
  const values = section.get(key);
  if (values === undefined) {
    throw new ConfigValidationError(`${config.label} missing setting ${sectionName}.${key}`);
  }
  return values;
}

function getNoBoolean(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  if (value !== "no") {
    throw new ConfigValidationError(`${config.label} requires ${sectionName}.${key}=no`);
  }
  return false;
}

function getYesBoolean(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  if (value !== "yes") {
    throw new ConfigValidationError(`${config.label} requires ${sectionName}.${key}=yes`);
  }
  return true;
}

function getEnvironment(config) {
  const entries = getListValue(config, "Content", "Environment");
  const environment = {};
  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === entry.length - 1) {
      throw new ConfigValidationError(`${config.label} has invalid environment entry ${entry}`);
    }
    const key = entry.slice(0, equalsIndex);
    const value = entry.slice(equalsIndex + 1);
    if (Object.hasOwn(environment, key)) {
      throw new ConfigValidationError(`${config.label} repeats environment key ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}

function assertEquals(actual, expected, label) {
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

function normalizeHostPath(hostPath) {
  const normalized = hostPath.replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function readRootBuildInput(repoRoot) {
  return {
    commonConfigText: readFileSync(join(repoRoot, COMMON_CONFIG_PATH), "utf8"),
    archConfigText: readFileSync(join(repoRoot, ARCH_CONFIG_PATH), "utf8"),
    workspacePath: repoRoot,
    outputPath: join(repoRoot, "os", "x86_64", "out"),
  };
}

function printUsage() {
  console.error("usage: node os/x86_64/build-root.mjs [--print-plan]");
}

function main(argv) {
  const args = argv.slice(2);
  const printPlan = args.length === 1 && args[0] === "--print-plan";
  if (args.length > 0 && !printPlan) {
    printUsage();
    return 2;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(dirname(scriptPath)));
  const plan = planRootBuild(readRootBuildInput(repoRoot));
  if (printPlan) {
    process.stdout.write(serializeRootBuildPlan(plan));
    return 0;
  }

  const run = spawnSync(plan.command.executable, plan.command.args, { stdio: "inherit" });
  if (run.error !== undefined) {
    console.error(`docker spawn error: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

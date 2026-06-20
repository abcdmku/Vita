#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const PINNED_UKIFY_IMAGE =
  "ghcr.io/systemd/mkosi@sha256:8b3870c154f085ba3428afa82799be2138ec2ca339d84a9f3802e02c342b31b2";
export const DEFAULT_SOURCE_DATE_EPOCH = "1781308800";
export const TEST_KEY_PATH_ENV = "VITA_TEST_SECUREBOOT_KEY_PATH";
export const TEST_CERT_PATH_ENV = "VITA_TEST_SECUREBOOT_CERT_PATH";
export const DEFAULT_UKI_CONFIG_TEXT = `# Vita x86_64 UKI deterministic assembly plan.
# Kernel, initrd, and stub are external upstream inputs. Digest=unresolved
# blocks assembly until the upstream image build supplies real sha256 pins.

[Paths]
WorkRoot=/work
ExternalRoot=/external
PlanRoot=/plan
OutputRoot=/out
TestKeysRoot=/test-keys
Config=/work/os/x86_64/uki.conf

[UKI]
Output=/out/vita-x86_64.unsigned.efi
Cmdline=root=LABEL=vita-debian-trixie-x86_64-root ro systemd.volatile=no quiet
OsRelease=/plan/uki.os-release
SourceDateEpoch=1781308800
Architecture=x86_64

[Kernel]
Path=/external/vmlinuz
Digest=unresolved

[Initrd]
Path=/external/initrd.img
Digest=unresolved

[Stub]
Path=/external/linuxx64.efi.stub
Digest=unresolved

[OsRelease]
NAME=Vita
ID=vita
PRETTY_NAME="Vita x86_64 UKI deterministic scaffold"
VERSION_ID=0.1-bootstrap
BUILD_ID=P1-012

[Tool]
Image=ghcr.io/systemd/mkosi@sha256:8b3870c154f085ba3428afa82799be2138ec2ca339d84a9f3802e02c342b31b2
Executable=ukify

[Runtime]
Network=none

[Signing]
Mode=test-runtime-path
Step=declare-only
TestKeyId=test:vita-secureboot-uki-dev-key
TestCertId=test:vita-secureboot-uki-dev-cert
TestKeyPathEnv=VITA_TEST_SECUREBOOT_KEY_PATH
TestCertPathEnv=VITA_TEST_SECUREBOOT_CERT_PATH
KeyContainerPath=/test-keys/db.key
CertContainerPath=/test-keys/db.crt
SignedOutput=/out/vita-x86_64.test-signed.efi
ProductionSigning=owner-only-out-of-band
`;

const DEFAULT_UKI_PLAN_INPUT = Object.freeze({
  configText: DEFAULT_UKI_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
    planInputsHostPath: "/repo/os/x86_64/generated-inputs",
    outputHostPath: "/repo/os/x86_64/out",
  }),
});

const UKI_CONFIG_PATH = "os/x86_64/uki.conf";
const OS_RELEASE_KEYS = Object.freeze(["NAME", "ID", "PRETTY_NAME", "VERSION_ID", "BUILD_ID"]);
const EXTERNAL_INPUT_SECTIONS = Object.freeze([
  ["kernel", "Kernel"],
  ["initrd", "Initrd"],
  ["stub", "Stub"],
]);

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planUKI(input = DEFAULT_UKI_PLAN_INPUT) {
  const normalizedInput = normalizeUKIPlanInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, UKI_CONFIG_PATH);
  const resolvedConfig = resolveUKIConfig(config);
  const osReleaseText = buildOsReleaseText(resolvedConfig.osRelease);
  const osReleaseDigest = sha256Text(osReleaseText);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const unresolvedInputs = resolvedConfig.externalInputs.filter((entry) => !entry.pin.resolved);
  const verificationStatus =
    unresolvedInputs.length === 0 ? "pending-runtime-verification" : "blocked-unresolved-digest";
  const assemblyBlockedBy =
    unresolvedInputs.length === 0
      ? ["verify-external-uki-inputs:pending-runtime-verification"]
      : unresolvedInputs.map((entry) => `verify-external-uki-inputs:${entry.name}:unresolved-digest`);

  const mounts = [
    {
      name: "source-tree",
      hostPath: normalizedInput.value.mountRoots.workspaceHostPath,
      containerPath: resolvedConfig.paths.workRoot,
      readOnly: true,
    },
    {
      name: "external-uki-inputs",
      hostPath: normalizedInput.value.mountRoots.externalInputsHostPath,
      containerPath: resolvedConfig.paths.externalRoot,
      readOnly: true,
    },
    {
      name: "produced-plan-inputs",
      hostPath: normalizedInput.value.mountRoots.planInputsHostPath,
      containerPath: resolvedConfig.paths.planRoot,
      readOnly: true,
    },
    {
      name: "uki-output",
      hostPath: normalizedInput.value.mountRoots.outputHostPath,
      containerPath: resolvedConfig.paths.outputRoot,
      readOnly: false,
    },
  ];

  const producedInputs = [
    {
      name: "os-release",
      kind: "deterministic-text",
      containerPath: resolvedConfig.uki.osReleasePath,
      digest: osReleaseDigest,
      text: osReleaseText,
    },
  ];

  const ukifyArgs = [
    "build",
    "--linux",
    resolvedConfig.externalInputs[0].path,
    "--initrd",
    resolvedConfig.externalInputs[1].path,
    "--cmdline",
    resolvedConfig.uki.cmdline,
    "--os-release",
    resolvedConfig.uki.osReleasePath,
    "--stub",
    resolvedConfig.externalInputs[2].path,
    "--output",
    resolvedConfig.uki.outputPath,
  ];
  const dockerArgs = [
    "run",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "-v",
    `${mounts[0].hostPath}:${mounts[0].containerPath}:ro`,
    "-v",
    `${mounts[1].hostPath}:${mounts[1].containerPath}:ro`,
    "-v",
    `${mounts[2].hostPath}:${mounts[2].containerPath}:ro`,
    "-v",
    `${mounts[3].hostPath}:${mounts[3].containerPath}`,
    "-w",
    resolvedConfig.paths.planRoot,
    "-e",
    `SOURCE_DATE_EPOCH=${resolvedConfig.uki.sourceDateEpoch}`,
    "-e",
    "TZ=UTC",
    "-e",
    "LC_ALL=C.UTF-8",
    resolvedConfig.tool.image,
    resolvedConfig.tool.executable,
    ...ukifyArgs,
  ];

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: UKI_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
    },
    mounts,
    tool: {
      engine: "docker",
      image: resolvedConfig.tool.image,
      executable: resolvedConfig.tool.executable,
      pullPolicy: "never",
      network: "none",
    },
    environment: {
      SOURCE_DATE_EPOCH: resolvedConfig.uki.sourceDateEpoch,
      TZ: "UTC",
      LC_ALL: "C.UTF-8",
    },
    inputs: {
      external: resolvedConfig.externalInputs,
      produced: producedInputs,
      cmdline: {
        value: resolvedConfig.uki.cmdline,
        digest: sha256Text(`${resolvedConfig.uki.cmdline}\n`),
      },
    },
    outputs: {
      unsignedUKI: resolvedConfig.uki.outputPath,
      testSignedUKI: resolvedConfig.signing.signedOutput,
    },
    preconditions: [
      {
        id: "verify-external-uki-inputs",
        kind: "digest-verification",
        status: verificationStatus,
        network: "none",
        verifies: resolvedConfig.externalInputs.map((entry) => ({
          name: entry.name,
          path: entry.path,
          pin: entry.pin,
        })),
        blocks: ["assemble-uki"],
      },
    ],
    steps: [
      {
        id: "assemble-uki",
        kind: "container-command",
        status: "blocked",
        gatedBy: ["verify-external-uki-inputs"],
        blockedBy: assemblyBlockedBy,
        output: resolvedConfig.uki.outputPath,
        command: {
          executable: "docker",
          args: dockerArgs,
          ukifyArgs,
        },
      },
      {
        id: "declare-test-signing",
        kind: "test-signing-declaration",
        status: "declared-non-executable",
        executable: false,
        gatedBy: ["assemble-uki"],
        blockedBy: ["runtime-test-key-paths-required", "production-signing-owner-only"],
        input: resolvedConfig.uki.outputPath,
        output: resolvedConfig.signing.signedOutput,
      },
    ],
    signing: {
      mode: "test-runtime-path",
      step: "declare-only",
      executable: false,
      materialInRepo: false,
      key: {
        id: resolvedConfig.signing.testKeyId,
        pathEnv: resolvedConfig.signing.testKeyPathEnv,
        containerPath: resolvedConfig.signing.keyContainerPath,
      },
      cert: {
        id: resolvedConfig.signing.testCertId,
        pathEnv: resolvedConfig.signing.testCertPathEnv,
        containerPath: resolvedConfig.signing.certContainerPath,
      },
      runtimeMount: {
        name: "test-secureboot-key-material",
        containerPath: resolvedConfig.paths.testKeysRoot,
        readOnly: true,
        hostPathEnv: [resolvedConfig.signing.testKeyPathEnv, resolvedConfig.signing.testCertPathEnv],
      },
      tool: {
        image: resolvedConfig.tool.image,
        executable: resolvedConfig.tool.executable,
        pullPolicy: "never",
        network: "none",
      },
      productionSigning: {
        included: false,
        ownerOnly: true,
        disposition: resolvedConfig.signing.productionSigning,
      },
    },
    command: {
      executable: "docker",
      args: dockerArgs,
      ukifyArgs,
    },
  };
}

export function serializeUKIPlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeUKIPlanInput(input) {
  const snapshot = snapshotPlainObject(input, "UKI plan input");
  if (!snapshot.ok) {
    return snapshot;
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(snapshot.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `UKI plan input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(snapshot.value, "configText")) {
    return { ok: false, error: "UKI plan input missing required field configText" };
  }
  if (!Object.hasOwn(snapshot.value, "mountRoots")) {
    return { ok: false, error: "UKI plan input missing required field mountRoots" };
  }

  const configText = snapshot.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "UKI plan input field configText must be a non-empty string" };
  }

  const mountRoots = normalizeMountRoots(snapshot.value.mountRoots);
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
  const snapshot = snapshotPlainObject(input, "UKI mount roots");
  if (!snapshot.ok) {
    return snapshot;
  }

  const requiredKeys = [
    "workspaceHostPath",
    "externalInputsHostPath",
    "planInputsHostPath",
    "outputHostPath",
  ];
  const allowedKeys = new Set(requiredKeys);
  for (const key of Object.keys(snapshot.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `UKI mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot.value, key)) {
      return { ok: false, error: `UKI mount roots missing required field ${key}` };
    }
    const value = snapshot.value[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `UKI mount roots field ${key} must be a non-empty string` };
    }
    rawValues[key] = value;
  }

  const workspaceHostPath = validateCanonicalPosixPath(rawValues.workspaceHostPath, {
    label: "mountRoots.workspaceHostPath",
    root: "/",
    allowRoot: false,
  });
  const externalInputsHostPath = validateCanonicalPosixPath(rawValues.externalInputsHostPath, {
    label: "mountRoots.externalInputsHostPath",
    root: workspaceHostPath,
    allowRoot: false,
  });
  const planInputsHostPath = validateCanonicalPosixPath(rawValues.planInputsHostPath, {
    label: "mountRoots.planInputsHostPath",
    root: workspaceHostPath,
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
      externalInputsHostPath,
      planInputsHostPath,
      outputHostPath,
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
    assertNoKeyMaterial(value, `${label}:${lineNumber} ${currentSection}.${key}`);

    const section = sections.get(currentSection);
    if (section.has(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} repeats setting ${currentSection}.${key}`);
    }
    section.set(key, value);
  }

  return { label, sections };
}

function resolveUKIConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "ExternalRoot", "PlanRoot", "OutputRoot", "TestKeysRoot", "Config"],
    UKI: ["Output", "Cmdline", "OsRelease", "SourceDateEpoch", "Architecture"],
    Kernel: ["Path", "Digest"],
    Initrd: ["Path", "Digest"],
    Stub: ["Path", "Digest"],
    OsRelease: [...OS_RELEASE_KEYS],
    Tool: ["Image", "Executable"],
    Runtime: ["Network"],
    Signing: [
      "Mode",
      "Step",
      "TestKeyId",
      "TestCertId",
      "TestKeyPathEnv",
      "TestCertPathEnv",
      "KeyContainerPath",
      "CertContainerPath",
      "SignedOutput",
      "ProductionSigning",
    ],
  });

  const paths = resolvePaths(config);
  const sourceDateEpoch = getSingleValue(config, "UKI", "SourceDateEpoch");
  if (sourceDateEpoch !== DEFAULT_SOURCE_DATE_EPOCH) {
    throw new ConfigValidationError(`UKI.SourceDateEpoch expected ${DEFAULT_SOURCE_DATE_EPOCH}, found ${sourceDateEpoch}`);
  }

  const architecture = getSingleValue(config, "UKI", "Architecture");
  if (architecture !== "x86_64") {
    throw new ConfigValidationError(`UKI.Architecture expected x86_64, found ${architecture}`);
  }

  const runtimeNetwork = getSingleValue(config, "Runtime", "Network");
  if (runtimeNetwork !== "none") {
    throw new ConfigValidationError(`Runtime.Network expected none, found ${runtimeNetwork}`);
  }

  const toolImage = getSingleValue(config, "Tool", "Image");
  validateDigestPinnedImage(toolImage, "Tool.Image");
  if (toolImage !== PINNED_UKIFY_IMAGE) {
    throw new ConfigValidationError(`Tool.Image expected ${PINNED_UKIFY_IMAGE}, found ${toolImage}`);
  }
  const toolExecutable = getSingleValue(config, "Tool", "Executable");
  if (toolExecutable !== "ukify") {
    throw new ConfigValidationError(`Tool.Executable expected ukify, found ${toolExecutable}`);
  }

  const externalInputs = [];
  for (const entry of EXTERNAL_INPUT_SECTIONS) {
    const [name, sectionName] = entry;
    externalInputs.push({
      name,
      source: "external-precondition",
      mountRoot: paths.externalRoot,
      path: validateCanonicalPosixPath(getSingleValue(config, sectionName, "Path"), {
        label: `${sectionName}.Path`,
        root: paths.externalRoot,
        allowRoot: false,
      }),
      pin: parseDigestPin(getSingleValue(config, sectionName, "Digest"), `${sectionName}.Digest`),
    });
  }

  const osReleasePath = validateCanonicalPosixPath(getSingleValue(config, "UKI", "OsRelease"), {
    label: "UKI.OsRelease",
    root: paths.planRoot,
    allowRoot: false,
  });
  const outputPath = validateCanonicalPosixPath(getSingleValue(config, "UKI", "Output"), {
    label: "UKI.Output",
    root: paths.outputRoot,
    allowRoot: false,
  });
  const cmdline = getSingleValue(config, "UKI", "Cmdline");
  if (cmdline.length === 0 || /[\u0000-\u001F\u007F]/u.test(cmdline)) {
    throw new ConfigValidationError("UKI.Cmdline must be non-empty and contain no control characters");
  }

  const signedOutput = validateCanonicalPosixPath(getSingleValue(config, "Signing", "SignedOutput"), {
    label: "Signing.SignedOutput",
    root: paths.outputRoot,
    allowRoot: false,
  });
  const signing = resolveSigning(config, paths, signedOutput);

  return {
    paths,
    uki: {
      outputPath,
      cmdline,
      osReleasePath,
      sourceDateEpoch,
      architecture,
    },
    externalInputs,
    osRelease: resolveOsRelease(config),
    tool: {
      image: toolImage,
      executable: toolExecutable,
    },
    signing,
  };
}

function resolvePaths(config) {
  const workRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "WorkRoot"), {
    label: "Paths.WorkRoot",
    root: "/",
    allowRoot: false,
  });
  const externalRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "ExternalRoot"), {
    label: "Paths.ExternalRoot",
    root: "/",
    allowRoot: false,
  });
  const planRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "PlanRoot"), {
    label: "Paths.PlanRoot",
    root: "/",
    allowRoot: false,
  });
  const outputRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "OutputRoot"), {
    label: "Paths.OutputRoot",
    root: "/",
    allowRoot: false,
  });
  const testKeysRoot = validateCanonicalPosixPath(getSingleValue(config, "Paths", "TestKeysRoot"), {
    label: "Paths.TestKeysRoot",
    root: "/",
    allowRoot: false,
  });
  const configPath = validateCanonicalPosixPath(getSingleValue(config, "Paths", "Config"), {
    label: "Paths.Config",
    root: workRoot,
    allowRoot: false,
  });

  assertDistinctMountRoots([
    ["Paths.WorkRoot", workRoot],
    ["Paths.ExternalRoot", externalRoot],
    ["Paths.PlanRoot", planRoot],
    ["Paths.OutputRoot", outputRoot],
    ["Paths.TestKeysRoot", testKeysRoot],
  ]);

  return {
    workRoot,
    externalRoot,
    planRoot,
    outputRoot,
    testKeysRoot,
    configPath,
  };
}

function resolveSigning(config, paths, signedOutput) {
  const mode = getSingleValue(config, "Signing", "Mode");
  if (mode !== "test-runtime-path") {
    throw new ConfigValidationError(`Signing.Mode expected test-runtime-path, found ${mode}`);
  }

  const step = getSingleValue(config, "Signing", "Step");
  if (step !== "declare-only") {
    throw new ConfigValidationError(`Signing.Step expected declare-only, found ${step}`);
  }

  const testKeyId = getSingleValue(config, "Signing", "TestKeyId");
  const testCertId = getSingleValue(config, "Signing", "TestCertId");
  assertTestReference(testKeyId, "Signing.TestKeyId");
  assertTestReference(testCertId, "Signing.TestCertId");

  const testKeyPathEnv = getSingleValue(config, "Signing", "TestKeyPathEnv");
  const testCertPathEnv = getSingleValue(config, "Signing", "TestCertPathEnv");
  if (testKeyPathEnv !== TEST_KEY_PATH_ENV) {
    throw new ConfigValidationError(`Signing.TestKeyPathEnv must be ${TEST_KEY_PATH_ENV}`);
  }
  if (testCertPathEnv !== TEST_CERT_PATH_ENV) {
    throw new ConfigValidationError(`Signing.TestCertPathEnv must be ${TEST_CERT_PATH_ENV}`);
  }

  const keyContainerPath = validateCanonicalPosixPath(getSingleValue(config, "Signing", "KeyContainerPath"), {
    label: "Signing.KeyContainerPath",
    root: paths.testKeysRoot,
    allowRoot: false,
  });
  const certContainerPath = validateCanonicalPosixPath(getSingleValue(config, "Signing", "CertContainerPath"), {
    label: "Signing.CertContainerPath",
    root: paths.testKeysRoot,
    allowRoot: false,
  });

  const productionSigning = getSingleValue(config, "Signing", "ProductionSigning");
  if (productionSigning !== "owner-only-out-of-band") {
    throw new ConfigValidationError("Signing.ProductionSigning must declare owner-only-out-of-band");
  }

  return {
    mode,
    step,
    testKeyId,
    testCertId,
    testKeyPathEnv,
    testCertPathEnv,
    keyContainerPath,
    certContainerPath,
    signedOutput,
    productionSigning,
  };
}

function resolveOsRelease(config) {
  const values = {};
  for (const key of OS_RELEASE_KEYS) {
    const value = getSingleValue(config, "OsRelease", key);
    if (value.length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) {
      throw new ConfigValidationError(`OsRelease.${key} must be non-empty and contain no control characters`);
    }
    values[key] = value;
  }
  return values;
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
  if (/[\u0000-\u001F\u007F]/u.test(path)) {
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

function assertDistinctMountRoots(entries) {
  for (let outerIndex = 0; outerIndex < entries.length; outerIndex += 1) {
    const outer = entries[outerIndex];
    const outerLabel = outer[0];
    const outerPath = outer[1];
    for (let innerIndex = outerIndex + 1; innerIndex < entries.length; innerIndex += 1) {
      const inner = entries[innerIndex];
      const innerLabel = inner[0];
      const innerPath = inner[1];
      if (outerPath === innerPath) {
        throw new ConfigValidationError(`${outerLabel} and ${innerLabel} must be distinct mount roots`);
      }
      if (outerPath.startsWith(`${innerPath}/`) || innerPath.startsWith(`${outerPath}/`)) {
        throw new ConfigValidationError(`${outerLabel} and ${innerLabel} must not be nested mount roots`);
      }
    }
  }
}

function parseDigestPin(value, label) {
  if (value === "unresolved") {
    return {
      algorithm: "sha256",
      required: true,
      resolved: false,
      status: "unresolved",
    };
  }

  const digest = validateSha256Digest(value, label);
  return {
    algorithm: "sha256",
    required: true,
    resolved: true,
    digest,
  };
}

function validateDigestPinnedImage(value, label) {
  const atIndex = value.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === value.length - 1) {
    throw new ConfigValidationError(`${label} must be digest-pinned`);
  }
  validateSha256Digest(value.slice(atIndex + 1), label);
}

function validateSha256Digest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be sha256 followed by exactly 64 lowercase hex characters`);
  }

  const hex = value.slice("sha256:".length);
  if (isPlaceholderDigest(hex)) {
    throw new ConfigValidationError(`${label} must not use a placeholder or sentinel digest`);
  }
  return value;
}

function isPlaceholderDigest(hex) {
  if (/^([0-9a-f])\1{63}$/.test(hex)) {
    return true;
  }

  for (let patternLength = 1; patternLength <= 16; patternLength += 1) {
    if (64 % patternLength !== 0) {
      continue;
    }
    const pattern = hex.slice(0, patternLength);
    if (pattern.repeat(64 / patternLength) === hex) {
      return true;
    }
  }

  const obviousSequences = new Set([
    "0123456789abcdef".repeat(4),
    "fedcba9876543210".repeat(4),
    "deadbeef".repeat(8),
    "cafebabe".repeat(8),
  ]);
  return obviousSequences.has(hex);
}

function assertTestReference(value, label) {
  if (!/^test:[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a test: reference`);
  }
  if (/(prod|production|release|owner)/iu.test(value)) {
    throw new ConfigValidationError(`${label} must not reference production, release, or owner keys`);
  }
}

function assertNoKeyMaterial(value, label) {
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|PUBLIC KEY|CERTIFICATE)-----/u.test(value)) {
    throw new ConfigValidationError(`${label} must reference key material, not embed it`);
  }
}

function buildOsReleaseText(values) {
  return `${OS_RELEASE_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
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

function printUsage() {
  console.error("usage: node os/x86_64/uki.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    process.stdout.write(serializeUKIPlan(planUKI()));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeNormalize } from "../../sdk/typescript/src/safe-normalize.ts";

export const DEFAULT_VERITY_HASH_ALGORITHM = "sha256";
export const DEFAULT_VERITY_DATA_BLOCK_SIZE = 4096;
export const DEFAULT_VERITY_HASH_BLOCK_SIZE = 4096;
export const DEFAULT_VERITY_CONFIG_TEXT = `# Vita x86_64 deterministic dm-verity plan.
# Per-slot root hashes are unresolved until the privileged host runs
# \`veritysetup format <data image artifact> <hash tree artifact>\`.

[Paths]
WorkRoot=/work
ExternalRoot=/external
PlanRoot=/plan
OutputRoot=/out
Config=/work/os/x86_64/verity.conf

[Verity]
Executable=veritysetup
FormatCommand=format
Version=1
HashAlgorithm=sha256
DataBlockSize=4096
HashBlockSize=4096
SaltPolicy=fixed-per-slot-hex
RootHashPolicy=external-precondition
Runtime=systemd-veritysetup-generator
Network=none

[SlotRootA]
Name=rootfs.0
Slot=root-a
Partition=root-a
RootLabel=vita-root-a
DataImage=/external/p1-014/converted/vita-root-a.rootfs.ext4
DataImageDigest=unresolved
HashTree=/out/verity/vita-root-a.verity
Salt=40baf37d92af06caa356636efdc678b04e8f60b64488d513321e05b6cdaa8815
RootHash=unresolved
UKIName=uki-root-a
UKIInput=/external/p1-012/root-a/vita-root-a.unsigned.efi
UKIInputDigest=unresolved
UKIOutput=/out/uki/vita-root-a.verity.unsigned.efi
VerityDevice=/dev/mapper/vita-root-a-verity
CmdlineOptions=ro systemd.volatile=no quiet

[SlotRootB]
Name=rootfs.1
Slot=root-b
Partition=root-b
RootLabel=vita-root-b
DataImage=/external/p1-014/converted/vita-root-b.rootfs.ext4
DataImageDigest=unresolved
HashTree=/out/verity/vita-root-b.verity
Salt=862b89114b3de4ccd6a45f907491eb06247beda316c19b55fb77510f71715c64
RootHash=unresolved
UKIName=uki-root-b
UKIInput=/external/p1-012/root-b/vita-root-b.unsigned.efi
UKIInputDigest=unresolved
UKIOutput=/out/uki/vita-root-b.verity.unsigned.efi
VerityDevice=/dev/mapper/vita-root-b-verity
CmdlineOptions=ro systemd.volatile=no quiet
`;

const DEFAULT_VERITY_PLAN_INPUT = Object.freeze({
  configText: DEFAULT_VERITY_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
    planInputsHostPath: "/repo/os/x86_64/generated-inputs",
    outputHostPath: "/repo/os/x86_64/out",
  }),
});

const VERITY_CONFIG_PATH = "os/x86_64/verity.conf";
const SLOT_SECTIONS = Object.freeze([
  Object.freeze({
    sectionName: "SlotRootA",
    name: "rootfs.0",
    slot: "root-a",
    partition: "root-a",
    rootLabel: "vita-root-a",
    dataImageName: "root-a-partition-image",
    dataImagePath: "/external/p1-014/converted/vita-root-a.rootfs.ext4",
    hashTreePath: "/out/verity/vita-root-a.verity",
    ukiName: "uki-root-a",
    ukiInputPath: "/external/p1-012/root-a/vita-root-a.unsigned.efi",
    ukiOutputPath: "/out/uki/vita-root-a.verity.unsigned.efi",
    verityDevice: "/dev/mapper/vita-root-a-verity",
  }),
  Object.freeze({
    sectionName: "SlotRootB",
    name: "rootfs.1",
    slot: "root-b",
    partition: "root-b",
    rootLabel: "vita-root-b",
    dataImageName: "root-b-partition-image",
    dataImagePath: "/external/p1-014/converted/vita-root-b.rootfs.ext4",
    hashTreePath: "/out/verity/vita-root-b.verity",
    ukiName: "uki-root-b",
    ukiInputPath: "/external/p1-012/root-b/vita-root-b.unsigned.efi",
    ukiOutputPath: "/out/uki/vita-root-b.verity.unsigned.efi",
    verityDevice: "/dev/mapper/vita-root-b-verity",
  }),
]);

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planVerity(input = DEFAULT_VERITY_PLAN_INPUT) {
  const normalizedInput = normalizeVerityPlanInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, VERITY_CONFIG_PATH);
  const resolvedConfig = resolveVerityConfig(config);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const mounts = buildMounts(normalizedInput.value.mountRoots, resolvedConfig.paths);
  const rootImageBlockedBy = blockedByForDigestPins("verify-root-images", resolvedConfig.slots.map((slot) => slot.dataImage));
  const ukiBlockedBy = blockedByForDigestPins("verify-slot-ukis", resolvedConfig.slots.map((slot) => slot.uki.input));
  const rootHashBlockedBy = blockedByForRootHashes("compute-verity-root-hashes", resolvedConfig.slots);
  const bindBlockedBy = [...rootHashBlockedBy, ...ukiBlockedBy];

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: VERITY_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
    },
    mounts,
    tool: {
      executable: resolvedConfig.verity.executable,
      formatCommand: resolvedConfig.verity.formatCommand,
      network: "none",
      upstreamPrivileged: true,
      runtimeCorrectness: "pending-build-and-boot-full-mode",
    },
    parameters: {
      version: resolvedConfig.verity.version,
      hashAlgorithm: resolvedConfig.verity.hashAlgorithm,
      dataBlockSize: resolvedConfig.verity.dataBlockSize,
      hashBlockSize: resolvedConfig.verity.hashBlockSize,
      saltPolicy: resolvedConfig.verity.saltPolicy,
      rootHashPolicy: resolvedConfig.verity.rootHashPolicy,
      runtime: resolvedConfig.verity.runtime,
    },
    inputs: {
      external: [
        ...resolvedConfig.slots.map((slot) => slot.dataImage),
        ...resolvedConfig.slots.map((slot) => slot.uki.input),
      ],
      produced: [],
    },
    outputs: {
      hashTrees: resolvedConfig.slots.map((slot) => slot.hashTree),
      boundUKIs: resolvedConfig.slots.map((slot) => slot.uki.output),
    },
    slots: resolvedConfig.slots,
    bindings: resolvedConfig.slots.map((slot) => slot.uki.binding),
    preconditions: [
      {
        id: "verify-root-images",
        kind: "digest-verification",
        status: preconditionStatusForDigestPins(resolvedConfig.slots.map((slot) => slot.dataImage)),
        network: "none",
        verifies: resolvedConfig.slots.map((slot) => ({
          name: slot.dataImage.name,
          slot: slot.name,
          path: slot.dataImage.path,
          pin: slot.dataImage.pin,
        })),
        blocks: ["compute-verity-root-hashes"],
      },
      {
        id: "verify-slot-ukis",
        kind: "digest-verification",
        status: preconditionStatusForDigestPins(resolvedConfig.slots.map((slot) => slot.uki.input)),
        network: "none",
        verifies: resolvedConfig.slots.map((slot) => ({
          name: slot.uki.input.name,
          slot: slot.name,
          path: slot.uki.input.path,
          pin: slot.uki.input.pin,
        })),
        blocks: ["bind-root-hashes-to-slot-ukis"],
      },
      {
        id: "compute-verity-root-hashes",
        kind: "external-precondition-step",
        status: preconditionStatusForRootHashes(resolvedConfig.slots),
        network: "none",
        executable: false,
        upstreamPrivileged: true,
        gatedBy: ["verify-root-images"],
        blockedBy: rootHashBlockedBy,
        commandPlans: resolvedConfig.slots.map((slot) => slot.veritysetup),
        outputs: resolvedConfig.slots.map((slot) => ({
          slot: slot.name,
          dataImage: slot.dataImage.name,
          hashTree: slot.hashTree.path,
          rootHash: slot.rootHash,
        })),
        blocks: ["bind-root-hashes-to-slot-ukis"],
      },
      {
        id: "bind-root-hashes-to-slot-ukis",
        kind: "uki-cmdline-binding",
        status: preconditionStatusForBinding(resolvedConfig.slots),
        network: "none",
        executable: false,
        gatedBy: ["compute-verity-root-hashes", "verify-slot-ukis"],
        blockedBy: bindBlockedBy,
        binds: resolvedConfig.slots.map((slot) => slot.uki.binding),
        blocks: ["assemble-slot-ukis"],
      },
    ],
    steps: [
      ...resolvedConfig.slots.map((slot) => ({
        id: `format-${slot.slot}-verity`,
        kind: "veritysetup-format-plan",
        status: "blocked",
        executable: false,
        upstreamPrivileged: true,
        gatedBy: ["verify-root-images"],
        blockedBy: rootImageBlockedBy,
        command: slot.veritysetup,
        output: slot.hashTree.path,
      })),
      ...resolvedConfig.slots.map((slot) => ({
        id: `bind-${slot.slot}-roothash-to-uki`,
        kind: "uki-cmdline-binding-plan",
        status: "blocked",
        executable: false,
        gatedBy: ["compute-verity-root-hashes", "verify-slot-ukis"],
        blockedBy: bindBlockedByForSlot(slot),
        input: slot.uki.input.path,
        output: slot.uki.output.path,
        cmdline: slot.uki.cmdline,
      })),
    ],
  };
}

export function serializeVerityPlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeVerityPlanInput(input) {
  const normalized = safeNormalize(input, { maxDepth: 64, maxNodes: 10_000 });
  if (!normalized.ok) {
    return { ok: false, error: `verity plan input normalization failed: ${normalized.reason}` };
  }
  if (!isPlainRecord(normalized.value)) {
    return { ok: false, error: "verity plan input must be a plain object" };
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(normalized.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `verity plan input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(normalized.value, "configText")) {
    return { ok: false, error: "verity plan input missing required field configText" };
  }
  if (!Object.hasOwn(normalized.value, "mountRoots")) {
    return { ok: false, error: "verity plan input missing required field mountRoots" };
  }

  const configText = normalized.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "verity plan input field configText must be a non-empty string" };
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
    return { ok: false, error: "verity mount roots must be a plain object" };
  }

  const requiredKeys = [
    "workspaceHostPath",
    "externalInputsHostPath",
    "planInputsHostPath",
    "outputHostPath",
  ];
  const allowedKeys = new Set(requiredKeys);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `verity mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      return { ok: false, error: `verity mount roots missing required field ${key}` };
    }
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `verity mount roots field ${key} must be a non-empty string` };
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
    if (/[\u0000-\u0008\u000B-\u001F\u007F]/u.test(value)) {
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

function resolveVerityConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "ExternalRoot", "PlanRoot", "OutputRoot", "Config"],
    Verity: [
      "Executable",
      "FormatCommand",
      "Version",
      "HashAlgorithm",
      "DataBlockSize",
      "HashBlockSize",
      "SaltPolicy",
      "RootHashPolicy",
      "Runtime",
      "Network",
    ],
    SlotRootA: [
      "Name",
      "Slot",
      "Partition",
      "RootLabel",
      "DataImage",
      "DataImageDigest",
      "HashTree",
      "Salt",
      "RootHash",
      "UKIName",
      "UKIInput",
      "UKIInputDigest",
      "UKIOutput",
      "VerityDevice",
      "CmdlineOptions",
    ],
    SlotRootB: [
      "Name",
      "Slot",
      "Partition",
      "RootLabel",
      "DataImage",
      "DataImageDigest",
      "HashTree",
      "Salt",
      "RootHash",
      "UKIName",
      "UKIInput",
      "UKIInputDigest",
      "UKIOutput",
      "VerityDevice",
      "CmdlineOptions",
    ],
  });

  const paths = resolvePaths(config);
  const verity = resolveVerityParams(config);
  const slots = SLOT_SECTIONS.map((expected) => resolveSlot(config, paths, verity, expected));
  assertUniqueSlotPaths(slots);

  return {
    paths,
    verity,
    slots,
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
  ]);

  return {
    workRoot,
    externalRoot,
    planRoot,
    outputRoot,
    configPath,
  };
}

function resolveVerityParams(config) {
  const executable = getSingleValue(config, "Verity", "Executable");
  if (executable !== "veritysetup") {
    throw new ConfigValidationError(`Verity.Executable expected veritysetup, found ${executable}`);
  }

  const formatCommand = getSingleValue(config, "Verity", "FormatCommand");
  if (formatCommand !== "format") {
    throw new ConfigValidationError(`Verity.FormatCommand expected format, found ${formatCommand}`);
  }

  const version = getInteger(config, "Verity", "Version");
  if (version !== 1) {
    throw new ConfigValidationError(`Verity.Version expected 1, found ${version}`);
  }

  const hashAlgorithm = getSingleValue(config, "Verity", "HashAlgorithm");
  if (hashAlgorithm !== DEFAULT_VERITY_HASH_ALGORITHM) {
    throw new ConfigValidationError(`Verity.HashAlgorithm expected ${DEFAULT_VERITY_HASH_ALGORITHM}, found ${hashAlgorithm}`);
  }

  const dataBlockSize = getInteger(config, "Verity", "DataBlockSize");
  if (dataBlockSize !== DEFAULT_VERITY_DATA_BLOCK_SIZE) {
    throw new ConfigValidationError(`Verity.DataBlockSize expected ${DEFAULT_VERITY_DATA_BLOCK_SIZE}, found ${dataBlockSize}`);
  }

  const hashBlockSize = getInteger(config, "Verity", "HashBlockSize");
  if (hashBlockSize !== DEFAULT_VERITY_HASH_BLOCK_SIZE) {
    throw new ConfigValidationError(`Verity.HashBlockSize expected ${DEFAULT_VERITY_HASH_BLOCK_SIZE}, found ${hashBlockSize}`);
  }

  const saltPolicy = getSingleValue(config, "Verity", "SaltPolicy");
  if (saltPolicy !== "fixed-per-slot-hex") {
    throw new ConfigValidationError("Verity.SaltPolicy expected fixed-per-slot-hex");
  }

  const rootHashPolicy = getSingleValue(config, "Verity", "RootHashPolicy");
  if (rootHashPolicy !== "external-precondition") {
    throw new ConfigValidationError("Verity.RootHashPolicy expected external-precondition");
  }

  const runtime = getSingleValue(config, "Verity", "Runtime");
  if (runtime !== "systemd-veritysetup-generator") {
    throw new ConfigValidationError("Verity.Runtime expected systemd-veritysetup-generator");
  }

  const network = getSingleValue(config, "Verity", "Network");
  if (network !== "none") {
    throw new ConfigValidationError(`Verity.Network expected none, found ${network}`);
  }

  return {
    executable,
    formatCommand,
    version,
    hashAlgorithm,
    dataBlockSize,
    hashBlockSize,
    saltPolicy,
    rootHashPolicy,
    runtime,
    network,
  };
}

function resolveSlot(config, paths, verity, expected) {
  const sectionName = expected.sectionName;
  const name = getSingleValue(config, sectionName, "Name");
  const slot = getSingleValue(config, sectionName, "Slot");
  const partition = getSingleValue(config, sectionName, "Partition");
  const rootLabel = getSingleValue(config, sectionName, "RootLabel");
  const dataImagePath = validateCanonicalPosixPath(getSingleValue(config, sectionName, "DataImage"), {
    label: `${sectionName}.DataImage`,
    root: paths.externalRoot,
    allowRoot: false,
  });
  const dataImagePin = parseDigestPin(getSingleValue(config, sectionName, "DataImageDigest"), `${sectionName}.DataImageDigest`);
  const hashTreePath = validateCanonicalPosixPath(getSingleValue(config, sectionName, "HashTree"), {
    label: `${sectionName}.HashTree`,
    root: paths.outputRoot,
    allowRoot: false,
  });
  const saltHex = validateSha256Hex(getSingleValue(config, sectionName, "Salt"), `${sectionName}.Salt`);
  const rootHash = parseRootHashPin(getSingleValue(config, sectionName, "RootHash"), `${sectionName}.RootHash`);
  const ukiName = getSingleValue(config, sectionName, "UKIName");
  const ukiInputPath = validateCanonicalPosixPath(getSingleValue(config, sectionName, "UKIInput"), {
    label: `${sectionName}.UKIInput`,
    root: paths.externalRoot,
    allowRoot: false,
  });
  const ukiInputPin = parseDigestPin(getSingleValue(config, sectionName, "UKIInputDigest"), `${sectionName}.UKIInputDigest`);
  const ukiOutputPath = validateCanonicalPosixPath(getSingleValue(config, sectionName, "UKIOutput"), {
    label: `${sectionName}.UKIOutput`,
    root: paths.outputRoot,
    allowRoot: false,
  });
  const verityDevice = validateCanonicalPosixPath(getSingleValue(config, sectionName, "VerityDevice"), {
    label: `${sectionName}.VerityDevice`,
    root: "/dev/mapper",
    allowRoot: false,
  });
  const cmdlineOptions = validateCmdlineOptions(getSingleValue(config, sectionName, "CmdlineOptions"), `${sectionName}.CmdlineOptions`);

  assertExpected(name, expected.name, `${sectionName}.Name`);
  assertExpected(slot, expected.slot, `${sectionName}.Slot`);
  assertExpected(partition, expected.partition, `${sectionName}.Partition`);
  assertExpected(rootLabel, expected.rootLabel, `${sectionName}.RootLabel`);
  assertExpected(dataImagePath, expected.dataImagePath, `${sectionName}.DataImage`);
  assertExpected(hashTreePath, expected.hashTreePath, `${sectionName}.HashTree`);
  assertExpected(ukiName, expected.ukiName, `${sectionName}.UKIName`);
  assertExpected(ukiInputPath, expected.ukiInputPath, `${sectionName}.UKIInput`);
  assertExpected(ukiOutputPath, expected.ukiOutputPath, `${sectionName}.UKIOutput`);
  assertExpected(verityDevice, expected.verityDevice, `${sectionName}.VerityDevice`);

  const dataImage = {
    name: expected.dataImageName,
    kind: "root-partition-image",
    source: "external-precondition",
    contract: "P1-014",
    slot,
    partition,
    rootLabel,
    path: dataImagePath,
    mountRoot: paths.externalRoot,
    pin: dataImagePin,
  };
  const hashTree = {
    name: `${slot}-verity-hash-tree`,
    kind: "verity-hash-tree",
    source: "veritysetup-format-output",
    slot,
    partition,
    path: hashTreePath,
    mountRoot: paths.outputRoot,
  };
  const veritysetup = buildVeritysetupCommand(verity, dataImagePath, hashTreePath, saltHex);
  const cmdline = buildUKICmdline(verityDevice, cmdlineOptions, rootHash, name);
  const ukiInput = {
    name: ukiName,
    kind: "uki",
    source: "external-precondition",
    contract: "P1-012",
    slot,
    partition,
    path: ukiInputPath,
    mountRoot: paths.externalRoot,
    pin: ukiInputPin,
  };
  const ukiOutput = {
    name: `${ukiName}-verity-bound`,
    kind: "uki",
    source: "uki-cmdline-binding-output",
    slot,
    partition,
    path: ukiOutputPath,
    mountRoot: paths.outputRoot,
  };
  const binding = {
    status: rootHash.resolved ? "bound" : "blocked-unresolved-root-hash",
    source: {
      slot: name,
      field: "rootHash",
    },
    target: {
      slot: name,
      artifact: ukiName,
      field: "cmdline.roothash",
    },
    rootDevice: verityDevice,
    rootHash,
    cmdline,
  };

  return {
    name,
    slot,
    partition,
    rootLabel,
    dataImage,
    hashTree,
    salt: {
      policy: "fixed-per-slot-hex",
      algorithm: verity.hashAlgorithm,
      hex: saltHex,
    },
    rootHash,
    veritysetup,
    uki: {
      input: ukiInput,
      output: ukiOutput,
      verityDevice,
      cmdline,
      binding,
    },
  };
}

function buildVeritysetupCommand(verity, dataImagePath, hashTreePath, saltHex) {
  const args = [
    verity.formatCommand,
    dataImagePath,
    hashTreePath,
    "--format",
    String(verity.version),
    "--hash",
    verity.hashAlgorithm,
    "--data-block-size",
    String(verity.dataBlockSize),
    "--hash-block-size",
    String(verity.hashBlockSize),
    "--salt",
    saltHex,
  ];

  return {
    executable: verity.executable,
    args,
    dataImageArtifact: dataImagePath,
    hashTreeArtifact: hashTreePath,
    capturesRootHash: true,
    expectedStdoutField: "Root hash",
  };
}

function buildUKICmdline(verityDevice, cmdlineOptions, rootHash, slotName) {
  const template = `root=${verityDevice} roothash=\${${slotName}.rootHash} ${cmdlineOptions}`;
  if (!rootHash.resolved) {
    return {
      status: "blocked-unresolved-root-hash",
      root: `root=${verityDevice}`,
      roothash: rootHash,
      template,
    };
  }

  const value = `root=${verityDevice} roothash=${rootHash.hex} ${cmdlineOptions}`;
  return {
    status: "bound",
    root: `root=${verityDevice}`,
    roothash: rootHash,
    template,
    value,
    digest: sha256Text(`${value}\n`),
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
      name: "external-verity-inputs",
      hostPath: mountRoots.externalInputsHostPath,
      containerPath: paths.externalRoot,
      readOnly: true,
    },
    {
      name: "produced-plan-inputs",
      hostPath: mountRoots.planInputsHostPath,
      containerPath: paths.planRoot,
      readOnly: true,
    },
    {
      name: "verity-output",
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

function getInteger(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ConfigValidationError(`${sectionName}.${key} must be a non-negative base-10 integer`);
  }
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) {
    throw new ConfigValidationError(`${sectionName}.${key} must be a safe integer`);
  }
  return integer;
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

function parseRootHashPin(value, label) {
  if (value === "unresolved") {
    return {
      algorithm: "sha256",
      required: true,
      resolved: false,
      status: "unresolved",
    };
  }

  const hex = validateSha256Hex(value, label);
  return {
    algorithm: "sha256",
    required: true,
    resolved: true,
    hex,
  };
}

function validateSha256Digest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be sha256 followed by exactly 64 lowercase hex characters`);
  }
  const hex = value.slice("sha256:".length);
  validateNonPlaceholderHex(hex, label);
  return value;
}

function validateSha256Hex(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be exactly 64 lowercase hex characters`);
  }
  validateNonPlaceholderHex(value, label);
  return value;
}

function validateNonPlaceholderHex(hex, label) {
  if (isPlaceholderHex(hex)) {
    throw new ConfigValidationError(`${label} must not use a placeholder or sentinel digest`);
  }
}

function isPlaceholderHex(hex) {
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

function validateCmdlineOptions(value, label) {
  if (value.length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ConfigValidationError(`${label} must be non-empty and contain no control characters`);
  }
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new ConfigValidationError(`${label} must contain at least one token`);
  }
  for (const token of tokens) {
    if (token.startsWith("root=")) {
      throw new ConfigValidationError(`${label} must not set root=; the planner binds root to the verity device`);
    }
    if (token.startsWith("roothash=")) {
      throw new ConfigValidationError(`${label} must not set roothash=; the planner binds the slot root hash`);
    }
    if (token.startsWith("verity.")) {
      throw new ConfigValidationError(`${label} must not invent verity.* cmdline tokens`);
    }
  }
  return tokens.join(" ");
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) {
    throw new ConfigValidationError(`${label} expected ${expected}, found ${actual}`);
  }
}

function assertUniqueSlotPaths(slots) {
  const dataImagePaths = new Set();
  const hashTreePaths = new Set();
  const ukiInputPaths = new Set();
  const ukiOutputPaths = new Set();
  const verityDevices = new Set();
  for (const slot of slots) {
    assertUnique(dataImagePaths, slot.dataImage.path, `${slot.name}.dataImage.path`);
    assertUnique(hashTreePaths, slot.hashTree.path, `${slot.name}.hashTree.path`);
    assertUnique(ukiInputPaths, slot.uki.input.path, `${slot.name}.uki.input.path`);
    assertUnique(ukiOutputPaths, slot.uki.output.path, `${slot.name}.uki.output.path`);
    assertUnique(verityDevices, slot.uki.verityDevice, `${slot.name}.verityDevice`);
  }
}

function preconditionStatusForDigestPins(entries) {
  for (const entry of entries) {
    if (!entry.pin.resolved) {
      return "blocked-unresolved-digest";
    }
  }
  return "pending-runtime-verification";
}

function preconditionStatusForRootHashes(slots) {
  for (const slot of slots) {
    if (!slot.rootHash.resolved) {
      return "blocked-unresolved-root-hash";
    }
  }
  return "pending-runtime-verification";
}

function preconditionStatusForBinding(slots) {
  for (const slot of slots) {
    if (!slot.rootHash.resolved || !slot.uki.input.pin.resolved) {
      return "blocked-unresolved-root-hash";
    }
  }
  return "pending-runtime-verification";
}

function blockedByForDigestPins(prefix, entries) {
  const unresolved = entries.filter((entry) => !entry.pin.resolved);
  if (unresolved.length === 0) {
    return [`${prefix}:pending-runtime-verification`];
  }
  return unresolved.map((entry) => `${prefix}:${entry.name}:unresolved-digest`);
}

function blockedByForRootHashes(prefix, slots) {
  const unresolved = slots.filter((slot) => !slot.rootHash.resolved);
  if (unresolved.length === 0) {
    return [`${prefix}:pending-runtime-verification`];
  }
  return unresolved.map((slot) => `${prefix}:${slot.name}:unresolved-root-hash`);
}

function bindBlockedByForSlot(slot) {
  const blockedBy = [];
  if (!slot.rootHash.resolved) {
    blockedBy.push(`compute-verity-root-hashes:${slot.name}:unresolved-root-hash`);
  }
  if (!slot.uki.input.pin.resolved) {
    blockedBy.push(`verify-slot-ukis:${slot.uki.input.name}:unresolved-digest`);
  }
  if (blockedBy.length === 0) {
    blockedBy.push(`bind-root-hashes-to-slot-ukis:${slot.name}:pending-runtime-verification`);
  }
  return blockedBy;
}

function assertUnique(set, value, label) {
  if (set.has(value)) {
    throw new ConfigValidationError(`${label} must be unique`);
  }
  set.add(value);
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

function readVerityInput(repoRoot) {
  return {
    configText: readFileSync(join(repoRoot, VERITY_CONFIG_PATH), "utf8"),
    mountRoots: DEFAULT_VERITY_PLAN_INPUT.mountRoots,
  };
}

function printUsage() {
  console.error("usage: node --experimental-strip-types os/x86_64/verity.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = dirname(dirname(dirname(scriptPath)));
    process.stdout.write(serializeVerityPlan(planVerity(readVerityInput(repoRoot))));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeNormalize } from "../../sdk/typescript/src/safe-normalize.ts";

export const DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH = "1781308800";
export const DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE = 4096;
export const DEFAULT_ROOTFS_IMAGE_INODE_SIZE = 256;
export const DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE = 16384;
export const DEFAULT_ROOTFS_IMAGE_MKE2FS_CONFIG_TEXT = `# Vita pinned mke2fs baseline for deterministic P1-024 rootfs images.

[defaults]
\tbase_features = sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr
\tdefault_mntopts = acl,user_xattr
\tenable_periodic_fsck = 0
\tblocksize = 4096
\tinode_size = 256
\tinode_ratio = 16384
\treserved_ratio = 0

[fs_types]
\text4 = {
\t\tfeatures = extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize
\t\tblocksize = 4096
\t\tinode_size = 256
\t\tinode_ratio = 16384
\t\treserved_ratio = 0
\t\tlazy_itable_init = 0
\t\tlazy_journal_init = 0
\t}
`;
export const DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT = `# Vita x86_64 deterministic rootfs directory -> ext4 image conversion plan.
# Converts the P1-011 Format=directory rootfs into the ext4 images consumed by image.conf and verity.conf.

[Paths]
WorkRoot=/work
ExternalRoot=/external
PlanRoot=/plan
OutputRoot=/external/p1-014/converted
Config=/work/os/x86_64/rootfs-image.conf

[RootDirectory]
Name=p1-011-root-directory
Contract=P1-011
OutputName=vita-debian-trixie-x86_64-root
Format=directory
Path=/external/p1-011/vita-debian-trixie-x86_64-root
Digest=unresolved

[Ext4]
Executable=mkfs.ext4
Mke2fsConfig=/work/os/x86_64/mke2fs.conf
SourceDateEpoch=1781308800
BlockSize=4096
InodeSize=256
BytesPerInode=16384
ReservedBlockPercentage=0
RootOwner=0:0
Features=sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize
ExtendedOptions=lazy_itable_init=0,lazy_journal_init=0
Network=none

[RootImageRootA]
Name=root-a-partition-image
Slot=root-a
Partition=root-a
RootLabel=vita-root-a
SourceDirectory=p1-011-root-directory
Output=/external/p1-014/converted/vita-root-a.rootfs.ext4
SizeBytes=4294967296
FilesystemUUID=4ee4a032-d49e-5f5f-8e26-98f656ec9ec4
HashSeed=26193224-75e4-5be1-8b75-ec293dd879df

[RootImageRootB]
Name=root-b-partition-image
Slot=root-b
Partition=root-b
RootLabel=vita-root-b
SourceDirectory=p1-011-root-directory
Output=/external/p1-014/converted/vita-root-b.rootfs.ext4
SizeBytes=4294967296
FilesystemUUID=dbe08ec3-fab5-5e5a-b7b9-71098e4d93c0
HashSeed=a9d349c3-0a0e-53e9-bc8d-4e8437f80cf3

[RootImageRecovery]
Name=recovery-partition-image
Slot=recovery
Partition=recovery
RootLabel=vita-recovery
SourceDirectory=p1-011-root-directory
Output=/external/p1-014/converted/vita-recovery.rootfs.ext4
SizeBytes=2147483648
FilesystemUUID=5ff29a79-4430-5fb2-b43c-3d6f8b2a9f1d
HashSeed=998d4f3d-d756-5a28-a51c-f5f092747dcd
`;

const DEFAULT_ROOTFS_IMAGE_PLAN_INPUT = Object.freeze({
  configText: DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
    planInputsHostPath: "/repo/os/x86_64/generated-inputs",
    outputHostPath: "/repo/os/x86_64/upstream-inputs/p1-014/converted",
  }),
});

const ROOTFS_IMAGE_CONFIG_PATH = "os/x86_64/rootfs-image.conf";
const ROOTFS_IMAGE_MKE2FS_CONFIG_PATH = "os/x86_64/mke2fs.conf";
const ROOTFS_IMAGE_MKE2FS_CONFIG_CONTAINER_PATH = "/work/os/x86_64/mke2fs.conf";
const ROOT_DIRECTORY_OUTPUT_NAME = "vita-debian-trixie-x86_64-root";
const ROOTFS_IMAGE_BASE_FEATURES = Object.freeze([
  "sparse_super",
  "large_file",
  "filetype",
  "resize_inode",
  "dir_index",
  "ext_attr",
]);
const ROOTFS_IMAGE_EXT4_FEATURES = Object.freeze([
  "extent",
  "huge_file",
  "flex_bg",
  "metadata_csum",
  "64bit",
  "dir_nlink",
  "extra_isize",
]);
const ROOTFS_IMAGE_FEATURES = Object.freeze([
  ...ROOTFS_IMAGE_BASE_FEATURES,
  ...ROOTFS_IMAGE_EXT4_FEATURES,
]);
const ROOT_IMAGE_SECTIONS = Object.freeze([
  Object.freeze({
    sectionName: "RootImageRootA",
    name: "root-a-partition-image",
    slot: "root-a",
    partition: "root-a",
    rootLabel: "vita-root-a",
    outputPath: "/external/p1-014/converted/vita-root-a.rootfs.ext4",
    sizeBytes: 4_294_967_296,
  }),
  Object.freeze({
    sectionName: "RootImageRootB",
    name: "root-b-partition-image",
    slot: "root-b",
    partition: "root-b",
    rootLabel: "vita-root-b",
    outputPath: "/external/p1-014/converted/vita-root-b.rootfs.ext4",
    sizeBytes: 4_294_967_296,
  }),
  Object.freeze({
    sectionName: "RootImageRecovery",
    name: "recovery-partition-image",
    slot: "recovery",
    partition: "recovery",
    rootLabel: "vita-recovery",
    outputPath: "/external/p1-014/converted/vita-recovery.rootfs.ext4",
    sizeBytes: 2_147_483_648,
  }),
]);

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planRootfsImage(input = DEFAULT_ROOTFS_IMAGE_PLAN_INPUT) {
  const normalizedInput = normalizeRootfsImagePlanInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, ROOTFS_IMAGE_CONFIG_PATH);
  const resolvedConfig = resolveRootfsImageConfig(config);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const mounts = buildMounts(normalizedInput.value.mountRoots, resolvedConfig.paths);
  const blockedBy = blockedByForPins("verify-p1-011-root-directory", [resolvedConfig.rootDirectory]);
  const commandPlans = resolvedConfig.rootImages.map((image) =>
    buildMkfsCommand(resolvedConfig.ext4, resolvedConfig.rootDirectory, image),
  );

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: ROOTFS_IMAGE_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
      mke2fsConfig: {
        path: ROOTFS_IMAGE_MKE2FS_CONFIG_PATH,
        containerPath: resolvedConfig.ext4.mke2fsConfig,
        digest: sha256Text(DEFAULT_ROOTFS_IMAGE_MKE2FS_CONFIG_TEXT),
      },
    },
    mounts,
    tool: {
      executable: resolvedConfig.ext4.executable,
      filesystem: "ext4",
      sourceMode: "directory",
      outputFormat: "rootfs.ext4",
      network: "none",
      upstreamPrivileged: true,
    },
    environment: {
      SOURCE_DATE_EPOCH: resolvedConfig.ext4.sourceDateEpoch,
      TZ: "UTC",
      LC_ALL: "C.UTF-8",
      MKE2FS_CONFIG: resolvedConfig.ext4.mke2fsConfig,
    },
    parameters: {
      mke2fsConfig: {
        path: ROOTFS_IMAGE_MKE2FS_CONFIG_PATH,
        containerPath: resolvedConfig.ext4.mke2fsConfig,
      },
      sourceDateEpoch: resolvedConfig.ext4.sourceDateEpoch,
      blockSize: resolvedConfig.ext4.blockSize,
      inodeSize: resolvedConfig.ext4.inodeSize,
      bytesPerInode: resolvedConfig.ext4.bytesPerInode,
      reservedBlockPercentage: resolvedConfig.ext4.reservedBlockPercentage,
      rootOwner: resolvedConfig.ext4.rootOwner,
      baseFeatures: ROOTFS_IMAGE_BASE_FEATURES,
      ext4Features: ROOTFS_IMAGE_EXT4_FEATURES,
      features: resolvedConfig.ext4.features,
      extendedOptions: resolvedConfig.ext4.extendedOptions,
      journal: "disabled",
      hashSeedPolicy: "fixed-per-image-uuid",
    },
    inputs: {
      external: [resolvedConfig.rootDirectory],
      produced: [],
    },
    outputs: {
      rootImages: resolvedConfig.rootImages,
    },
    preconditions: [
      {
        id: "verify-p1-011-root-directory",
        kind: "digest-verification",
        status: preconditionStatusForPins([resolvedConfig.rootDirectory]),
        network: "none",
        verifies: [
          {
            name: resolvedConfig.rootDirectory.name,
            path: resolvedConfig.rootDirectory.path,
            pin: resolvedConfig.rootDirectory.pin,
          },
        ],
        blocks: ["convert-root-directory-to-ext4-images"],
      },
      {
        id: "convert-root-directory-to-ext4-images",
        kind: "external-precondition-step",
        status: preconditionStatusForPins([resolvedConfig.rootDirectory]),
        network: "none",
        executable: false,
        upstreamPrivileged: true,
        gatedBy: ["verify-p1-011-root-directory"],
        blockedBy,
        input: resolvedConfig.rootDirectory.name,
        conversion: "root-directory-to-ext4-image",
        commandPlans,
        outputs: resolvedConfig.rootImages.map((image) => ({
          name: image.name,
          path: image.path,
          partition: image.partition,
          slot: image.slot,
          filesystemUuid: image.filesystemUuid,
          hashSeed: image.hashSeed,
          sizeBytes: image.sizeBytes,
        })),
        blocks: ["compute-verity-root-hashes", "assemble-image", "plan-rauc-bundle"],
      },
    ],
    steps: resolvedConfig.rootImages.map((image) => {
      const command = buildMkfsCommand(resolvedConfig.ext4, resolvedConfig.rootDirectory, image);
      return {
        id: `convert-${image.slot}-rootfs-image`,
        kind: "mkfs-ext4-rootfs-image-plan",
        status: "blocked",
        executable: false,
        upstreamPrivileged: true,
        gatedBy: ["verify-p1-011-root-directory"],
        blockedBy,
        input: resolvedConfig.rootDirectory.path,
        output: image.path,
        command,
      };
    }),
    commands: commandPlans,
  };
}

export function serializeRootfsImagePlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeRootfsImagePlanInput(input) {
  const normalized = safeNormalize(input, { maxDepth: 64, maxNodes: 10_000 });
  if (!normalized.ok) {
    return { ok: false, error: `rootfs image plan input normalization failed: ${normalized.reason}` };
  }
  if (!isPlainRecord(normalized.value)) {
    return { ok: false, error: "rootfs image plan input must be a plain object" };
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(normalized.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `rootfs image plan input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(normalized.value, "configText")) {
    return { ok: false, error: "rootfs image plan input missing required field configText" };
  }
  if (!Object.hasOwn(normalized.value, "mountRoots")) {
    return { ok: false, error: "rootfs image plan input missing required field mountRoots" };
  }

  const configText = normalized.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "rootfs image plan input field configText must be a non-empty string" };
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
    return { ok: false, error: "rootfs image mount roots must be a plain object" };
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
      return { ok: false, error: `rootfs image mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      return { ok: false, error: `rootfs image mount roots missing required field ${key}` };
    }
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `rootfs image mount roots field ${key} must be a non-empty string` };
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
    root: externalInputsHostPath,
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

function resolveRootfsImageConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "ExternalRoot", "PlanRoot", "OutputRoot", "Config"],
    RootDirectory: ["Name", "Contract", "OutputName", "Format", "Path", "Digest"],
    Ext4: [
      "Executable",
      "Mke2fsConfig",
      "SourceDateEpoch",
      "BlockSize",
      "InodeSize",
      "BytesPerInode",
      "ReservedBlockPercentage",
      "RootOwner",
      "Features",
      "ExtendedOptions",
      "Network",
    ],
    RootImageRootA: [
      "Name",
      "Slot",
      "Partition",
      "RootLabel",
      "SourceDirectory",
      "Output",
      "SizeBytes",
      "FilesystemUUID",
      "HashSeed",
    ],
    RootImageRootB: [
      "Name",
      "Slot",
      "Partition",
      "RootLabel",
      "SourceDirectory",
      "Output",
      "SizeBytes",
      "FilesystemUUID",
      "HashSeed",
    ],
    RootImageRecovery: [
      "Name",
      "Slot",
      "Partition",
      "RootLabel",
      "SourceDirectory",
      "Output",
      "SizeBytes",
      "FilesystemUUID",
      "HashSeed",
    ],
  });

  const paths = resolvePaths(config);
  const rootDirectory = resolveRootDirectory(config, paths);
  const ext4 = resolveExt4(config, paths);
  const rootImages = resolveRootImages(config, paths, rootDirectory, ext4);
  assertUniqueRootImages(rootImages);

  return {
    paths,
    rootDirectory,
    ext4,
    rootImages,
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
    root: externalRoot,
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
  ]);

  return {
    workRoot,
    externalRoot,
    planRoot,
    outputRoot,
    configPath,
  };
}

function resolveRootDirectory(config, paths) {
  const name = getSingleValue(config, "RootDirectory", "Name");
  const contract = getSingleValue(config, "RootDirectory", "Contract");
  const outputName = getSingleValue(config, "RootDirectory", "OutputName");
  const format = getSingleValue(config, "RootDirectory", "Format");
  const path = validateCanonicalPosixPath(getSingleValue(config, "RootDirectory", "Path"), {
    label: "RootDirectory.Path",
    root: paths.externalRoot,
    allowRoot: false,
  });
  const pin = parseDigestPin(getSingleValue(config, "RootDirectory", "Digest"), "RootDirectory.Digest");

  assertExpected(name, "p1-011-root-directory", "RootDirectory.Name");
  assertExpected(contract, "P1-011", "RootDirectory.Contract");
  assertExpected(outputName, ROOT_DIRECTORY_OUTPUT_NAME, "RootDirectory.OutputName");
  assertExpected(format, "directory", "RootDirectory.Format");
  assertExpected(path, "/external/p1-011/vita-debian-trixie-x86_64-root", "RootDirectory.Path");

  return {
    name,
    kind: "root-directory",
    source: "external-precondition",
    contract,
    outputName,
    format,
    path,
    mountRoot: paths.externalRoot,
    pin,
  };
}

function resolveExt4(config, paths) {
  const executable = getSingleValue(config, "Ext4", "Executable");
  if (executable !== "mkfs.ext4") {
    throw new ConfigValidationError(`Ext4.Executable expected mkfs.ext4, found ${executable}`);
  }

  const mke2fsConfig = validateCanonicalPosixPath(getSingleValue(config, "Ext4", "Mke2fsConfig"), {
    label: "Ext4.Mke2fsConfig",
    root: paths.workRoot,
    allowRoot: false,
  });
  assertExpected(mke2fsConfig, ROOTFS_IMAGE_MKE2FS_CONFIG_CONTAINER_PATH, "Ext4.Mke2fsConfig");

  const sourceDateEpoch = getSingleValue(config, "Ext4", "SourceDateEpoch");
  if (sourceDateEpoch !== DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH) {
    throw new ConfigValidationError(`Ext4.SourceDateEpoch expected ${DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH}, found ${sourceDateEpoch}`);
  }

  const blockSize = getInteger(config, "Ext4", "BlockSize");
  if (blockSize !== DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE) {
    throw new ConfigValidationError(`Ext4.BlockSize expected ${DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE}, found ${blockSize}`);
  }

  const inodeSize = getInteger(config, "Ext4", "InodeSize");
  if (inodeSize !== DEFAULT_ROOTFS_IMAGE_INODE_SIZE) {
    throw new ConfigValidationError(`Ext4.InodeSize expected ${DEFAULT_ROOTFS_IMAGE_INODE_SIZE}, found ${inodeSize}`);
  }

  const bytesPerInode = getInteger(config, "Ext4", "BytesPerInode");
  if (bytesPerInode !== DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE) {
    throw new ConfigValidationError(`Ext4.BytesPerInode expected ${DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE}, found ${bytesPerInode}`);
  }

  const reservedBlockPercentage = getInteger(config, "Ext4", "ReservedBlockPercentage");
  if (reservedBlockPercentage !== 0) {
    throw new ConfigValidationError(`Ext4.ReservedBlockPercentage expected 0, found ${reservedBlockPercentage}`);
  }

  const rootOwner = getSingleValue(config, "Ext4", "RootOwner");
  if (rootOwner !== "0:0") {
    throw new ConfigValidationError(`Ext4.RootOwner expected 0:0, found ${rootOwner}`);
  }

  const features = getCommaList(config, "Ext4", "Features");
  if (features.includes("has_journal") || features.includes("^has_journal")) {
    throw new ConfigValidationError("Ext4.Features must use the full pinned feature set without has_journal");
  }
  assertArrayEquals(features, ROOTFS_IMAGE_FEATURES, "Ext4.Features");

  const extendedOptions = getCommaList(config, "Ext4", "ExtendedOptions");
  assertArrayEquals(extendedOptions, ["lazy_itable_init=0", "lazy_journal_init=0"], "Ext4.ExtendedOptions");

  const network = getSingleValue(config, "Ext4", "Network");
  if (network !== "none") {
    throw new ConfigValidationError(`Ext4.Network expected none, found ${network}`);
  }

  return {
    executable,
    mke2fsConfig,
    sourceDateEpoch,
    blockSize,
    inodeSize,
    bytesPerInode,
    reservedBlockPercentage,
    rootOwner,
    features,
    extendedOptions,
    network,
  };
}

function resolveRootImages(config, paths, rootDirectory, ext4) {
  return ROOT_IMAGE_SECTIONS.map((expected) => {
    const sectionName = expected.sectionName;
    const name = getSingleValue(config, sectionName, "Name");
    const slot = getSingleValue(config, sectionName, "Slot");
    const partition = getSingleValue(config, sectionName, "Partition");
    const rootLabel = getSingleValue(config, sectionName, "RootLabel");
    const sourceDirectory = getSingleValue(config, sectionName, "SourceDirectory");
    const path = validateCanonicalPosixPath(getSingleValue(config, sectionName, "Output"), {
      label: `${sectionName}.Output`,
      root: paths.outputRoot,
      allowRoot: false,
    });
    const sizeBytes = getInteger(config, sectionName, "SizeBytes");
    const filesystemUuid = validateUuid(getSingleValue(config, sectionName, "FilesystemUUID"), `${sectionName}.FilesystemUUID`);
    const hashSeed = validateUuid(getSingleValue(config, sectionName, "HashSeed"), `${sectionName}.HashSeed`);

    validatePartitionId(slot, `${sectionName}.Slot`);
    validatePartitionId(partition, `${sectionName}.Partition`);
    validatePartitionLabel(rootLabel, `${sectionName}.RootLabel`);
    assertExpected(name, expected.name, `${sectionName}.Name`);
    assertExpected(slot, expected.slot, `${sectionName}.Slot`);
    assertExpected(partition, expected.partition, `${sectionName}.Partition`);
    assertExpected(rootLabel, expected.rootLabel, `${sectionName}.RootLabel`);
    assertExpected(sourceDirectory, rootDirectory.name, `${sectionName}.SourceDirectory`);
    assertExpected(path, expected.outputPath, `${sectionName}.Output`);
    if (sizeBytes !== expected.sizeBytes) {
      throw new ConfigValidationError(`${sectionName}.SizeBytes expected ${expected.sizeBytes}, found ${sizeBytes}`);
    }
    if (sizeBytes % ext4.blockSize !== 0) {
      throw new ConfigValidationError(`${sectionName}.SizeBytes must be a multiple of Ext4.BlockSize`);
    }

    return {
      name,
      kind: "root-partition-image",
      source: "mkfs.ext4-output",
      conversionFrom: rootDirectory.name,
      slot,
      partition,
      rootLabel,
      path,
      mountRoot: paths.externalRoot,
      outputRoot: paths.outputRoot,
      filesystem: "ext4",
      sizeBytes,
      blockSize: ext4.blockSize,
      blockCount: sizeBytes / ext4.blockSize,
      filesystemUuid,
      hashSeed,
    };
  });
}

function buildMkfsCommand(ext4, rootDirectory, image) {
  const extendedOptions = [
    `root_owner=${ext4.rootOwner}`,
    `hash_seed=${image.hashSeed}`,
    ...ext4.extendedOptions,
  ];
  const args = [
    "-d",
    rootDirectory.path,
    "-F",
    "-t",
    "ext4",
    "-b",
    String(ext4.blockSize),
    "-I",
    String(ext4.inodeSize),
    "-i",
    String(ext4.bytesPerInode),
    "-m",
    String(ext4.reservedBlockPercentage),
    "-L",
    image.rootLabel,
    "-U",
    image.filesystemUuid,
    "-O",
    ext4.features.join(","),
    "-E",
    extendedOptions.join(","),
    image.path,
    String(image.blockCount),
  ];

  return {
    executable: ext4.executable,
    args,
    environment: {
      SOURCE_DATE_EPOCH: ext4.sourceDateEpoch,
      TZ: "UTC",
      LC_ALL: "C.UTF-8",
      MKE2FS_CONFIG: ext4.mke2fsConfig,
    },
    sourceDirectory: rootDirectory.path,
    output: image.path,
    outputSizeBytes: image.sizeBytes,
    blockCount: image.blockCount,
    filesystemUuid: image.filesystemUuid,
    hashSeed: image.hashSeed,
    rootOwner: ext4.rootOwner,
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
      name: "external-rootfs-inputs",
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
      name: "converted-rootfs-output",
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

function getCommaList(config, sectionName, key) {
  const value = getSingleValue(config, sectionName, key);
  const entries = value.split(",");
  if (entries.length === 0) {
    throw new ConfigValidationError(`${sectionName}.${key} must contain at least one entry`);
  }
  for (const entry of entries) {
    if (entry.length === 0 || /\s/u.test(entry)) {
      throw new ConfigValidationError(`${sectionName}.${key} must be a comma-separated list without whitespace`);
    }
  }
  return entries;
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

function validateSha256Digest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be sha256 followed by exactly 64 lowercase hex characters`);
  }
  const hex = value.slice("sha256:".length);
  validateNonPlaceholderHex(hex, label);
  return value;
}

function validateUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a lowercase RFC 4122 UUID`);
  }
  validateNonPlaceholderHex(value.replaceAll("-", ""), label);
  return value;
}

function validateNonPlaceholderHex(hex, label) {
  if (isPlaceholderHex(hex)) {
    throw new ConfigValidationError(`${label} must not use a placeholder or sentinel digest`);
  }
}

function isPlaceholderHex(hex) {
  if (/^([0-9a-f])\1+$/.test(hex)) {
    return true;
  }

  for (let patternLength = 1; patternLength <= 16; patternLength += 1) {
    if (hex.length % patternLength !== 0) {
      continue;
    }
    const pattern = hex.slice(0, patternLength);
    if (pattern.repeat(hex.length / patternLength) === hex) {
      return true;
    }
  }

  const repeatedDeadbeef = "deadbeef".repeat(hex.length / 8);
  const repeatedCafebabe = "cafebabe".repeat(hex.length / 8);
  return hex === repeatedDeadbeef || hex === repeatedCafebabe;
}

function validatePartitionId(value, label) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a lowercase partition id`);
  }
}

function validatePartitionLabel(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable filesystem label`);
  }
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

function assertUniqueRootImages(rootImages) {
  const names = new Set();
  const paths = new Set();
  const filesystemUuids = new Set();
  const hashSeeds = new Set();
  for (const image of rootImages) {
    assertUnique(names, image.name, `${image.name}.name`);
    assertUnique(paths, image.path, `${image.name}.path`);
    assertUnique(filesystemUuids, image.filesystemUuid, `${image.name}.filesystemUuid`);
    assertUnique(hashSeeds, image.hashSeed, `${image.name}.hashSeed`);
  }
}

function preconditionStatusForPins(entries) {
  for (const entry of entries) {
    if (!entry.pin.resolved) {
      return "blocked-unresolved-digest";
    }
  }
  return "pending-runtime-verification";
}

function blockedByForPins(prefix, entries) {
  const unresolved = entries.filter((entry) => !entry.pin.resolved);
  if (unresolved.length === 0) {
    return [`${prefix}:pending-runtime-verification`];
  }
  return unresolved.map((entry) => `${prefix}:${entry.name}:unresolved-digest`);
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

function readRootfsImageInput(repoRoot) {
  return {
    configText: readFileSync(join(repoRoot, ROOTFS_IMAGE_CONFIG_PATH), "utf8"),
    mountRoots: DEFAULT_ROOTFS_IMAGE_PLAN_INPUT.mountRoots,
  };
}

function printUsage() {
  console.error("usage: node --experimental-strip-types os/x86_64/rootfs-image.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = dirname(dirname(dirname(scriptPath)));
    process.stdout.write(serializeRootfsImagePlan(planRootfsImage(readRootfsImageInput(repoRoot))));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

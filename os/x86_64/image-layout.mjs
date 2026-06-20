#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_SOURCE_DATE_EPOCH = "1781308800";
export const DEFAULT_RAUC_COMPATIBLE = "vita-x86_64";
export const DEFAULT_IMAGE_CONFIG_TEXT = `# Vita x86_64 deterministic GPT + RAUC A/B layout scaffold.
# External artifacts use Digest=unresolved until upstream builders pin them.

[Paths]
WorkRoot=/work
ExternalRoot=/external
PlanRoot=/plan
OutputRoot=/out
Config=/work/os/x86_64/image.conf

[Image]
Name=vita-x86_64-ab-recovery
Output=/out/vita-x86_64-ab-recovery.raw
SectorSize=512
AlignmentBytes=1048576
FirstUsableLBA=2048
SourceDateEpoch=1781308800
RaucCompatible=vita-x86_64
Version=0.1-bootstrap

[PartitionESP]
Number=1
Id=esp
Name=vita-esp
Label=VITA-ESP
Role=esp
Filesystem=vfat
SizeBytes=536870912
TypeGuid=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
PartitionGuid=5f7b7fb2-3228-43a3-8f52-6ac0d5d28c01

[PartitionRootA]
Number=2
Id=root-a
Name=vita-root-a
Label=vita-root-a
Role=rootfs
Filesystem=ext4
SizeBytes=4294967296
TypeGuid=4f68bce3-e8cd-4db1-96e7-fbcaf984b709
PartitionGuid=d3d7f6e6-1b23-4cf4-955f-4a87a2c04a11

[PartitionRootB]
Number=3
Id=root-b
Name=vita-root-b
Label=vita-root-b
Role=rootfs
Filesystem=ext4
SizeBytes=4294967296
TypeGuid=4f68bce3-e8cd-4db1-96e7-fbcaf984b709
PartitionGuid=abd2a3d5-6956-491b-9c48-14ac3280f7b2

[PartitionRecovery]
Number=4
Id=recovery
Name=vita-recovery
Label=vita-recovery
Role=recovery
Filesystem=ext4
SizeBytes=2147483648
TypeGuid=4f68bce3-e8cd-4db1-96e7-fbcaf984b709
PartitionGuid=76dc6fc4-f5a7-48a0-9122-874064f38044

[PartitionData]
Number=5
Id=data
Name=vita-data
Label=vita-data
Role=data
Filesystem=ext4
SizeBytes=8589934592
TypeGuid=0fc63daf-8483-4772-8e79-3d69d8477de4
PartitionGuid=ee154f01-bbe5-4b8a-a763-acef82710d55

[RootDirectory]
Name=p1-011-root-directory
Contract=P1-011
OutputName=vita-debian-trixie-x86_64-root
Format=directory
Path=/external/p1-011/vita-debian-trixie-x86_64-root
Digest=unresolved

[RootImageRootA]
Name=root-a-partition-image
Slot=root-a
Partition=root-a
SourceDirectory=p1-011-root-directory
Path=/external/p1-014/converted/vita-root-a.rootfs.ext4
Digest=unresolved

[RootImageRootB]
Name=root-b-partition-image
Slot=root-b
Partition=root-b
SourceDirectory=p1-011-root-directory
Path=/external/p1-014/converted/vita-root-b.rootfs.ext4
Digest=unresolved

[RootImageRecovery]
Name=recovery-partition-image
Slot=recovery
Partition=recovery
SourceDirectory=p1-011-root-directory
Path=/external/p1-014/converted/vita-recovery.rootfs.ext4
Digest=unresolved

[BootRootA]
Name=uki-root-a
Contract=P1-012
Slot=root-a
Partition=root-a
Path=/external/p1-012/root-a/vita-root-a.unsigned.efi
EspPath=/EFI/vita/vita-root-a.efi
Cmdline=root=LABEL=vita-root-a ro systemd.volatile=no quiet
Digest=unresolved

[BootRootB]
Name=uki-root-b
Contract=P1-012
Slot=root-b
Partition=root-b
Path=/external/p1-012/root-b/vita-root-b.unsigned.efi
EspPath=/EFI/vita/vita-root-b.efi
Cmdline=root=LABEL=vita-root-b ro systemd.volatile=no quiet
Digest=unresolved

[BootRecovery]
Name=uki-recovery
Contract=P1-012
Slot=recovery
Partition=recovery
Path=/external/p1-012/recovery/vita-recovery.unsigned.efi
EspPath=/EFI/vita/vita-recovery.efi
Cmdline=root=LABEL=vita-recovery ro systemd.unit=rescue.target quiet
Digest=unresolved

[SlotRootA]
Name=rootfs.0
Class=rootfs
Index=0
BootName=A
Partition=root-a
RootImage=root-a-partition-image
BootArtifact=uki-root-a

[SlotRootB]
Name=rootfs.1
Class=rootfs
Index=1
BootName=B
Partition=root-b
RootImage=root-b-partition-image
BootArtifact=uki-root-b

[SlotRecovery]
Name=recovery.0
Class=recovery
Index=0
BootName=recovery
Partition=recovery
RootImage=recovery-partition-image
BootArtifact=uki-recovery
`;

const DEFAULT_IMAGE_LAYOUT_INPUT = Object.freeze({
  configText: DEFAULT_IMAGE_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
    planInputsHostPath: "/repo/os/x86_64/generated-inputs",
    outputHostPath: "/repo/os/x86_64/out",
  }),
});

const IMAGE_CONFIG_PATH = "os/x86_64/image.conf";
const PARTITION_SECTIONS = Object.freeze([
  "PartitionESP",
  "PartitionRootA",
  "PartitionRootB",
  "PartitionRecovery",
  "PartitionData",
]);
const ROOT_IMAGE_SECTIONS = Object.freeze(["RootImageRootA", "RootImageRootB", "RootImageRecovery"]);
const BOOT_SECTIONS = Object.freeze(["BootRootA", "BootRootB", "BootRecovery"]);
const SLOT_SECTIONS = Object.freeze(["SlotRootA", "SlotRootB", "SlotRecovery"]);
const ROOT_DIRECTORY_OUTPUT_NAME = "vita-debian-trixie-x86_64-root";

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planImageLayout(input = DEFAULT_IMAGE_LAYOUT_INPUT) {
  const normalizedInput = normalizeImageLayoutInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, IMAGE_CONFIG_PATH);
  const resolvedConfig = resolveImageConfig(config);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const mounts = buildMounts(normalizedInput.value.mountRoots, resolvedConfig.paths);
  const raucManifestText = buildRaucManifestText(resolvedConfig);
  const raucManifestDigest = sha256Text(raucManifestText);

  const rootImageBlockedBy = blockedByForPins("convert-root-directory-to-partition-images", [
    resolvedConfig.rootDirectory,
    ...resolvedConfig.rootImages,
  ]);
  const bootBlockedBy = blockedByForPins("verify-slot-ukis", resolvedConfig.bootArtifacts);
  const assemblyBlockedBy = [...rootImageBlockedBy, ...bootBlockedBy];

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: IMAGE_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
    },
    mounts,
    environment: {
      SOURCE_DATE_EPOCH: resolvedConfig.image.sourceDateEpoch,
      TZ: "UTC",
      LC_ALL: "C.UTF-8",
    },
    image: {
      name: resolvedConfig.image.name,
      outputPath: resolvedConfig.image.outputPath,
      sectorSize: resolvedConfig.image.sectorSize,
      alignmentBytes: resolvedConfig.image.alignmentBytes,
      firstUsableLBA: resolvedConfig.image.firstUsableLBA,
      imageSizeBytes: resolvedConfig.image.imageSizeBytes,
      sourceDateEpoch: resolvedConfig.image.sourceDateEpoch,
      raucCompatible: resolvedConfig.image.raucCompatible,
      version: resolvedConfig.image.version,
    },
    partitions: resolvedConfig.partitions,
    inputs: {
      external: [
        resolvedConfig.rootDirectory,
        ...resolvedConfig.rootImages,
        ...resolvedConfig.bootArtifacts,
      ],
      produced: [
        {
          name: "rauc-manifest",
          kind: "deterministic-text",
          containerPath: `${resolvedConfig.paths.planRoot}/rauc/manifest.raucm`,
          digest: raucManifestDigest,
          text: raucManifestText,
        },
      ],
    },
    slots: {
      compatible: resolvedConfig.image.raucCompatible,
      bootOrder: ["rootfs.0", "rootfs.1", "recovery.0"],
      map: resolvedConfig.slots,
    },
    rauc: {
      compatible: resolvedConfig.image.raucCompatible,
      bundle: {
        kind: "rauc-bundle-manifest-plan",
        format: "plain",
        status: "blocked",
        compatible: resolvedConfig.image.raucCompatible,
        version: resolvedConfig.image.version,
        manifestPath: `${resolvedConfig.paths.planRoot}/rauc/manifest.raucm`,
        manifestDigest: raucManifestDigest,
        manifestText: raucManifestText,
        slots: resolvedConfig.slots.map((slot) => ({
          name: slot.name,
          class: slot.class,
          index: slot.index,
          partition: slot.partitionId,
          rootImage: slot.rootImageInput,
          bootArtifact: slot.bootArtifactInput,
        })),
      },
    },
    preconditions: [
      {
        id: "verify-p1-011-root-directory",
        kind: "digest-verification",
        status: preconditionStatus([resolvedConfig.rootDirectory]),
        network: "none",
        verifies: [
          {
            name: resolvedConfig.rootDirectory.name,
            path: resolvedConfig.rootDirectory.path,
            pin: resolvedConfig.rootDirectory.pin,
          },
        ],
        blocks: ["convert-root-directory-to-partition-images"],
      },
      {
        id: "convert-root-directory-to-partition-images",
        kind: "external-precondition-step",
        status: preconditionStatus([resolvedConfig.rootDirectory, ...resolvedConfig.rootImages]),
        network: "none",
        gatedBy: ["verify-p1-011-root-directory"],
        blockedBy: rootImageBlockedBy,
        input: resolvedConfig.rootDirectory.name,
        conversion: "root-directory-to-partition-image",
        outputs: resolvedConfig.rootImages.map((image) => ({
          name: image.name,
          path: image.path,
          partition: image.partition,
          slot: image.slot,
          pin: image.pin,
        })),
        blocks: ["assemble-image", "plan-rauc-bundle"],
      },
      {
        id: "verify-slot-ukis",
        kind: "digest-verification",
        status: preconditionStatus(resolvedConfig.bootArtifacts),
        network: "none",
        verifies: resolvedConfig.bootArtifacts.map((artifact) => ({
          name: artifact.name,
          path: artifact.path,
          slot: artifact.slot,
          cmdline: artifact.cmdline,
          pin: artifact.pin,
        })),
        blocks: ["assemble-image", "plan-rauc-bundle"],
      },
    ],
    steps: [
      {
        id: "assemble-image",
        kind: "gpt-image-assembly-plan",
        status: "blocked",
        executable: false,
        gatedBy: ["convert-root-directory-to-partition-images", "verify-slot-ukis"],
        blockedBy: assemblyBlockedBy,
        output: resolvedConfig.image.outputPath,
      },
      {
        id: "plan-rauc-bundle",
        kind: "rauc-bundle-manifest-plan",
        status: "blocked",
        executable: false,
        gatedBy: ["convert-root-directory-to-partition-images", "verify-slot-ukis"],
        blockedBy: assemblyBlockedBy,
        output: `${resolvedConfig.paths.outputRoot}/vita-x86_64.raucb`,
      },
    ],
  };
}

export function serializeImageLayoutPlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeImageLayoutInput(input) {
  const snapshot = snapshotPlainObject(input, "image layout input");
  if (!snapshot.ok) {
    return snapshot;
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(snapshot.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `image layout input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(snapshot.value, "configText")) {
    return { ok: false, error: "image layout input missing required field configText" };
  }
  if (!Object.hasOwn(snapshot.value, "mountRoots")) {
    return { ok: false, error: "image layout input missing required field mountRoots" };
  }

  const configText = snapshot.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "image layout input field configText must be a non-empty string" };
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
  const snapshot = snapshotPlainObject(input, "image layout mount roots");
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
      return { ok: false, error: `image layout mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot.value, key)) {
      return { ok: false, error: `image layout mount roots missing required field ${key}` };
    }
    const value = snapshot.value[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `image layout mount roots field ${key} must be a non-empty string` };
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
    if (/[\u0000-\u0008\u000B-\u001F\u007F]/u.test(value)) {
      throw new ConfigValidationError(`${label}:${lineNumber} ${currentSection}.${key} must not contain control characters`);
    }

    const section = sections.get(currentSection);
    if (section.has(key)) {
      throw new ConfigValidationError(`${label}:${lineNumber} repeats setting ${currentSection}.${key}`);
    }
    section.set(key, value);
  }

  return { label, sections };
}

function resolveImageConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "ExternalRoot", "PlanRoot", "OutputRoot", "Config"],
    Image: [
      "Name",
      "Output",
      "SectorSize",
      "AlignmentBytes",
      "FirstUsableLBA",
      "SourceDateEpoch",
      "RaucCompatible",
      "Version",
    ],
    PartitionESP: [
      "Number",
      "Id",
      "Name",
      "Label",
      "Role",
      "Filesystem",
      "SizeBytes",
      "TypeGuid",
      "PartitionGuid",
    ],
    PartitionRootA: [
      "Number",
      "Id",
      "Name",
      "Label",
      "Role",
      "Filesystem",
      "SizeBytes",
      "TypeGuid",
      "PartitionGuid",
    ],
    PartitionRootB: [
      "Number",
      "Id",
      "Name",
      "Label",
      "Role",
      "Filesystem",
      "SizeBytes",
      "TypeGuid",
      "PartitionGuid",
    ],
    PartitionRecovery: [
      "Number",
      "Id",
      "Name",
      "Label",
      "Role",
      "Filesystem",
      "SizeBytes",
      "TypeGuid",
      "PartitionGuid",
    ],
    PartitionData: [
      "Number",
      "Id",
      "Name",
      "Label",
      "Role",
      "Filesystem",
      "SizeBytes",
      "TypeGuid",
      "PartitionGuid",
    ],
    RootDirectory: ["Name", "Contract", "OutputName", "Format", "Path", "Digest"],
    RootImageRootA: ["Name", "Slot", "Partition", "SourceDirectory", "Path", "Digest"],
    RootImageRootB: ["Name", "Slot", "Partition", "SourceDirectory", "Path", "Digest"],
    RootImageRecovery: ["Name", "Slot", "Partition", "SourceDirectory", "Path", "Digest"],
    BootRootA: ["Name", "Contract", "Slot", "Partition", "Path", "EspPath", "Cmdline", "Digest"],
    BootRootB: ["Name", "Contract", "Slot", "Partition", "Path", "EspPath", "Cmdline", "Digest"],
    BootRecovery: ["Name", "Contract", "Slot", "Partition", "Path", "EspPath", "Cmdline", "Digest"],
    SlotRootA: ["Name", "Class", "Index", "BootName", "Partition", "RootImage", "BootArtifact"],
    SlotRootB: ["Name", "Class", "Index", "BootName", "Partition", "RootImage", "BootArtifact"],
    SlotRecovery: ["Name", "Class", "Index", "BootName", "Partition", "RootImage", "BootArtifact"],
  });

  const paths = resolvePaths(config);
  const image = resolveImage(config, paths);
  const partitions = resolvePartitions(config, image);
  const partitionById = indexBy(partitions, "id", "partitions");
  const rootDirectory = resolveRootDirectory(config, paths);
  const rootImages = resolveRootImages(config, paths, rootDirectory, partitionById);
  const rootImageByName = indexBy(rootImages, "name", "root images");
  const bootArtifacts = resolveBootArtifacts(config, paths, partitionById);
  const bootArtifactByName = indexBy(bootArtifacts, "name", "boot artifacts");
  const slots = resolveSlots(config, partitionById, rootImageByName, bootArtifactByName);

  assertExactSlotSet(slots);
  assertUniqueBootArtifacts(bootArtifacts);
  assertNoOverlaps(partitions);

  return {
    paths,
    image,
    partitions,
    rootDirectory,
    rootImages,
    bootArtifacts,
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

function resolveImage(config, paths) {
  const name = getSingleValue(config, "Image", "Name");
  validateToken(name, "Image.Name");
  const outputPath = validateCanonicalPosixPath(getSingleValue(config, "Image", "Output"), {
    label: "Image.Output",
    root: paths.outputRoot,
    allowRoot: false,
  });
  const sectorSize = getInteger(config, "Image", "SectorSize");
  const alignmentBytes = getInteger(config, "Image", "AlignmentBytes");
  const firstUsableLBA = getInteger(config, "Image", "FirstUsableLBA");
  const sourceDateEpoch = getSingleValue(config, "Image", "SourceDateEpoch");
  const raucCompatible = getSingleValue(config, "Image", "RaucCompatible");
  const version = getSingleValue(config, "Image", "Version");

  if (sectorSize !== 512) {
    throw new ConfigValidationError(`Image.SectorSize expected 512, found ${sectorSize}`);
  }
  if (alignmentBytes !== 1048576) {
    throw new ConfigValidationError(`Image.AlignmentBytes expected 1048576, found ${alignmentBytes}`);
  }
  if (alignmentBytes % sectorSize !== 0) {
    throw new ConfigValidationError("Image.AlignmentBytes must be a multiple of Image.SectorSize");
  }
  if (firstUsableLBA !== 2048) {
    throw new ConfigValidationError(`Image.FirstUsableLBA expected 2048, found ${firstUsableLBA}`);
  }
  if (sourceDateEpoch !== DEFAULT_SOURCE_DATE_EPOCH) {
    throw new ConfigValidationError(`Image.SourceDateEpoch expected ${DEFAULT_SOURCE_DATE_EPOCH}, found ${sourceDateEpoch}`);
  }
  if (raucCompatible !== DEFAULT_RAUC_COMPATIBLE) {
    throw new ConfigValidationError(`Image.RaucCompatible expected ${DEFAULT_RAUC_COMPATIBLE}, found ${raucCompatible}`);
  }
  validateToken(version, "Image.Version");

  return {
    name,
    outputPath,
    sectorSize,
    alignmentBytes,
    firstUsableLBA,
    firstUsableByte: firstUsableLBA * sectorSize,
    imageSizeBytes: 0,
    sourceDateEpoch,
    raucCompatible,
    version,
  };
}

function resolvePartitions(config, image) {
  let nextStartByte = image.firstUsableByte;
  const partitions = [];
  const seenNumbers = new Set();
  const seenIds = new Set();
  const seenNames = new Set();
  const seenLabels = new Set();
  const seenPartitionGuids = new Set();

  for (let index = 0; index < PARTITION_SECTIONS.length; index += 1) {
    const sectionName = PARTITION_SECTIONS[index];
    const expectedNumber = index + 1;
    const number = getInteger(config, sectionName, "Number");
    const id = getSingleValue(config, sectionName, "Id");
    const name = getSingleValue(config, sectionName, "Name");
    const label = getSingleValue(config, sectionName, "Label");
    const role = getSingleValue(config, sectionName, "Role");
    const filesystem = getSingleValue(config, sectionName, "Filesystem");
    const sizeBytes = getInteger(config, sectionName, "SizeBytes");
    const typeGuid = validateGuid(getSingleValue(config, sectionName, "TypeGuid"), `${sectionName}.TypeGuid`);
    const partitionGuid = validateGuid(getSingleValue(config, sectionName, "PartitionGuid"), `${sectionName}.PartitionGuid`);

    if (number !== expectedNumber) {
      throw new ConfigValidationError(`${sectionName}.Number expected ${expectedNumber}, found ${number}`);
    }
    validatePartitionId(id, `${sectionName}.Id`);
    validatePartitionName(name, `${sectionName}.Name`);
    validatePartitionLabel(label, `${sectionName}.Label`);
    validateRole(role, `${sectionName}.Role`);
    validateFilesystem(filesystem, `${sectionName}.Filesystem`);
    if (sizeBytes <= 0 || sizeBytes % image.alignmentBytes !== 0 || sizeBytes % image.sectorSize !== 0) {
      throw new ConfigValidationError(`${sectionName}.SizeBytes must be positive and aligned`);
    }
    assertUnique(seenNumbers, number, `${sectionName}.Number`);
    assertUnique(seenIds, id, `${sectionName}.Id`);
    assertUnique(seenNames, name, `${sectionName}.Name`);
    assertUnique(seenLabels, label, `${sectionName}.Label`);
    assertUnique(seenPartitionGuids, partitionGuid, `${sectionName}.PartitionGuid`);

    const startByte = nextStartByte;
    const endExclusiveByte = startByte + sizeBytes;
    const startLBA = startByte / image.sectorSize;
    const sizeSectors = sizeBytes / image.sectorSize;
    const endLBA = startLBA + sizeSectors - 1;

    partitions.push({
      number,
      id,
      name,
      label,
      role,
      filesystem,
      sizeBytes,
      typeGuid,
      partitionGuid,
      startByte,
      endExclusiveByte,
      startLBA,
      endLBA,
      device: `/dev/disk/by-partuuid/${partitionGuid}`,
      byPartLabel: `/dev/disk/by-partlabel/${name}`,
    });
    nextStartByte = endExclusiveByte;
  }

  image.imageSizeBytes = nextStartByte + image.alignmentBytes;
  return partitions;
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

  validateToken(name, "RootDirectory.Name");
  if (contract !== "P1-011") {
    throw new ConfigValidationError(`RootDirectory.Contract expected P1-011, found ${contract}`);
  }
  if (outputName !== ROOT_DIRECTORY_OUTPUT_NAME) {
    throw new ConfigValidationError(`RootDirectory.OutputName expected ${ROOT_DIRECTORY_OUTPUT_NAME}, found ${outputName}`);
  }
  if (format !== "directory") {
    throw new ConfigValidationError(`RootDirectory.Format expected directory, found ${format}`);
  }
  if (path.endsWith(".img")) {
    throw new ConfigValidationError("RootDirectory.Path must reference P1-011's directory output, not a .img");
  }

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

function resolveRootImages(config, paths, rootDirectory, partitionById) {
  const rootImages = [];
  const seenNames = new Set();
  const seenPaths = new Set();

  for (const sectionName of ROOT_IMAGE_SECTIONS) {
    const name = getSingleValue(config, sectionName, "Name");
    const slot = getSingleValue(config, sectionName, "Slot");
    const partition = getSingleValue(config, sectionName, "Partition");
    const sourceDirectory = getSingleValue(config, sectionName, "SourceDirectory");
    const path = validateCanonicalPosixPath(getSingleValue(config, sectionName, "Path"), {
      label: `${sectionName}.Path`,
      root: paths.externalRoot,
      allowRoot: false,
    });
    const pin = parseDigestPin(getSingleValue(config, sectionName, "Digest"), `${sectionName}.Digest`);
    const partitionPlan = requireMapEntry(partitionById, partition, `${sectionName}.Partition`);

    validateToken(name, `${sectionName}.Name`);
    validatePartitionId(slot, `${sectionName}.Slot`);
    if (sourceDirectory !== rootDirectory.name) {
      throw new ConfigValidationError(`${sectionName}.SourceDirectory must be ${rootDirectory.name}`);
    }
    if (partitionPlan.role !== "rootfs" && partitionPlan.role !== "recovery") {
      throw new ConfigValidationError(`${sectionName}.Partition must reference a root or recovery partition`);
    }
    if (slot !== partition) {
      throw new ConfigValidationError(`${sectionName}.Slot must match its partition id`);
    }
    assertUnique(seenNames, name, `${sectionName}.Name`);
    assertUnique(seenPaths, path, `${sectionName}.Path`);

    rootImages.push({
      name,
      kind: "root-partition-image",
      source: "external-precondition",
      conversionFrom: rootDirectory.name,
      slot,
      partition,
      rootLabel: partitionPlan.label,
      path,
      mountRoot: paths.externalRoot,
      pin,
    });
  }

  return rootImages;
}

function resolveBootArtifacts(config, paths, partitionById) {
  const bootArtifacts = [];
  const seenNames = new Set();
  const seenPaths = new Set();
  const seenEspPaths = new Set();

  for (const sectionName of BOOT_SECTIONS) {
    const name = getSingleValue(config, sectionName, "Name");
    const contract = getSingleValue(config, sectionName, "Contract");
    const slot = getSingleValue(config, sectionName, "Slot");
    const partition = getSingleValue(config, sectionName, "Partition");
    const path = validateCanonicalPosixPath(getSingleValue(config, sectionName, "Path"), {
      label: `${sectionName}.Path`,
      root: paths.externalRoot,
      allowRoot: false,
    });
    const espPath = validateCanonicalPosixPath(getSingleValue(config, sectionName, "EspPath"), {
      label: `${sectionName}.EspPath`,
      root: "/",
      allowRoot: false,
    });
    const cmdline = getSingleValue(config, sectionName, "Cmdline");
    const pin = parseDigestPin(getSingleValue(config, sectionName, "Digest"), `${sectionName}.Digest`);
    const partitionPlan = requireMapEntry(partitionById, partition, `${sectionName}.Partition`);

    validateToken(name, `${sectionName}.Name`);
    validatePartitionId(slot, `${sectionName}.Slot`);
    if (contract !== "P1-012") {
      throw new ConfigValidationError(`${sectionName}.Contract expected P1-012, found ${contract}`);
    }
    if (slot !== partition) {
      throw new ConfigValidationError(`${sectionName}.Slot must match its partition id`);
    }
    if (partitionPlan.role !== "rootfs" && partitionPlan.role !== "recovery") {
      throw new ConfigValidationError(`${sectionName}.Partition must reference a root or recovery partition`);
    }
    if (!espPath.startsWith("/EFI/vita/")) {
      throw new ConfigValidationError(`${sectionName}.EspPath must stay under /EFI/vita`);
    }
    validateSlotCmdline(cmdline, partitionPlan.label, `${sectionName}.Cmdline`);
    assertUnique(seenNames, name, `${sectionName}.Name`);
    assertUnique(seenPaths, path, `${sectionName}.Path`);
    assertUnique(seenEspPaths, espPath, `${sectionName}.EspPath`);

    bootArtifacts.push({
      name,
      kind: "uki",
      source: "external-precondition",
      contract,
      planner: "planUKI",
      parameterizedBySlot: true,
      slot,
      partition,
      rootLabel: partitionPlan.label,
      path,
      espPath,
      cmdline,
      mountRoot: paths.externalRoot,
      pin,
    });
  }

  return bootArtifacts;
}

function resolveSlots(config, partitionById, rootImageByName, bootArtifactByName) {
  const slots = [];
  const seenNames = new Set();
  const seenPartitions = new Set();

  for (const sectionName of SLOT_SECTIONS) {
    const name = getSingleValue(config, sectionName, "Name");
    const slotClass = getSingleValue(config, sectionName, "Class");
    const index = getInteger(config, sectionName, "Index");
    const bootName = getSingleValue(config, sectionName, "BootName");
    const partition = getSingleValue(config, sectionName, "Partition");
    const rootImageName = getSingleValue(config, sectionName, "RootImage");
    const bootArtifactName = getSingleValue(config, sectionName, "BootArtifact");

    validateSlotName(name, `${sectionName}.Name`);
    validateSlotClass(slotClass, `${sectionName}.Class`);
    validateToken(bootName, `${sectionName}.BootName`);
    const partitionPlan = requireMapEntry(partitionById, partition, `${sectionName}.Partition`);
    const rootImage = requireMapEntry(rootImageByName, rootImageName, `${sectionName}.RootImage`);
    const bootArtifact = requireMapEntry(bootArtifactByName, bootArtifactName, `${sectionName}.BootArtifact`);

    if (name !== `${slotClass}.${index}`) {
      throw new ConfigValidationError(`${sectionName}.Name must match Class.Index`);
    }
    if (slotClass === "rootfs" && partitionPlan.role !== "rootfs") {
      throw new ConfigValidationError(`${sectionName}.Partition must reference a rootfs partition`);
    }
    if (slotClass === "recovery" && partitionPlan.role !== "recovery") {
      throw new ConfigValidationError(`${sectionName}.Partition must reference the recovery partition`);
    }
    if (rootImage.partition !== partitionPlan.id) {
      throw new ConfigValidationError(`${sectionName}.RootImage must target ${partitionPlan.id}`);
    }
    if (bootArtifact.partition !== partitionPlan.id) {
      throw new ConfigValidationError(`${sectionName}.BootArtifact must target ${partitionPlan.id}`);
    }
    assertUnique(seenNames, name, `${sectionName}.Name`);
    assertUnique(seenPartitions, partitionPlan.id, `${sectionName}.Partition`);

    slots.push({
      name,
      class: slotClass,
      index,
      bootName,
      partitionId: partitionPlan.id,
      partitionGuid: partitionPlan.partitionGuid,
      device: partitionPlan.device,
      byPartLabel: partitionPlan.byPartLabel,
      rootLabel: partitionPlan.label,
      rootImageInput: rootImage.name,
      rootImagePath: rootImage.path,
      bootArtifactInput: bootArtifact.name,
      bootArtifactPath: bootArtifact.path,
      bootEspPath: bootArtifact.espPath,
      bootCmdline: bootArtifact.cmdline,
    });
  }

  return slots;
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
      name: "external-image-inputs",
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
      name: "image-output",
      hostPath: mountRoots.outputHostPath,
      containerPath: paths.outputRoot,
      readOnly: false,
    },
  ];
}

function buildRaucManifestText(resolvedConfig) {
  const lines = [
    "[update]",
    `compatible=${resolvedConfig.image.raucCompatible}`,
    `version=${resolvedConfig.image.version}`,
    "",
    "[bundle]",
    "format=plain",
    "",
  ];

  for (const slot of resolvedConfig.slots) {
    lines.push(
      `[slot.${slot.name}]`,
      `class=${slot.class}`,
      `device=${slot.device}`,
      `bootname=${slot.bootName}`,
      `root-label=${slot.rootLabel}`,
      `root-image=${slot.rootImageInput}`,
      `boot-artifact=${slot.bootArtifactInput}`,
      "",
    );
  }

  return `${lines.join("\n")}`;
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

function validateGuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a lowercase RFC 4122 GUID`);
  }
  return value;
}

function validateToken(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable token`);
  }
}

function validatePartitionId(value, label) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a lowercase partition id`);
  }
}

function validatePartitionName(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable GPT name`);
  }
}

function validatePartitionLabel(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable filesystem label`);
  }
}

function validateRole(value, label) {
  if (value !== "esp" && value !== "rootfs" && value !== "recovery" && value !== "data") {
    throw new ConfigValidationError(`${label} must be esp, rootfs, recovery, or data`);
  }
}

function validateFilesystem(value, label) {
  if (value !== "vfat" && value !== "ext4") {
    throw new ConfigValidationError(`${label} must be vfat or ext4`);
  }
}

function validateSlotName(value, label) {
  if (!/^(rootfs\.[0-9]+|recovery\.[0-9]+)$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a RAUC slot name`);
  }
}

function validateSlotClass(value, label) {
  if (value !== "rootfs" && value !== "recovery") {
    throw new ConfigValidationError(`${label} must be rootfs or recovery`);
  }
}

function validateSlotCmdline(cmdline, expectedRootLabel, label) {
  if (cmdline.length === 0 || /[\u0000-\u001F\u007F]/u.test(cmdline)) {
    throw new ConfigValidationError(`${label} must be non-empty and contain no control characters`);
  }
  const rootLabels = [];
  const tokens = cmdline.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith("root=LABEL=")) {
      rootLabels.push(token.slice("root=LABEL=".length));
    }
  }
  if (rootLabels.length !== 1 || rootLabels[0] !== expectedRootLabel) {
    throw new ConfigValidationError(`${label} must select root=LABEL=${expectedRootLabel}`);
  }
}

function assertExactSlotSet(slots) {
  const names = new Set(slots.map((slot) => slot.name));
  for (const expected of ["rootfs.0", "rootfs.1", "recovery.0"]) {
    if (!names.has(expected)) {
      throw new ConfigValidationError(`RAUC slot map missing ${expected}`);
    }
  }
  if (names.size !== 3) {
    throw new ConfigValidationError("RAUC slot map must contain exactly rootfs.0, rootfs.1, and recovery.0");
  }
}

function assertUniqueBootArtifacts(bootArtifacts) {
  const rootLabels = new Set();
  for (const artifact of bootArtifacts) {
    assertUnique(rootLabels, artifact.rootLabel, `${artifact.name}.rootLabel`);
  }
}

function assertNoOverlaps(partitions) {
  for (let outerIndex = 0; outerIndex < partitions.length; outerIndex += 1) {
    const outer = partitions[outerIndex];
    for (let innerIndex = outerIndex + 1; innerIndex < partitions.length; innerIndex += 1) {
      const inner = partitions[innerIndex];
      if (outer.startByte < inner.endExclusiveByte && inner.startByte < outer.endExclusiveByte) {
        throw new ConfigValidationError(`${outer.id} overlaps ${inner.id}`);
      }
    }
  }
}

function preconditionStatus(entries) {
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

function indexBy(entries, key, label) {
  const map = new Map();
  for (const entry of entries) {
    const value = entry[key];
    if (map.has(value)) {
      throw new ConfigValidationError(`${label} has duplicate ${key} ${value}`);
    }
    map.set(value, entry);
  }
  return map;
}

function requireMapEntry(map, key, label) {
  const value = map.get(key);
  if (value === undefined) {
    throw new ConfigValidationError(`${label} references unknown value ${key}`);
  }
  return value;
}

function assertUnique(set, value, label) {
  if (set.has(value)) {
    throw new ConfigValidationError(`${label} must be unique`);
  }
  set.add(value);
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

function readImageLayoutInput(repoRoot) {
  return {
    configText: readFileSync(join(repoRoot, IMAGE_CONFIG_PATH), "utf8"),
    mountRoots: DEFAULT_IMAGE_LAYOUT_INPUT.mountRoots,
  };
}

function printUsage() {
  console.error("usage: node os/x86_64/image-layout.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = dirname(dirname(dirname(scriptPath)));
    process.stdout.write(serializeImageLayoutPlan(planImageLayout(readImageLayoutInput(repoRoot))));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

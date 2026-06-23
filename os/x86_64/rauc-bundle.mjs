#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeNormalize } from "../../sdk/typescript/src/safe-normalize.ts";

export const DEFAULT_RAUC_BUNDLE_COMPATIBLE = "vita-x86_64";
export const DEFAULT_RAUC_BUNDLE_VERSION = "0.1-bootstrap";
export const DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH = "1781308800";
export const DEFAULT_RAUC_BUNDLE_CONFIG_TEXT = `# Vita x86_64 deterministic RAUC A/B rootfs bundle plan.
# The bundle command is unsigned; owner RAUC signing is declared separately for step 4c.

[Paths]
WorkRoot=/work
ExternalRoot=/external
PlanRoot=/plan
OutputRoot=/out
BundleInput=/plan/rauc-input
Config=/work/os/x86_64/rauc-bundle.conf

[Update]
Compatible=vita-x86_64
Version=0.1-bootstrap

[Bundle]
Executable=rauc
Command=bundle
NoSign=true
InputDirectory=/plan/rauc-input
Manifest=/plan/rauc-input/manifest.raucm
Output=/out/vita-0.1-bootstrap.raucx
SourceDateEpoch=1781308800
Network=none

[ImageRootfs]
SlotClass=rootfs
Filename=vita-x86_64-rootfs.verity.ext4
Path=/external/p1-028/vita-x86_64-rootfs.verity.ext4
Digest=unresolved
RootHash=unresolved

[SlotRootA]
Name=rootfs.0
Slot=root-a
Partition=root-a
RootLabel=vita-root-a

[SlotRootB]
Name=rootfs.1
Slot=root-b
Partition=root-b
RootLabel=vita-root-b

[Signing]
Mode=owner-rauc-key-step-4c
Step=declare-only
MaterialInRepo=false
ProductionSigning=owner-only-out-of-band
`;

const DEFAULT_RAUC_BUNDLE_PLAN_INPUT = Object.freeze({
  configText: DEFAULT_RAUC_BUNDLE_CONFIG_TEXT,
  mountRoots: Object.freeze({
    workspaceHostPath: "/repo",
    externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
    planInputsHostPath: "/repo/os/x86_64/generated-inputs",
    outputHostPath: "/repo/os/x86_64/out",
  }),
});

const RAUC_BUNDLE_CONFIG_PATH = "os/x86_64/rauc-bundle.conf";
const RAUC_MANIFEST_SHA256_PLACEHOLDER = "${image.rootfs.sha256}";
const SLOT_SECTIONS = Object.freeze([
  Object.freeze({
    sectionName: "SlotRootA",
    name: "rootfs.0",
    slot: "root-a",
    partition: "root-a",
    rootLabel: "vita-root-a",
  }),
  Object.freeze({
    sectionName: "SlotRootB",
    name: "rootfs.1",
    slot: "root-b",
    partition: "root-b",
    rootLabel: "vita-root-b",
  }),
]);

class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function planRaucBundle(input = DEFAULT_RAUC_BUNDLE_PLAN_INPUT) {
  const normalizedInput = normalizeRaucBundlePlanInput(input);
  if (!normalizedInput.ok) {
    throw new TypeError(normalizedInput.error);
  }

  const config = parseKeyValueConfig(normalizedInput.value.configText, RAUC_BUNDLE_CONFIG_PATH);
  const resolvedConfig = resolveRaucBundleConfig(config);
  const configDigest = sha256Text(normalizedInput.value.configText);
  const manifestText = buildRaucManifestText(resolvedConfig);
  const manifestDigest = sha256Text(manifestText);
  const mounts = buildMounts(normalizedInput.value.mountRoots, resolvedConfig.paths);
  const command = buildRaucBundleCommand(resolvedConfig);
  const bundleBlockedBy = blockedByForBundle(resolvedConfig.rootfsImage);
  const bundleStatus = bundleBlockedBy.length === 0 ? "ready" : "blocked";

  return {
    schemaVersion: 1,
    target: "x86_64",
    deterministic: true,
    network: "none",
    config: {
      path: RAUC_BUNDLE_CONFIG_PATH,
      containerPath: resolvedConfig.paths.configPath,
      digest: configDigest,
    },
    mounts,
    tool: {
      executable: resolvedConfig.bundle.executable,
      command: resolvedConfig.bundle.command,
      noSign: resolvedConfig.bundle.noSign,
      network: "none",
    },
    environment: {
      SOURCE_DATE_EPOCH: resolvedConfig.bundle.sourceDateEpoch,
      TZ: "UTC",
      LC_ALL: "C.UTF-8",
    },
    update: {
      compatible: resolvedConfig.update.compatible,
      version: resolvedConfig.update.version,
    },
    inputs: {
      external: [resolvedConfig.rootfsImage],
      produced: [
        {
          name: "manifest.raucm",
          kind: "deterministic-text",
          containerPath: resolvedConfig.bundle.manifestPath,
          digest: manifestDigest,
          text: manifestText,
        },
        {
          name: "rootfs-image-content-file",
          kind: "staged-external-artifact",
          source: resolvedConfig.rootfsImage.name,
          containerPath: resolvedConfig.rootfsImage.bundlePath,
        },
      ],
    },
    outputs: {
      bundle: {
        name: `vita-${resolvedConfig.update.version}.raucx`,
        kind: "rauc-bundle",
        format: "plain",
        signed: false,
        path: resolvedConfig.bundle.outputPath,
      },
    },
    slots: {
      compatible: resolvedConfig.update.compatible,
      targetClass: resolvedConfig.rootfsImage.slotClass,
      installPolicy: "rauc-selects-inactive-rootfs-slot",
      map: resolvedConfig.slots,
    },
    manifest: {
      path: resolvedConfig.bundle.manifestPath,
      filename: "manifest.raucm",
      digest: manifestDigest,
      text: manifestText,
      update: {
        compatible: resolvedConfig.update.compatible,
        version: resolvedConfig.update.version,
      },
      images: [
        {
          section: "image.rootfs",
          slotClass: resolvedConfig.rootfsImage.slotClass,
          filename: resolvedConfig.rootfsImage.filename,
          sourceImage: resolvedConfig.rootfsImage.name,
          sha256: manifestSha256(resolvedConfig.rootfsImage.pin),
        },
      ],
    },
    preconditions: [
      {
        id: "verify-verity-rootfs-image",
        kind: "digest-verification",
        status: preconditionStatusForDigestPin(resolvedConfig.rootfsImage.pin),
        network: "none",
        verifies: [
          {
            name: resolvedConfig.rootfsImage.name,
            path: resolvedConfig.rootfsImage.path,
            pin: resolvedConfig.rootfsImage.pin,
          },
        ],
        blocks: ["stage-rauc-bundle-input", "create-unsigned-rauc-bundle"],
      },
      {
        id: "capture-verity-root-hash",
        kind: "external-precondition-step",
        status: preconditionStatusForRootHash(resolvedConfig.rootfsImage.rootHash),
        network: "none",
        executable: false,
        upstreamPrivileged: true,
        rootHash: resolvedConfig.rootfsImage.rootHash,
        blocks: ["stage-rauc-bundle-input", "create-unsigned-rauc-bundle"],
      },
      {
        id: "stage-rauc-bundle-input",
        kind: "rauc-bundle-input-stage-plan",
        status: bundleStatus,
        network: "none",
        executable: false,
        gatedBy: ["verify-verity-rootfs-image", "capture-verity-root-hash"],
        blockedBy: bundleBlockedBy.length === 0 ? ["stage-rauc-bundle-input:pending-runtime-verification"] : bundleBlockedBy,
        manifest: resolvedConfig.bundle.manifestPath,
        image: {
          from: resolvedConfig.rootfsImage.path,
          to: resolvedConfig.rootfsImage.bundlePath,
        },
        outputs: [resolvedConfig.bundle.manifestPath, resolvedConfig.rootfsImage.bundlePath],
        blocks: ["create-unsigned-rauc-bundle"],
      },
    ],
    steps: [
      {
        id: "create-unsigned-rauc-bundle",
        kind: "rauc-bundle-command-plan",
        status: bundleStatus,
        executable: false,
        gatedBy: ["stage-rauc-bundle-input"],
        blockedBy: bundleBlockedBy.length === 0 ? ["create-unsigned-rauc-bundle:pending-runtime-verification"] : bundleBlockedBy,
        input: resolvedConfig.bundle.inputDirectory,
        output: resolvedConfig.bundle.outputPath,
        command,
      },
      {
        id: "declare-owner-rauc-signing",
        kind: "owner-rauc-signing-declaration",
        status: "declared-non-executable",
        executable: false,
        gatedBy: ["create-unsigned-rauc-bundle"],
        input: resolvedConfig.bundle.outputPath,
        output: resolvedConfig.bundle.outputPath,
      },
    ],
    command,
    signing: {
      mode: resolvedConfig.signing.mode,
      step: resolvedConfig.signing.step,
      executable: false,
      materialInRepo: false,
      bundleInput: resolvedConfig.bundle.outputPath,
      productionSigning: {
        included: false,
        ownerOnly: true,
        disposition: resolvedConfig.signing.productionSigning,
      },
    },
  };
}

export function serializeRaucBundlePlan(plan) {
  return `${stableStringify(plan)}\n`;
}

function normalizeRaucBundlePlanInput(input) {
  const normalized = safeNormalize(input, { maxDepth: 64, maxNodes: 10_000 });
  if (!normalized.ok) {
    return { ok: false, error: `RAUC bundle plan input normalization failed: ${normalized.reason}` };
  }
  if (!isPlainRecord(normalized.value)) {
    return { ok: false, error: "RAUC bundle plan input must be a plain object" };
  }

  const allowedKeys = new Set(["configText", "mountRoots"]);
  for (const key of Object.keys(normalized.value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `RAUC bundle plan input has unsupported field ${key}` };
    }
  }
  if (!Object.hasOwn(normalized.value, "configText")) {
    return { ok: false, error: "RAUC bundle plan input missing required field configText" };
  }
  if (!Object.hasOwn(normalized.value, "mountRoots")) {
    return { ok: false, error: "RAUC bundle plan input missing required field mountRoots" };
  }

  const configText = normalized.value.configText;
  if (typeof configText !== "string" || configText.length === 0) {
    return { ok: false, error: "RAUC bundle plan input field configText must be a non-empty string" };
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
    return { ok: false, error: "RAUC bundle mount roots must be a plain object" };
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
      return { ok: false, error: `RAUC bundle mount roots has unsupported field ${key}` };
    }
  }

  const rawValues = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      return { ok: false, error: `RAUC bundle mount roots missing required field ${key}` };
    }
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `RAUC bundle mount roots field ${key} must be a non-empty string` };
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
    if (/^\s/u.test(rawLine)) {
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

function resolveRaucBundleConfig(config) {
  assertAllowedSettings(config, {
    Paths: ["WorkRoot", "ExternalRoot", "PlanRoot", "OutputRoot", "BundleInput", "Config"],
    Update: ["Compatible", "Version"],
    Bundle: [
      "Executable",
      "Command",
      "NoSign",
      "InputDirectory",
      "Manifest",
      "Output",
      "SourceDateEpoch",
      "Network",
    ],
    ImageRootfs: ["SlotClass", "Filename", "Path", "Digest", "RootHash"],
    SlotRootA: ["Name", "Slot", "Partition", "RootLabel"],
    SlotRootB: ["Name", "Slot", "Partition", "RootLabel"],
    Signing: ["Mode", "Step", "MaterialInRepo", "ProductionSigning"],
  });

  const paths = resolvePaths(config);
  const update = resolveUpdate(config);
  const bundle = resolveBundle(config, paths, update);
  const rootfsImage = resolveRootfsImage(config, paths, bundle);
  const slots = SLOT_SECTIONS.map((expected) => resolveSlot(config, expected));
  assertUniqueSlots(slots);
  const signing = resolveSigning(config);

  return {
    paths,
    update,
    bundle,
    rootfsImage,
    slots,
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
  const bundleInput = validateCanonicalPosixPath(getSingleValue(config, "Paths", "BundleInput"), {
    label: "Paths.BundleInput",
    root: planRoot,
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
    bundleInput,
    configPath,
  };
}

function resolveUpdate(config) {
  const compatible = getSingleValue(config, "Update", "Compatible");
  if (compatible !== DEFAULT_RAUC_BUNDLE_COMPATIBLE) {
    throw new ConfigValidationError(`Update.Compatible expected ${DEFAULT_RAUC_BUNDLE_COMPATIBLE}, found ${compatible}`);
  }

  const version = getSingleValue(config, "Update", "Version");
  if (version !== DEFAULT_RAUC_BUNDLE_VERSION) {
    throw new ConfigValidationError(`Update.Version expected ${DEFAULT_RAUC_BUNDLE_VERSION}, found ${version}`);
  }
  validateVersionToken(version, "Update.Version");

  return {
    compatible,
    version,
  };
}

function resolveBundle(config, paths, update) {
  const executable = getSingleValue(config, "Bundle", "Executable");
  if (executable !== "rauc") {
    throw new ConfigValidationError(`Bundle.Executable expected rauc, found ${executable}`);
  }

  const command = getSingleValue(config, "Bundle", "Command");
  if (command !== "bundle") {
    throw new ConfigValidationError(`Bundle.Command expected bundle, found ${command}`);
  }

  const noSign = getBoolean(config, "Bundle", "NoSign");
  if (noSign !== true) {
    throw new ConfigValidationError("Bundle.NoSign must be true; owner signing is declared separately");
  }

  const inputDirectory = validateCanonicalPosixPath(getSingleValue(config, "Bundle", "InputDirectory"), {
    label: "Bundle.InputDirectory",
    root: paths.planRoot,
    allowRoot: false,
  });
  if (inputDirectory !== paths.bundleInput) {
    throw new ConfigValidationError(`Bundle.InputDirectory expected ${paths.bundleInput}, found ${inputDirectory}`);
  }

  const manifestPath = validateCanonicalPosixPath(getSingleValue(config, "Bundle", "Manifest"), {
    label: "Bundle.Manifest",
    root: inputDirectory,
    allowRoot: false,
  });
  if (manifestPath !== `${inputDirectory}/manifest.raucm`) {
    throw new ConfigValidationError(`Bundle.Manifest expected ${inputDirectory}/manifest.raucm, found ${manifestPath}`);
  }

  const outputPath = validateCanonicalPosixPath(getSingleValue(config, "Bundle", "Output"), {
    label: "Bundle.Output",
    root: paths.outputRoot,
    allowRoot: false,
  });
  const expectedOutput = `${paths.outputRoot}/vita-${update.version}.raucx`;
  if (outputPath !== expectedOutput) {
    throw new ConfigValidationError(`Bundle.Output expected ${expectedOutput}, found ${outputPath}`);
  }

  const sourceDateEpoch = getSingleValue(config, "Bundle", "SourceDateEpoch");
  if (sourceDateEpoch !== DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH) {
    throw new ConfigValidationError(`Bundle.SourceDateEpoch expected ${DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH}, found ${sourceDateEpoch}`);
  }

  const network = getSingleValue(config, "Bundle", "Network");
  if (network !== "none") {
    throw new ConfigValidationError(`Bundle.Network expected none, found ${network}`);
  }

  return {
    executable,
    command,
    noSign,
    inputDirectory,
    manifestPath,
    outputPath,
    sourceDateEpoch,
    network,
  };
}

function resolveRootfsImage(config, paths, bundle) {
  const slotClass = getSingleValue(config, "ImageRootfs", "SlotClass");
  if (slotClass !== "rootfs") {
    throw new ConfigValidationError(`ImageRootfs.SlotClass expected rootfs, found ${slotClass}`);
  }

  const filename = getSingleValue(config, "ImageRootfs", "Filename");
  validateBundleFilename(filename, "ImageRootfs.Filename");
  if (filename !== "vita-x86_64-rootfs.verity.ext4") {
    throw new ConfigValidationError(`ImageRootfs.Filename expected vita-x86_64-rootfs.verity.ext4, found ${filename}`);
  }

  const path = validateCanonicalPosixPath(getSingleValue(config, "ImageRootfs", "Path"), {
    label: "ImageRootfs.Path",
    root: paths.externalRoot,
    allowRoot: false,
  });
  if (path !== "/external/p1-028/vita-x86_64-rootfs.verity.ext4") {
    throw new ConfigValidationError(`ImageRootfs.Path expected /external/p1-028/vita-x86_64-rootfs.verity.ext4, found ${path}`);
  }

  const pin = parseDigestPin(getSingleValue(config, "ImageRootfs", "Digest"), "ImageRootfs.Digest");
  const rootHash = parseRootHashPin(getSingleValue(config, "ImageRootfs", "RootHash"), "ImageRootfs.RootHash");

  return {
    name: "verity-rootfs-image",
    kind: "verity-root-image",
    source: "external-precondition",
    contract: "P1-028",
    slotClass,
    filename,
    path,
    bundlePath: `${bundle.inputDirectory}/${filename}`,
    mountRoot: paths.externalRoot,
    pin,
    rootHash,
  };
}

function resolveSlot(config, expected) {
  const sectionName = expected.sectionName;
  const name = getSingleValue(config, sectionName, "Name");
  const slot = getSingleValue(config, sectionName, "Slot");
  const partition = getSingleValue(config, sectionName, "Partition");
  const rootLabel = getSingleValue(config, sectionName, "RootLabel");

  assertExpected(name, expected.name, `${sectionName}.Name`);
  assertExpected(slot, expected.slot, `${sectionName}.Slot`);
  assertExpected(partition, expected.partition, `${sectionName}.Partition`);
  assertExpected(rootLabel, expected.rootLabel, `${sectionName}.RootLabel`);

  return {
    name,
    class: "rootfs",
    index: name === "rootfs.0" ? 0 : 1,
    slot,
    partition,
    rootLabel,
  };
}

function resolveSigning(config) {
  const mode = getSingleValue(config, "Signing", "Mode");
  if (mode !== "owner-rauc-key-step-4c") {
    throw new ConfigValidationError(`Signing.Mode expected owner-rauc-key-step-4c, found ${mode}`);
  }

  const step = getSingleValue(config, "Signing", "Step");
  if (step !== "declare-only") {
    throw new ConfigValidationError(`Signing.Step expected declare-only, found ${step}`);
  }

  const materialInRepo = getBoolean(config, "Signing", "MaterialInRepo");
  if (materialInRepo !== false) {
    throw new ConfigValidationError("Signing.MaterialInRepo must be false");
  }

  const productionSigning = getSingleValue(config, "Signing", "ProductionSigning");
  if (productionSigning !== "owner-only-out-of-band") {
    throw new ConfigValidationError("Signing.ProductionSigning must declare owner-only-out-of-band");
  }

  return {
    mode,
    step,
    materialInRepo,
    productionSigning,
  };
}

function buildRaucManifestText(resolvedConfig) {
  const sha256 = manifestSha256(resolvedConfig.rootfsImage.pin);
  return [
    "[update]",
    `compatible=${resolvedConfig.update.compatible}`,
    `version=${resolvedConfig.update.version}`,
    "",
    "[image.rootfs]",
    `filename=${resolvedConfig.rootfsImage.filename}`,
    `sha256=${sha256.value}`,
    "",
  ].join("\n");
}

function buildRaucBundleCommand(resolvedConfig) {
  const args = [
    resolvedConfig.bundle.command,
    "--no-sign",
    resolvedConfig.bundle.inputDirectory,
    resolvedConfig.bundle.outputPath,
  ];

  return {
    executable: resolvedConfig.bundle.executable,
    args,
    inputDirectory: resolvedConfig.bundle.inputDirectory,
    manifest: resolvedConfig.bundle.manifestPath,
    output: resolvedConfig.bundle.outputPath,
    unsigned: true,
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
      name: "external-rauc-inputs",
      hostPath: mountRoots.externalInputsHostPath,
      containerPath: paths.externalRoot,
      readOnly: true,
    },
    {
      name: "produced-plan-inputs",
      hostPath: mountRoots.planInputsHostPath,
      containerPath: paths.planRoot,
      readOnly: false,
    },
    {
      name: "rauc-output",
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

function validateBundleFilename(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable relative filename`);
  }
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new ConfigValidationError(`${label} must not contain path separators or traversal`);
  }
}

function validateVersionToken(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new ConfigValidationError(`${label} must be a stable version token`);
  }
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) {
    throw new ConfigValidationError(`${label} expected ${expected}, found ${actual}`);
  }
}

function assertUniqueSlots(slots) {
  const names = new Set();
  const slotsById = new Set();
  const partitions = new Set();
  for (const slot of slots) {
    assertUnique(names, slot.name, `${slot.name}.name`);
    assertUnique(slotsById, slot.slot, `${slot.name}.slot`);
    assertUnique(partitions, slot.partition, `${slot.name}.partition`);
  }
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

function manifestSha256(pin) {
  if (!pin.resolved) {
    return {
      source: "external-precondition",
      resolved: false,
      placeholder: RAUC_MANIFEST_SHA256_PLACEHOLDER,
      value: RAUC_MANIFEST_SHA256_PLACEHOLDER,
      pin,
    };
  }

  const hex = pin.digest.slice("sha256:".length);
  return {
    source: "external-precondition",
    resolved: true,
    digest: pin.digest,
    value: hex,
    pin,
  };
}

function preconditionStatusForDigestPin(pin) {
  return pin.resolved ? "pending-runtime-verification" : "blocked-unresolved-digest";
}

function preconditionStatusForRootHash(rootHash) {
  return rootHash.resolved ? "pending-runtime-verification" : "blocked-unresolved-root-hash";
}

function blockedByForBundle(rootfsImage) {
  const blockedBy = [];
  if (!rootfsImage.pin.resolved) {
    blockedBy.push(`verify-verity-rootfs-image:${rootfsImage.name}:unresolved-digest`);
  }
  if (!rootfsImage.rootHash.resolved) {
    blockedBy.push("capture-verity-root-hash:rootfs:unresolved-root-hash");
  }
  return blockedBy;
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

function readRaucBundleInput(repoRoot) {
  return {
    configText: readFileSync(join(repoRoot, RAUC_BUNDLE_CONFIG_PATH), "utf8"),
    mountRoots: DEFAULT_RAUC_BUNDLE_PLAN_INPUT.mountRoots,
  };
}

function printUsage() {
  console.error("usage: node --experimental-strip-types os/x86_64/rauc-bundle.mjs --print-plan");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--print-plan") {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = dirname(dirname(dirname(scriptPath)));
    process.stdout.write(serializeRaucBundlePlan(planRaucBundle(readRaucBundleInput(repoRoot))));
    return 0;
  }
  printUsage();
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type RootfsImagePlanInput = {
  readonly configText: string;
  readonly mountRoots: MountRoots;
};

type MountRoots = {
  readonly workspaceHostPath: string;
  readonly externalInputsHostPath: string;
  readonly planInputsHostPath: string;
  readonly outputHostPath: string;
};

type ResolvedDigestPin = {
  readonly algorithm: "sha256";
  readonly required: true;
  readonly resolved: true;
  readonly digest: `sha256:${string}`;
};

type UnresolvedDigestPin = {
  readonly algorithm: "sha256";
  readonly required: true;
  readonly resolved: false;
  readonly status: "unresolved";
};

type DigestPin = ResolvedDigestPin | UnresolvedDigestPin;

type SlotPartitionId = "root-a" | "root-b" | "recovery";
type RootImageName = "root-a-partition-image" | "root-b-partition-image" | "recovery-partition-image";

type RootDirectoryInput = {
  readonly name: "p1-011-root-directory";
  readonly kind: "root-directory";
  readonly source: "external-precondition";
  readonly contract: "P1-011";
  readonly outputName: "vita-debian-trixie-x86_64-root";
  readonly format: "directory";
  readonly path: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
};

type RootImageOutput = {
  readonly name: RootImageName;
  readonly kind: "root-partition-image";
  readonly source: "mkfs.ext4-output";
  readonly conversionFrom: "p1-011-root-directory";
  readonly slot: SlotPartitionId;
  readonly partition: SlotPartitionId;
  readonly rootLabel: string;
  readonly path: string;
  readonly mountRoot: string;
  readonly outputRoot: string;
  readonly filesystem: "ext4";
  readonly sizeBytes: number;
  readonly blockSize: 4096;
  readonly blockCount: number;
  readonly filesystemUuid: string;
  readonly hashSeed: string;
};

type MkfsCommand = {
  readonly executable: "mkfs.ext4";
  readonly args: readonly string[];
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly sourceDirectory: string;
  readonly output: string;
  readonly outputSizeBytes: number;
  readonly blockCount: number;
  readonly filesystemUuid: string;
  readonly hashSeed: string;
  readonly rootOwner: "0:0";
};

type RootfsImagePrecondition = {
  readonly id: "verify-p1-011-root-directory" | "convert-root-directory-to-ext4-images";
  readonly kind: string;
  readonly status: "blocked-unresolved-digest" | "pending-runtime-verification";
  readonly network: "none";
  readonly executable?: false;
  readonly upstreamPrivileged?: true;
  readonly gatedBy?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly verifies?: readonly {
    readonly name: string;
    readonly path: string;
    readonly pin: DigestPin;
  }[];
  readonly input?: string;
  readonly conversion?: "root-directory-to-ext4-image";
  readonly commandPlans?: readonly MkfsCommand[];
  readonly outputs?: readonly {
    readonly name: RootImageName;
    readonly path: string;
    readonly partition: SlotPartitionId;
    readonly slot: SlotPartitionId;
    readonly filesystemUuid: string;
    readonly hashSeed: string;
    readonly sizeBytes: number;
  }[];
  readonly blocks: readonly string[];
};

type RootfsImageStep = {
  readonly id:
    | "convert-root-a-rootfs-image"
    | "convert-root-b-rootfs-image"
    | "convert-recovery-rootfs-image";
  readonly kind: "mkfs-ext4-rootfs-image-plan";
  readonly status: "blocked";
  readonly executable: false;
  readonly upstreamPrivileged: true;
  readonly gatedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly input: string;
  readonly output: string;
  readonly command: MkfsCommand;
};

type RootfsImagePlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly config: {
    readonly path: "os/x86_64/rootfs-image.conf";
    readonly containerPath: string;
    readonly digest: `sha256:${string}`;
  };
  readonly mounts: readonly {
    readonly name: string;
    readonly hostPath: string;
    readonly containerPath: string;
    readonly readOnly: boolean;
  }[];
  readonly tool: {
    readonly executable: "mkfs.ext4";
    readonly filesystem: "ext4";
    readonly sourceMode: "directory";
    readonly outputFormat: "rootfs.ext4";
    readonly network: "none";
    readonly upstreamPrivileged: true;
  };
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly parameters: {
    readonly sourceDateEpoch: string;
    readonly blockSize: 4096;
    readonly inodeSize: 256;
    readonly bytesPerInode: 16384;
    readonly reservedBlockPercentage: 0;
    readonly rootOwner: "0:0";
    readonly features: readonly ["^has_journal"];
    readonly extendedOptions: readonly ["lazy_itable_init=0", "lazy_journal_init=0"];
    readonly journal: "disabled";
    readonly hashSeedPolicy: "fixed-per-image-uuid";
  };
  readonly inputs: {
    readonly external: readonly RootDirectoryInput[];
    readonly produced: readonly never[];
  };
  readonly outputs: {
    readonly rootImages: readonly RootImageOutput[];
  };
  readonly preconditions: readonly RootfsImagePrecondition[];
  readonly steps: readonly RootfsImageStep[];
  readonly commands: readonly MkfsCommand[];
};

type RootfsImageModule = {
  readonly planRootfsImage: (input?: unknown) => RootfsImagePlan;
  readonly serializeRootfsImagePlan: (plan: RootfsImagePlan) => string;
  readonly DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT: string;
  readonly DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH: string;
  readonly DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE: number;
  readonly DEFAULT_ROOTFS_IMAGE_INODE_SIZE: number;
  readonly DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE: number;
};

type ImageLayoutPlan = {
  readonly inputs: {
    readonly external: readonly {
      readonly kind: string;
      readonly name: string;
      readonly path: string;
    }[];
  };
};

type VerityPlan = {
  readonly slots: readonly {
    readonly dataImage: {
      readonly path: string;
    };
  }[];
};

const rootfsImageModuleUrl = new URL("../rootfs-image.mjs", import.meta.url);
const imageLayoutModuleUrl = new URL("../image-layout.mjs", import.meta.url);
const verityModuleUrl = new URL("../verity.mjs", import.meta.url);
const rootfsImageConfigUrl = new URL("../rootfs-image.conf", import.meta.url);
const imageConfigUrl = new URL("../image.conf", import.meta.url);
const verityConfigUrl = new URL("../verity.conf", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/upstream-inputs/p1-014/converted",
} as const satisfies MountRoots;

const downstreamMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

test("planRootfsImage is byte deterministic and matches the committed config text", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const input = await readPlanInput();
  const firstPlan = rootfsImage.planRootfsImage(input);
  const secondPlan = rootfsImage.planRootfsImage(input);
  const defaultPlan = rootfsImage.planRootfsImage();

  assert.equal(input.configText, rootfsImage.DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT);
  assert.equal(rootfsImage.serializeRootfsImagePlan(firstPlan), rootfsImage.serializeRootfsImagePlan(secondPlan));
  assert.equal(
    rootfsImage.serializeRootfsImagePlan(defaultPlan),
    rootfsImage.serializeRootfsImagePlan(rootfsImage.planRootfsImage(planInput(rootfsImage.DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT))),
  );
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.config.path, "os/x86_64/rootfs-image.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
});

test("ext4 mke2fs parameters, environment, and no-journal policy are pinned", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const plan = rootfsImage.planRootfsImage(await readPlanInput());

  assert.deepEqual(plan.parameters, {
    sourceDateEpoch: "1781308800",
    blockSize: 4096,
    inodeSize: 256,
    bytesPerInode: 16384,
    reservedBlockPercentage: 0,
    rootOwner: "0:0",
    features: ["^has_journal"],
    extendedOptions: ["lazy_itable_init=0", "lazy_journal_init=0"],
    journal: "disabled",
    hashSeedPolicy: "fixed-per-image-uuid",
  });
  assert.equal(plan.parameters.sourceDateEpoch, rootfsImage.DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH);
  assert.equal(plan.parameters.blockSize, rootfsImage.DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE);
  assert.equal(plan.parameters.inodeSize, rootfsImage.DEFAULT_ROOTFS_IMAGE_INODE_SIZE);
  assert.equal(plan.parameters.bytesPerInode, rootfsImage.DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE);
  assert.deepEqual(plan.environment, {
    SOURCE_DATE_EPOCH: "1781308800",
    TZ: "UTC",
    LC_ALL: "C.UTF-8",
  });
  assert.equal(plan.tool.executable, "mkfs.ext4");
  assert.equal(plan.tool.network, "none");
  assert.equal(plan.tool.upstreamPrivileged, true);
  assert.equal(plan.inputs.produced.length, 0);

  assert.equal(findMount(plan, "source-tree").readOnly, true);
  assert.equal(findMount(plan, "external-rootfs-inputs").containerPath, "/external");
  assert.equal(findMount(plan, "external-rootfs-inputs").readOnly, true);
  assert.equal(findMount(plan, "produced-plan-inputs").readOnly, true);
  assert.equal(findMount(plan, "converted-rootfs-output").containerPath, "/external/p1-014/converted");
  assert.equal(findMount(plan, "converted-rootfs-output").readOnly, false);
});

test("each slot emits a deterministic mkfs.ext4 -d command for the P1-011 root directory", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const plan = rootfsImage.planRootfsImage(await readPlanInput());
  const rootDirectory = findRootDirectory(plan);

  assert.equal(rootDirectory.source, "external-precondition");
  assert.equal(rootDirectory.contract, "P1-011");
  assert.equal(rootDirectory.outputName, "vita-debian-trixie-x86_64-root");
  assert.equal(rootDirectory.format, "directory");
  assert.equal(rootDirectory.path, "/external/p1-011/vita-debian-trixie-x86_64-root");

  assert.deepEqual(
    plan.outputs.rootImages.map((image) => [image.name, image.partition, image.rootLabel, image.path, image.sizeBytes]),
    [
      ["root-a-partition-image", "root-a", "vita-root-a", "/external/p1-014/converted/vita-root-a.rootfs.ext4", 4294967296],
      ["root-b-partition-image", "root-b", "vita-root-b", "/external/p1-014/converted/vita-root-b.rootfs.ext4", 4294967296],
      ["recovery-partition-image", "recovery", "vita-recovery", "/external/p1-014/converted/vita-recovery.rootfs.ext4", 2147483648],
    ],
  );

  for (const image of plan.outputs.rootImages) {
    const command = findCommand(plan, image.path);
    assert.equal(command.executable, "mkfs.ext4");
    assert.equal(command.sourceDirectory, rootDirectory.path);
    assert.equal(command.output, image.path);
    assert.equal(command.outputSizeBytes, image.sizeBytes);
    assert.equal(command.blockCount, image.blockCount);
    assert.equal(command.filesystemUuid, image.filesystemUuid);
    assert.equal(command.hashSeed, image.hashSeed);
    assert.equal(image.blockCount, image.sizeBytes / 4096);

    assert.deepEqual(command.args.slice(0, 2), ["-d", rootDirectory.path]);
    assert.equal(argValue(command.args, "-t"), "ext4");
    assert.equal(argValue(command.args, "-b"), "4096");
    assert.equal(argValue(command.args, "-I"), "256");
    assert.equal(argValue(command.args, "-i"), "16384");
    assert.equal(argValue(command.args, "-m"), "0");
    assert.equal(argValue(command.args, "-L"), image.rootLabel);
    assert.equal(argValue(command.args, "-U"), image.filesystemUuid);
    assert.equal(argValue(command.args, "-O"), "^has_journal");
    assert.match(argValue(command.args, "-E"), /(?:^|,)root_owner=0:0(?:,|$)/u);
    assert.match(argValue(command.args, "-E"), new RegExp(`(?:^|,)hash_seed=${image.hashSeed}(?:,|$)`, "u"));
    assert.match(argValue(command.args, "-E"), /(?:^|,)lazy_itable_init=0(?:,|$)/u);
    assert.match(argValue(command.args, "-E"), /(?:^|,)lazy_journal_init=0(?:,|$)/u);
    assert.equal(command.args.at(-2), image.path);
    assert.equal(command.args.at(-1), String(image.blockCount));
    assert.doesNotMatch(command.args.join(" "), /(?:^| )-j(?: |$)|has_journal(?!\b)|root=LABEL=/u);
    assert.deepEqual(command.environment, plan.environment);
  }

  assert.deepEqual(
    plan.steps.map((step) => [step.id, step.input, step.output, step.command.output]),
    plan.outputs.rootImages.map((image) => [
      `convert-${image.slot}-rootfs-image`,
      rootDirectory.path,
      image.path,
      image.path,
    ]),
  );
});

test("source rootfs remains an unresolved external precondition until P1-011 is pinned", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const configText = await readConfigText();
  const unresolvedPlan = rootfsImage.planRootfsImage(planInput(configText));
  const rootDirectory = findRootDirectory(unresolvedPlan);

  assertUnresolvedDigestPin(rootDirectory.pin);
  assert.equal(findPrecondition(unresolvedPlan, "verify-p1-011-root-directory").status, "blocked-unresolved-digest");
  assert.equal(findPrecondition(unresolvedPlan, "convert-root-directory-to-ext4-images").status, "blocked-unresolved-digest");
  assert.ok(
    findPrecondition(unresolvedPlan, "convert-root-directory-to-ext4-images").blockedBy?.includes(
      "verify-p1-011-root-directory:p1-011-root-directory:unresolved-digest",
    ),
  );
  for (const step of unresolvedPlan.steps) {
    assert.equal(step.status, "blocked");
    assert.ok(step.blockedBy.includes("verify-p1-011-root-directory:p1-011-root-directory:unresolved-digest"));
  }

  const resolvedConfigText = replaceConfigSetting(configText, "RootDirectory", "Digest", sha256("fixture p1-011 root directory\n"));
  const resolvedPlan = rootfsImage.planRootfsImage(planInput(resolvedConfigText));
  assertResolvedPin(findRootDirectory(resolvedPlan).pin);
  assert.equal(findPrecondition(resolvedPlan, "verify-p1-011-root-directory").status, "pending-runtime-verification");
  assert.equal(findPrecondition(resolvedPlan, "convert-root-directory-to-ext4-images").status, "pending-runtime-verification");
  assert.deepEqual(findPrecondition(resolvedPlan, "convert-root-directory-to-ext4-images").blockedBy, [
    "verify-p1-011-root-directory:pending-runtime-verification",
  ]);
  assert.deepEqual(
    resolvedPlan.commands.map((command) => command.args),
    unresolvedPlan.commands.map((command) => command.args),
  );

  assert.throws(
    () =>
      rootfsImage.planRootfsImage(
        planInput(replaceConfigSetting(configText, "RootDirectory", "Digest", `sha256:${"1".repeat(64)}`)),
      ),
    /RootDirectory\.Digest must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () =>
      rootfsImage.planRootfsImage(
        planInput(replaceConfigSetting(configText, "RootDirectory", "Digest", `sha256:${"deadbeef".repeat(8)}`)),
      ),
    /RootDirectory\.Digest must not use a placeholder or sentinel digest/u,
  );
});

test("produced ext4 paths exactly match image.conf and verity.conf consumers", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const plan = rootfsImage.planRootfsImage(await readPlanInput());
  const imageConfigText = await readFile(imageConfigUrl, "utf8");
  const verityConfigText = await readFile(verityConfigUrl, "utf8");
  const imageLayoutPlan = await loadImageLayoutPlan(imageConfigText);
  const verityPlan = await loadVerityPlan(verityConfigText);

  const rootfsOutputPaths = plan.outputs.rootImages.map((image) => image.path);
  const imageConfigPaths = [
    extractConfigSetting(imageConfigText, "RootImageRootA", "Path"),
    extractConfigSetting(imageConfigText, "RootImageRootB", "Path"),
    extractConfigSetting(imageConfigText, "RootImageRecovery", "Path"),
  ];
  const verityConfigDataImages = [
    extractConfigSetting(verityConfigText, "SlotRootA", "DataImage"),
    extractConfigSetting(verityConfigText, "SlotRootB", "DataImage"),
  ];

  assert.deepEqual(rootfsOutputPaths, imageConfigPaths);
  assert.deepEqual(rootfsOutputPaths.slice(0, 2), verityConfigDataImages);
  assert.deepEqual(rootfsOutputPaths, findImageLayoutRootImagePaths(imageLayoutPlan));
  assert.deepEqual(rootfsOutputPaths.slice(0, 2), verityPlan.slots.map((slot) => slot.dataImage.path));
});

test("canonical path validation rejects traversal, mount escapes, and path drift", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const configText = await readConfigText();
  const invalidConfigPaths = [
    ["RootDirectory", "Path", "/external/../p1-011/root", /RootDirectory\.Path must not contain \. or \.\. segments/u],
    ["RootImageRootA", "Output", "/external/p1-014/../converted/root-a.ext4", /RootImageRootA\.Output must not contain \. or \.\. segments/u],
    ["RootImageRootB", "Output", "/external/p1-014/converted/../root-b.ext4", /RootImageRootB\.Output must not contain \. or \.\. segments/u],
    ["Paths", "OutputRoot", "/external/../converted", /Paths\.OutputRoot must not contain \. or \.\. segments/u],
    ["Paths", "ExternalRoot", "//external", /Paths\.ExternalRoot must not contain empty or duplicate-slash segments/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigPaths) {
    assert.throws(() => rootfsImage.planRootfsImage(planInput(replaceConfigSetting(configText, section, key, value))), message);
  }

  assert.throws(
    () =>
      rootfsImage.planRootfsImage({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/os/x86_64/upstream-inputs/../converted" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      rootfsImage.planRootfsImage({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/u,
  );
  assert.throws(
    () =>
      rootfsImage.planRootfsImage({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/os/x86_64/out" },
      }),
    /mountRoots\.outputHostPath must stay within mount root \/repo\/os\/x86_64\/upstream-inputs/u,
  );
  assert.throws(
    () => rootfsImage.planRootfsImage(planInput(replaceConfigSetting(configText, "RootImageRootA", "Output", "/external/p1-014/converted/drift.ext4"))),
    /RootImageRootA\.Output expected \/external\/p1-014\/converted\/vita-root-a\.rootfs\.ext4/u,
  );
});

test("planRootfsImage rejects partial, accessor-bearing, cyclic, and hostile inputs through safeNormalize", async () => {
  const rootfsImage = await loadRootfsImageModule();
  const configText = await readConfigText();

  assert.throws(() => rootfsImage.planRootfsImage({ configText: "partial" }), /missing required field mountRoots/u);

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      assert.fail("top-level accessor must not be invoked");
    },
    enumerable: true,
  });
  assert.throws(() => rootfsImage.planRootfsImage(accessorInput), /rootfs image plan input normalization failed/u);

  const accessorMountRoots = {};
  Object.defineProperty(accessorMountRoots, "workspaceHostPath", {
    value: "/repo",
    enumerable: true,
  });
  Object.defineProperty(accessorMountRoots, "externalInputsHostPath", {
    value: "/repo/os/x86_64/upstream-inputs",
    enumerable: true,
  });
  Object.defineProperty(accessorMountRoots, "planInputsHostPath", {
    value: "/repo/os/x86_64/generated-inputs",
    enumerable: true,
  });
  Object.defineProperty(accessorMountRoots, "outputHostPath", {
    get() {
      assert.fail("nested accessor must not be invoked");
    },
    enumerable: true,
  });
  assert.throws(
    () => rootfsImage.planRootfsImage({ configText, mountRoots: accessorMountRoots }),
    /rootfs image plan input normalization failed/u,
  );

  const hostileIteratorMountRoots: Record<PropertyKey, unknown> = { ...defaultMountRoots };
  hostileIteratorMountRoots[Symbol.iterator] = () => {
    assert.fail("hostile iterator must not be invoked");
  };
  assert.throws(
    () => rootfsImage.planRootfsImage({ configText, mountRoots: hostileIteratorMountRoots }),
    /rootfs image plan input normalization failed/u,
  );

  const cyclicMountRoots: Record<string, unknown> = { ...defaultMountRoots };
  cyclicMountRoots["self"] = cyclicMountRoots;
  assert.throws(
    () => rootfsImage.planRootfsImage({ configText, mountRoots: cyclicMountRoots }),
    /rootfs image plan input normalization failed/u,
  );

  const proxyInput = new Proxy(
    { configText, mountRoots: defaultMountRoots },
    {
      ownKeys() {
        assert.fail("proxy ownKeys must not be trusted");
      },
    },
  );
  assert.throws(() => rootfsImage.planRootfsImage(proxyInput), /rootfs image plan input normalization failed/u);
});

async function readPlanInput(): Promise<RootfsImagePlanInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(rootfsImageConfigUrl, "utf8");
}

function planInput(configText: string): RootfsImagePlanInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadRootfsImageModule(): Promise<RootfsImageModule> {
  const moduleValue: unknown = await import(rootfsImageModuleUrl.href);
  return asRootfsImageModule(moduleValue);
}

function asRootfsImageModule(value: unknown): RootfsImageModule {
  const record = asRecord(value, "rootfs-image module");
  const planRootfsImage = record["planRootfsImage"];
  const serializeRootfsImagePlan = record["serializeRootfsImagePlan"];
  const defaultConfigText = record["DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT"];
  const sourceDateEpoch = record["DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH"];
  const blockSize = record["DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE"];
  const inodeSize = record["DEFAULT_ROOTFS_IMAGE_INODE_SIZE"];
  const bytesPerInode = record["DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE"];

  assert.equal(typeof planRootfsImage, "function");
  assert.equal(typeof serializeRootfsImagePlan, "function");

  return {
    planRootfsImage: (input?: unknown) => {
      const result = (planRootfsImage as (input?: unknown) => unknown)(input);
      asRecord(result, "rootfs image plan");
      return result as RootfsImagePlan;
    },
    serializeRootfsImagePlan: (plan: RootfsImagePlan) =>
      (serializeRootfsImagePlan as (plan: RootfsImagePlan) => string)(plan),
    DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT: asString(defaultConfigText, "DEFAULT_ROOTFS_IMAGE_CONFIG_TEXT"),
    DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH: asString(sourceDateEpoch, "DEFAULT_ROOTFS_IMAGE_SOURCE_DATE_EPOCH"),
    DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE: asNumber(blockSize, "DEFAULT_ROOTFS_IMAGE_BLOCK_SIZE"),
    DEFAULT_ROOTFS_IMAGE_INODE_SIZE: asNumber(inodeSize, "DEFAULT_ROOTFS_IMAGE_INODE_SIZE"),
    DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE: asNumber(bytesPerInode, "DEFAULT_ROOTFS_IMAGE_BYTES_PER_INODE"),
  };
}

async function loadImageLayoutPlan(configText: string): Promise<ImageLayoutPlan> {
  const moduleValue: unknown = await import(imageLayoutModuleUrl.href);
  const record = asRecord(moduleValue, "image-layout module");
  const planImageLayout = record["planImageLayout"];
  assert.equal(typeof planImageLayout, "function");
  const result = (planImageLayout as (input?: unknown) => unknown)({
    configText,
    mountRoots: downstreamMountRoots,
  });
  asRecord(result, "image layout plan");
  return result as ImageLayoutPlan;
}

async function loadVerityPlan(configText: string): Promise<VerityPlan> {
  const moduleValue: unknown = await import(verityModuleUrl.href);
  const record = asRecord(moduleValue, "verity module");
  const planVerity = record["planVerity"];
  assert.equal(typeof planVerity, "function");
  const result = (planVerity as (input?: unknown) => unknown)({
    configText,
    mountRoots: downstreamMountRoots,
  });
  asRecord(result, "verity plan");
  return result as VerityPlan;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    assert.fail(`${label} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    assert.fail(`${label} must be a number`);
  }
  return value;
}

function findMount(plan: RootfsImagePlan, name: string): RootfsImagePlan["mounts"][number] {
  for (const mount of plan.mounts) {
    if (mount.name === name) {
      return mount;
    }
  }
  assert.fail(`${name} mount must be declared`);
}

function findRootDirectory(plan: RootfsImagePlan): RootDirectoryInput {
  const rootDirectory = plan.inputs.external[0];
  if (rootDirectory === undefined) {
    assert.fail("root directory input must be declared");
  }
  return rootDirectory;
}

function findCommand(plan: RootfsImagePlan, outputPath: string): MkfsCommand {
  for (const command of plan.commands) {
    if (command.output === outputPath) {
      return command;
    }
  }
  assert.fail(`${outputPath} command must be declared`);
}

function findPrecondition(plan: RootfsImagePlan, id: RootfsImagePrecondition["id"]): RootfsImagePrecondition {
  for (const precondition of plan.preconditions) {
    if (precondition.id === id) {
      return precondition;
    }
  }
  assert.fail(`${id} precondition must be declared`);
}

function findImageLayoutRootImagePaths(plan: ImageLayoutPlan): string[] {
  const paths: string[] = [];
  for (const input of plan.inputs.external) {
    if (input.kind === "root-partition-image") {
      paths.push(input.path);
    }
  }
  return paths;
}

function argValue(args: readonly string[], option: string): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) {
      const value = args[index + 1];
      if (typeof value !== "string") {
        assert.fail(`${option} must have a value`);
      }
      return value;
    }
  }
  assert.fail(`${option} not found`);
}

function assertUnresolvedDigestPin(pin: DigestPin): asserts pin is UnresolvedDigestPin {
  if (pin.resolved) {
    assert.fail("expected unresolved digest pin");
  }
  assert.equal(pin.required, true);
  assert.equal(pin.status, "unresolved");
}

function assertResolvedPin(pin: DigestPin): asserts pin is ResolvedDigestPin {
  if (!pin.resolved) {
    assert.fail("expected resolved digest pin");
  }
  assert.match(pin.digest, /^sha256:[0-9a-f]{64}$/u);
}

function extractConfigSetting(configText: string, section: string, key: string): string {
  const lines = configText.split("\n");
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (inSection && trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1);
    }
  }
  assert.fail(`${section}.${key} not found`);
}

function replaceConfigSetting(configText: string, section: string, key: string, value: string): string {
  const lines = configText.split("\n");
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      inSection = sectionMatch[1] === section;
      continue;
    }
    if (inSection && trimmed.startsWith(`${key}=`)) {
      lines[index] = `${key}=${value}`;
      return lines.join("\n");
    }
  }
  assert.fail(`${section}.${key} not found`);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ImageLayoutInput = {
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

type PartitionId = "esp" | "root-a" | "root-b" | "recovery" | "data";
type SlotPartitionId = Exclude<PartitionId, "esp" | "data">;
type SlotName = "rootfs.0" | "rootfs.1" | "recovery.0";

type PartitionPlan = {
  readonly number: number;
  readonly id: PartitionId;
  readonly name: string;
  readonly label: string;
  readonly role: "esp" | "rootfs" | "recovery" | "data";
  readonly filesystem: "vfat" | "ext4";
  readonly sizeBytes: number;
  readonly typeGuid: string;
  readonly partitionGuid: string;
  readonly startByte: number;
  readonly endExclusiveByte: number;
  readonly startLBA: number;
  readonly endLBA: number;
  readonly device: string;
  readonly byPartLabel: string;
};

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

type RootPartitionImageInput = {
  readonly name: "root-a-partition-image" | "root-b-partition-image" | "recovery-partition-image";
  readonly kind: "root-partition-image";
  readonly source: "external-precondition";
  readonly conversionFrom: "p1-011-root-directory";
  readonly slot: SlotPartitionId;
  readonly partition: SlotPartitionId;
  readonly rootLabel: string;
  readonly path: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
};

type SlotBootArtifactInput = {
  readonly name: "uki-root-a" | "uki-root-b" | "uki-recovery";
  readonly kind: "uki";
  readonly source: "external-precondition";
  readonly contract: "P1-012";
  readonly planner: "planUKI";
  readonly parameterizedBySlot: true;
  readonly slot: SlotPartitionId;
  readonly partition: SlotPartitionId;
  readonly rootLabel: string;
  readonly path: string;
  readonly espPath: string;
  readonly cmdline: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
};

type ExternalInput = RootDirectoryInput | RootPartitionImageInput | SlotBootArtifactInput;

type SlotPlan = {
  readonly name: SlotName;
  readonly class: "rootfs" | "recovery";
  readonly index: number;
  readonly bootName: string;
  readonly partitionId: SlotPartitionId;
  readonly partitionGuid: string;
  readonly device: string;
  readonly byPartLabel: string;
  readonly rootLabel: string;
  readonly rootImageInput: RootPartitionImageInput["name"];
  readonly rootImagePath: string;
  readonly bootArtifactInput: SlotBootArtifactInput["name"];
  readonly bootArtifactPath: string;
  readonly bootEspPath: string;
  readonly bootCmdline: string;
};

type ImagePrecondition = {
  readonly id: string;
  readonly kind: string;
  readonly status: "blocked-unresolved-digest" | "pending-runtime-verification";
  readonly network: "none";
  readonly verifies?: readonly {
    readonly name: string;
    readonly path: string;
    readonly slot?: string;
    readonly cmdline?: string;
    readonly pin: DigestPin;
  }[];
  readonly gatedBy?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly input?: string;
  readonly conversion?: "root-directory-to-partition-image";
  readonly outputs?: readonly {
    readonly name: RootPartitionImageInput["name"];
    readonly path: string;
    readonly partition: SlotPartitionId;
    readonly slot: SlotPartitionId;
    readonly pin: DigestPin;
  }[];
  readonly blocks: readonly string[];
};

type ImageStep = {
  readonly id: "assemble-image" | "plan-rauc-bundle";
  readonly kind: string;
  readonly status: "blocked";
  readonly executable: false;
  readonly gatedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly output: string;
};

type ImageLayoutPlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly config: {
    readonly path: "os/x86_64/image.conf";
    readonly containerPath: string;
    readonly digest: `sha256:${string}`;
  };
  readonly mounts: readonly {
    readonly name: string;
    readonly hostPath: string;
    readonly containerPath: string;
    readonly readOnly: boolean;
  }[];
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly image: {
    readonly name: string;
    readonly outputPath: string;
    readonly sectorSize: 512;
    readonly alignmentBytes: 1048576;
    readonly firstUsableLBA: 2048;
    readonly imageSizeBytes: number;
    readonly sourceDateEpoch: string;
    readonly raucCompatible: "vita-x86_64";
    readonly version: string;
  };
  readonly partitions: readonly PartitionPlan[];
  readonly inputs: {
    readonly external: readonly ExternalInput[];
    readonly produced: readonly {
      readonly name: "rauc-manifest";
      readonly kind: "deterministic-text";
      readonly containerPath: string;
      readonly digest: `sha256:${string}`;
      readonly text: string;
    }[];
  };
  readonly slots: {
    readonly compatible: "vita-x86_64";
    readonly bootOrder: readonly SlotName[];
    readonly map: readonly SlotPlan[];
  };
  readonly rauc: {
    readonly compatible: "vita-x86_64";
    readonly bundle: {
      readonly kind: "rauc-bundle-manifest-plan";
      readonly format: "plain";
      readonly status: "blocked";
      readonly compatible: "vita-x86_64";
      readonly version: string;
      readonly manifestPath: string;
      readonly manifestDigest: `sha256:${string}`;
      readonly manifestText: string;
      readonly slots: readonly {
        readonly name: SlotName;
        readonly class: "rootfs" | "recovery";
        readonly index: number;
        readonly partition: SlotPartitionId;
        readonly rootImage: RootPartitionImageInput["name"];
        readonly bootArtifact: SlotBootArtifactInput["name"];
      }[];
    };
  };
  readonly preconditions: readonly ImagePrecondition[];
  readonly steps: readonly ImageStep[];
};

type ImageLayoutModule = {
  readonly planImageLayout: (input?: unknown) => ImageLayoutPlan;
  readonly serializeImageLayoutPlan: (plan: ImageLayoutPlan) => string;
  readonly DEFAULT_IMAGE_CONFIG_TEXT: string;
  readonly DEFAULT_SOURCE_DATE_EPOCH: string;
  readonly DEFAULT_RAUC_COMPATIBLE: string;
};

const imageLayoutModuleUrl = new URL("../image-layout.mjs", import.meta.url);
const imageConfigUrl = new URL("../image.conf", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

const expectedPartitions = [
  {
    id: "esp",
    number: 1,
    label: "VITA-ESP",
    role: "esp",
    filesystem: "vfat",
    sizeBytes: 536870912,
    typeGuid: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
    partitionGuid: "5f7b7fb2-3228-43a3-8f52-6ac0d5d28c01",
  },
  {
    id: "root-a",
    number: 2,
    label: "vita-root-a",
    role: "rootfs",
    filesystem: "ext4",
    sizeBytes: 4294967296,
    typeGuid: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
    partitionGuid: "d3d7f6e6-1b23-4cf4-955f-4a87a2c04a11",
  },
  {
    id: "root-b",
    number: 3,
    label: "vita-root-b",
    role: "rootfs",
    filesystem: "ext4",
    sizeBytes: 4294967296,
    typeGuid: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
    partitionGuid: "abd2a3d5-6956-491b-9c48-14ac3280f7b2",
  },
  {
    id: "recovery",
    number: 4,
    label: "vita-recovery",
    role: "recovery",
    filesystem: "ext4",
    sizeBytes: 2147483648,
    typeGuid: "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
    partitionGuid: "76dc6fc4-f5a7-48a0-9122-874064f38044",
  },
  {
    id: "data",
    number: 5,
    label: "vita-data",
    role: "data",
    filesystem: "ext4",
    sizeBytes: 8589934592,
    typeGuid: "0fc63daf-8483-4772-8e79-3d69d8477de4",
    partitionGuid: "ee154f01-bbe5-4b8a-a763-acef82710d55",
  },
] as const;

test("planImageLayout is byte deterministic and matches the committed config text", async () => {
  const imageLayout = await loadImageLayoutModule();
  const input = await readPlanInput();
  const firstPlan = imageLayout.planImageLayout(input);
  const secondPlan = imageLayout.planImageLayout(input);
  const defaultPlan = imageLayout.planImageLayout();

  assert.equal(input.configText, imageLayout.DEFAULT_IMAGE_CONFIG_TEXT);
  assert.equal(imageLayout.serializeImageLayoutPlan(firstPlan), imageLayout.serializeImageLayoutPlan(secondPlan));
  assert.equal(
    imageLayout.serializeImageLayoutPlan(defaultPlan),
    imageLayout.serializeImageLayoutPlan(imageLayout.planImageLayout(planInput(imageLayout.DEFAULT_IMAGE_CONFIG_TEXT))),
  );
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.config.path, "os/x86_64/image.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
  assert.equal(firstPlan.environment.SOURCE_DATE_EPOCH, imageLayout.DEFAULT_SOURCE_DATE_EPOCH);
  assert.equal(firstPlan.image.raucCompatible, imageLayout.DEFAULT_RAUC_COMPATIBLE);
});

test("GPT partitions have pinned sizes, GUIDs, labels, and non-overlapping byte ranges", async () => {
  const imageLayout = await loadImageLayoutModule();
  const plan = imageLayout.planImageLayout(await readPlanInput());

  assert.deepEqual(
    plan.partitions.map((partition) => partition.id),
    ["esp", "root-a", "root-b", "recovery", "data"],
  );
  assert.equal(plan.image.sectorSize, 512);
  assert.equal(plan.image.alignmentBytes, 1048576);
  assert.equal(plan.image.firstUsableLBA, 2048);
  assert.equal(plan.partitions[0]?.startByte, 1048576);

  for (const expected of expectedPartitions) {
    const partition = findPartition(plan, expected.id);
    assert.equal(partition.number, expected.number);
    assert.equal(partition.label, expected.label);
    assert.equal(partition.role, expected.role);
    assert.equal(partition.filesystem, expected.filesystem);
    assert.equal(partition.sizeBytes, expected.sizeBytes);
    assert.equal(partition.typeGuid, expected.typeGuid);
    assert.equal(partition.partitionGuid, expected.partitionGuid);
    assert.equal(partition.startByte % plan.image.alignmentBytes, 0);
    assert.equal(partition.sizeBytes % plan.image.alignmentBytes, 0);
    assert.equal(partition.startLBA * plan.image.sectorSize, partition.startByte);
    assert.equal((partition.endLBA + 1) * plan.image.sectorSize, partition.endExclusiveByte);
  }

  for (let outerIndex = 0; outerIndex < plan.partitions.length; outerIndex += 1) {
    const outer = plan.partitions[outerIndex];
    if (outer === undefined) {
      assert.fail("partition entry must exist");
    }
    for (let innerIndex = outerIndex + 1; innerIndex < plan.partitions.length; innerIndex += 1) {
      const inner = plan.partitions[innerIndex];
      if (inner === undefined) {
        assert.fail("partition entry must exist");
      }
      assert.ok(
        outer.endExclusiveByte <= inner.startByte || inner.endExclusiveByte <= outer.startByte,
        `${outer.id} must not overlap ${inner.id}`,
      );
    }
  }

  const lastPartition = plan.partitions[plan.partitions.length - 1];
  if (lastPartition === undefined) {
    assert.fail("last partition must exist");
  }
  assert.equal(plan.image.imageSizeBytes, lastPartition.endExclusiveByte + plan.image.alignmentBytes);
});

test("RAUC A/B plus recovery slot mapping is coherent with partitions and bundle manifest", async () => {
  const imageLayout = await loadImageLayoutModule();
  const plan = imageLayout.planImageLayout(await readPlanInput());

  assert.equal(plan.slots.compatible, "vita-x86_64");
  assert.deepEqual(plan.slots.bootOrder, ["rootfs.0", "rootfs.1", "recovery.0"]);
  assert.deepEqual(
    plan.slots.map.map((slot) => [slot.name, slot.class, slot.index, slot.partitionId, slot.rootLabel]),
    [
      ["rootfs.0", "rootfs", 0, "root-a", "vita-root-a"],
      ["rootfs.1", "rootfs", 1, "root-b", "vita-root-b"],
      ["recovery.0", "recovery", 0, "recovery", "vita-recovery"],
    ],
  );

  for (const slot of plan.slots.map) {
    const partition = findPartition(plan, slot.partitionId);
    assert.equal(slot.partitionGuid, partition.partitionGuid);
    assert.equal(slot.device, partition.device);
    assert.equal(slot.byPartLabel, partition.byPartLabel);
    assert.equal(slot.rootLabel, partition.label);
    assert.equal(cmdlineRootLabel(slot.bootCmdline), slot.rootLabel);
    assert.ok(slot.rootImagePath.startsWith("/external/p1-014/converted/"));
    assert.ok(slot.bootArtifactPath.startsWith("/external/p1-012/"));
  }

  assert.equal(plan.rauc.compatible, "vita-x86_64");
  assert.equal(plan.rauc.bundle.compatible, "vita-x86_64");
  assert.equal(plan.rauc.bundle.format, "plain");
  assert.equal(plan.rauc.bundle.manifestDigest, sha256(plan.rauc.bundle.manifestText));
  assert.equal(plan.inputs.produced[0]?.digest, plan.rauc.bundle.manifestDigest);
  assert.match(plan.rauc.bundle.manifestText, /\[slot\.rootfs\.0\]\nclass=rootfs/u);
  assert.match(plan.rauc.bundle.manifestText, /root-label=vita-root-a/u);
  assert.match(plan.rauc.bundle.manifestText, /\[slot\.recovery\.0\]\nclass=recovery/u);
  const slotPartitionIds: readonly string[] = plan.slots.map.map((slot) => slot.partitionId);
  assert.equal(slotPartitionIds.includes("data"), false);
});

test("slot-specific UKI preconditions select exactly their slot root labels", async () => {
  const imageLayout = await loadImageLayoutModule();
  const plan = imageLayout.planImageLayout(await readPlanInput());
  const bootArtifacts = findBootArtifacts(plan);

  assert.deepEqual(
    bootArtifacts.map((artifact) => artifact.name),
    ["uki-root-a", "uki-root-b", "uki-recovery"],
  );
  assert.equal(new Set(bootArtifacts.map((artifact) => artifact.path)).size, 3);
  assert.equal(new Set(bootArtifacts.map((artifact) => artifact.espPath)).size, 3);
  assert.equal(new Set(bootArtifacts.map((artifact) => artifact.cmdline)).size, 3);

  for (const artifact of bootArtifacts) {
    assert.equal(artifact.contract, "P1-012");
    assert.equal(artifact.planner, "planUKI");
    assert.equal(artifact.parameterizedBySlot, true);
    assert.equal(cmdlineRootLabel(artifact.cmdline), artifact.rootLabel);
    assert.equal(artifact.slot, artifact.partition);
    assert.doesNotMatch(artifact.cmdline, /vita-debian-trixie-x86_64-root/u);

    const slot = findSlotByBootArtifact(plan, artifact.name);
    assert.equal(slot.partitionId, artifact.partition);
    assert.equal(slot.rootLabel, artifact.rootLabel);
    assert.equal(slot.bootArtifactPath, artifact.path);
    assert.equal(slot.bootEspPath, artifact.espPath);
    assert.equal(slot.bootCmdline, artifact.cmdline);
  }
});

test("P1-011 directory output feeds a declared root-directory to partition-image conversion", async () => {
  const imageLayout = await loadImageLayoutModule();
  const plan = imageLayout.planImageLayout(await readPlanInput());
  const rootDirectory = findRootDirectory(plan);
  const rootImages = findRootPartitionImages(plan);
  const conversion = findPrecondition(plan, "convert-root-directory-to-partition-images");
  const assemble = findStep(plan, "assemble-image");

  assert.equal(rootDirectory.contract, "P1-011");
  assert.equal(rootDirectory.outputName, "vita-debian-trixie-x86_64-root");
  assert.equal(rootDirectory.format, "directory");
  assert.equal(rootDirectory.path, "/external/p1-011/vita-debian-trixie-x86_64-root");
  assert.equal(rootDirectory.path.endsWith(".img"), false);

  assert.deepEqual(
    rootImages.map((image) => [image.name, image.partition, image.rootLabel, image.conversionFrom]),
    [
      ["root-a-partition-image", "root-a", "vita-root-a", "p1-011-root-directory"],
      ["root-b-partition-image", "root-b", "vita-root-b", "p1-011-root-directory"],
      ["recovery-partition-image", "recovery", "vita-recovery", "p1-011-root-directory"],
    ],
  );
  for (const image of rootImages) {
    assert.ok(image.path.startsWith("/external/p1-014/converted/"));
    assert.equal(image.path.endsWith(".img"), false);
    assert.equal(image.pin.resolved, false);
  }

  assert.equal(conversion.kind, "external-precondition-step");
  assert.equal(conversion.conversion, "root-directory-to-partition-image");
  assert.deepEqual(conversion.gatedBy, ["verify-p1-011-root-directory"]);
  assert.equal(conversion.input, "p1-011-root-directory");
  assert.deepEqual(
    conversion.outputs?.map((output) => output.name),
    ["root-a-partition-image", "root-b-partition-image", "recovery-partition-image"],
  );
  assert.ok(conversion.blockedBy?.includes("convert-root-directory-to-partition-images:root-a-partition-image:unresolved-digest"));
  assert.ok(assemble.blockedBy.includes("convert-root-directory-to-partition-images:root-a-partition-image:unresolved-digest"));
  assert.ok(assemble.blockedBy.includes("verify-slot-ukis:uki-root-a:unresolved-digest"));
});

test("resolved fixture digests become pinned preconditions without changing assembly purity", async () => {
  const imageLayout = await loadImageLayoutModule();
  const configText = withConfigReplacements(await readConfigText(), [
    ["RootDirectory", "Digest", sha256("fixture p1-011 root directory\n")],
    ["RootImageRootA", "Digest", sha256("fixture root a ext4\n")],
    ["RootImageRootB", "Digest", sha256("fixture root b ext4\n")],
    ["RootImageRecovery", "Digest", sha256("fixture recovery ext4\n")],
    ["BootRootA", "Digest", sha256("fixture uki root a\n")],
    ["BootRootB", "Digest", sha256("fixture uki root b\n")],
    ["BootRecovery", "Digest", sha256("fixture uki recovery\n")],
  ]);
  const plan = imageLayout.planImageLayout(planInput(configText));

  for (const input of plan.inputs.external) {
    assertResolvedPin(input.pin);
  }
  assert.equal(findPrecondition(plan, "verify-p1-011-root-directory").status, "pending-runtime-verification");
  assert.equal(findPrecondition(plan, "convert-root-directory-to-partition-images").status, "pending-runtime-verification");
  assert.equal(findPrecondition(plan, "verify-slot-ukis").status, "pending-runtime-verification");
  assert.deepEqual(findStep(plan, "assemble-image").blockedBy, [
    "convert-root-directory-to-partition-images:pending-runtime-verification",
    "verify-slot-ukis:pending-runtime-verification",
  ]);
  assert.equal(findStep(plan, "assemble-image").executable, false);
});

test("unresolved pins are required, and placeholder or malformed digests are rejected", async () => {
  const imageLayout = await loadImageLayoutModule();
  const plan = imageLayout.planImageLayout(await readPlanInput());

  for (const input of plan.inputs.external) {
    assert.equal(input.source, "external-precondition");
    assert.equal(input.pin.required, true);
    assert.equal(input.pin.resolved, false);
    assert.equal(input.pin.status, "unresolved");
  }
  assert.equal(findPrecondition(plan, "verify-p1-011-root-directory").status, "blocked-unresolved-digest");
  assert.equal(findPrecondition(plan, "convert-root-directory-to-partition-images").status, "blocked-unresolved-digest");
  assert.equal(findPrecondition(plan, "verify-slot-ukis").status, "blocked-unresolved-digest");

  const configText = await readConfigText();
  assert.throws(
    () =>
      imageLayout.planImageLayout(
        planInput(replaceConfigSetting(configText, "RootDirectory", "Digest", `sha256:${"1".repeat(64)}`)),
      ),
    /RootDirectory\.Digest must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () =>
      imageLayout.planImageLayout(
        planInput(replaceConfigSetting(configText, "BootRootA", "Digest", `sha256:${"deadbeef".repeat(8)}`)),
      ),
    /BootRootA\.Digest must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => imageLayout.planImageLayout(planInput(replaceConfigSetting(configText, "RootImageRootA", "Digest", "sha256:ABC"))),
    /RootImageRootA\.Digest must be sha256 followed by exactly 64 lowercase hex characters/u,
  );
});

test("canonical path validation covers container paths, host mount roots, and traversal attempts", async () => {
  const imageLayout = await loadImageLayoutModule();
  const configText = await readConfigText();
  const invalidConfigPaths = [
    ["RootDirectory", "Path", "/external/../p1-011/root", /RootDirectory\.Path must not contain \. or \.\. segments/u],
    ["RootImageRootA", "Path", "/external/p1-014/../root-a.ext4", /RootImageRootA\.Path must not contain \. or \.\. segments/u],
    ["BootRootA", "Path", "/external/../p1-012/root-a.efi", /BootRootA\.Path must not contain \. or \.\. segments/u],
    ["BootRootA", "EspPath", "/EFI/../vita/root-a.efi", /BootRootA\.EspPath must not contain \. or \.\. segments/u],
    ["Image", "Output", "/out/../image.raw", /Image\.Output must not contain \. or \.\. segments/u],
    ["Paths", "ExternalRoot", "//external", /Paths\.ExternalRoot must not contain empty or duplicate-slash segments/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigPaths) {
    assert.throws(() => imageLayout.planImageLayout(planInput(replaceConfigSetting(configText, section, key, value))), message);
  }

  assert.throws(
    () =>
      imageLayout.planImageLayout({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/../out" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      imageLayout.planImageLayout({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/u,
  );

  const plan = imageLayout.planImageLayout(planInput(configText));
  for (const mount of plan.mounts) {
    assertCanonicalPath(mount.hostPath);
    assertCanonicalPath(mount.containerPath);
  }
  for (const input of plan.inputs.external) {
    assertCanonicalPath(input.path);
  }
});

test("planImageLayout rejects partial, accessor-bearing, and hostile-iterator inputs before planning", async () => {
  const imageLayout = await loadImageLayoutModule();
  const configText = await readConfigText();

  assert.throws(() => imageLayout.planImageLayout({ configText: "partial" }), /missing required field mountRoots/u);

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      assert.fail("top-level accessor must not be invoked");
    },
    enumerable: true,
  });
  assert.throws(() => imageLayout.planImageLayout(accessorInput), /property configText must be a data property/u);

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
    () => imageLayout.planImageLayout({ configText, mountRoots: accessorMountRoots }),
    /property outputHostPath must be a data property/u,
  );

  const hostileIteratorMountRoots: Record<PropertyKey, unknown> = { ...defaultMountRoots };
  hostileIteratorMountRoots[Symbol.iterator] = () => {
    assert.fail("hostile iterator must not be invoked");
  };
  assert.throws(
    () => imageLayout.planImageLayout({ configText, mountRoots: hostileIteratorMountRoots }),
    /must not contain symbol keys/u,
  );
});

async function readPlanInput(): Promise<ImageLayoutInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(imageConfigUrl, "utf8");
}

function planInput(configText: string): ImageLayoutInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadImageLayoutModule(): Promise<ImageLayoutModule> {
  const moduleValue: unknown = await import(imageLayoutModuleUrl.href);
  return asImageLayoutModule(moduleValue);
}

function asImageLayoutModule(value: unknown): ImageLayoutModule {
  const record = asRecord(value, "image-layout module");
  const planImageLayout = record["planImageLayout"];
  const serializeImageLayoutPlan = record["serializeImageLayoutPlan"];
  const defaultConfigText = record["DEFAULT_IMAGE_CONFIG_TEXT"];
  const sourceDateEpoch = record["DEFAULT_SOURCE_DATE_EPOCH"];
  const raucCompatible = record["DEFAULT_RAUC_COMPATIBLE"];

  assert.equal(typeof planImageLayout, "function");
  assert.equal(typeof serializeImageLayoutPlan, "function");

  return {
    planImageLayout: (input?: unknown) => {
      const result = (planImageLayout as (input?: unknown) => unknown)(input);
      asRecord(result, "image layout plan");
      return result as ImageLayoutPlan;
    },
    serializeImageLayoutPlan: (plan: ImageLayoutPlan) =>
      (serializeImageLayoutPlan as (plan: ImageLayoutPlan) => string)(plan),
    DEFAULT_IMAGE_CONFIG_TEXT: asString(defaultConfigText, "DEFAULT_IMAGE_CONFIG_TEXT"),
    DEFAULT_SOURCE_DATE_EPOCH: asString(sourceDateEpoch, "DEFAULT_SOURCE_DATE_EPOCH"),
    DEFAULT_RAUC_COMPATIBLE: asString(raucCompatible, "DEFAULT_RAUC_COMPATIBLE"),
  };
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

function findPartition(plan: ImageLayoutPlan, id: PartitionId): PartitionPlan {
  for (const partition of plan.partitions) {
    if (partition.id === id) {
      return partition;
    }
  }
  assert.fail(`${id} partition must be declared`);
}

function findRootDirectory(plan: ImageLayoutPlan): RootDirectoryInput {
  for (const input of plan.inputs.external) {
    if (input.kind === "root-directory") {
      return input;
    }
  }
  assert.fail("P1-011 root directory input must be declared");
}

function findRootPartitionImages(plan: ImageLayoutPlan): RootPartitionImageInput[] {
  const images: RootPartitionImageInput[] = [];
  for (const input of plan.inputs.external) {
    if (input.kind === "root-partition-image") {
      images.push(input);
    }
  }
  return images;
}

function findBootArtifacts(plan: ImageLayoutPlan): SlotBootArtifactInput[] {
  const artifacts: SlotBootArtifactInput[] = [];
  for (const input of plan.inputs.external) {
    if (input.kind === "uki") {
      artifacts.push(input);
    }
  }
  return artifacts;
}

function findSlotByBootArtifact(plan: ImageLayoutPlan, name: SlotBootArtifactInput["name"]): SlotPlan {
  for (const slot of plan.slots.map) {
    if (slot.bootArtifactInput === name) {
      return slot;
    }
  }
  assert.fail(`${name} slot mapping must be declared`);
}

function findPrecondition(plan: ImageLayoutPlan, id: string): ImagePrecondition {
  for (const precondition of plan.preconditions) {
    if (precondition.id === id) {
      return precondition;
    }
  }
  assert.fail(`${id} precondition must be declared`);
}

function findStep(plan: ImageLayoutPlan, id: ImageStep["id"]): ImageStep {
  for (const step of plan.steps) {
    if (step.id === id) {
      return step;
    }
  }
  assert.fail(`${id} step must be declared`);
}

function cmdlineRootLabel(cmdline: string): string {
  const labels: string[] = [];
  const tokens = cmdline.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith("root=LABEL=")) {
      labels.push(token.slice("root=LABEL=".length));
    }
  }
  assert.equal(labels.length, 1, `${cmdline} must select exactly one root label`);
  const label = labels[0];
  if (label === undefined) {
    assert.fail("root label must exist");
  }
  return label;
}

function assertResolvedPin(pin: DigestPin): asserts pin is ResolvedDigestPin {
  if (!pin.resolved) {
    assert.fail("expected resolved digest pin");
  }
  assert.match(pin.digest, /^sha256:[0-9a-f]{64}$/u);
}

function assertCanonicalPath(path: string): void {
  assert.ok(path.startsWith("/"), `${path} must be absolute`);
  assert.doesNotMatch(path, /(^|\/)\.\.?(\/|$)/u);
  assert.doesNotMatch(path, /\/\//u);
  assert.doesNotMatch(path, /\\/u);
  assert.equal(path.endsWith("/") && path !== "/", false);
}

function withConfigReplacements(
  configText: string,
  replacements: readonly (readonly [string, string, string])[],
): string {
  let next = configText;
  for (const [section, key, value] of replacements) {
    next = replaceConfigSetting(next, section, key, value);
  }
  return next;
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

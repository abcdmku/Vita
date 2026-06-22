import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type VerityPlanInput = {
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

type ResolvedRootHashPin = {
  readonly algorithm: "sha256";
  readonly required: true;
  readonly resolved: true;
  readonly hex: string;
};

type UnresolvedRootHashPin = {
  readonly algorithm: "sha256";
  readonly required: true;
  readonly resolved: false;
  readonly status: "unresolved";
};

type RootHashPin = ResolvedRootHashPin | UnresolvedRootHashPin;

type SlotName = "rootfs.0" | "rootfs.1";
type SlotId = "root-a" | "root-b";

type ExternalDataImage = {
  readonly name: "root-a-partition-image" | "root-b-partition-image";
  readonly kind: "root-partition-image";
  readonly source: "external-precondition";
  readonly contract: "P1-014";
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly rootLabel: string;
  readonly path: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
};

type ExternalUKI = {
  readonly name: "uki-root-a" | "uki-root-b";
  readonly kind: "uki";
  readonly source: "external-precondition";
  readonly contract: "P1-012";
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly path: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
};

type HashTreeOutput = {
  readonly name: "root-a-verity-hash-tree" | "root-b-verity-hash-tree";
  readonly kind: "verity-hash-tree";
  readonly source: "veritysetup-format-output";
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly path: string;
  readonly mountRoot: string;
};

type BoundUKIOutput = {
  readonly name: "uki-root-a-verity-bound" | "uki-root-b-verity-bound";
  readonly kind: "uki";
  readonly source: "uki-cmdline-binding-output";
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly path: string;
  readonly mountRoot: string;
};

type VeritysetupCommand = {
  readonly executable: "veritysetup";
  readonly args: readonly string[];
  readonly dataImageArtifact: string;
  readonly hashTreeArtifact: string;
  readonly capturesRootHash: true;
  readonly expectedStdoutField: "Root hash";
};

type UKICmdline = {
  readonly status: "blocked-unresolved-root-hash" | "bound";
  readonly root: string;
  readonly roothash: RootHashPin;
  readonly template: string;
  readonly value?: string;
  readonly digest?: `sha256:${string}`;
};

type UKIBinding = {
  readonly status: "blocked-unresolved-root-hash" | "bound";
  readonly source: {
    readonly slot: SlotName;
    readonly field: "rootHash";
  };
  readonly target: {
    readonly slot: SlotName;
    readonly artifact: ExternalUKI["name"];
    readonly field: "cmdline.roothash";
  };
  readonly rootDevice: string;
  readonly rootHash: RootHashPin;
  readonly cmdline: UKICmdline;
};

type VeritySlot = {
  readonly name: SlotName;
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly rootLabel: string;
  readonly dataImage: ExternalDataImage;
  readonly hashTree: HashTreeOutput;
  readonly salt: {
    readonly policy: "fixed-per-slot-hex";
    readonly algorithm: "sha256";
    readonly hex: string;
  };
  readonly rootHash: RootHashPin;
  readonly veritysetup: VeritysetupCommand;
  readonly uki: {
    readonly input: ExternalUKI;
    readonly output: BoundUKIOutput;
    readonly verityDevice: string;
    readonly cmdline: UKICmdline;
    readonly binding: UKIBinding;
  };
};

type VerityPrecondition = {
  readonly id:
    | "verify-root-images"
    | "verify-slot-ukis"
    | "compute-verity-root-hashes"
    | "bind-root-hashes-to-slot-ukis";
  readonly kind: string;
  readonly status:
    | "blocked-unresolved-digest"
    | "blocked-unresolved-root-hash"
    | "pending-runtime-verification";
  readonly network: "none";
  readonly executable?: false;
  readonly upstreamPrivileged?: true;
  readonly gatedBy?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly verifies?: readonly {
    readonly name: string;
    readonly slot: SlotName;
    readonly path: string;
    readonly pin: DigestPin;
  }[];
  readonly commandPlans?: readonly VeritysetupCommand[];
  readonly outputs?: readonly {
    readonly slot: SlotName;
    readonly dataImage: ExternalDataImage["name"];
    readonly hashTree: string;
    readonly rootHash: RootHashPin;
  }[];
  readonly binds?: readonly UKIBinding[];
  readonly blocks: readonly string[];
};

type VerityStep = {
  readonly id:
    | "format-root-a-verity"
    | "format-root-b-verity"
    | "bind-root-a-roothash-to-uki"
    | "bind-root-b-roothash-to-uki";
  readonly kind: string;
  readonly status: "blocked";
  readonly executable: false;
  readonly upstreamPrivileged?: true;
  readonly gatedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly command?: VeritysetupCommand;
  readonly input?: string;
  readonly output: string;
  readonly cmdline?: UKICmdline;
};

type VerityPlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly config: {
    readonly path: "os/x86_64/verity.conf";
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
    readonly executable: "veritysetup";
    readonly formatCommand: "format";
    readonly network: "none";
    readonly upstreamPrivileged: true;
    readonly runtimeCorrectness: "pending-build-and-boot-full-mode";
  };
  readonly parameters: {
    readonly version: 1;
    readonly hashAlgorithm: "sha256";
    readonly dataBlockSize: 4096;
    readonly hashBlockSize: 4096;
    readonly saltPolicy: "fixed-per-slot-hex";
    readonly rootHashPolicy: "external-precondition";
    readonly runtime: "systemd-veritysetup-generator";
  };
  readonly inputs: {
    readonly external: readonly (ExternalDataImage | ExternalUKI)[];
    readonly produced: readonly never[];
  };
  readonly outputs: {
    readonly hashTrees: readonly HashTreeOutput[];
    readonly boundUKIs: readonly BoundUKIOutput[];
  };
  readonly slots: readonly VeritySlot[];
  readonly bindings: readonly UKIBinding[];
  readonly preconditions: readonly VerityPrecondition[];
  readonly steps: readonly VerityStep[];
};

type VerityModule = {
  readonly planVerity: (input?: unknown) => VerityPlan;
  readonly serializeVerityPlan: (plan: VerityPlan) => string;
  readonly DEFAULT_VERITY_CONFIG_TEXT: string;
  readonly DEFAULT_VERITY_HASH_ALGORITHM: string;
  readonly DEFAULT_VERITY_DATA_BLOCK_SIZE: number;
  readonly DEFAULT_VERITY_HASH_BLOCK_SIZE: number;
};

const verityModuleUrl = new URL("../verity.mjs", import.meta.url);
const verityConfigUrl = new URL("../verity.conf", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

const rootAHash = createHash("sha256").update("fixture verity root hash root-a\n", "utf8").digest("hex");
const rootBHash = createHash("sha256").update("fixture verity root hash root-b\n", "utf8").digest("hex");

test("planVerity is byte deterministic and matches the committed config text", async () => {
  const verity = await loadVerityModule();
  const input = await readPlanInput();
  const firstPlan = verity.planVerity(input);
  const secondPlan = verity.planVerity(input);
  const defaultPlan = verity.planVerity();

  assert.equal(input.configText, verity.DEFAULT_VERITY_CONFIG_TEXT);
  assert.equal(verity.serializeVerityPlan(firstPlan), verity.serializeVerityPlan(secondPlan));
  assert.equal(
    verity.serializeVerityPlan(defaultPlan),
    verity.serializeVerityPlan(verity.planVerity(planInput(verity.DEFAULT_VERITY_CONFIG_TEXT))),
  );
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.config.path, "os/x86_64/verity.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
});

test("verity parameters, mounts, and runtime policy are pinned", async () => {
  const verity = await loadVerityModule();
  const plan = verity.planVerity(await readPlanInput());

  assert.deepEqual(plan.parameters, {
    version: 1,
    hashAlgorithm: "sha256",
    dataBlockSize: 4096,
    hashBlockSize: 4096,
    saltPolicy: "fixed-per-slot-hex",
    rootHashPolicy: "external-precondition",
    runtime: "systemd-veritysetup-generator",
  });
  assert.equal(plan.parameters.hashAlgorithm, verity.DEFAULT_VERITY_HASH_ALGORITHM);
  assert.equal(plan.parameters.dataBlockSize, verity.DEFAULT_VERITY_DATA_BLOCK_SIZE);
  assert.equal(plan.parameters.hashBlockSize, verity.DEFAULT_VERITY_HASH_BLOCK_SIZE);
  assert.equal(plan.tool.executable, "veritysetup");
  assert.equal(plan.tool.formatCommand, "format");
  assert.equal(plan.tool.network, "none");
  assert.equal(plan.tool.upstreamPrivileged, true);
  assert.equal(plan.inputs.produced.length, 0);

  const producedPlanInputsMount = findMount(plan, "produced-plan-inputs");
  assert.equal(producedPlanInputsMount.containerPath, "/plan");
  assert.equal(producedPlanInputsMount.readOnly, true);
  assert.equal(findMount(plan, "source-tree").readOnly, true);
  assert.equal(findMount(plan, "external-verity-inputs").readOnly, true);
  assert.equal(findMount(plan, "verity-output").readOnly, false);
});

test("each A/B slot formats the produced image file into its own hash-tree artifact", async () => {
  const verity = await loadVerityModule();
  const plan = verity.planVerity(await readPlanInput());

  assert.deepEqual(
    plan.slots.map((slot) => [slot.name, slot.slot, slot.partition, slot.rootLabel]),
    [
      ["rootfs.0", "root-a", "root-a", "vita-root-a"],
      ["rootfs.1", "root-b", "root-b", "vita-root-b"],
    ],
  );

  for (const slot of plan.slots) {
    assert.equal(slot.dataImage.source, "external-precondition");
    assert.equal(slot.dataImage.contract, "P1-014");
    assert.equal(slot.dataImage.mountRoot, "/external");
    assert.equal(slot.dataImage.path, slot.veritysetup.dataImageArtifact);
    assert.equal(slot.hashTree.source, "veritysetup-format-output");
    assert.equal(slot.hashTree.mountRoot, "/out");
    assert.equal(slot.hashTree.path, slot.veritysetup.hashTreeArtifact);
    assert.equal(slot.veritysetup.executable, "veritysetup");
    assert.deepEqual(slot.veritysetup.args.slice(0, 3), [
      "format",
      slot.dataImage.path,
      slot.hashTree.path,
    ]);
    assert.equal(argValue(slot.veritysetup.args, "--hash"), "sha256");
    assert.equal(argValue(slot.veritysetup.args, "--data-block-size"), "4096");
    assert.equal(argValue(slot.veritysetup.args, "--hash-block-size"), "4096");
    assert.equal(argValue(slot.veritysetup.args, "--salt"), slot.salt.hex);
    assert.match(slot.salt.hex, /^[0-9a-f]{64}$/u);
    // veritysetup format uses --format <ver> for the hash format version; --type is an `open` option, not `format`.
    assert.equal(argValue(slot.veritysetup.args, "--format"), "1");
    assert.doesNotMatch(slot.veritysetup.args.join(" "), /(?:^| )--type(?: |$)/u);
    assert.doesNotMatch(slot.veritysetup.args.join(" "), /\/dev\/disk\/by-partlabel|root=LABEL/u);
    assertUnresolvedDigestPin(slot.dataImage.pin);
    assertUnresolvedRootHash(slot.rootHash);
  }

  assert.equal(findPrecondition(plan, "compute-verity-root-hashes").status, "blocked-unresolved-root-hash");
  assert.ok(
    findPrecondition(plan, "compute-verity-root-hashes").blockedBy?.includes(
      "compute-verity-root-hashes:rootfs.0:unresolved-root-hash",
    ),
  );
});

test("resolved root hashes bind into the matching slot UKI cmdline only", async () => {
  const verity = await loadVerityModule();
  const configText = withConfigReplacements(await readConfigText(), [
    ["SlotRootA", "DataImageDigest", sha256("fixture root-a image\n")],
    ["SlotRootB", "DataImageDigest", sha256("fixture root-b image\n")],
    ["SlotRootA", "UKIInputDigest", sha256("fixture root-a uki\n")],
    ["SlotRootB", "UKIInputDigest", sha256("fixture root-b uki\n")],
    ["SlotRootA", "RootHash", rootAHash],
    ["SlotRootB", "RootHash", rootBHash],
  ]);
  const plan = verity.planVerity(planInput(configText));
  const rootA = findSlot(plan, "rootfs.0");
  const rootB = findSlot(plan, "rootfs.1");

  assertResolvedRootHash(rootA.rootHash, rootAHash);
  assertResolvedRootHash(rootB.rootHash, rootBHash);
  assertResolvedCmdline(rootA.uki.cmdline);
  assertResolvedCmdline(rootB.uki.cmdline);
  assert.equal(rootA.uki.cmdline.value, `root=/dev/mapper/vita-root-a-verity roothash=${rootAHash} ro systemd.volatile=no quiet`);
  assert.equal(rootB.uki.cmdline.value, `root=/dev/mapper/vita-root-b-verity roothash=${rootBHash} ro systemd.volatile=no quiet`);
  assert.doesNotMatch(rootA.uki.cmdline.value, new RegExp(rootBHash, "u"));
  assert.doesNotMatch(rootB.uki.cmdline.value, new RegExp(rootAHash, "u"));

  for (const slot of plan.slots) {
    assertResolvedCmdline(slot.uki.cmdline);
    assert.equal(slot.uki.binding.status, "bound");
    assert.equal(slot.uki.binding.source.slot, slot.name);
    assert.equal(slot.uki.binding.target.slot, slot.name);
    assert.equal(slot.uki.binding.rootHash, slot.rootHash);
    assert.equal(slot.uki.cmdline.root, `root=${slot.uki.verityDevice}`);
    assert.match(slot.uki.cmdline.value, /(?:^|\s)roothash=[0-9a-f]{64}(?:\s|$)/u);
    assert.doesNotMatch(slot.uki.cmdline.value, /root=LABEL=|\/dev\/disk\/by-partlabel/u);
    assert.equal(slot.uki.cmdline.digest, sha256(`${slot.uki.cmdline.value}\n`));
  }

  assert.equal(findPrecondition(plan, "compute-verity-root-hashes").status, "pending-runtime-verification");
  assert.equal(findPrecondition(plan, "bind-root-hashes-to-slot-ukis").status, "pending-runtime-verification");
});

test("root hashes are unresolved by default and placeholders are rejected", async () => {
  const verity = await loadVerityModule();
  const plan = verity.planVerity(await readPlanInput());

  for (const slot of plan.slots) {
    assertUnresolvedRootHash(slot.rootHash);
    assert.equal(slot.uki.cmdline.status, "blocked-unresolved-root-hash");
    assert.equal(slot.uki.cmdline.value, undefined);
    assert.match(slot.uki.cmdline.template, /^root=\/dev\/mapper\/vita-root-[ab]-verity roothash=\$\{rootfs\.[01]\.rootHash\}/u);
    assert.doesNotMatch(slot.uki.cmdline.template, /roothash=unresolved|<ROOTHASH|root=LABEL=/u);
  }

  const configText = await readConfigText();
  assert.throws(
    () => verity.planVerity(planInput(replaceConfigSetting(configText, "SlotRootA", "RootHash", "1".repeat(64)))),
    /SlotRootA\.RootHash must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => verity.planVerity(planInput(replaceConfigSetting(configText, "SlotRootB", "RootHash", "deadbeef".repeat(8)))),
    /SlotRootB\.RootHash must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => verity.planVerity(planInput(replaceConfigSetting(configText, "SlotRootA", "RootHash", `sha256:${rootAHash}`))),
    /SlotRootA\.RootHash must be exactly 64 lowercase hex characters/u,
  );
  assert.throws(
    () => verity.planVerity(planInput(replaceConfigSetting(configText, "SlotRootA", "Salt", "0".repeat(64)))),
    /SlotRootA\.Salt must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () =>
      verity.planVerity(
        planInput(replaceConfigSetting(configText, "SlotRootA", "DataImageDigest", `sha256:${"cafebabe".repeat(8)}`)),
      ),
    /SlotRootA\.DataImageDigest must not use a placeholder or sentinel digest/u,
  );
});

test("canonical path validation rejects traversal, mount escapes, and raw root devices", async () => {
  const verity = await loadVerityModule();
  const configText = await readConfigText();
  const invalidConfigPaths = [
    ["SlotRootA", "DataImage", "/external/../p1-014/root.ext4", /SlotRootA\.DataImage must not contain \. or \.\. segments/u],
    ["SlotRootA", "HashTree", "/out/../verity/root.verity", /SlotRootA\.HashTree must not contain \. or \.\. segments/u],
    ["SlotRootB", "UKIInput", "/external/p1-012/../root-b.efi", /SlotRootB\.UKIInput must not contain \. or \.\. segments/u],
    ["SlotRootB", "UKIOutput", "/out//uki/root-b.efi", /SlotRootB\.UKIOutput must not contain empty or duplicate-slash segments/u],
    ["Paths", "ExternalRoot", "//external", /Paths\.ExternalRoot must not contain empty or duplicate-slash segments/u],
    ["SlotRootA", "VerityDevice", "/dev/disk/by-partlabel/vita-root-a", /SlotRootA\.VerityDevice must stay within mount root \/dev\/mapper/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigPaths) {
    assert.throws(() => verity.planVerity(planInput(replaceConfigSetting(configText, section, key, value))), message);
  }

  assert.throws(
    () =>
      verity.planVerity({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/../out" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      verity.planVerity({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/u,
  );
});

test("cmdline validation rejects raw root labels, invented verity tokens, and cross-slot wiring", async () => {
  const verity = await loadVerityModule();
  const configText = await readConfigText();

  assert.throws(
    () =>
      verity.planVerity(
        planInput(replaceConfigSetting(configText, "SlotRootA", "CmdlineOptions", "ro root=LABEL=vita-root-a quiet")),
      ),
    /SlotRootA\.CmdlineOptions must not set root=/u,
  );
  assert.throws(
    () =>
      verity.planVerity(
        planInput(replaceConfigSetting(configText, "SlotRootA", "CmdlineOptions", "ro verity\.root_data=vita-root-a quiet")),
      ),
    /SlotRootA\.CmdlineOptions must not invent verity\.\* cmdline tokens/u,
  );
  assert.throws(
    () => verity.planVerity(planInput(replaceConfigSetting(configText, "SlotRootA", "UKIName", "uki-root-b"))),
    /SlotRootA\.UKIName expected uki-root-a, found uki-root-b/u,
  );
  assert.throws(
    () =>
      verity.planVerity(
        planInput(
          replaceConfigSetting(
            configText,
            "SlotRootA",
            "UKIInput",
            "/external/p1-012/root-b/vita-root-b.unsigned.efi",
          ),
        ),
      ),
    /SlotRootA\.UKIInput expected \/external\/p1-012\/root-a\/vita-root-a\.unsigned\.efi/u,
  );
});

test("planVerity rejects partial and hostile inputs through safeNormalize before planning", async () => {
  const verity = await loadVerityModule();
  const configText = await readConfigText();

  assert.throws(() => verity.planVerity({ configText: "partial" }), /missing required field mountRoots/u);

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      assert.fail("top-level accessor must not be invoked");
    },
    enumerable: true,
  });
  assert.throws(() => verity.planVerity(accessorInput), /verity plan input normalization failed/u);

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
    () => verity.planVerity({ configText, mountRoots: accessorMountRoots }),
    /verity plan input normalization failed/u,
  );

  const hostileIteratorMountRoots: Record<PropertyKey, unknown> = { ...defaultMountRoots };
  hostileIteratorMountRoots[Symbol.iterator] = () => {
    assert.fail("hostile iterator must not be invoked");
  };
  assert.throws(
    () => verity.planVerity({ configText, mountRoots: hostileIteratorMountRoots }),
    /verity plan input normalization failed/u,
  );

  const proxyInput = new Proxy(
    { configText, mountRoots: defaultMountRoots },
    {
      ownKeys() {
        assert.fail("proxy ownKeys must not be trusted");
      },
    },
  );
  assert.throws(() => verity.planVerity(proxyInput), /verity plan input normalization failed/u);
});

async function readPlanInput(): Promise<VerityPlanInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(verityConfigUrl, "utf8");
}

function planInput(configText: string): VerityPlanInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadVerityModule(): Promise<VerityModule> {
  const moduleValue: unknown = await import(verityModuleUrl.href);
  return asVerityModule(moduleValue);
}

function asVerityModule(value: unknown): VerityModule {
  const record = asRecord(value, "verity module");
  const planVerity = record["planVerity"];
  const serializeVerityPlan = record["serializeVerityPlan"];
  const defaultConfigText = record["DEFAULT_VERITY_CONFIG_TEXT"];
  const hashAlgorithm = record["DEFAULT_VERITY_HASH_ALGORITHM"];
  const dataBlockSize = record["DEFAULT_VERITY_DATA_BLOCK_SIZE"];
  const hashBlockSize = record["DEFAULT_VERITY_HASH_BLOCK_SIZE"];

  assert.equal(typeof planVerity, "function");
  assert.equal(typeof serializeVerityPlan, "function");

  return {
    planVerity: (input?: unknown) => {
      const result = (planVerity as (input?: unknown) => unknown)(input);
      asRecord(result, "verity plan");
      return result as VerityPlan;
    },
    serializeVerityPlan: (plan: VerityPlan) =>
      (serializeVerityPlan as (plan: VerityPlan) => string)(plan),
    DEFAULT_VERITY_CONFIG_TEXT: asString(defaultConfigText, "DEFAULT_VERITY_CONFIG_TEXT"),
    DEFAULT_VERITY_HASH_ALGORITHM: asString(hashAlgorithm, "DEFAULT_VERITY_HASH_ALGORITHM"),
    DEFAULT_VERITY_DATA_BLOCK_SIZE: asNumber(dataBlockSize, "DEFAULT_VERITY_DATA_BLOCK_SIZE"),
    DEFAULT_VERITY_HASH_BLOCK_SIZE: asNumber(hashBlockSize, "DEFAULT_VERITY_HASH_BLOCK_SIZE"),
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

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    assert.fail(`${label} must be a number`);
  }
  return value;
}

function findMount(plan: VerityPlan, name: string): VerityPlan["mounts"][number] {
  for (const mount of plan.mounts) {
    if (mount.name === name) {
      return mount;
    }
  }
  assert.fail(`${name} mount must be declared`);
}

function findSlot(plan: VerityPlan, name: SlotName): VeritySlot {
  for (const slot of plan.slots) {
    if (slot.name === name) {
      return slot;
    }
  }
  assert.fail(`${name} slot must be declared`);
}

function findPrecondition(plan: VerityPlan, id: VerityPrecondition["id"]): VerityPrecondition {
  for (const precondition of plan.preconditions) {
    if (precondition.id === id) {
      return precondition;
    }
  }
  assert.fail(`${id} precondition must be declared`);
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

function assertUnresolvedRootHash(pin: RootHashPin): asserts pin is UnresolvedRootHashPin {
  if (pin.resolved) {
    assert.fail("expected unresolved root hash");
  }
  assert.equal(pin.required, true);
  assert.equal(pin.status, "unresolved");
}

function assertResolvedRootHash(pin: RootHashPin, expectedHex: string): asserts pin is ResolvedRootHashPin {
  if (!pin.resolved) {
    assert.fail(`expected resolved root hash ${expectedHex}`);
  }
  assert.equal(pin.hex, expectedHex);
}

function assertResolvedCmdline(cmdline: UKICmdline): asserts cmdline is UKICmdline & {
  readonly status: "bound";
  readonly value: string;
  readonly digest: `sha256:${string}`;
} {
  assert.equal(cmdline.status, "bound");
  if (cmdline.value === undefined) {
    assert.fail("resolved cmdline must have a value");
  }
  if (cmdline.digest === undefined) {
    assert.fail("resolved cmdline must have a digest");
  }
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type UKIPlanInput = {
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

type ExternalInputName = "kernel" | "initrd" | "stub";

type SlotName = "rootfs.0" | "rootfs.1";
type SlotId = "root-a" | "root-b";

type ExternalUKIInput = {
  readonly name: ExternalInputName;
  readonly source: "external-precondition";
  readonly mountRoot: string;
  readonly path: string;
  readonly pin: DigestPin;
};

type ProducedInput = {
  readonly name: "os-release";
  readonly kind: "deterministic-text";
  readonly containerPath: string;
  readonly digest: `sha256:${string}`;
  readonly text: string;
};

type CommandPlan = {
  readonly executable: "docker";
  readonly args: readonly string[];
  readonly ukifyArgs: readonly string[];
};

type UKICmdline = {
  readonly status: "blocked-unresolved-root-hash" | "bound";
  readonly root: string;
  readonly roothash: RootHashPin;
  readonly template: string;
  readonly value?: string;
  readonly digest?: `sha256:${string}`;
};

type UKIStep = {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly executable?: false;
  readonly slot: SlotName;
  readonly gatedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly input?: string;
  readonly output: string;
  readonly command?: CommandPlan;
};

type UKISlot = {
  readonly name: SlotName;
  readonly slot: SlotId;
  readonly rootLabel: string;
  readonly verityDevice: string;
  readonly ukiName: "uki-root-a" | "uki-root-b";
  readonly rootHash: RootHashPin;
  readonly cmdline: UKICmdline;
  readonly outputPath: string;
  readonly signedOutputPath: string;
  readonly command: CommandPlan;
  readonly assembleStep: UKIStep;
  readonly signingStep: UKIStep;
};

type UKIPrecondition = {
  readonly id: "verify-external-uki-inputs";
  readonly kind: "digest-verification";
  readonly status: "blocked-unresolved-digest" | "pending-runtime-verification";
  readonly network: "none";
  readonly verifies: readonly {
    readonly name: ExternalInputName;
    readonly path: string;
    readonly pin: DigestPin;
  }[];
  readonly blocks: readonly string[];
};

type UKIPlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly rootBinding: "verity-device";
  readonly config: {
    readonly path: "os/x86_64/uki.conf";
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
    readonly engine: "docker";
    readonly image: string;
    readonly executable: "ukify";
    readonly pullPolicy: "never";
    readonly network: "none";
  };
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly inputs: {
    readonly external: readonly ExternalUKIInput[];
    readonly produced: readonly ProducedInput[];
  };
  readonly outputs: {
    readonly unsignedUKIs: readonly string[];
    readonly testSignedUKIs: readonly string[];
  };
  readonly slots: readonly UKISlot[];
  readonly preconditions: readonly UKIPrecondition[];
  readonly steps: readonly UKIStep[];
  readonly signing: {
    readonly mode: "test-runtime-path";
    readonly step: "declare-only";
    readonly executable: false;
    readonly materialInRepo: false;
    readonly key: {
      readonly id: string;
      readonly pathEnv: string;
      readonly containerPath: string;
    };
    readonly cert: {
      readonly id: string;
      readonly pathEnv: string;
      readonly containerPath: string;
    };
    readonly runtimeMount: {
      readonly name: "test-secureboot-key-material";
      readonly containerPath: string;
      readonly readOnly: true;
      readonly hostPathEnv: readonly string[];
    };
    readonly tool: {
      readonly image: string;
      readonly executable: "ukify";
      readonly pullPolicy: "never";
      readonly network: "none";
    };
    readonly productionSigning: {
      readonly included: false;
      readonly ownerOnly: true;
      readonly disposition: "owner-only-out-of-band";
    };
  };
};

type UKIModule = {
  readonly planUKI: (input?: unknown) => UKIPlan;
  readonly serializeUKIPlan: (plan: UKIPlan) => string;
  readonly PINNED_UKIFY_IMAGE: string;
  readonly DEFAULT_SOURCE_DATE_EPOCH: string;
  readonly TEST_KEY_PATH_ENV: string;
  readonly TEST_CERT_PATH_ENV: string;
  readonly DEFAULT_UKI_CONFIG_TEXT: string;
};

// Minimal shape of the REAL verity plan we read for cross-plan coherence. We do
// NOT keep a private copy of the verity cmdline; we assert the UKI cmdline
// equals the verity plan's per-slot `slot.uki.cmdline.template` produced by the
// committed verity.mjs/verity.conf (trap-8: self-reference is forbidden).
type VeritySlotView = {
  readonly name: SlotName;
  readonly uki: {
    readonly verityDevice: string;
    readonly cmdline: { readonly template: string };
  };
};

type VerityModule = {
  readonly planVerity: (input?: unknown) => { readonly slots: readonly VeritySlotView[] };
};

const ukiModuleUrl = new URL("../uki.mjs", import.meta.url);
const ukiConfigUrl = new URL("../uki.conf", import.meta.url);
const verityModuleUrl = new URL("../verity.mjs", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

const rootAHash = createHash("sha256").update("fixture uki verity root hash root-a\n", "utf8").digest("hex");
const rootBHash = createHash("sha256").update("fixture uki verity root hash root-b\n", "utf8").digest("hex");

test("planUKI is byte deterministic and matches the committed config text", async () => {
  const uki = await loadUKIModule();
  const input = await readPlanInput();
  const firstPlan = uki.planUKI(input);
  const secondPlan = uki.planUKI(input);
  const defaultPlan = uki.planUKI();

  assert.equal(input.configText, uki.DEFAULT_UKI_CONFIG_TEXT);
  assert.equal(uki.serializeUKIPlan(firstPlan), uki.serializeUKIPlan(secondPlan));
  assert.equal(uki.serializeUKIPlan(defaultPlan), uki.serializeUKIPlan(uki.planUKI(planInput(uki.DEFAULT_UKI_CONFIG_TEXT))));
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.rootBinding, "verity-device");
  assert.equal(firstPlan.config.path, "os/x86_64/uki.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
});

test("external kernel inputs are preconditions, not self-produced artifacts", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());
  const producedInputPaths = new Set(plan.inputs.produced.map((entry) => entry.containerPath));

  assert.deepEqual(plan.inputs.external.map((entry) => entry.name), ["kernel", "initrd", "stub"]);
  for (const input of plan.inputs.external) {
    assert.equal(input.source, "external-precondition");
    assert.equal(input.mountRoot, "/external");
    assert.equal(input.pin.required, true);
    assertUnresolvedDigestPin(input.pin);
    assert.equal(producedInputPaths.has(input.path), false);
  }

  const osRelease = onlyProducedInput(plan);
  assert.equal(osRelease.containerPath, "/plan/uki.os-release");
  assert.equal(osRelease.digest, sha256(osRelease.text));
  assert.equal(osRelease.text, [
    "NAME=Vita",
    "ID=vita",
    "PRETTY_NAME=\"Vita x86_64 UKI deterministic scaffold\"",
    "VERSION_ID=0.1-bootstrap",
    "BUILD_ID=P1-012",
    "",
  ].join("\n"));

  const precondition = findPrecondition(plan);
  assert.equal(precondition.status, "blocked-unresolved-digest");
  assert.equal(precondition.network, "none");
  assert.deepEqual(precondition.blocks, ["assemble-root-a-uki", "assemble-root-b-uki"]);
  assert.deepEqual(precondition.verifies.map((entry) => entry.name), ["kernel", "initrd", "stub"]);
});

test("each A/B slot emits a verity-bearing UKI whose cmdline binds the per-slot verity device", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());
  const externalInputPaths = new Set(plan.inputs.external.map((entry) => entry.path));
  const producedInputPaths = new Set(plan.inputs.produced.map((entry) => entry.containerPath));

  assert.deepEqual(
    plan.slots.map((slot) => [slot.name, slot.slot, slot.rootLabel, slot.verityDevice]),
    [
      ["rootfs.0", "root-a", "vita-root-a", "/dev/mapper/vita-root-a-verity"],
      ["rootfs.1", "root-b", "vita-root-b", "/dev/mapper/vita-root-b-verity"],
    ],
  );
  assert.deepEqual(plan.outputs.unsignedUKIs, [
    "/out/uki/vita-root-a.verity.unsigned.efi",
    "/out/uki/vita-root-b.verity.unsigned.efi",
  ]);

  for (const slot of plan.slots) {
    // Root hash is unresolved by default: the cmdline carries the placeholder template, never a value.
    assertUnresolvedRootHash(slot.rootHash);
    assert.equal(slot.cmdline.status, "blocked-unresolved-root-hash");
    assert.equal(slot.cmdline.value, undefined);
    assert.equal(slot.cmdline.digest, undefined);
    assert.equal(slot.cmdline.root, `root=${slot.verityDevice}`);

    // The cmdline points at the per-slot verity device, NEVER root=LABEL= or a raw partition.
    assert.match(
      slot.cmdline.template,
      /^root=\/dev\/mapper\/vita-root-[ab]-verity roothash=\$\{rootfs\.[01]\.rootHash\} ro systemd\.volatile=no quiet$/u,
    );
    assert.doesNotMatch(slot.cmdline.template, /root=LABEL=|\/dev\/disk\/by-partlabel|roothash=unresolved|<ROOTHASH/u);

    // The ukify command carries that exact cmdline and the slot's own output path.
    assert.equal(argValue(slot.command.ukifyArgs, "--cmdline"), slot.cmdline.template);
    assert.equal(argValue(slot.command.ukifyArgs, "--output"), slot.outputPath);
    assert.doesNotMatch(slot.command.ukifyArgs.join(" "), /root=LABEL=/u);

    // ukify inputs are declared external or produced inputs.
    for (const option of ["--linux", "--initrd", "--stub", "--os-release"] as const) {
      const value = argValue(slot.command.ukifyArgs, option);
      assert.ok(
        externalInputPaths.has(value) || producedInputPaths.has(value),
        `${value} must be a declared external or produced input`,
      );
    }

    // The assemble step is blocked on both the input digests and the slot's root hash.
    assert.equal(slot.assembleStep.id, `assemble-${slot.slot}-uki`);
    assert.equal(slot.assembleStep.status, "blocked");
    assert.deepEqual(slot.assembleStep.gatedBy, ["verify-external-uki-inputs", "compute-verity-root-hashes"]);
    assert.ok(slot.assembleStep.blockedBy.includes(`compute-verity-root-hashes:${slot.name}:unresolved-root-hash`));
    assert.ok(slot.assembleStep.blockedBy.includes("verify-external-uki-inputs:kernel:unresolved-digest"));
  }

  const rootA = findSlot(plan, "rootfs.0");
  const rootB = findSlot(plan, "rootfs.1");
  assert.notEqual(rootA.cmdline.template, rootB.cmdline.template);
  assert.doesNotMatch(rootA.cmdline.template, /vita-root-b-verity|rootfs\.1/u);
  assert.doesNotMatch(rootB.cmdline.template, /vita-root-a-verity|rootfs\.0/u);
});

test("each slot cmdline equals planVerity's per-slot cmdline template (cross-plan coherence)", async () => {
  const uki = await loadUKIModule();
  const verity = await loadVerityModule();
  const ukiPlan = uki.planUKI(await readPlanInput());
  const verityPlan = verity.planVerity();

  // Read the REAL verity plan's per-slot template — no private copy of the string.
  const verityBySlot = new Map<SlotName, VeritySlotView>();
  for (const slot of verityPlan.slots) {
    verityBySlot.set(slot.name, slot);
  }
  assert.equal(verityBySlot.size, ukiPlan.slots.length);

  for (const slot of ukiPlan.slots) {
    const verSlot = verityBySlot.get(slot.name);
    if (verSlot === undefined) {
      assert.fail(`verity plan is missing slot ${slot.name}`);
    }
    // Same verity device and byte-identical cmdline template for the SAME slot.
    assert.equal(slot.verityDevice, verSlot.uki.verityDevice);
    assert.equal(slot.cmdline.template, verSlot.uki.cmdline.template);
  }

  // And no cross-slot mixup: A's cmdline must not equal B's verity template and vice versa.
  const rootA = findSlot(ukiPlan, "rootfs.0");
  const rootB = findSlot(ukiPlan, "rootfs.1");
  const verityA = verityBySlot.get("rootfs.0");
  const verityB = verityBySlot.get("rootfs.1");
  assert.ok(verityA !== undefined && verityB !== undefined);
  assert.notEqual(rootA.cmdline.template, verityB.uki.cmdline.template);
  assert.notEqual(rootB.cmdline.template, verityA.uki.cmdline.template);
});

test("resolved root hashes bind into the matching slot UKI cmdline only", async () => {
  const uki = await loadUKIModule();
  const configText = withConfigReplacements(await readConfigText(), [
    ["Kernel", "Digest", sha256("fixture kernel\n")],
    ["Initrd", "Digest", sha256("fixture initrd\n")],
    ["Stub", "Digest", sha256("fixture systemd stub\n")],
    ["SlotRootA", "RootHash", rootAHash],
    ["SlotRootB", "RootHash", rootBHash],
  ]);
  const plan = uki.planUKI(planInput(configText));
  const rootA = findSlot(plan, "rootfs.0");
  const rootB = findSlot(plan, "rootfs.1");

  assertResolvedRootHash(rootA.rootHash, rootAHash);
  assertResolvedRootHash(rootB.rootHash, rootBHash);
  assertResolvedCmdline(rootA.cmdline);
  assertResolvedCmdline(rootB.cmdline);
  assert.equal(rootA.cmdline.value, `root=/dev/mapper/vita-root-a-verity roothash=${rootAHash} ro systemd.volatile=no quiet`);
  assert.equal(rootB.cmdline.value, `root=/dev/mapper/vita-root-b-verity roothash=${rootBHash} ro systemd.volatile=no quiet`);
  assert.doesNotMatch(rootA.cmdline.value, new RegExp(rootBHash, "u"));
  assert.doesNotMatch(rootB.cmdline.value, new RegExp(rootAHash, "u"));

  for (const slot of plan.slots) {
    assertResolvedCmdline(slot.cmdline);
    assert.equal(slot.cmdline.root, `root=${slot.verityDevice}`);
    assert.match(slot.cmdline.value, /(?:^|\s)roothash=[0-9a-f]{64}(?:\s|$)/u);
    assert.doesNotMatch(slot.cmdline.value, /root=LABEL=|\/dev\/disk\/by-partlabel/u);
    assert.equal(slot.cmdline.digest, sha256(`${slot.cmdline.value}\n`));
    // The planner still emits the unresolved-safe template into ukifyArgs; the build
    // substitutes the captured root hash into the placeholder before invoking ukify.
    assert.equal(argValue(slot.command.ukifyArgs, "--cmdline"), slot.cmdline.template);
  }
});

test("resolved external digests flip the input precondition to pending-runtime-verification", async () => {
  const uki = await loadUKIModule();
  // Resolve ONLY the external input digests; the per-slot root hashes stay unresolved.
  const configText = withConfigReplacements(await readConfigText(), [
    ["Kernel", "Digest", sha256("fixture kernel\n")],
    ["Initrd", "Digest", sha256("fixture initrd\n")],
    ["Stub", "Digest", sha256("fixture systemd stub\n")],
  ]);
  const plan = uki.planUKI(planInput(configText));

  // The shared input precondition flips blocked-unresolved-digest -> pending-runtime-verification
  // (it flips ONLY when every external digest is resolved — uki.mjs:155-156),
  assert.equal(findPrecondition(plan).status, "pending-runtime-verification");
  // and each slot's assemble step drops its per-input digest blockers for the collapsed marker while
  // staying blocked on its own still-unresolved root hash.
  for (const slot of plan.slots) {
    assert.ok(slot.assembleStep.blockedBy.includes("verify-external-uki-inputs:pending-runtime-verification"));
    assert.equal(slot.assembleStep.blockedBy.some((entry) => entry.includes("unresolved-digest")), false);
    assert.ok(slot.assembleStep.blockedBy.includes(`compute-verity-root-hashes:${slot.name}:unresolved-root-hash`));
    assert.equal(slot.assembleStep.status, "blocked");
  }
});

test("unresolved root-hash sentinels and placeholder digests are rejected", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();

  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootA", "RootHash", "1".repeat(64)))),
    /SlotRootA\.RootHash must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootB", "RootHash", "deadbeef".repeat(8)))),
    /SlotRootB\.RootHash must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootA", "RootHash", "0".repeat(64)))),
    /SlotRootA\.RootHash must not use a placeholder or sentinel digest/u,
  );
  // A digest-prefixed value is not a bare 64-hex root hash.
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootA", "RootHash", `sha256:${rootAHash}`))),
    /SlotRootA\.RootHash must be exactly 64 lowercase hex characters/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Kernel", "Digest", `sha256:${"1".repeat(64)}`))),
    /Kernel\.Digest must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Stub", "Digest", "sha256:ABC"))),
    /Stub\.Digest must be sha256 followed by exactly 64 lowercase hex characters/u,
  );
});

test("cmdline binding rejects root=LABEL=, raw partitions, and invented verity tokens", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();

  // The slot may not smuggle root= or roothash= through CmdlineOptions; the planner owns those.
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "SlotRootA", "CmdlineOptions", "ro root=LABEL=vita-root-a quiet")),
      ),
    /SlotRootA\.CmdlineOptions must not set root=/u,
  );
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "SlotRootB", "CmdlineOptions", "ro roothash=abc quiet")),
      ),
    /SlotRootB\.CmdlineOptions must not set roothash=/u,
  );
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "SlotRootA", "CmdlineOptions", "ro verity.root_hash=x quiet")),
      ),
    /SlotRootA\.CmdlineOptions must not invent verity\.\* cmdline tokens/u,
  );

  // The verity device must live under /dev/mapper, never a by-partlabel / LABEL device.
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "SlotRootA", "VerityDevice", "/dev/disk/by-partlabel/vita-root-a")),
      ),
    /SlotRootA\.VerityDevice must stay within mount root \/dev\/mapper/u,
  );

  // The committed plan never emits a label-based root anywhere in its serialized form.
  const plan = uki.planUKI(planInput(configText));
  assert.doesNotMatch(uki.serializeUKIPlan(plan), /root=LABEL=|\/dev\/disk\/by-partlabel/u);
});

test("cross-slot identity wiring is rejected (no slot may impersonate the other)", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();

  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootA", "VerityDevice", "/dev/mapper/vita-root-b-verity"))),
    /SlotRootA\.VerityDevice expected \/dev\/mapper\/vita-root-a-verity/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootA", "Name", "rootfs.1"))),
    /SlotRootA\.Name expected rootfs\.0/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "SlotRootB", "Output", "/out/uki/vita-root-a.verity.unsigned.efi"))),
    /SlotRootB\.Output expected \/out\/uki\/vita-root-b\.verity\.unsigned\.efi/u,
  );
});

test("tooling, environment, and network policy are pinned and deterministic per slot", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());

  assert.equal(plan.tool.engine, "docker");
  assert.equal(plan.tool.image, uki.PINNED_UKIFY_IMAGE);
  assert.match(plan.tool.image, /^ghcr\.io\/systemd\/mkosi@sha256:[0-9a-f]{64}$/);
  assert.equal(plan.tool.pullPolicy, "never");
  assert.equal(plan.tool.network, "none");
  assert.equal(plan.network, "none");
  assert.equal(plan.environment.SOURCE_DATE_EPOCH, uki.DEFAULT_SOURCE_DATE_EPOCH);
  assert.deepEqual(plan.environment, {
    SOURCE_DATE_EPOCH: "1781308800",
    TZ: "UTC",
    LC_ALL: "C.UTF-8",
  });

  for (const slot of plan.slots) {
    assert.equal(slot.command.executable, "docker");
    assert.ok(slot.command.args.includes("--pull=never"));
    assert.deepEqual(slot.command.args.slice(3, 5), ["--network", "none"]);
    assert.ok(slot.command.args.includes("SOURCE_DATE_EPOCH=1781308800"));
    assert.ok(slot.command.args.includes(uki.PINNED_UKIFY_IMAGE));
  }
});

test("signing is a non-executable TEST-key declaration with locked TEST env names", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());
  const serialized = uki.serializeUKIPlan(plan);

  assert.equal(plan.signing.mode, "test-runtime-path");
  assert.equal(plan.signing.step, "declare-only");
  assert.equal(plan.signing.executable, false);
  assert.equal(plan.signing.materialInRepo, false);
  assert.match(plan.signing.key.id, /^test:/u);
  assert.match(plan.signing.cert.id, /^test:/u);
  assert.equal(plan.signing.key.pathEnv, uki.TEST_KEY_PATH_ENV);
  assert.equal(plan.signing.cert.pathEnv, uki.TEST_CERT_PATH_ENV);
  assert.equal(plan.signing.key.containerPath, "/test-keys/db.key");
  assert.equal(plan.signing.cert.containerPath, "/test-keys/db.crt");
  assert.deepEqual(plan.signing.runtimeMount.hostPathEnv, [
    "VITA_TEST_SECUREBOOT_KEY_PATH",
    "VITA_TEST_SECUREBOOT_CERT_PATH",
  ]);
  assert.equal(plan.signing.tool.image, uki.PINNED_UKIFY_IMAGE);
  assert.equal(plan.signing.productionSigning.included, false);
  assert.equal(plan.signing.productionSigning.ownerOnly, true);
  assert.deepEqual(plan.outputs.testSignedUKIs, [
    "/out/uki/vita-root-a.verity.test-signed.efi",
    "/out/uki/vita-root-b.verity.test-signed.efi",
  ]);
  for (const slot of plan.slots) {
    assert.equal(slot.signingStep.executable, false);
    assert.equal(slot.signingStep.input, slot.outputPath);
    assert.equal(slot.signingStep.output, slot.signedOutputPath);
  }
  assert.doesNotMatch(serialized, /-----BEGIN|PRIVATE KEY|VITA_PROD|RELEASE_SIGNING_KEY/u);
});

test("signing rejects production-looking env names and key references", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();

  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "Signing", "TestKeyPathEnv", "VITA_PROD_SECUREBOOT_KEY_PATH")),
      ),
    /Signing\.TestKeyPathEnv must be VITA_TEST_SECUREBOOT_KEY_PATH/u,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Signing", "TestKeyId", "prod:vita-secureboot"))),
    /Signing\.TestKeyId must be a test: reference/u,
  );
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "Signing", "TestCertId", "test:production-secureboot-cert")),
      ),
    /Signing\.TestCertId must not reference production, release, or owner keys/u,
  );
});

test("canonical POSIX path validation rejects traversal, duplicate slashes, controls, and mount escapes", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();
  const invalidConfigPaths = [
    ["Kernel", "Path", "/external/../plan/x", /Kernel\.Path must not contain \. or \.\. segments/u],
    ["SlotRootA", "Output", "/out/../work/x", /SlotRootA\.Output must not contain \. or \.\. segments/u],
    ["SlotRootB", "Output", "/out//uki/root-b.efi", /SlotRootB\.Output must not contain empty or duplicate-slash segments/u],
    ["Paths", "ExternalRoot", "//x", /Paths\.ExternalRoot must not contain empty or duplicate-slash segments/u],
    ["Kernel", "Path", "/a/./b", /Kernel\.Path must not contain \. or \.\. segments/u],
    ["Stub", "Path", "/plan/linuxx64.efi.stub", /Stub\.Path must stay within mount root \/external/u],
    ["Signing", "KeyContainerPath", "/test-keys/../db.key", /Signing\.KeyContainerPath must not contain \. or \.\. segments/u],
    ["Initrd", "Path", "/external/initrd.img", /Initrd\.Path must not contain control characters/u],
    ["SlotRootA", "SignedOutput", "/out/../work/x", /SlotRootA\.SignedOutput must not contain \. or \.\. segments/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigPaths) {
    assert.throws(() => uki.planUKI(planInput(replaceConfigSetting(configText, section, key, value))), message);
  }

  assert.throws(
    () =>
      uki.planUKI({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/../out" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      uki.planUKI({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/u,
  );
});

test("planUKI rejects partial and accessor-bearing top-level inputs before planning", async () => {
  const uki = await loadUKIModule();

  assert.throws(() => uki.planUKI({ configText: "partial" }), /missing required field mountRoots/u);

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      assert.fail("top-level accessor must not be invoked");
    },
    enumerable: true,
  });
  assert.throws(() => uki.planUKI(accessorInput), /property configText must be a data property/u);

  const accessorMountRoots = {};
  Object.defineProperty(accessorMountRoots, "workspaceHostPath", { value: "/repo", enumerable: true });
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
    () => uki.planUKI({ configText: "ignored", mountRoots: accessorMountRoots }),
    /property outputHostPath must be a data property/u,
  );
});

async function readPlanInput(): Promise<UKIPlanInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(ukiConfigUrl, "utf8");
}

function planInput(configText: string): UKIPlanInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadUKIModule(): Promise<UKIModule> {
  const moduleValue: unknown = await import(ukiModuleUrl.href);
  return asUKIModule(moduleValue);
}

function asUKIModule(value: unknown): UKIModule {
  const record = asRecord(value, "uki module");
  const planUKI = record["planUKI"];
  const serializeUKIPlan = record["serializeUKIPlan"];
  const pinnedUkifyImage = record["PINNED_UKIFY_IMAGE"];
  const sourceDateEpoch = record["DEFAULT_SOURCE_DATE_EPOCH"];
  const testKeyPathEnv = record["TEST_KEY_PATH_ENV"];
  const testCertPathEnv = record["TEST_CERT_PATH_ENV"];
  const defaultConfigText = record["DEFAULT_UKI_CONFIG_TEXT"];

  assert.equal(typeof planUKI, "function");
  assert.equal(typeof serializeUKIPlan, "function");

  return {
    planUKI: (input?: unknown) => {
      const result = (planUKI as (input?: unknown) => unknown)(input);
      asRecord(result, "UKI plan");
      return result as UKIPlan;
    },
    serializeUKIPlan: (plan: UKIPlan) => (serializeUKIPlan as (plan: UKIPlan) => string)(plan),
    PINNED_UKIFY_IMAGE: asString(pinnedUkifyImage, "PINNED_UKIFY_IMAGE"),
    DEFAULT_SOURCE_DATE_EPOCH: asString(sourceDateEpoch, "DEFAULT_SOURCE_DATE_EPOCH"),
    TEST_KEY_PATH_ENV: asString(testKeyPathEnv, "TEST_KEY_PATH_ENV"),
    TEST_CERT_PATH_ENV: asString(testCertPathEnv, "TEST_CERT_PATH_ENV"),
    DEFAULT_UKI_CONFIG_TEXT: asString(defaultConfigText, "DEFAULT_UKI_CONFIG_TEXT"),
  };
}

async function loadVerityModule(): Promise<VerityModule> {
  const moduleValue: unknown = await import(verityModuleUrl.href);
  const record = asRecord(moduleValue, "verity module");
  const planVerity = record["planVerity"];
  assert.equal(typeof planVerity, "function");
  return {
    planVerity: (input?: unknown) => {
      const result = (planVerity as (input?: unknown) => unknown)(input);
      const plan = asRecord(result, "verity plan");
      const slots = plan["slots"];
      assert.ok(Array.isArray(slots), "verity plan slots must be an array");
      return result as { readonly slots: readonly VeritySlotView[] };
    },
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

function onlyProducedInput(plan: UKIPlan): ProducedInput {
  assert.equal(plan.inputs.produced.length, 1);
  const input = plan.inputs.produced[0];
  if (input === undefined) {
    assert.fail("produced os-release input must be declared");
  }
  return input;
}

function findSlot(plan: UKIPlan, name: SlotName): UKISlot {
  for (const slot of plan.slots) {
    if (slot.name === name) {
      return slot;
    }
  }
  assert.fail(`${name} slot must be declared`);
}

function findPrecondition(plan: UKIPlan): UKIPrecondition {
  const precondition = plan.preconditions.find((entry) => entry.id === "verify-external-uki-inputs");
  if (precondition === undefined) {
    assert.fail("verify precondition must be declared");
  }
  return precondition;
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

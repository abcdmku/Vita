import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type RaucBundlePlanInput = {
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

type RaucRootfsImage = {
  readonly name: "verity-rootfs-image";
  readonly kind: "verity-root-image";
  readonly source: "external-precondition";
  readonly contract: "P1-028";
  readonly slotClass: "rootfs";
  readonly filename: string;
  readonly path: string;
  readonly bundlePath: string;
  readonly mountRoot: string;
  readonly pin: DigestPin;
  readonly rootHash: RootHashPin;
};

type ProducedInput =
  | {
      readonly name: "manifest.raucm";
      readonly kind: "deterministic-text";
      readonly containerPath: string;
      readonly digest: `sha256:${string}`;
      readonly text: string;
    }
  | {
      readonly name: "rootfs-image-content-file";
      readonly kind: "staged-external-artifact";
      readonly source: "verity-rootfs-image";
      readonly containerPath: string;
    };

type RaucCommand = {
  readonly executable: "rauc";
  readonly args: readonly string[];
  readonly inputDirectory: string;
  readonly manifest: string;
  readonly output: string;
  readonly unsigned: true;
};

type RaucSlot = {
  readonly name: SlotName;
  readonly class: "rootfs";
  readonly index: 0 | 1;
  readonly slot: SlotId;
  readonly partition: SlotId;
  readonly rootLabel: string;
};

type RaucPrecondition = {
  readonly id: "verify-verity-rootfs-image" | "capture-verity-root-hash" | "stage-rauc-bundle-input";
  readonly kind: string;
  readonly status:
    | "blocked"
    | "ready"
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
    readonly path: string;
    readonly pin: DigestPin;
  }[];
  readonly rootHash?: RootHashPin;
  readonly manifest?: string;
  readonly image?: {
    readonly from: string;
    readonly to: string;
  };
  readonly outputs?: readonly string[];
  readonly blocks: readonly string[];
};

type RaucStep = {
  readonly id: "create-unsigned-rauc-bundle" | "declare-owner-rauc-signing";
  readonly kind: string;
  readonly status: "blocked" | "ready" | "declared-non-executable";
  readonly executable: false;
  readonly gatedBy: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly input: string;
  readonly output: string;
  readonly command?: RaucCommand;
};

type RaucPlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly config: {
    readonly path: "os/x86_64/rauc-bundle.conf";
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
    readonly executable: "rauc";
    readonly command: "bundle";
    readonly noSign: true;
    readonly network: "none";
  };
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly update: {
    readonly compatible: "vita-x86_64";
    readonly version: string;
  };
  readonly inputs: {
    readonly external: readonly RaucRootfsImage[];
    readonly produced: readonly ProducedInput[];
  };
  readonly outputs: {
    readonly bundle: {
      readonly name: string;
      readonly kind: "rauc-bundle";
      readonly format: "plain";
      readonly signed: false;
      readonly path: string;
    };
  };
  readonly slots: {
    readonly compatible: "vita-x86_64";
    readonly targetClass: "rootfs";
    readonly installPolicy: "rauc-selects-inactive-rootfs-slot";
    readonly map: readonly RaucSlot[];
  };
  readonly manifest: {
    readonly path: string;
    readonly filename: "manifest.raucm";
    readonly digest: `sha256:${string}`;
    readonly text: string;
    readonly update: {
      readonly compatible: "vita-x86_64";
      readonly version: string;
    };
    readonly images: readonly {
      readonly section: "image.rootfs";
      readonly slotClass: "rootfs";
      readonly filename: string;
      readonly sourceImage: "verity-rootfs-image";
      readonly sha256: {
        readonly source: "external-precondition";
        readonly resolved: boolean;
        readonly placeholder?: string;
        readonly digest?: `sha256:${string}`;
        readonly value: string;
        readonly pin: DigestPin;
      };
    }[];
  };
  readonly preconditions: readonly RaucPrecondition[];
  readonly steps: readonly RaucStep[];
  readonly command: RaucCommand;
  readonly signing: {
    readonly mode: "owner-rauc-key-step-4c";
    readonly step: "declare-only";
    readonly executable: false;
    readonly materialInRepo: false;
    readonly bundleInput: string;
    readonly productionSigning: {
      readonly included: false;
      readonly ownerOnly: true;
      readonly disposition: "owner-only-out-of-band";
    };
  };
};

type RaucModule = {
  readonly planRaucBundle: (input?: unknown) => RaucPlan;
  readonly serializeRaucBundlePlan: (plan: RaucPlan) => string;
  readonly DEFAULT_RAUC_BUNDLE_CONFIG_TEXT: string;
  readonly DEFAULT_RAUC_BUNDLE_COMPATIBLE: string;
  readonly DEFAULT_RAUC_BUNDLE_VERSION: string;
  readonly DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH: string;
};

type ImageLayoutModule = {
  readonly planImageLayout: (input?: unknown) => {
    readonly slots: {
      readonly map: readonly {
        readonly name: string;
        readonly class: string;
        readonly partitionId: string;
        readonly rootLabel: string;
      }[];
    };
  };
};

const raucBundleModuleUrl = new URL("../rauc-bundle.mjs", import.meta.url);
const raucBundleConfigUrl = new URL("../rauc-bundle.conf", import.meta.url);
const imageLayoutModuleUrl = new URL("../image-layout.mjs", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

const resolvedImageDigest = sha256("fixture p1-028 verity rootfs image\n");
const resolvedRootHash = createHash("sha256").update("fixture p1-028 verity root hash\n", "utf8").digest("hex");

test("planRaucBundle is byte deterministic and matches the committed config text", async () => {
  const rauc = await loadRaucModule();
  const input = await readPlanInput();
  const firstPlan = rauc.planRaucBundle(input);
  const secondPlan = rauc.planRaucBundle(input);
  const defaultPlan = rauc.planRaucBundle();

  assert.equal(input.configText, rauc.DEFAULT_RAUC_BUNDLE_CONFIG_TEXT);
  assert.equal(rauc.serializeRaucBundlePlan(firstPlan), rauc.serializeRaucBundlePlan(secondPlan));
  assert.equal(
    rauc.serializeRaucBundlePlan(defaultPlan),
    rauc.serializeRaucBundlePlan(rauc.planRaucBundle(planInput(rauc.DEFAULT_RAUC_BUNDLE_CONFIG_TEXT))),
  );
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.config.path, "os/x86_64/rauc-bundle.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
  assert.equal(firstPlan.update.compatible, rauc.DEFAULT_RAUC_BUNDLE_COMPATIBLE);
  assert.equal(firstPlan.update.version, rauc.DEFAULT_RAUC_BUNDLE_VERSION);
  assert.equal(firstPlan.environment.SOURCE_DATE_EPOCH, rauc.DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH);
});

test("manifest declares the rootfs slot class with unresolved external sha256", async () => {
  const rauc = await loadRaucModule();
  const plan = rauc.planRaucBundle(await readPlanInput());
  const rootfsImage = onlyExternalImage(plan);
  const manifestInput = findProducedManifest(plan);
  const manifestImage = onlyManifestImage(plan);

  assert.equal(rootfsImage.source, "external-precondition");
  assert.equal(rootfsImage.contract, "P1-028");
  assert.equal(rootfsImage.slotClass, "rootfs");
  assert.equal(rootfsImage.filename, "vita-x86_64-rootfs.verity.ext4");
  assert.equal(rootfsImage.path, "/external/p1-028/vita-x86_64-rootfs.verity.ext4");
  assert.equal(rootfsImage.bundlePath, "/plan/rauc-input/vita-x86_64-rootfs.verity.ext4");
  assertUnresolvedDigestPin(rootfsImage.pin);
  assertUnresolvedRootHash(rootfsImage.rootHash);

  assert.equal(plan.manifest.path, "/plan/rauc-input/manifest.raucm");
  assert.equal(plan.manifest.digest, sha256(plan.manifest.text));
  assert.equal(manifestInput.digest, plan.manifest.digest);
  assert.equal(manifestInput.text, plan.manifest.text);
  assert.deepEqual(plan.manifest.update, {
    compatible: "vita-x86_64",
    version: "0.1-bootstrap",
  });
  assert.deepEqual(plan.manifest.text.split("\n"), [
    "[update]",
    "compatible=vita-x86_64",
    "version=0.1-bootstrap",
    "",
    "[image.rootfs]",
    "filename=vita-x86_64-rootfs.verity.ext4",
    "sha256=${image.rootfs.sha256}",
    "",
  ]);
  assert.equal(manifestImage.section, "image.rootfs");
  assert.equal(manifestImage.slotClass, "rootfs");
  assert.equal(manifestImage.filename, rootfsImage.filename);
  assert.equal(manifestImage.sourceImage, rootfsImage.name);
  assert.equal(manifestImage.sha256.source, "external-precondition");
  assert.equal(manifestImage.sha256.resolved, false);
  assert.equal(manifestImage.sha256.placeholder, "${image.rootfs.sha256}");
  assert.equal(manifestImage.sha256.value, "${image.rootfs.sha256}");
});

test("rauc bundle command is unsigned and writes vita-<version>.raucx", async () => {
  const rauc = await loadRaucModule();
  const plan = rauc.planRaucBundle(await readPlanInput());
  const step = findStep(plan, "create-unsigned-rauc-bundle");

  assert.equal(plan.tool.executable, "rauc");
  assert.equal(plan.tool.command, "bundle");
  assert.equal(plan.tool.noSign, true);
  assert.equal(plan.outputs.bundle.name, "vita-0.1-bootstrap.raucx");
  assert.equal(plan.outputs.bundle.path, "/out/vita-0.1-bootstrap.raucx");
  assert.equal(plan.outputs.bundle.signed, false);
  assert.equal(plan.command.executable, "rauc");
  assert.equal(plan.command.unsigned, true);
  assert.deepEqual(plan.command.args, [
    "bundle",
    "--no-sign",
    "/plan/rauc-input",
    "/out/vita-0.1-bootstrap.raucx",
  ]);
  assert.equal(argValue(plan.command.args, "--no-sign"), "/plan/rauc-input");
  assert.equal(plan.command.output.endsWith(".raucx"), true);
  assert.doesNotMatch(plan.command.args.join(" "), /--cert|--key|PRIVATE KEY|-----BEGIN/u);

  assert.equal(step.executable, false);
  assert.equal(step.command, plan.command);
  assert.equal(step.input, "/plan/rauc-input");
  assert.equal(step.output, "/out/vita-0.1-bootstrap.raucx");
  assert.ok(step.blockedBy?.includes("verify-verity-rootfs-image:verity-rootfs-image:unresolved-digest"));
  assert.ok(step.blockedBy?.includes("capture-verity-root-hash:rootfs:unresolved-root-hash"));
});

test("A/B rootfs slots match planImageLayout root-a/root-b and exclude recovery", async () => {
  const rauc = await loadRaucModule();
  const imageLayout = await loadImageLayoutModule();
  const raucPlan = rauc.planRaucBundle(await readPlanInput());
  const imageLayoutPlan = imageLayout.planImageLayout();
  const layoutRootfsSlots = imageLayoutPlan.slots.map.filter((slot) => slot.class === "rootfs");

  assert.deepEqual(
    raucPlan.slots.map.map((slot) => [slot.name, slot.class, slot.index, slot.partition, slot.rootLabel]),
    [
      ["rootfs.0", "rootfs", 0, "root-a", "vita-root-a"],
      ["rootfs.1", "rootfs", 1, "root-b", "vita-root-b"],
    ],
  );
  assert.deepEqual(
    raucPlan.slots.map.map((slot) => [slot.name, slot.partition, slot.rootLabel]),
    layoutRootfsSlots.map((slot) => [slot.name, slot.partitionId, slot.rootLabel]),
  );
  assert.equal(raucPlan.slots.targetClass, "rootfs");
  assert.equal(raucPlan.slots.map.length, 2);
});

test("resolved image digest and root hash bind manifest sha256 without changing command shape", async () => {
  const rauc = await loadRaucModule();
  const configText = withConfigReplacements(await readConfigText(), [
    ["ImageRootfs", "Digest", resolvedImageDigest],
    ["ImageRootfs", "RootHash", resolvedRootHash],
  ]);
  const plan = rauc.planRaucBundle(planInput(configText));
  const rootfsImage = onlyExternalImage(plan);
  const manifestImage = onlyManifestImage(plan);
  const expectedHex = resolvedImageDigest.slice("sha256:".length);

  assertResolvedDigestPin(rootfsImage.pin, resolvedImageDigest);
  assertResolvedRootHash(rootfsImage.rootHash, resolvedRootHash);
  assert.equal(manifestImage.sha256.resolved, true);
  assert.equal(manifestImage.sha256.digest, resolvedImageDigest);
  assert.equal(manifestImage.sha256.value, expectedHex);
  assert.match(plan.manifest.text, new RegExp(`^sha256=${expectedHex}$`, "mu"));
  assert.doesNotMatch(plan.manifest.text, /\$\{image\.rootfs\.sha256\}/u);
  assert.equal(findPrecondition(plan, "verify-verity-rootfs-image").status, "pending-runtime-verification");
  assert.equal(findPrecondition(plan, "capture-verity-root-hash").status, "pending-runtime-verification");
  assert.equal(findPrecondition(plan, "stage-rauc-bundle-input").status, "ready");
  assert.equal(findStep(plan, "create-unsigned-rauc-bundle").status, "ready");
  assert.deepEqual(plan.command.args, [
    "bundle",
    "--no-sign",
    "/plan/rauc-input",
    "/out/vita-0.1-bootstrap.raucx",
  ]);
});

test("signing is declare-only and contains no key material or signing command args", async () => {
  const rauc = await loadRaucModule();
  const plan = rauc.planRaucBundle(await readPlanInput());
  const signingStep = findStep(plan, "declare-owner-rauc-signing");
  const serialized = rauc.serializeRaucBundlePlan(plan);

  assert.deepEqual(plan.signing, {
    mode: "owner-rauc-key-step-4c",
    step: "declare-only",
    executable: false,
    materialInRepo: false,
    bundleInput: "/out/vita-0.1-bootstrap.raucx",
    productionSigning: {
      included: false,
      ownerOnly: true,
      disposition: "owner-only-out-of-band",
    },
  });
  assert.equal(signingStep.executable, false);
  assert.equal(signingStep.status, "declared-non-executable");
  assert.equal(signingStep.input, plan.outputs.bundle.path);
  assert.equal(signingStep.output, plan.outputs.bundle.path);
  assert.doesNotMatch(serialized, /-----BEGIN|PRIVATE KEY|CERTIFICATE|VITA_PROD|RELEASE_SIGNING_KEY/u);
  assert.doesNotMatch(plan.command.args.join(" "), /--cert|--key/u);
});

test("invalid paths, placeholder digests, and embedded key material are rejected", async () => {
  const rauc = await loadRaucModule();
  const configText = await readConfigText();

  const invalidConfigValues = [
    ["ImageRootfs", "Path", "/external/../p1-028/root.ext4", /ImageRootfs\.Path must not contain \. or \.\. segments/u],
    ["Bundle", "Manifest", "/plan/manifest.raucm", /Bundle\.Manifest must stay within mount root \/plan\/rauc-input/u],
    ["Bundle", "Output", "/out/vita-0.1-bootstrap.raucb", /Bundle\.Output expected \/out\/vita-0\.1-bootstrap\.raucx/u],
    ["Paths", "PlanRoot", "//plan", /Paths\.PlanRoot must not contain empty or duplicate-slash segments/u],
    ["ImageRootfs", "Filename", "../rootfs.ext4", /ImageRootfs\.Filename must be a stable relative filename/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigValues) {
    assert.throws(() => rauc.planRaucBundle(planInput(replaceConfigSetting(configText, section, key, value))), message);
  }

  assert.throws(
    () =>
      rauc.planRaucBundle(
        planInput(replaceConfigSetting(configText, "ImageRootfs", "Digest", `sha256:${"1".repeat(64)}`)),
      ),
    /ImageRootfs\.Digest must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () => rauc.planRaucBundle(planInput(replaceConfigSetting(configText, "ImageRootfs", "RootHash", "deadbeef".repeat(8)))),
    /ImageRootfs\.RootHash must not use a placeholder or sentinel digest/u,
  );
  assert.throws(
    () =>
      rauc.planRaucBundle(
        planInput(replaceConfigSetting(configText, "Signing", "ProductionSigning", "-----BEGIN PRIVATE KEY-----")),
      ),
    /Signing\.ProductionSigning must reference key material, not embed it/u,
  );
  assert.throws(
    () =>
      rauc.planRaucBundle({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/../out" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      rauc.planRaucBundle({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/u,
  );
});

test("planRaucBundle rejects partial, accessor-bearing, cyclic, and hostile inputs through safeNormalize", async () => {
  const rauc = await loadRaucModule();
  const configText = await readConfigText();

  assert.throws(() => rauc.planRaucBundle({ configText: "partial" }), /missing required field mountRoots/u);

  let topLevelAccessorInvoked = false;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      topLevelAccessorInvoked = true;
      return configText;
    },
    enumerable: true,
  });
  assert.throws(() => rauc.planRaucBundle(accessorInput), /RAUC bundle plan input normalization failed/u);
  assert.equal(topLevelAccessorInvoked, false);

  let nestedAccessorInvoked = false;
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
      nestedAccessorInvoked = true;
      return "/repo/os/x86_64/out";
    },
    enumerable: true,
  });
  assert.throws(
    () => rauc.planRaucBundle({ configText, mountRoots: accessorMountRoots }),
    /RAUC bundle plan input normalization failed/u,
  );
  assert.equal(nestedAccessorInvoked, false);

  let hostileIteratorInvoked = false;
  const hostileIteratorMountRoots: Record<PropertyKey, unknown> = { ...defaultMountRoots };
  hostileIteratorMountRoots[Symbol.iterator] = () => {
    hostileIteratorInvoked = true;
    return [][Symbol.iterator]();
  };
  assert.throws(
    () => rauc.planRaucBundle({ configText, mountRoots: hostileIteratorMountRoots }),
    /RAUC bundle plan input normalization failed/u,
  );
  assert.equal(hostileIteratorInvoked, false);

  const cyclicMountRoots: Record<string, unknown> = { ...defaultMountRoots };
  cyclicMountRoots["self"] = cyclicMountRoots;
  assert.throws(
    () => rauc.planRaucBundle({ configText, mountRoots: cyclicMountRoots }),
    /RAUC bundle plan input normalization failed/u,
  );

  let proxyOwnKeysInvoked = false;
  const proxyInput = new Proxy(
    { configText, mountRoots: defaultMountRoots },
    {
      ownKeys() {
        proxyOwnKeysInvoked = true;
        return ["configText", "mountRoots"];
      },
    },
  );
  assert.throws(() => rauc.planRaucBundle(proxyInput), /RAUC bundle plan input normalization failed/u);
  assert.equal(proxyOwnKeysInvoked, false);
});

async function readPlanInput(): Promise<RaucBundlePlanInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(raucBundleConfigUrl, "utf8");
}

function planInput(configText: string): RaucBundlePlanInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadRaucModule(): Promise<RaucModule> {
  const moduleValue: unknown = await import(raucBundleModuleUrl.href);
  return asRaucModule(moduleValue);
}

function asRaucModule(value: unknown): RaucModule {
  const record = asRecord(value, "rauc-bundle module");
  const planRaucBundle = record["planRaucBundle"];
  const serializeRaucBundlePlan = record["serializeRaucBundlePlan"];
  const defaultConfigText = record["DEFAULT_RAUC_BUNDLE_CONFIG_TEXT"];
  const compatible = record["DEFAULT_RAUC_BUNDLE_COMPATIBLE"];
  const version = record["DEFAULT_RAUC_BUNDLE_VERSION"];
  const sourceDateEpoch = record["DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH"];

  assert.equal(typeof planRaucBundle, "function");
  assert.equal(typeof serializeRaucBundlePlan, "function");

  return {
    planRaucBundle: (input?: unknown) => {
      const result = (planRaucBundle as (input?: unknown) => unknown)(input);
      asRecord(result, "RAUC bundle plan");
      return result as RaucPlan;
    },
    serializeRaucBundlePlan: (plan: RaucPlan) =>
      (serializeRaucBundlePlan as (plan: RaucPlan) => string)(plan),
    DEFAULT_RAUC_BUNDLE_CONFIG_TEXT: asString(defaultConfigText, "DEFAULT_RAUC_BUNDLE_CONFIG_TEXT"),
    DEFAULT_RAUC_BUNDLE_COMPATIBLE: asString(compatible, "DEFAULT_RAUC_BUNDLE_COMPATIBLE"),
    DEFAULT_RAUC_BUNDLE_VERSION: asString(version, "DEFAULT_RAUC_BUNDLE_VERSION"),
    DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH: asString(sourceDateEpoch, "DEFAULT_RAUC_BUNDLE_SOURCE_DATE_EPOCH"),
  };
}

async function loadImageLayoutModule(): Promise<ImageLayoutModule> {
  const moduleValue: unknown = await import(imageLayoutModuleUrl.href);
  const record = asRecord(moduleValue, "image-layout module");
  const planImageLayout = record["planImageLayout"];
  assert.equal(typeof planImageLayout, "function");
  return {
    planImageLayout: (input?: unknown) => {
      const result = (planImageLayout as (input?: unknown) => unknown)(input);
      asRecord(result, "image layout plan");
      return result as ReturnType<ImageLayoutModule["planImageLayout"]>;
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

function onlyExternalImage(plan: RaucPlan): RaucRootfsImage {
  assert.equal(plan.inputs.external.length, 1);
  const input = plan.inputs.external[0];
  if (input === undefined) {
    assert.fail("external rootfs image must be declared");
  }
  return input;
}

function findProducedManifest(plan: RaucPlan): Extract<ProducedInput, { readonly name: "manifest.raucm" }> {
  for (const input of plan.inputs.produced) {
    if (input.name === "manifest.raucm") {
      return input;
    }
  }
  assert.fail("manifest.raucm produced input must be declared");
}

function onlyManifestImage(plan: RaucPlan): RaucPlan["manifest"]["images"][number] {
  assert.equal(plan.manifest.images.length, 1);
  const image = plan.manifest.images[0];
  if (image === undefined) {
    assert.fail("manifest image must be declared");
  }
  return image;
}

function findPrecondition(plan: RaucPlan, id: RaucPrecondition["id"]): RaucPrecondition {
  for (const precondition of plan.preconditions) {
    if (precondition.id === id) {
      return precondition;
    }
  }
  assert.fail(`${id} precondition must be declared`);
}

function findStep(plan: RaucPlan, id: RaucStep["id"]): RaucStep {
  for (const step of plan.steps) {
    if (step.id === id) {
      return step;
    }
  }
  assert.fail(`${id} step must be declared`);
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

function assertResolvedDigestPin(pin: DigestPin, expectedDigest: `sha256:${string}`): asserts pin is ResolvedDigestPin {
  if (!pin.resolved) {
    assert.fail(`expected resolved digest ${expectedDigest}`);
  }
  assert.equal(pin.digest, expectedDigest);
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

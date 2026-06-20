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

type ExternalInputName = "kernel" | "initrd" | "stub";

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

type UKIStep = {
  readonly id: "assemble-uki" | "declare-test-signing";
  readonly kind: string;
  readonly status: string;
  readonly executable?: false;
  readonly gatedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly input?: string;
  readonly output: string;
  readonly command?: CommandPlan;
};

type UKIPlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
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
    readonly cmdline: {
      readonly value: string;
      readonly digest: `sha256:${string}`;
    };
  };
  readonly outputs: {
    readonly unsignedUKI: string;
    readonly testSignedUKI: string;
  };
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
  readonly command: CommandPlan;
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

const ukiModuleUrl = new URL("../uki.mjs", import.meta.url);
const ukiConfigUrl = new URL("../uki.conf", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  externalInputsHostPath: "/repo/os/x86_64/upstream-inputs",
  planInputsHostPath: "/repo/os/x86_64/generated-inputs",
  outputHostPath: "/repo/os/x86_64/out",
} as const satisfies MountRoots;

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
  assert.equal(firstPlan.config.digest, sha256(input.configText));
});

test("external kernel inputs are preconditions, not self-produced artifacts", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());
  const externalInputPaths = new Set(plan.inputs.external.map((entry) => entry.path));
  const producedInputPaths = new Set(plan.inputs.produced.map((entry) => entry.containerPath));

  assert.deepEqual(plan.inputs.external.map((entry) => entry.name), ["kernel", "initrd", "stub"]);
  for (const input of plan.inputs.external) {
    assert.equal(input.source, "external-precondition");
    assert.equal(input.mountRoot, "/external");
    assert.equal(input.pin.resolved, false);
    assert.equal(input.pin.required, true);
    assert.equal(input.pin.status, "unresolved");
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
  assert.deepEqual(precondition.blocks, ["assemble-uki"]);
  assert.deepEqual(precondition.verifies.map((entry) => entry.name), ["kernel", "initrd", "stub"]);

  const assemble = findStep(plan, "assemble-uki");
  assert.equal(assemble.status, "blocked");
  assert.deepEqual(assemble.gatedBy, ["verify-external-uki-inputs"]);
  assert.ok(assemble.blockedBy.includes("verify-external-uki-inputs:kernel:unresolved-digest"));

  const commandInputPaths = [
    argValue(plan.command.ukifyArgs, "--linux"),
    argValue(plan.command.ukifyArgs, "--initrd"),
    argValue(plan.command.ukifyArgs, "--stub"),
    argValue(plan.command.ukifyArgs, "--os-release"),
  ];
  for (const commandPath of commandInputPaths) {
    assert.ok(
      externalInputPaths.has(commandPath) || producedInputPaths.has(commandPath),
      `${commandPath} must be declared as an external or produced input`,
    );
  }
  assert.equal(argValue(plan.command.ukifyArgs, "--output"), plan.outputs.unsignedUKI);
});

test("resolved real fixture digests become pinned external preconditions", async () => {
  const uki = await loadUKIModule();
  const configText = withConfigReplacements(await readConfigText(), [
    ["Kernel", "Digest", sha256("fixture kernel\n")],
    ["Initrd", "Digest", sha256("fixture initrd\n")],
    ["Stub", "Digest", sha256("fixture systemd stub\n")],
  ]);
  const plan = uki.planUKI(planInput(configText));

  assertResolvedPin(findExternalInput(plan, "kernel").pin, sha256("fixture kernel\n"));
  assertResolvedPin(findExternalInput(plan, "initrd").pin, sha256("fixture initrd\n"));
  assertResolvedPin(findExternalInput(plan, "stub").pin, sha256("fixture systemd stub\n"));
  assert.equal(findPrecondition(plan).status, "pending-runtime-verification");
  assert.deepEqual(findStep(plan, "assemble-uki").blockedBy, [
    "verify-external-uki-inputs:pending-runtime-verification",
  ]);
});

test("tooling, environment, and network policy are pinned and deterministic", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());

  assert.equal(plan.tool.engine, "docker");
  assert.equal(plan.tool.image, uki.PINNED_UKIFY_IMAGE);
  assert.match(plan.tool.image, /^ghcr\.io\/systemd\/mkosi@sha256:[0-9a-f]{64}$/);
  assert.equal(plan.tool.pullPolicy, "never");
  assert.equal(plan.tool.network, "none");
  assert.equal(plan.network, "none");
  assert.equal(plan.command.executable, "docker");
  assert.ok(plan.command.args.includes("--pull=never"));
  assert.deepEqual(plan.command.args.slice(3, 5), ["--network", "none"]);
  assert.equal(plan.environment.SOURCE_DATE_EPOCH, uki.DEFAULT_SOURCE_DATE_EPOCH);
  assert.deepEqual(plan.environment, {
    SOURCE_DATE_EPOCH: "1781308800",
    TZ: "UTC",
    LC_ALL: "C.UTF-8",
  });
  assert.ok(plan.command.args.includes("SOURCE_DATE_EPOCH=1781308800"));
});

test("signing is a non-executable TEST-key declaration with locked TEST env names", async () => {
  const uki = await loadUKIModule();
  const plan = uki.planUKI(await readPlanInput());
  const serialized = uki.serializeUKIPlan(plan);

  assert.equal(plan.signing.mode, "test-runtime-path");
  assert.equal(plan.signing.step, "declare-only");
  assert.equal(plan.signing.executable, false);
  assert.equal(plan.signing.materialInRepo, false);
  assert.match(plan.signing.key.id, /^test:/);
  assert.match(plan.signing.cert.id, /^test:/);
  assert.equal(plan.signing.key.pathEnv, uki.TEST_KEY_PATH_ENV);
  assert.equal(plan.signing.cert.pathEnv, uki.TEST_CERT_PATH_ENV);
  assert.equal(plan.signing.key.containerPath, "/test-keys/db.key");
  assert.equal(plan.signing.cert.containerPath, "/test-keys/db.crt");
  assert.deepEqual(plan.signing.runtimeMount.hostPathEnv, [
    "VITA_TEST_SECUREBOOT_KEY_PATH",
    "VITA_TEST_SECUREBOOT_CERT_PATH",
  ]);
  assert.equal(plan.signing.tool.image, uki.PINNED_UKIFY_IMAGE);
  assert.equal(plan.signing.tool.executable, "ukify");
  assert.equal(plan.signing.tool.network, "none");
  assert.equal(plan.signing.productionSigning.included, false);
  assert.equal(plan.signing.productionSigning.ownerOnly, true);
  assert.equal(findStep(plan, "declare-test-signing").executable, false);
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
    /Signing\.TestKeyPathEnv must be VITA_TEST_SECUREBOOT_KEY_PATH/,
  );
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "Signing", "TestCertPathEnv", "VITA_PROD_SECUREBOOT_CERT_PATH")),
      ),
    /Signing\.TestCertPathEnv must be VITA_TEST_SECUREBOOT_CERT_PATH/,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Signing", "TestKeyId", "prod:vita-secureboot"))),
    /Signing\.TestKeyId must be a test: reference/,
  );
  assert.throws(
    () =>
      uki.planUKI(
        planInput(replaceConfigSetting(configText, "Signing", "TestCertId", "test:production-secureboot-cert")),
      ),
    /Signing\.TestCertId must not reference production, release, or owner keys/,
  );
});

test("placeholder digests are rejected and never treated as pinned", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();

  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Kernel", "Digest", `sha256:${"1".repeat(64)}`))),
    /Kernel\.Digest must not use a placeholder or sentinel digest/,
  );
  assert.throws(
    () =>
      uki.planUKI(planInput(replaceConfigSetting(configText, "Initrd", "Digest", `sha256:${"deadbeef".repeat(8)}`))),
    /Initrd\.Digest must not use a placeholder or sentinel digest/,
  );
  assert.throws(
    () => uki.planUKI(planInput(replaceConfigSetting(configText, "Stub", "Digest", "sha256:ABC"))),
    /Stub\.Digest must be sha256 followed by exactly 64 lowercase hex characters/,
  );
});

test("canonical POSIX path validation rejects traversal, duplicate slashes, controls, and mount escapes", async () => {
  const uki = await loadUKIModule();
  const configText = await readConfigText();
  const invalidConfigPaths = [
    ["Kernel", "Path", "/external/../plan/x", /Kernel\.Path must not contain \. or \.\. segments/u],
    ["UKI", "Output", "/out/../work/x", /UKI\.Output must not contain \. or \.\. segments/u],
    ["Paths", "ExternalRoot", "//x", /Paths\.ExternalRoot must not contain empty or duplicate-slash segments/u],
    ["Kernel", "Path", "/a/./b", /Kernel\.Path must not contain \. or \.\. segments/u],
    ["Initrd", "Path", "/external/initrd\u0001.img", /Initrd\.Path must not contain control characters/u],
    ["Stub", "Path", "/plan/linuxx64.efi.stub", /Stub\.Path must stay within mount root \/external/u],
    ["Signing", "KeyContainerPath", "/test-keys/../db.key", /Signing\.KeyContainerPath must not contain \. or \.\. segments/u],
    ["Signing", "SignedOutput", "/out/../work/x", /Signing\.SignedOutput must not contain \. or \.\. segments/u],
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
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/,
  );
  assert.throws(
    () =>
      uki.planUKI({
        configText,
        mountRoots: { ...defaultMountRoots, externalInputsHostPath: "/repo-other/upstream-inputs" },
      }),
    /mountRoots\.externalInputsHostPath must stay within mount root \/repo/,
  );
});

test("planUKI rejects partial and accessor-bearing top-level inputs before planning", async () => {
  const uki = await loadUKIModule();

  assert.throws(() => uki.planUKI({ configText: "partial" }), /missing required field mountRoots/);

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      return "untrusted";
    },
    enumerable: true,
  });
  assert.throws(() => uki.planUKI(accessorInput), /property configText must be a data property/);
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

function findExternalInput(plan: UKIPlan, name: ExternalInputName): ExternalUKIInput {
  const input = plan.inputs.external.find((entry) => entry.name === name);
  if (input === undefined) {
    assert.fail(`${name} input must be declared`);
  }
  return input;
}

function findPrecondition(plan: UKIPlan): UKIPrecondition {
  const precondition = plan.preconditions.find((entry) => entry.id === "verify-external-uki-inputs");
  if (precondition === undefined) {
    assert.fail("verify precondition must be declared");
  }
  return precondition;
}

function findStep(plan: UKIPlan, id: UKIStep["id"]): UKIStep {
  const step = plan.steps.find((entry) => entry.id === id);
  if (step === undefined) {
    assert.fail(`${id} step must be declared`);
  }
  return step;
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

function assertResolvedPin(pin: DigestPin, expectedDigest: `sha256:${string}`): asserts pin is ResolvedDigestPin {
  if (!pin.resolved) {
    assert.fail(`expected resolved pin ${expectedDigest}`);
  }
  assert.equal(pin.digest, expectedDigest);
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

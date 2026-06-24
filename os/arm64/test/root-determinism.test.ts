import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type RootBuildInput = {
  readonly commonConfigText: string;
  readonly archConfigText: string;
  readonly workspacePath: string;
  readonly outputPath: string;
};

type ConfigLayer = {
  readonly name: string;
  readonly hostPath: string;
  readonly containerPath: string;
  readonly digest: string;
  readonly includes?: readonly string[];
  readonly resolvedIncludes?: readonly string[];
};

type VitaOverlay = {
  readonly name: "ts-overlay" | "agent-overlay";
  readonly kind: string;
  readonly relativePath: string;
  readonly containerPath: string;
  readonly x86Reference?: string;
  readonly configPath?: string;
  readonly requiredPaths: readonly string[];
};

type RootBuildPlan = {
  readonly schemaVersion: 1;
  readonly target: "arm64";
  readonly builder: {
    readonly engine: "docker";
    readonly image: string;
    readonly pullPolicy: "never";
    readonly network: "none";
    readonly workdir: string;
  };
  readonly config: {
    readonly commonPath: string;
    readonly archPath: string;
    readonly includeChain: readonly ConfigLayer[];
    readonly distribution: "debian";
    readonly release: "trixie";
    readonly snapshot: string;
    readonly mirror: string;
    readonly repositories: readonly string[];
    readonly architecture: "arm64";
    readonly mkosiArchitecture: "arm64";
    readonly outputFormat: "directory";
    readonly output: string;
    readonly imageVersion: string;
    readonly immutableRoot: true;
    readonly basePackages: false;
    readonly bootable: false;
    readonly cleanPackageMetadata: true;
    readonly withNetwork: false;
    readonly packages: readonly string[];
    readonly sourceDateEpoch: string;
  };
  readonly overlays: {
    readonly appliedBy: "mkosi --extra-tree";
    readonly required: true;
    readonly extraTrees: readonly VitaOverlay[];
  };
  readonly environment: {
    readonly SOURCE_DATE_EPOCH: string;
    readonly TZ: "UTC";
    readonly LC_ALL: "C.UTF-8";
  };
  readonly command: {
    readonly executable: "docker";
    readonly args: readonly string[];
    readonly mkosiArgs: readonly string[];
  };
};

type BuildRootModule = {
  readonly planRootBuild: (input?: unknown) => RootBuildPlan;
  readonly serializeRootBuildPlan: (plan: RootBuildPlan) => string;
  readonly PINNED_MKOSI_IMAGE: string;
  readonly DEFAULT_DEBIAN_SNAPSHOT: string;
  readonly DEFAULT_PACKAGE_ALLOWLIST_ARM64: readonly string[];
  readonly DEFAULT_SOURCE_DATE_EPOCH: string;
};

type X86BuildRootModule = {
  readonly DEFAULT_DEBIAN_SNAPSHOT: string;
  readonly DEFAULT_PACKAGE_ALLOWLIST: readonly string[];
  readonly DEFAULT_SOURCE_DATE_EPOCH: string;
  readonly PINNED_MKOSI_IMAGE: string;
};

const buildRootModuleUrl = new URL("../build-root.mjs", import.meta.url);
const x86BuildRootModuleUrl = new URL("../../x86_64/build-root.mjs", import.meta.url);
const commonConfigUrl = new URL("../../common/mkosi.conf", import.meta.url);
const archConfigUrl = new URL("../mkosi.conf", import.meta.url);

const expectedPackageAllowlist = [
  "bash",
  "ca-certificates",
  "coreutils",
  "cryptsetup-bin",
  "dbus",
  "initramfs-tools",
  "iproute2",
  "kmod",
  "linux-image-arm64",
  "raspi-firmware",
  "nftables",
  "systemd",
  "systemd-boot",
  "systemd-boot-efi",
  "systemd-sysv",
  "udev",
  "util-linux",
] as const;

test("planRootBuild is deterministic with its default pure inputs", async () => {
  const buildRoot = await loadBuildRootModule();
  const firstPlan = buildRoot.planRootBuild();
  const secondPlan = buildRoot.planRootBuild();

  assert.equal(buildRoot.serializeRootBuildPlan(firstPlan), buildRoot.serializeRootBuildPlan(secondPlan));
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "arm64");
  assert.equal(firstPlan.config.release, "trixie");
  assert.equal(firstPlan.config.withNetwork, false);
  assert.deepEqual(firstPlan.config.packages, expectedPackageAllowlist);
  assert.equal(Object.isFrozen(firstPlan), true);
  assert.equal(Object.isFrozen(firstPlan.config.packages), true);
  assert.equal(Object.isFrozen(firstPlan.overlays.extraTrees), true);
});

test("planRootBuild resolves both mkosi config layers deterministically", async () => {
  const buildRoot = await loadBuildRootModule();
  const input = await readPlanInput();

  const firstPlan = buildRoot.planRootBuild(input);
  const secondPlan = buildRoot.planRootBuild(input);
  assert.equal(buildRoot.serializeRootBuildPlan(firstPlan), buildRoot.serializeRootBuildPlan(secondPlan));

  assert.equal(firstPlan.config.commonPath, "os/common/mkosi.conf");
  assert.equal(firstPlan.config.archPath, "os/arm64/mkosi.conf");
  assert.equal(firstPlan.config.includeChain.length, 2);
  assert.equal(firstPlan.config.includeChain[0]?.name, "common");
  assert.equal(firstPlan.config.includeChain[0]?.containerPath, "/work/os/common/mkosi.conf");
  assert.equal(firstPlan.config.includeChain[0]?.digest, sha256(input.commonConfigText));
  assert.equal(firstPlan.config.includeChain[1]?.name, "arm64");
  assert.equal(firstPlan.config.includeChain[1]?.containerPath, "/work/os/arm64/mkosi.conf");
  assert.deepEqual(firstPlan.config.includeChain[1]?.includes, ["../common/mkosi.conf"]);
  assert.deepEqual(firstPlan.config.includeChain[1]?.resolvedIncludes, ["/work/os/common/mkosi.conf"]);
  assert.equal(firstPlan.config.includeChain[1]?.digest, sha256(input.archConfigText));

  assert.deepEqual(firstPlan.command.mkosiArgs, [
    "--directory",
    "/work/os/arm64",
    "--force",
    "--output-dir",
    "/out",
    "--extra-tree=/work/os/arm64/ts-overlay",
    "--extra-tree=/work/os/arm64/agent-overlay",
  ]);
});

test("resolved plan carries the shared Debian snapshot, package set, and deterministic environment", async () => {
  const buildRoot = await loadBuildRootModule();
  const x86BuildRoot = await loadX86BuildRootModule();
  const plan = buildRoot.planRootBuild(await readPlanInput());

  assert.equal(plan.config.distribution, "debian");
  assert.equal(plan.config.release, "trixie");
  assert.equal(plan.config.architecture, "arm64");
  assert.equal(plan.config.mkosiArchitecture, "arm64");
  assert.equal(plan.config.snapshot, "20260613T000000Z");
  assert.equal(plan.config.snapshot, buildRoot.DEFAULT_DEBIAN_SNAPSHOT);
  assert.equal(plan.config.snapshot, x86BuildRoot.DEFAULT_DEBIAN_SNAPSHOT);
  assert.equal(plan.config.mirror, "https://snapshot.debian.org/archive/debian/20260613T000000Z/");
  assert.deepEqual(plan.config.repositories, ["main"]);
  assert.deepEqual(plan.config.packages, expectedPackageAllowlist);
  assert.deepEqual(plan.config.packages, buildRoot.DEFAULT_PACKAGE_ALLOWLIST_ARM64);

  assert.equal(plan.config.immutableRoot, true);
  assert.equal(plan.config.outputFormat, "directory");
  assert.equal(plan.config.output, "vita-debian-trixie-arm64-root");
  assert.equal(plan.config.imageVersion, "0.1-bootstrap");
  assert.equal(plan.config.basePackages, false);
  assert.equal(plan.config.bootable, false);
  assert.equal(plan.config.cleanPackageMetadata, true);
  assert.equal(plan.config.withNetwork, false);

  assert.equal(plan.config.sourceDateEpoch, "1781308800");
  assert.equal(plan.config.sourceDateEpoch, buildRoot.DEFAULT_SOURCE_DATE_EPOCH);
  assert.equal(plan.config.sourceDateEpoch, x86BuildRoot.DEFAULT_SOURCE_DATE_EPOCH);
  assert.deepEqual(plan.environment, {
    SOURCE_DATE_EPOCH: "1781308800",
    TZ: "UTC",
    LC_ALL: "C.UTF-8",
  });
});

test("builder command is digest-pinned and declares no network", async () => {
  const buildRoot = await loadBuildRootModule();
  const x86BuildRoot = await loadX86BuildRootModule();
  const plan = buildRoot.planRootBuild(await readPlanInput());

  assert.equal(plan.builder.engine, "docker");
  assert.equal(plan.builder.image, buildRoot.PINNED_MKOSI_IMAGE);
  assert.equal(plan.builder.image, x86BuildRoot.PINNED_MKOSI_IMAGE);
  assert.match(plan.builder.image, /^ghcr\.io\/systemd\/mkosi@sha256:[0-9a-f]{64}$/u);
  assert.equal(plan.builder.pullPolicy, "never");
  assert.equal(plan.builder.network, "none");
  assert.equal(plan.command.executable, "docker");
  assert.ok(plan.command.args.includes("--pull=never"));
  assert.deepEqual(plan.command.args.slice(3, 5), ["--network", "none"]);
  assert.ok(plan.command.args.includes(buildRoot.PINNED_MKOSI_IMAGE));
  assert.ok(plan.command.args.includes("SOURCE_DATE_EPOCH=1781308800"));
});

test("arm64 package allowlist is x86 non-kernel runtime plus Pi kernel and firmware", async () => {
  const buildRoot = await loadBuildRootModule();
  const x86BuildRoot = await loadX86BuildRootModule();
  const arm64PackageSet = new Set<string>(buildRoot.DEFAULT_PACKAGE_ALLOWLIST_ARM64);

  assert.deepEqual(buildRoot.DEFAULT_PACKAGE_ALLOWLIST_ARM64, expectedPackageAllowlist);
  assert.ok(arm64PackageSet.has("linux-image-arm64"));
  assert.ok(arm64PackageSet.has("raspi-firmware"));
  assert.equal(arm64PackageSet.has("linux-image-amd64"), false);

  for (const packageName of x86BuildRoot.DEFAULT_PACKAGE_ALLOWLIST) {
    if (packageName === "linux-image-amd64") {
      continue;
    }
    assert.ok(
      arm64PackageSet.has(packageName),
      `arm64 package allowlist must retain x86 runtime member ${packageName}`,
    );
  }
  assert.equal(
    buildRoot.DEFAULT_PACKAGE_ALLOWLIST_ARM64.length,
    x86BuildRoot.DEFAULT_PACKAGE_ALLOWLIST.length + 1,
  );
});

test("planRootBuild rejects partial and accessor-bearing inputs before planning", async () => {
  const buildRoot = await loadBuildRootModule();
  assert.throws(
    () => buildRoot.planRootBuild({ commonConfigText: "partial" }),
    /missing required field archConfigText/u,
  );

  const accessorInput = {};
  Object.defineProperty(accessorInput, "commonConfigText", {
    get() {
      return "untrusted";
    },
    enumerable: true,
  });
  assert.throws(() => buildRoot.planRootBuild(accessorInput), /property commonConfigText must be a data property/u);
});

test("relabeled x86 or bare-Debian arm64 config is rejected", async () => {
  const buildRoot = await loadBuildRootModule();
  const input = await readPlanInput();

  assert.throws(
    () =>
      buildRoot.planRootBuild({
        ...input,
        archConfigText: replaceText(input.archConfigText, "Architecture=arm64", "Architecture=x86-64"),
      }),
    /Distribution\.Architecture expected arm64/u,
  );
  assert.throws(
    () =>
      buildRoot.planRootBuild({
        ...input,
        archConfigText: replaceText(input.archConfigText, "Output=vita-debian-trixie-arm64-root", "Output=vita-debian-trixie-x86_64-root"),
      }),
    /Output\.Output expected vita-debian-trixie-arm64-root/u,
  );
  assert.throws(
    () =>
      buildRoot.planRootBuild({
        ...input,
        archConfigText: input.archConfigText
          .replace("linux-image-arm64", "linux-image-amd64")
          .replace(/\n    raspi-firmware/u, ""),
      }),
    /Content\.Packages expected 17 entries, found 16/u,
  );
});

async function readPlanInput(): Promise<RootBuildInput> {
  return {
    commonConfigText: await readFile(commonConfigUrl, "utf8"),
    archConfigText: await readFile(archConfigUrl, "utf8"),
    workspacePath: "/repo",
    outputPath: "/repo/os/arm64/out",
  };
}

async function loadBuildRootModule(): Promise<BuildRootModule> {
  const moduleValue: unknown = await import(buildRootModuleUrl.href);
  return asBuildRootModule(moduleValue);
}

async function loadX86BuildRootModule(): Promise<X86BuildRootModule> {
  const moduleValue: unknown = await import(x86BuildRootModuleUrl.href);
  return asX86BuildRootModule(moduleValue);
}

function asBuildRootModule(value: unknown): BuildRootModule {
  const record = asRecord(value, "build-root module");
  const planRootBuild = record["planRootBuild"];
  const serializeRootBuildPlan = record["serializeRootBuildPlan"];
  const pinnedMkosiImage = record["PINNED_MKOSI_IMAGE"];
  const debianSnapshot = record["DEFAULT_DEBIAN_SNAPSHOT"];
  const packageAllowlist = record["DEFAULT_PACKAGE_ALLOWLIST_ARM64"];
  const sourceDateEpoch = record["DEFAULT_SOURCE_DATE_EPOCH"];

  assert.equal(typeof planRootBuild, "function");
  assert.equal(typeof serializeRootBuildPlan, "function");
  const pinnedMkosiImageValue = asString(pinnedMkosiImage, "PINNED_MKOSI_IMAGE");
  const debianSnapshotValue = asString(debianSnapshot, "DEFAULT_DEBIAN_SNAPSHOT");
  const packageAllowlistValue = asReadonlyStringArray(packageAllowlist, "DEFAULT_PACKAGE_ALLOWLIST_ARM64");
  const sourceDateEpochValue = asString(sourceDateEpoch, "DEFAULT_SOURCE_DATE_EPOCH");

  return {
    planRootBuild: (input?: unknown) => {
      const result = (planRootBuild as (input?: unknown) => unknown)(input);
      asRecord(result, "root build plan");
      return result as RootBuildPlan;
    },
    serializeRootBuildPlan: (plan: RootBuildPlan) =>
      (serializeRootBuildPlan as (plan: RootBuildPlan) => string)(plan),
    PINNED_MKOSI_IMAGE: pinnedMkosiImageValue,
    DEFAULT_DEBIAN_SNAPSHOT: debianSnapshotValue,
    DEFAULT_PACKAGE_ALLOWLIST_ARM64: packageAllowlistValue,
    DEFAULT_SOURCE_DATE_EPOCH: sourceDateEpochValue,
  };
}

function asX86BuildRootModule(value: unknown): X86BuildRootModule {
  const record = asRecord(value, "x86 build-root module");
  return {
    DEFAULT_DEBIAN_SNAPSHOT: asString(record["DEFAULT_DEBIAN_SNAPSHOT"], "x86 DEFAULT_DEBIAN_SNAPSHOT"),
    DEFAULT_PACKAGE_ALLOWLIST: asReadonlyStringArray(record["DEFAULT_PACKAGE_ALLOWLIST"], "x86 DEFAULT_PACKAGE_ALLOWLIST"),
    DEFAULT_SOURCE_DATE_EPOCH: asString(record["DEFAULT_SOURCE_DATE_EPOCH"], "x86 DEFAULT_SOURCE_DATE_EPOCH"),
    PINNED_MKOSI_IMAGE: asString(record["PINNED_MKOSI_IMAGE"], "x86 PINNED_MKOSI_IMAGE"),
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

function asReadonlyStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    assert.fail(`${label} must be an array`);
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== "string") {
      assert.fail(`${label}[${index}] must be a string`);
    }
    strings.push(entry);
  }
  return strings;
}

function replaceText(text: string, needle: string, replacement: string): string {
  assert.ok(text.includes(needle), `${needle} must be present before replacement`);
  return text.replace(needle, replacement);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

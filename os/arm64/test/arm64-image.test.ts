import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  readonly target: "arm64";
  readonly overlays: {
    readonly appliedBy: "mkosi --extra-tree";
    readonly required: true;
    readonly extraTrees: readonly VitaOverlay[];
  };
  readonly command: {
    readonly mkosiArgs: readonly string[];
  };
};

type BuildRootModule = {
  readonly planRootBuild: (input?: unknown) => RootBuildPlan;
};

type AgentConfigSummary = {
  readonly paths: {
    readonly workRoot: string;
    readonly sourceRoot: string;
    readonly outputRoot: string;
    readonly overlayRoot: string;
    readonly configPath: string;
  };
  readonly build: {
    readonly builder: string;
    readonly image: string;
    readonly moduleDir: string;
    readonly command: string;
    readonly target: string;
    readonly output: string;
    readonly cgoEnabled: string;
    readonly goOS: string;
    readonly goArch: string;
    readonly trimpath: string;
    readonly buildVcs: string;
    readonly ldflags: string;
    readonly sourceDateEpoch: string;
    readonly network: string;
  };
  readonly install: {
    readonly binary: string;
    readonly binaryMode: string;
    readonly binaryOwner: string;
    readonly symlink: string;
    readonly symlinkTarget: string;
    readonly stateDir: string;
    readonly stateDirMode: string;
    readonly stateDirOwner: string;
  };
  readonly service: {
    readonly unit: string;
    readonly unitPath: string;
    readonly wantedBy: string;
    readonly enablePath: string;
    readonly enableTarget: string;
    readonly execStart: string;
    readonly type: string;
    readonly ambientCapabilities: readonly string[];
    readonly listenAddress: string;
  };
  readonly tmpfiles: {
    readonly confPath: string;
    readonly entry: string;
  };
};

type ParsedConfig = ReadonlyMap<string, ReadonlyMap<string, string>>;

const buildRootModuleUrl = new URL("../build-root.mjs", import.meta.url);
const agentImageConfigUrl = new URL("../agent-image.conf", import.meta.url);

test("arm64 plan carries the Vita TS and agent overlays into mkosi", async () => {
  const buildRoot = await loadBuildRootModule();
  const plan = buildRoot.planRootBuild();

  assert.equal(plan.target, "arm64");
  assert.equal(plan.overlays.appliedBy, "mkosi --extra-tree");
  assert.equal(plan.overlays.required, true);
  assert.deepEqual(
    plan.overlays.extraTrees.map((overlay) => overlay.name),
    ["ts-overlay", "agent-overlay"],
  );

  const tsOverlay = findOverlay(plan, "ts-overlay");
  assert.equal(tsOverlay.kind, "typescript-runtime-overlay");
  assert.equal(tsOverlay.relativePath, "os/arm64/ts-overlay");
  assert.equal(tsOverlay.containerPath, "/work/os/arm64/ts-overlay");
  assert.equal(tsOverlay.x86Reference, "os/x86_64/ts-overlay");
  assert.ok(tsOverlay.requiredPaths.includes("/usr/lib/vita/deno"));
  assert.ok(tsOverlay.requiredPaths.includes("/usr/lib/vita/ts/main.ts"));
  assert.ok(tsOverlay.requiredPaths.includes("/usr/lib/systemd/system/vita-ts.service"));

  const agentOverlay = findOverlay(plan, "agent-overlay");
  assert.equal(agentOverlay.kind, "privileged-agent-overlay");
  assert.equal(agentOverlay.relativePath, "os/arm64/agent-overlay");
  assert.equal(agentOverlay.containerPath, "/work/os/arm64/agent-overlay");
  assert.equal(agentOverlay.configPath, "os/arm64/agent-image.conf");
  assert.ok(agentOverlay.requiredPaths.includes("/usr/lib/vita/agentd"));
  assert.ok(agentOverlay.requiredPaths.includes("/usr/bin/vita-agentd"));
  assert.ok(agentOverlay.requiredPaths.includes("/usr/lib/systemd/system/vita-agentd.service"));

  assert.ok(plan.command.mkosiArgs.includes("--extra-tree=/work/os/arm64/ts-overlay"));
  assert.ok(plan.command.mkosiArgs.includes("--extra-tree=/work/os/arm64/agent-overlay"));
});

test("arm64 agent-image.conf pins the cross-build envelope and install surface", async () => {
  const configText = await readAgentConfigText();
  const summary = assertArm64AgentConfig(configText);
  const buildArgs = buildAgentdArgs(summary);

  assert.deepEqual(summary.paths, {
    workRoot: "/work",
    sourceRoot: "/work/agent",
    outputRoot: "/work/os/arm64/out/agent",
    overlayRoot: "/work/os/arm64/agent-overlay",
    configPath: "/work/os/arm64/agent-image.conf",
  });

  assert.equal(summary.build.builder, "tools/build/go-in-docker.mjs");
  assert.equal(summary.build.image, "golang:1.26");
  assert.equal(summary.build.moduleDir, "agent");
  assert.equal(summary.build.command, "build");
  assert.equal(summary.build.target, "./cmd/agentd");
  assert.equal(summary.build.output, "/work/os/arm64/out/agent/agentd");
  assert.equal(summary.build.cgoEnabled, "0");
  assert.equal(summary.build.goOS, "linux");
  assert.equal(summary.build.goArch, "arm64");
  assert.equal(summary.build.trimpath, "true");
  assert.equal(summary.build.buildVcs, "false");
  assert.equal(summary.build.ldflags, "-s -w -buildid=");
  assert.equal(summary.build.sourceDateEpoch, "1781308800");
  assert.equal(summary.build.network, "build-time-module-fetch-only");

  assert.deepEqual(buildArgs, [
    "tools/build/go-in-docker.mjs",
    "--dir",
    "agent",
    "--env",
    "CGO_ENABLED=0",
    "--env",
    "GOOS=linux",
    "--env",
    "GOARCH=arm64",
    "--env",
    "SOURCE_DATE_EPOCH=1781308800",
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags",
    "-s -w -buildid=",
    "-o",
    "/work/os/arm64/out/agent/agentd",
    "./cmd/agentd",
  ]);

  assert.deepEqual(summary.install, {
    binary: "/usr/lib/vita/agentd",
    binaryMode: "0755",
    binaryOwner: "root:root",
    symlink: "/usr/bin/vita-agentd",
    symlinkTarget: "/usr/lib/vita/agentd",
    stateDir: "/var/lib/vita-agent",
    stateDirMode: "0700",
    stateDirOwner: "root:root",
  });
  assert.deepEqual(summary.service, {
    unit: "vita-agentd.service",
    unitPath: "/usr/lib/systemd/system/vita-agentd.service",
    wantedBy: "multi-user.target",
    enablePath: "/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service",
    enableTarget: "../vita-agentd.service",
    execStart: "/usr/lib/vita/agentd",
    type: "simple",
    ambientCapabilities: ["CAP_NET_ADMIN", "CAP_SYS_ADMIN", "CAP_SYS_TIME"],
    listenAddress: "127.0.0.1:8786",
  });
  assert.deepEqual(summary.tmpfiles, {
    confPath: "/usr/lib/tmpfiles.d/vita-agent.conf",
    entry: "d /var/lib/vita-agent 0700 root root -",
  });
});

test("agent-image.conf rejects amd64, dynamic-CGO, or no-overlay variants", async () => {
  const configText = await readAgentConfigText();

  assert.throws(
    () => assertArm64AgentConfig(replaceConfigSetting(configText, "Build", "GoArch", "amd64")),
    /Build\.GoArch expected arm64/u,
  );
  assert.throws(
    () => assertArm64AgentConfig(replaceConfigSetting(configText, "Build", "CgoEnabled", "1")),
    /Build\.CgoEnabled expected 0/u,
  );
  assert.throws(
    () => assertArm64AgentConfig(replaceConfigSetting(configText, "Build", "Ldflags", "-s -w")),
    /Build\.Ldflags expected -s -w -buildid=/u,
  );
  assert.throws(
    () => assertArm64AgentConfig(replaceConfigSetting(configText, "Paths", "OverlayRoot", "/work/os/arm64/bare-debian")),
    /Paths\.OverlayRoot expected \/work\/os\/arm64\/agent-overlay/u,
  );
});

test("bare-Debian or relabeled-x86 root plans fail the Vita overlay assertions", async () => {
  const buildRoot = await loadBuildRootModule();
  const realPlan = buildRoot.planRootBuild();
  assert.doesNotThrow(() => assertVitaOverlaysPresent(realPlan));

  assert.throws(
    () =>
      assertVitaOverlaysPresent({
        ...realPlan,
        overlays: {
          appliedBy: "mkosi --extra-tree",
          required: true,
          extraTrees: [],
        },
      }),
    /must carry exactly the TS and agent overlays/u,
  );
  assert.throws(
    () =>
      assertVitaOverlaysPresent({
        ...realPlan,
        command: {
          mkosiArgs: realPlan.command.mkosiArgs.filter((arg) => !arg.includes("agent-overlay")),
        },
      }),
    /mkosi args must include agent-overlay extra-tree/u,
  );
});

async function readAgentConfigText(): Promise<string> {
  return readFile(agentImageConfigUrl, "utf8");
}

async function loadBuildRootModule(): Promise<BuildRootModule> {
  const moduleValue: unknown = await import(buildRootModuleUrl.href);
  const record = asRecord(moduleValue, "build-root module");
  const planRootBuild = record["planRootBuild"];
  assert.equal(typeof planRootBuild, "function");
  return {
    planRootBuild: (input?: unknown) => {
      const result = (planRootBuild as (input?: unknown) => unknown)(input);
      asRecord(result, "root build plan");
      return result as RootBuildPlan;
    },
  };
}

function assertArm64AgentConfig(configText: string): AgentConfigSummary {
  const config = parseKeyValueConfig(configText);
  const summary = {
    paths: {
      workRoot: getSetting(config, "Paths", "WorkRoot"),
      sourceRoot: getSetting(config, "Paths", "SourceRoot"),
      outputRoot: getSetting(config, "Paths", "OutputRoot"),
      overlayRoot: getSetting(config, "Paths", "OverlayRoot"),
      configPath: getSetting(config, "Paths", "Config"),
    },
    build: {
      builder: getSetting(config, "Build", "Builder"),
      image: getSetting(config, "Build", "Image"),
      moduleDir: getSetting(config, "Build", "ModuleDir"),
      command: getSetting(config, "Build", "Command"),
      target: getSetting(config, "Build", "Target"),
      output: getSetting(config, "Build", "Output"),
      cgoEnabled: getSetting(config, "Build", "CgoEnabled"),
      goOS: getSetting(config, "Build", "GoOS"),
      goArch: getSetting(config, "Build", "GoArch"),
      trimpath: getSetting(config, "Build", "Trimpath"),
      buildVcs: getSetting(config, "Build", "BuildVcs"),
      ldflags: getSetting(config, "Build", "Ldflags"),
      sourceDateEpoch: getSetting(config, "Build", "SourceDateEpoch"),
      network: getSetting(config, "Build", "Network"),
    },
    install: {
      binary: getSetting(config, "Install", "Binary"),
      binaryMode: getSetting(config, "Install", "BinaryMode"),
      binaryOwner: getSetting(config, "Install", "BinaryOwner"),
      symlink: getSetting(config, "Install", "Symlink"),
      symlinkTarget: getSetting(config, "Install", "SymlinkTarget"),
      stateDir: getSetting(config, "Install", "StateDir"),
      stateDirMode: getSetting(config, "Install", "StateDirMode"),
      stateDirOwner: getSetting(config, "Install", "StateDirOwner"),
    },
    service: {
      unit: getSetting(config, "Service", "Unit"),
      unitPath: getSetting(config, "Service", "UnitPath"),
      wantedBy: getSetting(config, "Service", "WantedBy"),
      enablePath: getSetting(config, "Service", "EnablePath"),
      enableTarget: getSetting(config, "Service", "EnableTarget"),
      execStart: getSetting(config, "Service", "ExecStart"),
      type: getSetting(config, "Service", "Type"),
      ambientCapabilities: getSetting(config, "Service", "AmbientCapabilities")
        .split(/\s+/u)
        .filter((entry) => entry.length > 0),
      listenAddress: getSetting(config, "Service", "ListenAddress"),
    },
    tmpfiles: {
      confPath: getSetting(config, "Tmpfiles", "ConfPath"),
      entry: getSetting(config, "Tmpfiles", "Entry"),
    },
  } satisfies AgentConfigSummary;

  assertExpected(summary.paths.workRoot, "/work", "Paths.WorkRoot");
  assertExpected(summary.paths.sourceRoot, "/work/agent", "Paths.SourceRoot");
  assertExpected(summary.paths.outputRoot, "/work/os/arm64/out/agent", "Paths.OutputRoot");
  assertExpected(summary.paths.overlayRoot, "/work/os/arm64/agent-overlay", "Paths.OverlayRoot");
  assertExpected(summary.paths.configPath, "/work/os/arm64/agent-image.conf", "Paths.Config");
  assertExpected(summary.build.builder, "tools/build/go-in-docker.mjs", "Build.Builder");
  assertExpected(summary.build.image, "golang:1.26", "Build.Image");
  assertExpected(summary.build.moduleDir, "agent", "Build.ModuleDir");
  assertExpected(summary.build.command, "build", "Build.Command");
  assertExpected(summary.build.target, "./cmd/agentd", "Build.Target");
  assertExpected(summary.build.output, "/work/os/arm64/out/agent/agentd", "Build.Output");
  assertExpected(summary.build.cgoEnabled, "0", "Build.CgoEnabled");
  assertExpected(summary.build.goOS, "linux", "Build.GoOS");
  assertExpected(summary.build.goArch, "arm64", "Build.GoArch");
  assertExpected(summary.build.trimpath, "true", "Build.Trimpath");
  assertExpected(summary.build.buildVcs, "false", "Build.BuildVcs");
  assertExpected(summary.build.ldflags, "-s -w -buildid=", "Build.Ldflags");
  assertExpected(summary.build.sourceDateEpoch, "1781308800", "Build.SourceDateEpoch");
  assertExpected(summary.build.network, "build-time-module-fetch-only", "Build.Network");
  assertExpected(summary.install.binary, "/usr/lib/vita/agentd", "Install.Binary");
  assertExpected(summary.install.binaryMode, "0755", "Install.BinaryMode");
  assertExpected(summary.install.binaryOwner, "root:root", "Install.BinaryOwner");
  assertExpected(summary.install.symlink, "/usr/bin/vita-agentd", "Install.Symlink");
  assertExpected(summary.install.symlinkTarget, "/usr/lib/vita/agentd", "Install.SymlinkTarget");
  assertExpected(summary.install.stateDir, "/var/lib/vita-agent", "Install.StateDir");
  assertExpected(summary.install.stateDirMode, "0700", "Install.StateDirMode");
  assertExpected(summary.install.stateDirOwner, "root:root", "Install.StateDirOwner");
  assertExpected(summary.service.unit, "vita-agentd.service", "Service.Unit");
  assertExpected(summary.service.unitPath, "/usr/lib/systemd/system/vita-agentd.service", "Service.UnitPath");
  assertExpected(summary.service.wantedBy, "multi-user.target", "Service.WantedBy");
  assertExpected(
    summary.service.enablePath,
    "/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service",
    "Service.EnablePath",
  );
  assertExpected(summary.service.enableTarget, "../vita-agentd.service", "Service.EnableTarget");
  assertExpected(summary.service.execStart, "/usr/lib/vita/agentd", "Service.ExecStart");
  assertExpected(summary.service.type, "simple", "Service.Type");
  assert.deepEqual(summary.service.ambientCapabilities, ["CAP_NET_ADMIN", "CAP_SYS_ADMIN", "CAP_SYS_TIME"]);
  assertExpected(summary.service.listenAddress, "127.0.0.1:8786", "Service.ListenAddress");
  assertExpected(summary.tmpfiles.confPath, "/usr/lib/tmpfiles.d/vita-agent.conf", "Tmpfiles.ConfPath");
  assertExpected(summary.tmpfiles.entry, "d /var/lib/vita-agent 0700 root root -", "Tmpfiles.Entry");

  return summary;
}

function buildAgentdArgs(summary: AgentConfigSummary): readonly string[] {
  return [
    summary.build.builder,
    "--dir",
    summary.build.moduleDir,
    "--env",
    `CGO_ENABLED=${summary.build.cgoEnabled}`,
    "--env",
    `GOOS=${summary.build.goOS}`,
    "--env",
    `GOARCH=${summary.build.goArch}`,
    "--env",
    `SOURCE_DATE_EPOCH=${summary.build.sourceDateEpoch}`,
    summary.build.command,
    "-trimpath",
    "-buildvcs=false",
    "-ldflags",
    summary.build.ldflags,
    "-o",
    summary.build.output,
    summary.build.target,
  ];
}

function assertVitaOverlaysPresent(plan: RootBuildPlan): void {
  assert.equal(plan.overlays.extraTrees.length, 2, "arm64 plan must carry exactly the TS and agent overlays");
  findOverlay(plan, "ts-overlay");
  findOverlay(plan, "agent-overlay");
  assert.ok(
    plan.command.mkosiArgs.includes("--extra-tree=/work/os/arm64/ts-overlay"),
    "mkosi args must include ts-overlay extra-tree",
  );
  assert.ok(
    plan.command.mkosiArgs.includes("--extra-tree=/work/os/arm64/agent-overlay"),
    "mkosi args must include agent-overlay extra-tree",
  );
}

function findOverlay(plan: RootBuildPlan, name: VitaOverlay["name"]): VitaOverlay {
  for (const overlay of plan.overlays.extraTrees) {
    if (overlay.name === name) {
      return overlay;
    }
  }
  assert.fail(`${name} must be declared`);
}

function parseKeyValueConfig(text: string): ParsedConfig {
  const sections = new Map<string, Map<string, string>>();
  let currentSection = "";
  const lines = text.replaceAll("\r\n", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) {
      continue;
    }
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1];
      if (sectionName === undefined) {
        assert.fail("section name must exist");
      }
      if (sections.has(sectionName)) {
        assert.fail(`agent-image.conf:${lineNumber} repeats section [${sectionName}]`);
      }
      sections.set(sectionName, new Map<string, string>());
      currentSection = sectionName;
      continue;
    }

    if (currentSection === "") {
      assert.fail(`agent-image.conf:${lineNumber} setting appears before a section`);
    }
    if (/^\s/u.test(rawLine)) {
      assert.fail(`agent-image.conf:${lineNumber} must not use continuation lines`);
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      assert.fail(`agent-image.conf:${lineNumber} must be a Key=Value setting`);
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    const section = sections.get(currentSection);
    if (section === undefined) {
      assert.fail(`agent-image.conf:${lineNumber} section must exist`);
    }
    if (section.has(key)) {
      assert.fail(`agent-image.conf:${lineNumber} repeats setting ${currentSection}.${key}`);
    }
    section.set(key, value);
  }

  return sections;
}

function getSetting(config: ParsedConfig, sectionName: string, key: string): string {
  const section = config.get(sectionName);
  if (section === undefined) {
    assert.fail(`agent-image.conf missing section [${sectionName}]`);
  }
  const value = section.get(key);
  if (value === undefined || value.length === 0) {
    assert.fail(`agent-image.conf missing setting ${sectionName}.${key}`);
  }
  return value;
}

function assertExpected(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    assert.fail(`${label} expected ${expected}, found ${actual}`);
  }
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  return value as Record<string, unknown>;
}

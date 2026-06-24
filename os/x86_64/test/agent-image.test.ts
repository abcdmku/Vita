import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

type AgentImagePlanInput = {
  readonly configText: string;
  readonly mountRoots: MountRoots;
};

type MountRoots = {
  readonly workspaceHostPath: string;
  readonly outputHostPath: string;
};

type BuildCommand = {
  readonly executable: "node";
  readonly script: string;
  readonly args: readonly string[];
  readonly builderArgs: readonly string[];
  readonly image: string;
  readonly moduleDir: string;
  readonly target: string;
  readonly output: string;
  readonly environment: {
    readonly CGO_ENABLED: string;
    readonly GOOS: string;
    readonly GOARCH: string;
    readonly GOFLAGS: string;
    readonly SOURCE_DATE_EPOCH: string;
  };
  readonly reproducible: true;
  readonly network: "build-time-module-fetch-only";
};

type InstallManifest = {
  readonly binary: {
    readonly kind: "binary";
    readonly path: string;
    readonly mode: string;
    readonly owner: string;
  };
  readonly symlink: {
    readonly kind: "symlink";
    readonly path: string;
    readonly target: string;
  };
  readonly stateDir: {
    readonly kind: "directory";
    readonly path: string;
    readonly mode: string;
    readonly owner: string;
  };
  readonly service: {
    readonly unit: string;
    readonly unitPath: string;
    readonly type: "simple";
    readonly execStart: string;
    readonly wantedBy: string;
    readonly enablePath: string;
    readonly enableTarget: string;
    readonly ambientCapabilities: readonly string[];
    readonly listenAddress: string;
    readonly enabled: true;
  };
  readonly tmpfiles: {
    readonly path: string;
    readonly entry: string;
  };
};

type AgentImagePlan = {
  readonly schemaVersion: 1;
  readonly target: "x86_64";
  readonly deterministic: true;
  readonly network: "none";
  readonly config: {
    readonly path: "os/x86_64/agent-image.conf";
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
    readonly builder: string;
    readonly image: string;
    readonly moduleDir: string;
    readonly language: "go";
    readonly reproducible: true;
    readonly network: "build-time-module-fetch-only";
    readonly runtimeCorrectness: string;
  };
  readonly build: BuildCommand;
  readonly install: InstallManifest;
  readonly overlay: {
    readonly relativePath: string;
    readonly extraTree: string;
    readonly stages: readonly {
      readonly kind: string;
      readonly path?: string;
      readonly from?: string;
      readonly to?: string;
      readonly mode?: string;
      readonly owner?: string;
      readonly target?: string;
      readonly enabledBy?: string;
      readonly entry?: string;
    }[];
  };
  readonly inputs: {
    readonly source: {
      readonly name: string;
      readonly kind: string;
      readonly module: string;
      readonly moduleDir: string;
      readonly target: string;
      readonly path: string;
    };
  };
  readonly outputs: {
    readonly binary: {
      readonly name: string;
      readonly kind: string;
      readonly source: string;
      readonly path: string;
      readonly os: string;
      readonly arch: string;
      readonly reproducible: true;
    };
  };
  readonly steps: readonly {
    readonly id: "build-agentd" | "stage-agentd-overlay";
    readonly kind: string;
    readonly status: "ready" | "blocked";
    readonly executable: false;
    readonly network: string;
    readonly blocks: readonly string[];
    readonly command?: BuildCommand;
    readonly output?: string;
    readonly gatedBy?: readonly string[];
    readonly input?: string;
    readonly extraTree?: string;
    readonly install?: InstallManifest;
  }[];
};

type AgentImageModule = {
  readonly planAgentImage: (input?: unknown) => AgentImagePlan;
  readonly serializeAgentImagePlan: (plan: AgentImagePlan) => string;
  readonly DEFAULT_AGENT_IMAGE_CONFIG_TEXT: string;
  readonly DEFAULT_AGENT_IMAGE_GO_IMAGE: string;
  readonly DEFAULT_AGENT_IMAGE_OUTPUT: string;
  readonly DEFAULT_AGENT_IMAGE_LDFLAGS: string;
  readonly DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH: string;
  readonly DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS: string;
};

const agentImageModuleUrl = new URL("../agent-image.mjs", import.meta.url);
const agentImageConfigUrl = new URL("../agent-image.conf", import.meta.url);
const serviceUnitUrl = new URL(
  "../agent-overlay/usr/lib/systemd/system/vita-agentd.service",
  import.meta.url,
);
const wantsSymlinkUrl = new URL(
  "../agent-overlay/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service",
  import.meta.url,
);
const tmpfilesUrl = new URL("../agent-overlay/usr/lib/tmpfiles.d/vita-agent.conf", import.meta.url);

const defaultMountRoots = {
  workspaceHostPath: "/repo",
  outputHostPath: "/repo/os/x86_64/out/agent",
} as const satisfies MountRoots;

test("planAgentImage is byte deterministic and matches the committed config text", async () => {
  const agentImage = await loadAgentImageModule();
  const input = await readPlanInput();
  const firstPlan = agentImage.planAgentImage(input);
  const secondPlan = agentImage.planAgentImage(input);
  const defaultPlan = agentImage.planAgentImage();

  assert.equal(input.configText, agentImage.DEFAULT_AGENT_IMAGE_CONFIG_TEXT);
  assert.equal(
    agentImage.serializeAgentImagePlan(firstPlan),
    agentImage.serializeAgentImagePlan(secondPlan),
  );
  assert.equal(
    agentImage.serializeAgentImagePlan(defaultPlan),
    agentImage.serializeAgentImagePlan(agentImage.planAgentImage(planInput(agentImage.DEFAULT_AGENT_IMAGE_CONFIG_TEXT))),
  );
  assert.equal(firstPlan.schemaVersion, 1);
  assert.equal(firstPlan.target, "x86_64");
  assert.equal(firstPlan.deterministic, true);
  assert.equal(firstPlan.network, "none");
  assert.equal(firstPlan.config.path, "os/x86_64/agent-image.conf");
  assert.equal(firstPlan.config.containerPath, "/work/os/x86_64/agent-image.conf");
  assert.equal(firstPlan.config.digest, sha256(input.configText));
});

test("the agentd build command carries every reproducible flag, the fixed -o, and GOOS/GOARCH", async () => {
  const agentImage = await loadAgentImageModule();
  const plan = agentImage.planAgentImage(await readPlanInput());
  const build = plan.build;

  // Wraps the canonical go-in-docker substrate against the agent module.
  assert.equal(build.executable, "node");
  assert.equal(build.script, "tools/build/go-in-docker.mjs");
  assert.equal(build.image, agentImage.DEFAULT_AGENT_IMAGE_GO_IMAGE);
  assert.equal(build.image, "golang:1.26");
  assert.equal(build.moduleDir, "agent");
  assert.equal(build.target, "./cmd/agentd");

  // The full argv the orchestrator runs: node tools/build/go-in-docker.mjs --dir agent build ...
  assert.deepEqual(build.args, [
    "tools/build/go-in-docker.mjs",
    "--dir",
    "agent",
    "--env",
    "CGO_ENABLED=0",
    "--env",
    "GOOS=linux",
    "--env",
    "GOARCH=amd64",
    "--env",
    "SOURCE_DATE_EPOCH=1781308800",
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags",
    agentImage.DEFAULT_AGENT_IMAGE_LDFLAGS,
    "-o",
    agentImage.DEFAULT_AGENT_IMAGE_OUTPUT,
    "./cmd/agentd",
  ]);
  assert.deepEqual(build.builderArgs, build.args.slice(1));

  // Reproducible go flags must all be present.
  assert.ok(build.builderArgs.includes("-trimpath"), "must pass -trimpath");
  assert.ok(build.builderArgs.includes("-buildvcs=false"), "must pass -buildvcs=false");
  const ldflags = argValue(build.builderArgs, "-ldflags");
  assert.equal(ldflags, "-s -w -buildid=");
  assert.match(ldflags, /(?:^|\s)-s(?:\s|$)/u);
  assert.match(ldflags, /(?:^|\s)-w(?:\s|$)/u);
  assert.match(ldflags, /-buildid=(?:\s|$)/u);

  // The fixed -o output path (deterministic, gitignored build artifact under out/).
  assert.equal(argValue(build.builderArgs, "-o"), agentImage.DEFAULT_AGENT_IMAGE_OUTPUT);
  assert.equal(argValue(build.builderArgs, "-o"), "/work/os/x86_64/out/agent/agentd");

  // The target is the LAST positional, after -o, exactly as `go build` expects.
  assert.equal(build.builderArgs[build.builderArgs.length - 1], "./cmd/agentd");

  // Reproducible environment: static (CGO off), linux/amd64, fixed epoch, vcs stamping off.
  assert.equal(build.environment.CGO_ENABLED, "0");
  assert.equal(build.environment.GOOS, "linux");
  assert.equal(build.environment.GOARCH, "amd64");
  assert.equal(build.environment.GOFLAGS, "-buildvcs=false");
  assert.equal(build.environment.SOURCE_DATE_EPOCH, agentImage.DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH);
  assert.equal(build.environment.SOURCE_DATE_EPOCH, "1781308800");

  // CLOSE THE LOOP: the reproducibility env must be FORWARDED into the container via go-in-docker's --env
  // passthrough, not merely sit in the inert `environment` field. Without this, go-in-docker drops these and
  // CGO defaults on → a dynamically-linked, non-reproducible binary (the dm-verity root hash would drift).
  for (const [key, value] of Object.entries(build.environment)) {
    if (key === "GOFLAGS") continue; // go-in-docker already sets GOFLAGS by default; the rest must be forwarded.
    const idx = build.builderArgs.indexOf(`${key}=${value}`);
    assert.ok(idx > 0 && build.builderArgs[idx - 1] === "--env", `${key} must be forwarded into the container as a --env arg`);
  }

  assert.equal(build.reproducible, true);
  assert.equal(plan.outputs.binary.path, build.output);
  assert.equal(plan.outputs.binary.os, "linux");
  assert.equal(plan.outputs.binary.arch, "amd64");
  assert.equal(plan.outputs.binary.reproducible, true);

  // build step is ready; staging is gated on it.
  const buildStep = findStep(plan, "build-agentd");
  const stageStep = findStep(plan, "stage-agentd-overlay");
  assert.equal(buildStep.status, "ready");
  assert.equal(stageStep.status, "blocked");
  assert.deepEqual(stageStep.gatedBy, ["build-agentd"]);
  assert.deepEqual(buildStep.command, build);
});

test("the install manifest pins paths, modes, and owners", async () => {
  const agentImage = await loadAgentImageModule();
  const plan = agentImage.planAgentImage(await readPlanInput());
  const install = plan.install;

  assert.deepEqual(install.binary, {
    kind: "binary",
    path: "/usr/lib/vita/agentd",
    mode: "0755",
    owner: "root:root",
  });
  assert.deepEqual(install.symlink, {
    kind: "symlink",
    path: "/usr/bin/vita-agentd",
    target: "/usr/lib/vita/agentd",
  });
  assert.equal(install.symlink.target, install.binary.path);
  assert.deepEqual(install.stateDir, {
    kind: "directory",
    path: "/var/lib/vita-agent",
    mode: "0700",
    owner: "root:root",
  });
});

test("the systemd unit content is enabled and binds loopback through ambient caps", async () => {
  const agentImage = await loadAgentImageModule();
  const plan = agentImage.planAgentImage(await readPlanInput());
  const service = plan.install.service;

  assert.equal(service.unit, "vita-agentd.service");
  assert.equal(service.unitPath, "/usr/lib/systemd/system/vita-agentd.service");
  assert.equal(service.type, "simple");
  assert.equal(service.execStart, "/usr/lib/vita/agentd");
  assert.equal(service.execStart, plan.install.binary.path);
  assert.equal(service.wantedBy, "multi-user.target");
  assert.deepEqual(service.ambientCapabilities, ["CAP_NET_ADMIN", "CAP_SYS_ADMIN", "CAP_SYS_TIME"]);
  assert.equal(service.listenAddress, "127.0.0.1:8786");
  assert.equal(service.listenAddress, agentImage.DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS);

  // Enabled deterministically with a committed wants-symlink (no `systemctl enable` at build).
  assert.equal(service.enabled, true);
  assert.equal(
    service.enablePath,
    "/usr/lib/systemd/system/multi-user.target.wants/vita-agentd.service",
  );
  assert.equal(service.enableTarget, "../vita-agentd.service");

  // The committed overlay files match what the manifest claims.
  const unitText = await readFile(serviceUnitUrl, "utf8");
  assert.match(unitText, /^Type=simple$/mu);
  assert.match(unitText, /^ExecStart=\/usr\/lib\/vita\/agentd$/mu);
  // Loopback-only daemon: must NOT order behind network-online.target (it hangs headless/no-NIC boots ~120s).
  // Match directive lines only — a comment may still mention it.
  assert.doesNotMatch(unitText, /^(?:After|Wants)=network-online\.target$/mu);
  assert.match(unitText, /^Restart=on-failure$/mu);
  assert.match(unitText, /^RestartSec=5s$/mu);
  assert.match(unitText, /^AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN CAP_SYS_TIME$/mu);
  assert.match(unitText, /^StateDirectory=vita-agent$/mu);
  assert.match(unitText, /^WantedBy=multi-user\.target$/mu);

  // The enable-at-boot symlink is committed and points at the sibling unit (verbatim, no newline).
  const wantsTarget = await readFile(wantsSymlinkUrl, "utf8");
  assert.equal(wantsTarget, "../vita-agentd.service");
});

test("the tmpfiles entry creates /var/lib/vita-agent as 0700 root root", async () => {
  const agentImage = await loadAgentImageModule();
  const plan = agentImage.planAgentImage(await readPlanInput());

  assert.equal(plan.install.tmpfiles.path, "/usr/lib/tmpfiles.d/vita-agent.conf");
  assert.equal(plan.install.tmpfiles.entry, "d /var/lib/vita-agent 0700 root root -");
  assert.equal(
    plan.install.tmpfiles.entry,
    `d ${plan.install.stateDir.path} ${plan.install.stateDir.mode} root root -`,
  );

  const tmpfilesText = await readFile(tmpfilesUrl, "utf8");
  assert.match(tmpfilesText, /^d \/var\/lib\/vita-agent 0700 root root -$/mu);
});

test("canonical path validation rejects traversal, mount escapes, and non-canonical paths", async () => {
  const agentImage = await loadAgentImageModule();
  const configText = await readConfigText();

  const invalidConfigPaths = [
    ["Build", "Output", "/work/os/x86_64/out/../agent/agentd", /Build\.Output must not contain \. or \.\. segments/u],
    ["Install", "Binary", "/usr/lib/vita/../vita/agentd", /Install\.Binary must not contain \. or \.\. segments/u],
    ["Install", "StateDir", "/var//lib/vita-agent", /Install\.StateDir must not contain empty or duplicate-slash segments/u],
    ["Service", "UnitPath", "/etc/systemd/system/vita-agentd.service", /Service\.UnitPath must stay within mount root \/usr/u],
    ["Service", "EnablePath", "/usr/lib/systemd/system/vita-agentd.service", /Service\.EnablePath expected/u],
  ] as const;

  for (const [section, key, value, message] of invalidConfigPaths) {
    assert.throws(
      () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, section, key, value))),
      message,
    );
  }

  // mountRoots are a trust boundary too.
  assert.throws(
    () =>
      agentImage.planAgentImage({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/repo/../out" },
      }),
    /mountRoots\.outputHostPath must not contain \. or \.\. segments/u,
  );
  assert.throws(
    () =>
      agentImage.planAgentImage({
        configText,
        mountRoots: { ...defaultMountRoots, outputHostPath: "/elsewhere/out/agent" },
      }),
    /mountRoots\.outputHostPath must stay within mount root \/repo/u,
  );
});

test("build, owner, and listen-address validation reject weakened or non-loopback config", async () => {
  const agentImage = await loadAgentImageModule();
  const configText = await readConfigText();

  // Reproducibility flags cannot be weakened.
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Build", "CgoEnabled", "1"))),
    /Build\.CgoEnabled expected 0/u,
  );
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Build", "Trimpath", "false"))),
    /Build\.Trimpath must be true/u,
  );
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Build", "Ldflags", "-s -w"))),
    /Build\.Ldflags expected -s -w -buildid=/u,
  );
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Build", "GoArch", "arm64"))),
    /Build\.GoArch expected amd64/u,
  );
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Build", "SourceDateEpoch", "0"))),
    /Build\.SourceDateEpoch expected 1781308800/u,
  );

  // Install modes/owners must be the pinned privileged values.
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Install", "BinaryMode", "0777"))),
    /Install\.BinaryMode expected 0755/u,
  );
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Install", "StateDirMode", "0755"))),
    /Install\.StateDirMode expected 0700/u,
  );

  // The control surface must stay on loopback.
  assert.throws(
    () => agentImage.planAgentImage(planInput(replaceConfigSetting(configText, "Service", "ListenAddress", "0.0.0.0:8786"))),
    /Service\.ListenAddress expected 127\.0\.0\.1:8786/u,
  );

  // Ambient caps are an exact, ordered set.
  assert.throws(
    () =>
      agentImage.planAgentImage(
        planInput(replaceConfigSetting(configText, "Service", "AmbientCapabilities", "CAP_SYS_ADMIN")),
      ),
    /Service\.AmbientCapabilities expected 3 entries, found 1/u,
  );

  // Unknown sections/settings are rejected.
  assert.throws(
    () => agentImage.planAgentImage(planInput(`${configText}\n[Bogus]\nKey=value\n`)),
    /contains unsupported section \[Bogus\]/u,
  );
});

test("planAgentImage rejects partial and hostile inputs through safeNormalize without invoking traps", async () => {
  const agentImage = await loadAgentImageModule();
  const configText = await readConfigText();

  // Partial input: missing mountRoots.
  assert.throws(() => agentImage.planAgentImage({ configText }), /missing required field mountRoots/u);

  // An EXTERNAL side-effect flag proves the getter/proxy traps are NEVER invoked — not merely that
  // a throw happened. If safeNormalize touched these, the flag would flip and the assert would fail.
  let trapTouched = false;

  const accessorInput = {};
  Object.defineProperty(accessorInput, "configText", {
    get() {
      trapTouched = true;
      return "smuggled";
    },
    enumerable: true,
  });
  assert.throws(() => agentImage.planAgentImage(accessorInput), /agent image plan input normalization failed/u);
  assert.equal(trapTouched, false, "top-level configText getter must not be invoked");

  const accessorMountRoots = {};
  Object.defineProperty(accessorMountRoots, "workspaceHostPath", { value: "/repo", enumerable: true });
  Object.defineProperty(accessorMountRoots, "outputHostPath", {
    get() {
      trapTouched = true;
      return "/repo/os/x86_64/out/agent";
    },
    enumerable: true,
  });
  assert.throws(
    () => agentImage.planAgentImage({ configText, mountRoots: accessorMountRoots }),
    /agent image plan input normalization failed/u,
  );
  assert.equal(trapTouched, false, "nested outputHostPath getter must not be invoked");

  // Hostile iterator on the nested object must not be consulted.
  const hostileIteratorMountRoots: Record<PropertyKey, unknown> = { ...defaultMountRoots };
  hostileIteratorMountRoots[Symbol.iterator] = () => {
    trapTouched = true;
    return [][Symbol.iterator]();
  };
  assert.throws(
    () => agentImage.planAgentImage({ configText, mountRoots: hostileIteratorMountRoots }),
    /agent image plan input normalization failed/u,
  );
  assert.equal(trapTouched, false, "hostile iterator must not be invoked");

  // A proxy at the top level: its ownKeys trap must not be trusted/invoked by the planner.
  const proxyInput = new Proxy(
    { configText, mountRoots: defaultMountRoots },
    {
      ownKeys() {
        trapTouched = true;
        return Reflect.ownKeys({ configText, mountRoots: defaultMountRoots });
      },
      get(targetObject, key, receiver) {
        trapTouched = true;
        return Reflect.get(targetObject, key, receiver);
      },
    },
  );
  assert.throws(() => agentImage.planAgentImage(proxyInput), /agent image plan input normalization failed/u);
  assert.equal(trapTouched, false, "proxy traps must not be invoked");

  // Unknown top-level keys are rejected even when configText/mountRoots are valid.
  assert.throws(
    () => agentImage.planAgentImage({ configText, mountRoots: defaultMountRoots, extra: 1 }),
    /unsupported field extra/u,
  );
});

async function readPlanInput(): Promise<AgentImagePlanInput> {
  return planInput(await readConfigText());
}

async function readConfigText(): Promise<string> {
  return readFile(agentImageConfigUrl, "utf8");
}

function planInput(configText: string): AgentImagePlanInput {
  return {
    configText,
    mountRoots: defaultMountRoots,
  };
}

async function loadAgentImageModule(): Promise<AgentImageModule> {
  const moduleValue: unknown = await import(agentImageModuleUrl.href);
  return asAgentImageModule(moduleValue);
}

function asAgentImageModule(value: unknown): AgentImageModule {
  const record = asRecord(value, "agent image module");
  const planAgentImage = record["planAgentImage"];
  const serializeAgentImagePlan = record["serializeAgentImagePlan"];

  assert.equal(typeof planAgentImage, "function");
  assert.equal(typeof serializeAgentImagePlan, "function");

  return {
    planAgentImage: (input?: unknown) => {
      const result = (planAgentImage as (input?: unknown) => unknown)(input);
      asRecord(result, "agent image plan");
      return result as AgentImagePlan;
    },
    serializeAgentImagePlan: (plan: AgentImagePlan) =>
      (serializeAgentImagePlan as (plan: AgentImagePlan) => string)(plan),
    DEFAULT_AGENT_IMAGE_CONFIG_TEXT: asString(record["DEFAULT_AGENT_IMAGE_CONFIG_TEXT"], "DEFAULT_AGENT_IMAGE_CONFIG_TEXT"),
    DEFAULT_AGENT_IMAGE_GO_IMAGE: asString(record["DEFAULT_AGENT_IMAGE_GO_IMAGE"], "DEFAULT_AGENT_IMAGE_GO_IMAGE"),
    DEFAULT_AGENT_IMAGE_OUTPUT: asString(record["DEFAULT_AGENT_IMAGE_OUTPUT"], "DEFAULT_AGENT_IMAGE_OUTPUT"),
    DEFAULT_AGENT_IMAGE_LDFLAGS: asString(record["DEFAULT_AGENT_IMAGE_LDFLAGS"], "DEFAULT_AGENT_IMAGE_LDFLAGS"),
    DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH: asString(
      record["DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH"],
      "DEFAULT_AGENT_IMAGE_SOURCE_DATE_EPOCH",
    ),
    DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS: asString(
      record["DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS"],
      "DEFAULT_AGENT_IMAGE_LISTEN_ADDRESS",
    ),
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

function findStep(plan: AgentImagePlan, id: AgentImagePlan["steps"][number]["id"]): AgentImagePlan["steps"][number] {
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

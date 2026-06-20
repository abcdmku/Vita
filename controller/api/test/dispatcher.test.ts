import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryControllerApi,
  dispatchControllerRequest,
} from "../src/dispatcher.ts";
import { REQUIRED_PROFILES } from "../../../simulation/profiles/src/profiles.ts";
import { normalize } from "../../../sdk/typescript/src/plan.ts";
import type { ControllerApiDispatchResult, IdentityRole } from "../src/contracts.ts";
import type { BrokerPolicy, CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type { Capsule } from "../../../storage/capsules/src/capsule.ts";
import type { DeviceArchitecture } from "../../../sdk/typescript/src/capabilities.ts";
import type { DesiredState } from "../../../sdk/typescript/src/plan.ts";

test("overview and node health route through the dispatcher", () => {
  const api = createInMemoryControllerApi();

  const overview = dispatchControllerRequest(api, {
    method: "getOverview",
  });

  assert.equal(overview.ok, true);

  if (!overview.ok || overview.method !== "getOverview") {
    assert.fail(`expected overview response: ${JSON.stringify(overview)}`);
  }

  assert.equal(overview.response.nodeCount, 1);
  assert.deepEqual(overview.response.health, {
    healthy: 1,
    degraded: 0,
    offline: 0,
  });
  assert.deepEqual(overview.response.protection, {
    protected: 1,
    warnings: 0,
    unprotected: 0,
  });
  assert.equal(overview.response.exposure.publicServices, 1);

  const health = dispatchControllerRequest(api, {
    method: "getNodeHealth",
    params: {
      nodeId: "node-1",
    },
  });

  assert.equal(health.ok, true);

  if (!health.ok || health.method !== "getNodeHealth") {
    assert.fail(`expected node health response: ${JSON.stringify(health)}`);
  }

  assert.equal(health.response.nodeId, "node-1");
  assert.equal(health.response.status, "healthy");
  assert.equal(health.response.uptimeSeconds, 86_400);
  assert.equal(health.response.capabilities.memoryGB, 32);
  assert.equal(health.response.capabilities.architecture, "x86_64");
  assert.deepEqual(
    health.response.capabilities.accelerators.map((accelerator) => accelerator.kind),
    ["intel.npu", "nvidia.cuda"],
  );
});

test("storage, backup, and identity overview endpoints route through the dispatcher", () => {
  const api = createInMemoryControllerApi();

  const storage = dispatchControllerRequest(api, {
    method: "getStorageOverview",
  });

  assert.equal(storage.ok, true);

  if (!storage.ok || storage.method !== "getStorageOverview") {
    assert.fail(`expected storage overview response: ${JSON.stringify(storage)}`);
  }

  assert.equal(storage.response.summary.health, "healthy");
  assert.equal(storage.response.summary.encryptedVolumes, 2);
  assert.equal(storage.response.pools.length, 1);
  assert.equal(storage.response.volumes.length, 2);
  assert.equal(storage.response.volumes[0]?.snapshotCadence, "hourly");
  assert.deepEqual(
    storage.response.volumes[0]?.protectionStates.map((state) => [
      state.protectionLevel,
      state.backupClass,
      state.isBackup,
    ]),
    [
      ["snapshot", "not-backup", false],
      ["mirror", "not-backup", false],
      ["local-backup", "backup", true],
      ["off-site-backup", "backup", true],
    ],
  );
  assert.equal(
    storage.response.volumes[0]?.protectionStates.some(
      (state) => state.protectionLevel === "mirror" && state.isBackup,
    ),
    false,
  );
  assert.equal(Object.isFrozen(storage.response.volumes[0]?.protectionStates), true);

  const backup = dispatchControllerRequest(api, {
    method: "getBackupStatus",
  });

  assert.equal(backup.ok, true);

  if (!backup.ok || backup.method !== "getBackupStatus") {
    assert.fail(`expected backup status response: ${JSON.stringify(backup)}`);
  }

  assert.equal(backup.response.summary.backupTargetCount, 2);
  assert.deepEqual(
    backup.response.targets.map((target) => [target.targetKind, target.protectionState.level]),
    [
      ["attached-disk", "local-backup"],
      ["remote-object", "off-site-backup"],
    ],
  );
  assert.equal(
    backup.response.targets.every((target) => target.protectionState.isBackup),
    true,
  );
  assert.equal(
    backup.response.targets.some((target) => target.protectionState.protectionLevel === "mirror"),
    false,
  );
  assert.deepEqual(
    backup.response.nonBackupProtection.map((entry) => [
      entry.protectionState.protectionLevel,
      entry.protectionState.backupClass,
      entry.protectionState.isBackup,
    ]),
    [
      ["snapshot", "not-backup", false],
      ["mirror", "not-backup", false],
    ],
  );
  assert.equal(backup.response.targets[0]?.lastRun.result, "succeeded");
  assert.equal(backup.response.targets[0]?.lastRestoreTest.result, "passed");
  assert.equal(Object.isFrozen(backup.response.targets[0]?.protectionState), true);

  const identity = dispatchControllerRequest(api, {
    method: "getIdentitySummary",
  });

  assert.equal(identity.ok, true);

  if (!identity.ok || identity.method !== "getIdentitySummary") {
    assert.fail(`expected identity summary response: ${JSON.stringify(identity)}`);
  }

  const expectedRoles: readonly IdentityRole[] = [
    "owner",
    "administrator",
    "member",
    "restricted-member",
    "guest",
    "service",
  ];
  assert.deepEqual(
    identity.response.roles.map((role) => role.role),
    expectedRoles,
  );
  assert.equal(identity.response.passkeys.required, true);
  assert.equal(identity.response.passkeys.state, "partial");
  assert.equal(identity.response.auditLog.available, true);
  assert.equal(identity.response.auditLog.retentionDays, 365);
  assert.deepEqual(Object.keys(identity.response.roles[0] ?? {}).sort(), [
    "principalCount",
    "role",
  ]);
});

test("previewPlan returns validation, diff, and explanation for a valid desired state", () => {
  const api = createInMemoryControllerApi();
  const desiredState: DesiredState = {
    identity: {
      owner: {
        id: "did:example:alice",
        displayName: "Alice",
      },
      passkeysRequired: true,
    },
    storage: {
      dataVolume: {
        encryption: "required",
        snapshots: "daily",
        quotaGiB: 256,
      },
    },
    apps: [
      {
        id: "atproto-pds",
        version: "1.0.0",
        config: {
          allowedCapabilities: ["network.public"],
          publicAccess: true,
          memory: "2GiB",
        },
      },
    ],
    backups: [
      {
        id: "usb-main",
        target: "usb",
        schedule: "daily",
        retentionDays: 30,
      },
    ],
  };

  const preview = dispatchControllerRequest(api, {
    method: "previewPlan",
    params: {
      desiredState,
    },
  });

  assert.equal(preview.ok, true);

  if (!preview.ok || preview.method !== "previewPlan") {
    assert.fail(`expected preview response: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.response.ok, true);

  if (!preview.response.ok) {
    assert.fail(`expected plan preview to pass: ${JSON.stringify(preview.response.validation)}`);
  }

  assert.equal(preview.response.validation.ok, true);
  assert.ok(preview.response.diff.changes.length > 0);
  assert.equal(
    preview.response.diff.changes.some((change) => change.path === "apps/atproto-pds"),
    true,
  );
  assert.match(preview.response.explanation, /Canonical plan v1/);
  assert.match(preview.response.explanation, /atproto-pds/);
});

test("previewPlan returns a typed validation error for overprivileged input without throwing", () => {
  const api = createInMemoryControllerApi();
  const desiredState: DesiredState = {
    apps: [
      {
        id: "public-dashboard",
        config: {
          publicAccess: true,
        },
      },
    ],
  };

  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewPlan",
      params: {
        desiredState,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || !preview.ok || preview.method !== "previewPlan") {
    assert.fail(`expected preview response: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.response.ok, false);

  if (preview.response.ok) {
    assert.fail(`expected plan preview to fail: ${JSON.stringify(preview.response)}`);
  }

  assert.equal(preview.response.error.code, "VALIDATION_FAILED");
  assert.deepEqual(
    preview.response.validation.errors.map((error) => error.path),
    ["apps/0/config/publicAccess"],
  );
});

test("dispatcher rejects malformed currentPlan without throwing", () => {
  const cyclicConfig: Record<string, unknown> = {};
  cyclicConfig.self = cyclicConfig;
  const cyclicPlan = {
    ...normalize({}),
    apps: [
      {
        id: "cycle",
        config: cyclicConfig,
      },
    ],
  };

  const throwingConfig: Record<string, unknown> = {};
  Object.defineProperty(throwingConfig, "boom", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const throwingPlan = {
    ...normalize({}),
    apps: [
      {
        id: "throws",
        config: throwingConfig,
      },
    ],
  };

  assertPreviewCurrentPlanRejectsWithoutThrow(cyclicPlan);
  assertPreviewCurrentPlanRejectsWithoutThrow(throwingPlan);
});

function assertPreviewCurrentPlanRejectsWithoutThrow(currentPlan: unknown): void {
  const api = createInMemoryControllerApi();
  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewPlan",
      params: {
        desiredState: {},
        currentPlan,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || preview.ok) {
    assert.fail(`expected invalid currentPlan to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.error.code, "INVALID_PARAMS");
  assert.match(preview.error.message, /currentPlan/);
}

test("listApps and previewAppInstall expose a valid least-privilege app preview", () => {
  const api = createInMemoryControllerApi();

  const apps = dispatchControllerRequest(api, {
    method: "listApps",
  });

  assert.equal(apps.ok, true);

  if (!apps.ok || apps.method !== "listApps") {
    assert.fail(`expected app list response: ${JSON.stringify(apps)}`);
  }

  assert.equal(apps.response.apps.length > 0, true);
  assert.equal(typeof apps.response.apps[0]?.id, "string");
  assert.equal(typeof apps.response.apps[0]?.version, "string");
  assert.match(apps.response.apps[0]?.status ?? "", /^(installed|available)$/);

  const preview = dispatchPreview(validPackageContract(), matchingPolicy());

  assert.equal(preview.ok, true);

  if (!preview.ok) {
    assert.fail(`expected install preview to pass: ${JSON.stringify(preview)}`);
  }

  const expectedCapabilities: readonly CapabilityGrant[] = [
    {
      kind: "data",
      class: "app-state",
      access: "read-only",
      scope: "state",
    },
    {
      kind: "network",
      direction: "ingress",
      protocol: "https",
      port: 443,
      public: false,
    },
    {
      kind: "network",
      direction: "egress",
      protocol: "https",
      destination: "updates.example.invalid",
      port: 443,
    },
  ];

  assert.equal(preview.validation.ok, true);
  assert.deepEqual(preview.grantedCapabilities, expectedCapabilities);
  assert.deepEqual(preview.deniedCapabilities, []);
  assert.deepEqual(preview.reasons, []);
});

test("previewAppInstall returns denied capabilities with reasons for overprivileged apps", () => {
  const preview = dispatchPreview(
    validPackageContract({ dataAccess: "read-write" }),
    matchingPolicy({ dataAccess: "read-only" }),
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail(`expected install preview to deny: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.error.code, "CAPABILITY_DENIED");
  assert.equal(
    preview.grantedCapabilities.some(
      (capability) =>
        capability.kind === "data" &&
        capability.class === "app-state" &&
        capability.access === "read-write" &&
        capability.scope === "state",
    ),
    false,
  );
  assert.equal(preview.deniedCapabilities.length, 1);
  assert.deepEqual(preview.deniedCapabilities[0]?.capability, {
    kind: "data",
    class: "app-state",
    access: "read-write",
    scope: "state",
  });
  assert.equal(preview.deniedCapabilities[0]?.code, "POLICY_DENIED");
  assert.match(preview.reasons[0] ?? "", /policy/i);
});

test("previewAppInstall returns typed errors for invalid and method-shadowed contracts", () => {
  const partial = dispatchPreview(
    {
      identity: {
        id: "com.example.partial",
      },
    },
    matchingPolicy(),
  );

  assert.equal(partial.ok, false);

  if (partial.ok) {
    assert.fail(`expected partial contract to fail: ${JSON.stringify(partial)}`);
  }

  assert.equal(partial.validation.ok, false);
  assert.equal(partial.error.code, "VALIDATION_FAILED");

  const shadowedContract = validPackageContract();
  const egress = shadowedContract.network.egress as unknown as Record<string, unknown>;
  egress.some = () => true;

  let shadowed: ReturnType<typeof dispatchPreview> | undefined;

  assert.doesNotThrow(() => {
    shadowed = dispatchPreview(shadowedContract, matchingPolicy());
  });

  assert.notEqual(shadowed, undefined);

  if (shadowed === undefined || shadowed.ok) {
    assert.fail(`expected method-shadowed contract to fail: ${JSON.stringify(shadowed)}`);
  }

  assert.equal(shadowed.error.code, "INVALID_PARAMS");
  assert.match(shadowed.reasons[0] ?? "", /malformed/i);
});

test("previewAppInstall fail-closes hostile contract and policy inputs without throwing", () => {
  const throwingContract = new Proxy(validPackageContract(), {
    get(target, key, receiver) {
      if (key === "data") {
        throw new Error("contract boom");
      }

      return Reflect.get(target, key, receiver);
    },
  });
  const throwingPolicy: Record<string, unknown> = {};
  Object.defineProperty(throwingPolicy, "data", {
    enumerable: true,
    get() {
      throw new Error("policy boom");
    },
  });
  Object.defineProperty(throwingPolicy, "network", {
    enumerable: true,
    value: matchingPolicy().network,
  });

  let contractPreview: ReturnType<typeof dispatchPreview> | undefined;
  let policyPreview: ReturnType<typeof dispatchPreview> | undefined;

  assert.doesNotThrow(() => {
    contractPreview = dispatchPreview(throwingContract, matchingPolicy());
  });
  assert.doesNotThrow(() => {
    policyPreview = dispatchPreview(validPackageContract(), throwingPolicy);
  });

  assert.notEqual(contractPreview, undefined);
  assert.notEqual(policyPreview, undefined);

  if (contractPreview === undefined || contractPreview.ok) {
    assert.fail(`expected hostile contract to fail: ${JSON.stringify(contractPreview)}`);
  }

  if (policyPreview === undefined || policyPreview.ok) {
    assert.fail(`expected hostile policy to fail: ${JSON.stringify(policyPreview)}`);
  }

  assert.equal(contractPreview.error.code, "VALIDATION_FAILED");
  assert.equal(policyPreview.error.code, "INVALID_PARAMS");
});

test("previewAppInstall rejects malformed policy even for valid zero-capability apps", () => {
  const malformedPolicy = {
    data: [],
    network: {
      egress: [],
    },
  };

  const preview = dispatchPreview(
    validPackageContract({ zeroCapabilities: true }),
    malformedPolicy,
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail(`expected malformed policy to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.error.code, "INVALID_PARAMS");
  assert.deepEqual(preview.grantedCapabilities, []);
  assert.deepEqual(preview.deniedCapabilities, []);
  assert.match(preview.reasons[0] ?? "", /policy/i);
});

test("previewCapsuleImport returns a ready preview for valid neutral capsules", () => {
  const preview = dispatchCapsulePreview(
    validCapsule({
      architectures: ["x86_64", "arm64"],
      dataAccess: "read-write",
    }),
    "arm64",
    matchingPolicy({ dataAccess: "read-write" }),
  );

  assert.equal(preview.ok, true);

  if (!preview.ok) {
    assert.fail(`expected capsule import preview to pass: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.targetArch, "arm64");
  assert.equal(preview.migratable, true);
  assert.deepEqual(preview.migrationReasons, []);
  assert.deepEqual(preview.missingProfiles, []);
  assert.deepEqual(preview.deniedCapabilities, []);
  assert.equal(preview.grantedCapabilities.length, 3);
  assert.equal("granted" in preview, false);
  assert.equal("denied" in preview, false);
});

test("previewCapsuleImport surfaces missing sim coverage and over-policy grants", () => {
  const preview = dispatchCapsulePreview(
    validCapsule({
      dataAccess: "read-write",
      requiredProfiles: REQUIRED_PROFILES.filter((profile) => profile !== "power-loss"),
    }),
    "x86_64",
    matchingPolicy({ dataAccess: "read-only" }),
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail(`expected capsule import preview to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.error.code, "CAPABILITY_DENIED");
  assert.equal(preview.migratable, true);
  assert.deepEqual(preview.missingProfiles, ["power-loss"]);
  assert.equal(preview.deniedCapabilities.length, 1);
  assert.deepEqual(preview.deniedCapabilities[0]?.capability, {
    kind: "data",
    class: "app-state",
    access: "read-write",
    scope: "state",
  });
  assert.match(preview.reasons.join("\n"), /power-loss/);
  assert.match(preview.reasons.join("\n"), /policy/i);
});

test("previewCapsuleImport reports architecture migration readiness reasons", () => {
  const preview = dispatchCapsulePreview(
    validCapsule({
      architectureNeutral: false,
      architectures: ["x86_64"],
      dataAccess: "read-write",
      packageClass: "oci-service",
      runtimeArchitectures: ["x86_64"],
    }),
    "arm64",
    matchingPolicy({ dataAccess: "read-write" }),
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail(`expected wrong-architecture capsule to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.error.code, "VALIDATION_FAILED");
  assert.equal(preview.migratable, false);
  assert.match(preview.migrationReasons.join("\n"), /target architecture arm64/);
  assert.match(preview.migrationReasons.join("\n"), /state snapshot/i);
  assert.match(preview.migrationReasons.join("\n"), /runtime artifacts/i);
});

test("previewCapsuleImport requires declared target architecture for neutral runtimes", () => {
  const preview = dispatchCapsulePreview(
    validCapsule({
      architectureNeutral: true,
      architectures: ["x86_64"],
      dataAccess: "read-write",
      packageClass: "wasm-component",
      runtimeArchitectures: ["x86_64", "arm64"],
    }),
    "arm64",
    matchingPolicy({ dataAccess: "read-write" }),
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail(`expected x86-only neutral runtime to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.validation.ok, true);
  assert.equal(preview.migratable, false);
  assert.deepEqual(preview.missingProfiles, []);
  assert.deepEqual(preview.deniedCapabilities, []);
  assert.match(preview.migrationReasons.join("\n"), /does not declare target architecture arm64/);
});

test("previewCapsuleImport fail-closes accessor and exotic inputs without throwing", () => {
  const accessorParams: Record<string, unknown> = {};
  let capsuleReads = 0;

  Object.defineProperty(accessorParams, "capsule", {
    enumerable: true,
    get() {
      capsuleReads += 1;
      return validCapsule();
    },
  });
  Object.defineProperty(accessorParams, "targetArch", {
    enumerable: true,
    value: "x86_64",
  });
  Object.defineProperty(accessorParams, "policy", {
    enumerable: true,
    value: matchingPolicy({ dataAccess: "read-write" }),
  });

  assertDispatchInvalidParams("previewCapsuleImport", accessorParams, "top-level-accessor");
  assert.equal(capsuleReads, 0);

  const nestedPolicy = matchingPolicy({ dataAccess: "read-write" }) as unknown as Record<
    string,
    unknown
  >;
  let policyReads = 0;

  Object.defineProperty(nestedPolicy, "data", {
    enumerable: true,
    get() {
      policyReads += 1;
      return [];
    },
  });

  assertDispatchInvalidParams(
    "previewCapsuleImport",
    {
      capsule: validCapsule({ dataAccess: "read-write" }),
      targetArch: "x86_64",
      policy: nestedPolicy,
    },
    "nested-policy-accessor",
  );
  assert.equal(policyReads, 0);

  const shadowedCapsule = validCapsule({ dataAccess: "read-write" });
  const requiredProfiles = shadowedCapsule.simulation.requiredProfiles as unknown as Record<
    string,
    unknown
  >;
  requiredProfiles.some = () => true;

  assertDispatchInvalidParams(
    "previewCapsuleImport",
    {
      capsule: shadowedCapsule,
      targetArch: "x86_64",
      policy: matchingPolicy({ dataAccess: "read-write" }),
    },
    "method-shadowed-capsule",
  );

  const proxyCapsule = new Proxy(validCapsule({ dataAccess: "read-write" }), {
    getPrototypeOf() {
      throw new Error("proxy should not escape");
    },
  });

  assertDispatchInvalidParams(
    "previewCapsuleImport",
    {
      capsule: proxyCapsule,
      targetArch: "x86_64",
      policy: matchingPolicy({ dataAccess: "read-write" }),
    },
    "throwing-proxy-capsule",
  );
});

test("dispatcher rejects unknown methods with a typed error", () => {
  const api = createInMemoryControllerApi();

  const result = dispatchControllerRequest(api, {
    method: "applyPlan",
    params: {},
  });

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail(`expected unknown method to fail: ${JSON.stringify(result)}`);
  }

  assert.equal(result.error.code, "UNKNOWN_METHOD");
  assert.match(result.error.message, /applyPlan/);
});

test("new overview endpoints reject malformed params without throwing", () => {
  const prototypeBearing = Object.create({ inherited: true }) as Record<string, unknown>;
  const malformedParams = [
    { label: "unknown-field", value: { unexpected: true } },
    { label: "date", value: new Date("2026-06-20T00:00:00.000Z") },
    { label: "map", value: new Map() },
    { label: "proxy", value: new Proxy({}, {}) },
    { label: "prototype-bearing", value: prototypeBearing },
  ];
  const methods = ["getStorageOverview", "getBackupStatus", "getIdentitySummary"];

  for (let methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
    const method = methods[methodIndex] ?? "";

    for (let paramIndex = 0; paramIndex < malformedParams.length; paramIndex += 1) {
      const malformed = malformedParams[paramIndex];

      if (malformed === undefined) {
        assert.fail("expected malformed params fixture");
      }

      assertDispatchInvalidParams(method, malformed.value, malformed.label);
    }
  }
});

function dispatchPreview(packageContract: unknown, policy: unknown) {
  const api = createInMemoryControllerApi();
  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewAppInstall",
      params: {
        packageContract,
        policy,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || !preview.ok || preview.method !== "previewAppInstall") {
    assert.fail(`expected app install preview response: ${JSON.stringify(preview)}`);
  }

  return preview.response;
}

function dispatchCapsulePreview(
  capsule: unknown,
  targetArch: DeviceArchitecture,
  policy: unknown,
) {
  const api = createInMemoryControllerApi();
  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewCapsuleImport",
      params: {
        capsule,
        targetArch,
        policy,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || !preview.ok || preview.method !== "previewCapsuleImport") {
    assert.fail(`expected capsule import preview response: ${JSON.stringify(preview)}`);
  }

  return preview.response;
}

function assertDispatchInvalidParams(method: string, params: unknown, label: string): void {
  const api = createInMemoryControllerApi();
  let result: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    result = dispatchControllerRequest(api, {
      method,
      params,
    });
  }, `${method} should not throw for ${label} params`);

  assert.notEqual(result, undefined);

  if (result === undefined || result.ok) {
    assert.fail(`expected ${method} ${label} params to fail: ${JSON.stringify(result)}`);
  }

  assert.equal(result.error.code, "INVALID_PARAMS");
}

function validCapsule(
  options: {
    readonly architectureNeutral?: boolean;
    readonly architectures?: PackageContract["architectures"];
    readonly dataAccess?: "read-only" | "read-write";
    readonly packageClass?: PackageContract["packageClass"];
    readonly requiredProfiles?: readonly string[];
    readonly runtimeArchitectures?: readonly DeviceArchitecture[];
  } = {},
): Capsule {
  const dataAccess = options.dataAccess ?? "read-write";
  const runtimeArchitectures = options.runtimeArchitectures ?? ["x86_64", "arm64"];

  return {
    manifest: {
      package: validPackageContract({
        architectures: options.architectures ?? ["x86_64", "arm64"],
        dataAccess,
        packageClass: options.packageClass ?? "ts-service",
      }),
      versions: {
        capsule: "1",
        package: "1.2.3",
        runtime: "1",
        state: "7",
        policy: "1",
        simulation: "1",
      },
      signatures: [
        {
          ref: "signature://vita/notes/1.2.3/sigstore",
          keyRef: "publisher-key://vita/first-party/stable",
          algorithm: "sigstore-bundle",
          digest: digest("a34d88f8f4f5b74051f10b39a6f8a62ffb1a4d993db1ea5744d70d7f4a7dd04f"),
          signedAt: "2026-06-01T12:20:00.000Z",
        },
      ],
      sbom: {
        format: "spdx-json",
        ref: "sbom://vita/notes/1.2.3/spdx",
        digest: digest("497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e"),
        generatedAt: "2026-06-01T12:00:00.000Z",
      },
    },
    runtime: {
      ociImageIndexes: [
        {
          name: "notes-service",
          ref: "oci://registry.example.invalid/vita/notes@sha256:8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25",
          digest: digest("8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
          mediaType: "application/vnd.oci.image.index.v1+json",
          platforms: runtimeArchitectures.map((architecture) => ({
            os: "linux",
            architecture,
          })),
        },
      ],
      wasmComponents: [
        {
          name: "notes-renderer",
          ref: "wasm://vita/notes/1.2.3/renderer",
          digest: digest("5b3db6c7aa7dfaa8f9d2698b0f6f30f3cfba71d9acaa6168d7a4a4d8f56e6f5c"),
          mediaType: "application/wasm",
          componentId: "com.vita.notes.renderer",
        },
      ],
      typescript: {
        source: {
          ref: "artifact://vita/notes/1.2.3/source",
          digest: digest("b0f5e8c4af6f3a5e513d67fd77f4a5a9f8f9362d653880f4dd9c6cfe77987f5b"),
          mediaType: "application/vnd.vita.typescript-source",
          entrypoint: "src/main.ts",
        },
        compiled: {
          ref: "artifact://vita/notes/1.2.3/compiled",
          digest: digest("dd3fd69f459fef75ad205b5f8f50df24ed34cb6a56a54edfc832790a93fb2bc0"),
          mediaType: "application/javascript",
          entrypoint: "dist/main.js",
        },
      },
    },
    state: {
      snapshot: {
        ref: "snapshot://vita/notes/2026-06-01T12:30:00Z",
        architectureNeutral: options.architectureNeutral ?? true,
        consistency: "application-consistent",
        digest: digest("7f4f8dcf3688a770886fd18a97ed8d691a59d221429d7f429a9634a31e1a0f08"),
        createdAt: "2026-06-01T12:30:00.000Z",
      },
      exports: [
        {
          name: "notes-state-json",
          format: "json",
          ref: "export://vita/notes/2026-06-01/state-json",
          digest: digest("43d907b11d3f093f2fead79f5064dd530a4b0c42df75e8308152e1e2d1d7f2a7"),
          dataClass: "app-state",
          rebuildable: false,
        },
      ],
      migrationMetadata: {
        currentVersion: "7",
        minimumSupportedVersion: "5",
        migrations: [
          {
            id: "notes-state-6-to-7",
            fromVersion: "6",
            toVersion: "7",
            reversible: true,
            hookRef: "artifact://vita/notes/1.2.3/migrations/6-to-7",
          },
        ],
      },
    },
    policy: {
      dataGrants: [
        {
          name: "state",
          class: "app-state",
          access: dataAccess,
          scope: "state",
        },
      ],
      networkGrants: [
        {
          name: "web",
          direction: "ingress",
          protocol: "https",
          ports: [443],
          public: false,
        },
        {
          name: "updates",
          direction: "egress",
          protocol: "https",
          destination: "updates.example.invalid",
          ports: [443],
        },
      ],
      resourceLimits: {
        cpuCores: 2,
        ramMiB: 512,
        storageMiB: 1024,
      },
      identityBindings: [
        {
          name: "owner",
          identityRef: "identity://vita/local-owner",
          role: "admin",
        },
      ],
    },
    simulation: {
      requiredProfiles: options.requiredProfiles ?? Array.from(REQUIRED_PROFILES),
      expectedHealthChecks: [
        {
          name: "http",
          type: "http",
          target: "/healthz",
          intervalSeconds: 30,
          timeoutSeconds: 5,
        },
      ],
      failureTests: [
        {
          name: "restore-after-power-loss",
          profile: "power-loss",
          fault: "host-power-loss",
          expectedHealth: "http",
          timeoutSeconds: 120,
        },
      ],
    },
  };
}

function matchingPolicy(
  options: {
    readonly dataAccess?: "read-only" | "read-write";
  } = {},
): BrokerPolicy {
  return {
    data: [
      {
        class: "app-state",
        access: options.dataAccess ?? "read-only",
        scope: "state",
      },
    ],
    network: {
      ingress: [
        {
          name: "web",
          protocol: "https",
          port: 443,
          public: false,
        },
      ],
      egress: [
        {
          name: "updates",
          protocol: "https",
          destinations: ["updates.example.invalid"],
          ports: [443],
        },
      ],
    },
  };
}

function validPackageContract(
  options: {
    readonly architectures?: PackageContract["architectures"];
    readonly dataAccess?: "read-only" | "read-write";
    readonly packageClass?: PackageContract["packageClass"];
    readonly zeroCapabilities?: boolean;
  } = {},
): PackageContract {
  const zeroCapabilities = options.zeroCapabilities ?? false;

  return {
    packageClass: options.packageClass ?? "ts-service",
    identity: {
      id: "com.vita.notes",
      name: "Vita Notes",
    },
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    version: "1.2.3",
    digest: {
      algorithm: "sha256",
      value: "8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25",
    },
    architectures: options.architectures ?? ["x86_64"],
    resources: {
      cpuCores: 1,
      ramMiB: 256,
      storageMiB: 512,
    },
    accelerators: {
      required: [],
      optional: [],
      preference: ["cpu"],
    },
    network: {
      ingress: zeroCapabilities
        ? []
        : [
            {
              name: "web",
              protocol: "https",
              port: 443,
              public: false,
            },
          ],
      egress: zeroCapabilities
        ? []
        : [
            {
              name: "updates",
              protocol: "https",
              destinations: ["updates.example.invalid"],
              ports: [443],
            },
          ],
    },
    data: {
      classes: zeroCapabilities ? [] : ["app-state"],
      volumes: zeroCapabilities
        ? []
        : [
            {
              name: "state",
              mountPath: "/var/lib/vita-notes",
              class: "app-state",
              access: options.dataAccess ?? "read-only",
              persistence: "persistent",
              backup: true,
              sizeMiB: 512,
            },
          ],
    },
    secrets: [],
    backup: {
      strategy: "none",
      includeVolumes: [],
      quiesceHooks: [],
      backupHooks: [],
    },
    restore: {
      requireCleanVerification: true,
      verificationHooks: [],
    },
    healthChecks: [],
    updates: {
      channel: "stable",
      strategy: "replace",
      schemaMigrations: [],
    },
    rollback: {
      maxRollbackVersions: 2,
      maxRollbackAgeDays: 30,
      requiresFreshBackup: true,
    },
    exportFormats: ["json"],
    endOfSupportDate: "2028-12-31",
    sbom: {
      format: "spdx-json",
      digest: {
        algorithm: "sha256",
        value: "497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e",
      },
      generatedAt: "2026-06-01T12:00:00.000Z",
    },
    vulnerabilityStatus: {
      status: "clean",
      scannedAt: "2026-06-01T12:10:00.000Z",
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    requiredSimulationProfiles: [],
  };
}

function digest(value: string): { readonly algorithm: "sha256"; readonly value: string } {
  return {
    algorithm: "sha256",
    value,
  };
}

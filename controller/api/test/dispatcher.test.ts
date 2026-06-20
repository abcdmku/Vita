import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryControllerApi,
  dispatchControllerRequest,
} from "../src/dispatcher.ts";
import { normalize } from "../../../sdk/typescript/src/plan.ts";
import type { ControllerApiDispatchResult, IdentityRole } from "../src/contracts.ts";
import type { BrokerPolicy, CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
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
    readonly dataAccess?: "read-only" | "read-write";
    readonly zeroCapabilities?: boolean;
  } = {},
): PackageContract {
  const zeroCapabilities = options.zeroCapabilities ?? false;

  return {
    packageClass: "ts-service",
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
    architectures: ["x86_64"],
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

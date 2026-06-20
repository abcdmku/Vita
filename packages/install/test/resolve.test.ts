import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveInstallPlan } from "../src/resolve.ts";
import type { ResolveInstallPlanResult } from "../src/resolve.ts";
import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type {
  ImmutableDigest,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";

interface InstallEntryFixture extends CatalogEntry {
  readonly requestedCapabilities: readonly CapabilityGrant[];
}

type MutableJsonObject = { [key: string]: unknown };
type ResolveInstallPlanErrorCode =
  Extract<ResolveInstallPlanResult, { readonly ok: false }>["errors"][number]["code"];

const dataRead: CapabilityGrant = {
  access: "read-only",
  class: "app-state",
  kind: "data",
  scope: "state",
};

const privateIngress: CapabilityGrant = {
  direction: "ingress",
  kind: "network",
  port: 8443,
  protocol: "https",
  public: false,
};

const declaredEgress: CapabilityGrant = {
  destination: "updates.example.invalid",
  direction: "egress",
  kind: "network",
  port: 443,
  protocol: "https",
};

test("valid entry and pinned npm lockfile resolve to ordered plan and requested grants only", () => {
  const requestedCapabilities = [dataRead, privateIngress];
  const result = resolveInstallPlan(
    validInstallEntry({ requestedCapabilities }),
    validNpmLockfileWithUnusedRecord(),
  );
  const plan = assertPlan(result);

  assert.deepEqual(
    plan.steps.map((step) => `${step.name}@${step.version}`),
    ["beta@2.0.0", "alpha@1.2.3"],
  );
  assert.deepEqual(plan.capabilityGrants, requestedCapabilities);
  assert.equal(plan.package.id, "com.vita.notes");
  assert.equal(plan.trustTier, "verified");
});

test("reachable closure excludes unrelated pinned lockfile records", () => {
  const plan = assertPlan(
    resolveInstallPlan(validInstallEntry(), validNpmLockfileWithUnusedRecord()),
  );

  assert.deepEqual(
    plan.steps.map((step) => step.name),
    ["beta", "alpha"],
  );
  assert.equal(plan.steps.some((step) => step.name === "unused"), false);
});

test("unpinned, script-bearing, and remote lockfiles reject through policy", () => {
  const unpinned = validNpmLockfile();
  objectAt(objectAt(unpinned, "packages"), "node_modules/alpha").version = "^1.2.3";

  assertRejects(resolveInstallPlan(validInstallEntry(), unpinned), "INVALID_LOCKFILE_POLICY");

  const scriptBearing = validNpmLockfile();
  objectAt(objectAt(scriptBearing, "packages"), "node_modules/alpha").scripts = {
    postinstall: "node install.js",
  };

  assertRejects(
    resolveInstallPlan(validInstallEntry(), scriptBearing),
    "INVALID_LOCKFILE_POLICY",
  );

  const remote = validNpmLockfile();
  objectAt(objectAt(remote, "packages"), "node_modules/alpha").resolved =
    "https://registry.example.invalid/alpha.tgz";

  assertRejects(resolveInstallPlan(validInstallEntry(), remote), "INVALID_LOCKFILE_POLICY");
});

test("out-of-tier requested capability rejects instead of being silently dropped", () => {
  const result = resolveInstallPlan(
    validInstallEntry({
      requestedCapabilities: [declaredEgress],
      trustTier: "community",
    }),
    validNpmLockfile(),
  );

  assertRejects(result, "CAPABILITY_DENIED");
  assert.match(formatErrors(rejectErrors(result)), /POLICY_DENIED/u);
});

test("missing requestedCapabilities rejects fail-closed", () => {
  const entry = validInstallEntry() as unknown as MutableJsonObject;
  delete entry.requestedCapabilities;

  assertRejects(
    resolveInstallPlan(entry, validNpmLockfile()),
    "MISSING_REQUESTED_CAPABILITIES",
  );
});

test("hostile entry and lockfile inputs reject through safeNormalize without throwing", () => {
  const getterEntry = validInstallEntry() as unknown as MutableJsonObject;
  Object.defineProperty(getterEntry, "requestedCapabilities", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape");
    },
  });

  assert.doesNotThrow(() => resolveInstallPlan(getterEntry, validNpmLockfile()));
  assertRejects(resolveInstallPlan(getterEntry, validNpmLockfile()), "NORMALIZATION_FAILED");

  const cyclic = validNpmLockfile();
  objectAt(cyclic, "packages").self = cyclic;

  assert.doesNotThrow(() => resolveInstallPlan(validInstallEntry(), cyclic));
  assertRejects(resolveInstallPlan(validInstallEntry(), cyclic), "NORMALIZATION_FAILED");

  const shadowedCapabilities = validInstallEntry();
  const requested = shadowedCapabilities.requestedCapabilities as unknown as MutableJsonObject;
  requested.some = () => true;

  assertRejects(
    resolveInstallPlan(shadowedCapabilities, validNpmLockfile()),
    "NORMALIZATION_FAILED",
  );
});

test("conflicting duplicate name and version records reject", () => {
  const lockfile = validNpmLockfile();
  objectAt(lockfile, "packages")["node_modules/nester/node_modules/alpha"] = {
    dependencies: {
      beta: "2.0.0",
    },
    integrity: sri("x"),
    resolved: "alpha@1.2.3",
    version: "1.2.3",
  };

  const result = resolveInstallPlan(validInstallEntry(), lockfile);

  assertRejects(result, "INVALID_LOCKFILE_GRAPH");
  assert.match(formatErrors(rejectErrors(result)), /Conflicting duplicate package record/u);
});

test("JSR specifier roots resolve reachable dependency closure", () => {
  const plan = assertPlan(resolveInstallPlan(validInstallEntry(), validJsrLockfile()));

  assert.deepEqual(
    plan.steps.map((step) => `${step.name}@${step.version}`),
    ["@scope/pkg@2.0.0", "@scope/root@1.0.0"],
  );
  assert.deepEqual(plan.steps[0]?.dependencies, []);
  assert.deepEqual(plan.steps[1]?.dependencies, [{ name: "@scope/pkg", version: "2.0.0" }]);
});

function assertPlan(result: ResolveInstallPlanResult): Extract<ResolveInstallPlanResult, { readonly ok: true }>["plan"] {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result.plan;
}

function assertRejects(
  result: ResolveInstallPlanResult,
  code: ResolveInstallPlanErrorCode,
): void {
  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected install plan resolution to reject");
  }

  assert.equal(
    result.errors.some((error) => error.code === code),
    true,
    formatErrors(result.errors),
  );
}

function rejectErrors(
  result: ResolveInstallPlanResult,
): Extract<ResolveInstallPlanResult, { readonly ok: false }>["errors"] {
  if (result.ok) {
    assert.fail("expected install plan resolution to reject");
  }

  return result.errors;
}

function validInstallEntry(
  options: {
    readonly requestedCapabilities?: readonly CapabilityGrant[];
    readonly trustTier?: "verified" | "community";
  } = {},
): InstallEntryFixture {
  const contract = validPackageContract();

  return {
    digest: contract.digest,
    endOfSupport: contract.endOfSupportDate,
    package: contract,
    requestedCapabilities: options.requestedCapabilities ?? [dataRead],
    sbom: {
      digest: contract.sbom.digest,
      format: "spdx-json",
      generatedAt: contract.sbom.generatedAt,
      ref: "sbom://vita/notes/1.2.3/spdx",
    },
    signatures: [
      {
        algorithm: "sigstore-bundle",
        digest: digest("a34d88f8f4f5b74051f10b39a6f8a62ffb1a4d993db1ea5744d70d7f4a7dd04f"),
        keyRef: "publisher-key://vita/first-party/stable",
        ref: "signature://vita/notes/1.2.3/sigstore",
        signedAt: "2026-06-01T12:20:00.000Z",
      },
    ],
    signingPublisher: contract.signingPublisher,
    trustTier: options.trustTier ?? "verified",
    vulnerabilityStatus: contract.vulnerabilityStatus,
  };
}

function validPackageContract(): PackageContract {
  return {
    accelerators: {
      optional: [],
      preference: ["cpu"],
      required: [],
    },
    architectures: ["x86_64", "arm64"],
    backup: {
      backupHooks: [],
      includeVolumes: ["state"],
      quiesceHooks: [],
      strategy: "filesystem-snapshot",
    },
    data: {
      classes: ["app-state"],
      volumes: [
        {
          access: "read-write",
          backup: true,
          class: "app-state",
          mountPath: "/var/lib/vita-notes",
          name: "state",
          persistence: "persistent",
          sizeMiB: 512,
        },
      ],
    },
    digest: digest("8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
    endOfSupportDate: "2028-12-31",
    exportFormats: ["json"],
    healthChecks: [],
    identity: {
      description: "First-party notes service.",
      id: "com.vita.notes",
      name: "Vita Notes",
    },
    network: {
      egress: [
        {
          destinations: ["updates.example.invalid"],
          name: "updates",
          ports: [443],
          protocol: "https",
        },
      ],
      ingress: [{ name: "private-api", port: 8443, protocol: "https", public: false }],
    },
    packageClass: "ts-service",
    requiredSimulationProfiles: [],
    resources: {
      cpuCores: 1,
      ramMiB: 256,
      storageMiB: 512,
    },
    restore: {
      requireCleanVerification: true,
      verificationHooks: [],
    },
    rollback: {
      maxRollbackAgeDays: 30,
      maxRollbackVersions: 2,
      requiresFreshBackup: true,
    },
    sbom: {
      digest: digest("497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e"),
      format: "spdx-json",
      generatedAt: "2026-06-01T12:00:00.000Z",
    },
    secrets: [],
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    updates: {
      channel: "stable",
      schemaMigrations: [],
      strategy: "replace",
    },
    version: "1.2.3",
    vulnerabilityStatus: {
      critical: 0,
      high: 0,
      low: 0,
      medium: 0,
      scannedAt: "2026-06-01T12:10:00.000Z",
      status: "clean",
    },
  };
}

function validNpmLockfileWithUnusedRecord(): MutableJsonObject {
  const lockfile = validNpmLockfile();
  objectAt(lockfile, "packages")["node_modules/unused"] = {
    integrity: sri("u"),
    resolved: "unused@9.9.9",
    version: "9.9.9",
  };

  return lockfile;
}

function validNpmLockfile(): MutableJsonObject {
  return {
    lockfileVersion: 3,
    name: "vita-app",
    packages: {
      "": {
        dependencies: {
          alpha: "1.2.3",
        },
        name: "vita-app",
        version: "1.0.0",
      },
      "node_modules/alpha": {
        dependencies: {
          beta: "2.0.0",
        },
        integrity: sri("a"),
        resolved: "alpha@1.2.3",
        version: "1.2.3",
      },
      "node_modules/beta": {
        integrity: sri("b"),
        resolved: "beta@2.0.0",
        version: "2.0.0",
      },
    },
    requires: true,
    version: "1.0.0",
  };
}

function validJsrLockfile(): MutableJsonObject {
  return {
    resolved: {
      "@scope/pkg@2.0.0": {
        integrity: sri("j"),
        source: "@scope/pkg@2.0.0",
        version: "2.0.0",
      },
      "@scope/root@1.0.0": {
        dependencies: {
          "@scope/pkg": "2.0.0",
        },
        integrity: sri("r"),
        source: "@scope/root@1.0.0",
        version: "1.0.0",
      },
      "unused@9.9.9": {
        integrity: sri("u"),
        source: "unused@9.9.9",
        version: "9.9.9",
      },
    },
    specifiers: {
      "jsr:@scope/root@1.0.0": "1.0.0",
    },
    version: "1",
  };
}

function sri(seed: string): string {
  const first = seed.charCodeAt(0);
  const byte = Number.isFinite(first) ? first : 0;

  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

function digest(value: string): ImmutableDigest {
  return {
    algorithm: "sha256",
    value,
  };
}

function objectAt(value: MutableJsonObject, key: string): MutableJsonObject {
  const child = value[key];

  if (!mutableJsonObject(child)) {
    assert.fail(`expected object at ${key}`);
  }

  return child;
}

function mutableJsonObject(value: unknown): value is MutableJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatErrors(errors: readonly { readonly path: string; readonly message: string }[]): string {
  return errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n");
}

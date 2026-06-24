import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { resolveFromCatalog } from "../src/resolve-from-catalog.ts";
import type {
  ResolveFromCatalogError,
  ResolveFromCatalogResult,
} from "../src/resolve-from-catalog.ts";
import type { MirrorStore } from "../src/mirror.ts";
import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type {
  CatalogPayload,
  SignedCatalogManifest,
} from "../../catalog/src/catalog-manifest.ts";
import {
  signCatalog,
  TEST_CATALOG_TRUSTED_KEYS,
} from "../../catalog/test/fixtures/catalog-test-signing.ts";
import type {
  ImmutableDigest,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";

interface InstallEntryFixture extends CatalogEntry {
  readonly requestedCapabilities: readonly CapabilityGrant[];
}

type MutableJsonObject = { [key: string]: unknown };
type ResolveFromCatalogErrorCode = ResolveFromCatalogError["code"];
type SriAlgorithm = "sha256" | "sha384" | "sha512";

const packageRef = "package://vita/notes/1.2.3";
const alphaBytes = bytes("alpha package tarball");
const betaBytes = bytes("beta package tarball");

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

test("valid verified catalog app resolves to ordered install plan, grants, package ref, and mirror closure", () => {
  const requestedCapabilities = [dataRead, privateIngress];
  const fixture = signedFixture({ requestedCapabilities });
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: fixture.catalog,
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });
  const plan = assertPlan(result);

  assert.equal(plan.packageRef, packageRef);
  assert.equal(plan.integrity, fixture.artifactIntegrity);
  assert.equal(plan.packageClass, "ts-service");
  assert.deepEqual(plan.resourceLimits, { cpuCores: 1, ramMiB: 256, storageMiB: 512 });
  assert.equal(plan.package.id, "com.vita.notes");
  assert.equal(plan.trustTier, "verified");
  assert.deepEqual(plan.capabilityGrants, requestedCapabilities);
  assert.deepEqual(
    plan.steps.map((step) => `${step.name}@${step.version}`),
    ["beta@2.0.0", "alpha@1.2.3"],
  );
  assert.deepEqual(
    plan.mirrorResolution.packages.map((entry) => entry.key),
    ["alpha@1.2.3", "beta@2.0.0"],
  );
});

test("tampered catalog rejects as CATALOG_UNVERIFIED before mirror resolution", () => {
  const fixture = signedFixture();
  const tampered: SignedCatalogManifest = {
    ...fixture.catalog,
    catalog: {
      ...fixture.catalog.catalog,
      apps: fixture.catalog.catalog.apps.map((app) => ({
        ...app,
        id: app.id === "com.vita.notes" ? "com.vita.notes.tampered" : app.id,
      })),
    },
  };
  const mirrorStore = countingMirrorStore(validMirrorEntries(fixture.artifactBytes));
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: tampered,
    mirrorStore,
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });

  assertRejects(result, "CATALOG_UNVERIFIED");
  assert.equal(mirrorStore.calls(), 0);

  assertRejects(
    resolveFromCatalog({
      appId: "",
      catalog: tampered,
      mirrorStore: null,
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "",
    }),
    "CATALOG_UNVERIFIED",
  );
});

test("unknown app and version reject fail-closed", () => {
  const fixture = signedFixture();

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.unknown",
      catalog: fixture.catalog,
      mirrorStore: validMirrorStore(fixture.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "APP_NOT_FOUND",
  );

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: fixture.catalog,
      mirrorStore: validMirrorStore(fixture.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "9.9.9",
    }),
    "VERSION_NOT_FOUND",
  );
});

test("missing and bad-SRI dependencies reject through mirror resolution", () => {
  const fixture = signedFixture();

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: fixture.catalog,
      mirrorStore: mirrorStore([
        [packageRef, fixture.artifactBytes],
        ["alpha@1.2.3", alphaBytes],
      ]),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "NOT_IN_MIRROR",
  );

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: fixture.catalog,
      mirrorStore: mirrorStore([
        [packageRef, fixture.artifactBytes],
        ["alpha@1.2.3", alphaBytes],
        ["beta@2.0.0", bytes("tampered beta package tarball")],
      ]),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "INTEGRITY_MISMATCH",
  );
});

test("resolution output is byte-identical under input key reorder", () => {
  const fixture = signedFixture();
  const first = assertPlan(resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: fixture.catalog,
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  }));
  const second = assertPlan(resolveFromCatalog({
    version: "1.2.3",
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    catalog: reorderedSignedCatalog(fixture.catalog),
    appId: "com.vita.notes",
  }));

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("hostile boundary inputs reject without throwing", () => {
  const fixture = signedFixture();

  const cyclicCatalog: MutableJsonObject = {};
  cyclicCatalog.catalog = cyclicCatalog;
  cyclicCatalog.signature = {
    algorithm: "ed25519",
    keyId: "vita-catalog-test-ed25519",
    value: "AAAA",
  };
  assert.doesNotThrow(() =>
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: cyclicCatalog,
      mirrorStore: validMirrorStore(fixture.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
  );
  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: cyclicCatalog,
      mirrorStore: validMirrorStore(fixture.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "CATALOG_UNVERIFIED",
  );

  const accessorInput: MutableJsonObject = {
    appId: "com.vita.notes",
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  };
  Object.defineProperty(accessorInput, "catalog", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape");
    },
  });
  assert.doesNotThrow(() => resolveFromCatalog(accessorInput));
  assertRejects(resolveFromCatalog(accessorInput), "POLICY_REJECTED");

  const protoInput: MutableJsonObject = {
    appId: "com.vita.notes",
    catalog: fixture.catalog,
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  };
  Object.defineProperty(protoInput, "__proto__", {
    configurable: true,
    enumerable: true,
    value: "polluted",
    writable: true,
  });
  assert.doesNotThrow(() => resolveFromCatalog(protoInput));
  assertRejects(resolveFromCatalog(protoInput), "POLICY_REJECTED");
});

function assertPlan(
  result: ResolveFromCatalogResult,
): Extract<ResolveFromCatalogResult, { readonly ok: true }>["plan"] {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result.plan;
}

function assertRejects(
  result: ResolveFromCatalogResult,
  code: ResolveFromCatalogErrorCode,
): void {
  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected catalog install resolution to reject");
  }

  assert.equal(
    result.errors.some((entry) => entry.code === code),
    true,
    formatErrors(result.errors),
  );
}

function signedFixture(
  options: {
    readonly requestedCapabilities?: readonly CapabilityGrant[];
  } = {},
): {
  readonly artifactBytes: Uint8Array;
  readonly artifactIntegrity: string;
  readonly catalog: SignedCatalogManifest;
} {
  const entry = options.requestedCapabilities === undefined
    ? validInstallEntry()
    : validInstallEntry({ requestedCapabilities: options.requestedCapabilities });
  const artifactBytes = packageArtifactBytes({
    entry,
    lockfile: validNpmLockfile(),
  });
  const artifactIntegrity = sri(artifactBytes, "sha512");

  return {
    artifactBytes,
    artifactIntegrity,
    catalog: signCatalog(validCatalog(artifactIntegrity)),
  };
}

function packageArtifactBytes(value: {
  readonly entry: InstallEntryFixture;
  readonly lockfile: MutableJsonObject;
}): Uint8Array {
  return bytes(JSON.stringify(value));
}

function validCatalog(artifactIntegrity: string): CatalogPayload {
  return {
    apps: [
      {
        id: "com.vita.notes",
        versions: [
          {
            grantsSummary: ["capability.network.ingress", "capability.storage.app-state"],
            integrity: artifactIntegrity,
            packageRef,
            riskSummary: "R1",
            version: "1.2.3",
          },
        ],
      },
    ],
    catalogVersion: "2026.06.23",
    generatedAt: "2026-06-23T12:00:00.000Z",
    schemaVersion: "vita.catalog.v1",
  };
}

function validInstallEntry(
  options: {
    readonly requestedCapabilities?: readonly CapabilityGrant[];
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
    trustTier: "verified",
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
      egress: [],
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
        integrity: sri(alphaBytes, "sha256"),
        resolved: "alpha@1.2.3",
        version: "1.2.3",
      },
      "node_modules/beta": {
        integrity: sri(betaBytes, "sha512"),
        resolved: "beta@2.0.0",
        version: "2.0.0",
      },
    },
    requires: true,
    version: "1.0.0",
  };
}

function validMirrorStore(artifactBytes: Uint8Array): MirrorStore {
  return mirrorStore(validMirrorEntries(artifactBytes));
}

function validMirrorEntries(artifactBytes: Uint8Array): readonly (readonly [string, Uint8Array])[] {
  return [
    [packageRef, artifactBytes],
    ["alpha@1.2.3", alphaBytes],
    ["beta@2.0.0", betaBytes],
  ];
}

function mirrorStore(entries: readonly (readonly [string, Uint8Array])[]): MirrorStore {
  return new Map(entries);
}

function countingMirrorStore(entries: readonly (readonly [string, Uint8Array])[]): MirrorStore & {
  readonly calls: () => number;
} {
  const values = new Map(entries);
  let calls = 0;

  return {
    calls() {
      return calls;
    },
    get(key: string): Uint8Array | undefined {
      calls += 1;
      return values.get(key);
    },
  };
}

function reorderedSignedCatalog(manifest: SignedCatalogManifest): SignedCatalogManifest {
  return {
    signature: {
      value: manifest.signature.value,
      keyId: manifest.signature.keyId,
      algorithm: manifest.signature.algorithm,
    },
    catalog: {
      generatedAt: manifest.catalog.generatedAt,
      catalogVersion: manifest.catalog.catalogVersion,
      apps: manifest.catalog.apps.map((app) => ({
        versions: app.versions.map((version) => ({
          riskSummary: version.riskSummary,
          packageRef: version.packageRef,
          version: version.version,
          integrity: version.integrity,
          grantsSummary: version.grantsSummary,
        })),
        id: app.id,
      })),
      schemaVersion: manifest.catalog.schemaVersion,
    },
  };
}

function sri(value: Uint8Array, algorithm: SriAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(value).digest("base64")}`;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function digest(value: string): ImmutableDigest {
  return {
    algorithm: "sha256",
    value,
  };
}

function formatErrors(errors: readonly ResolveFromCatalogError[]): string {
  return errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("\n");
}

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

import { resolveFromCatalog } from "../src/resolve-from-catalog.ts";
import type {
  ResolveFromCatalogError,
  ResolveFromCatalogResult,
} from "../src/resolve-from-catalog.ts";
import type { MirrorStore } from "../src/mirror.ts";
import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type {
  CatalogAppVersion,
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
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

interface InstallEntryFixture extends CatalogEntry {
  readonly requestedCapabilities: readonly CapabilityGrant[];
}

interface ExecutionManifestFixture {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly packageClass: "ts-service" | "oci-service" | "wasm-service";
  readonly runtime: PlainJsonObject;
  readonly resourceLimits: {
    readonly cpuCores: number;
    readonly ramMiB: number;
    readonly storageMiB: number;
    readonly tasksMax: number;
  };
  readonly data?: PlainJsonObject | null;
  readonly healthChecks?: readonly PlainJson[] | null;
  readonly lifecyclePolicy?: PlainJsonObject | null;
  readonly network?: PlainJsonObject | null;
}

type MutableJsonObject = { [key: string]: unknown };
type ResolveFromCatalogErrorCode = ResolveFromCatalogError["code"];
type SriAlgorithm = "sha256" | "sha384" | "sha512";

const packageRef = "file:///mirror/vita/notes-1.2.3.capsule.tar.zst";
const alphaBytes = bytes("alpha package tarball");
const betaBytes = bytes("beta package tarball");
const TAR_BLOCK_BYTES = 512;

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

test("valid verified catalog app resolves to ordered install plan, grants, artifact ref, and mirror closure", () => {
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

test("legacy metadata envelope is not accepted as the package artifact", () => {
  const metadataBytes = bytes(JSON.stringify({
    entry: validInstallEntry(),
    lockfile: validNpmLockfile(),
  }));
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: signCatalog(validCatalog({
      artifactIntegrity: sri(metadataBytes, "sha512"),
      entry: validInstallEntry(),
      lockfile: validNpmLockfile(),
    })),
    mirrorStore: validMirrorStore(metadataBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });

  assertRejects(result, "POLICY_REJECTED");
});

test("capsule ExecutionManifest id and version must match the verified catalog selection", () => {
  const mismatchedApp = signedFixture({
    executionManifest: validExecutionManifest({ id: "com.other.app" }),
  });
  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: mismatchedApp.catalog,
      mirrorStore: validMirrorStore(mismatchedApp.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "POLICY_REJECTED",
  );

  const mismatchedVersion = signedFixture({
    executionManifest: validExecutionManifest({ version: "9.9.9" }),
  });
  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: mismatchedVersion.catalog,
      mirrorStore: validMirrorStore(mismatchedVersion.artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "POLICY_REJECTED",
  );
});

test("capsule ExecutionManifest nested __proto__ field rejects fail-closed", () => {
  const manifest = validExecutionManifest() as ExecutionManifestFixture & MutableJsonObject;
  const runtime = manifest.runtime as unknown as MutableJsonObject;
  Object.defineProperty(runtime, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { typescript: { entrypoint: "main.ts" } },
    writable: true,
  });
  const artifactBytes = packageArtifactBytes({ manifest });
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: signCatalog(validCatalog({
      artifactIntegrity: sri(artifactBytes, "sha512"),
      entry: validInstallEntry(),
      lockfile: validNpmLockfile(),
    })),
    mirrorStore: validMirrorStore(artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });

  assertRejects(result, "POLICY_REJECTED");
});

test("capsule ExecutionManifest duplicate JSON keys reject before last-wins parsing", () => {
  const manifestJson = `{"id":"com.other.app",${JSON.stringify(validExecutionManifest()).slice(1)}`;
  const artifactBytes = packageArtifactBytesFromManifestJson(manifestJson);
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: signCatalog(validCatalog({
      artifactIntegrity: sri(artifactBytes, "sha512"),
      entry: validInstallEntry(),
      lockfile: validNpmLockfile(),
    })),
    mirrorStore: validMirrorStore(artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });

  assertRejects(result, "POLICY_REJECTED");
});

test("capsule artifact must be zstd and use a root manifest.json", () => {
  const rawTar = tarArchive({
    "main.ts": bytes("export default {};\n"),
    "manifest.json": bytes(JSON.stringify(validExecutionManifest())),
  });
  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: signCatalog(validCatalog({
        artifactIntegrity: sri(rawTar, "sha512"),
        entry: validInstallEntry(),
        lockfile: validNpmLockfile(),
      })),
      mirrorStore: validMirrorStore(rawTar),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "POLICY_REJECTED",
  );

  const nestedManifest = zstdCompressSync(tarArchive({
    "main.ts": bytes("export default {};\n"),
    "nested/manifest.json": bytes(JSON.stringify(validExecutionManifest())),
  }));
  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: signCatalog(validCatalog({
        artifactIntegrity: sri(nestedManifest, "sha512"),
        entry: validInstallEntry(),
        lockfile: validNpmLockfile(),
      })),
      mirrorStore: validMirrorStore(nestedManifest),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "POLICY_REJECTED",
  );
});

test("capsule artifact SRI mismatch rejects before install planning", () => {
  const fixture = signedFixture();
  const tamperedArtifact = packageArtifactBytes({
    manifest: validExecutionManifest({ integrity: sri(bytes("tampered manifest-declared integrity"), "sha256") }),
  });

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: fixture.catalog,
      mirrorStore: validMirrorStore(tamperedArtifact),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "INTEGRITY_MISMATCH",
  );
});

test("capsule ExecutionManifest runtime and optional sub-shapes validate fail-closed", () => {
  const ociRuntimeMissingDigest = validExecutionManifest({
    packageClass: "oci-service",
    runtime: {
      oci: {
        image: {
          entrypoint: ["/init"],
        },
      },
    },
  });
  assertRejects(
    resolveFromCatalog(fixtureInput({
      executionManifest: ociRuntimeMissingDigest,
      packageContract: validPackageContract({ packageClass: "oci-service" }),
    })),
    "POLICY_REJECTED",
  );

  assertRejects(
    resolveFromCatalog(fixtureInput({
      executionManifest: validExecutionManifest({
        network: {},
      }),
    })),
    "POLICY_REJECTED",
  );

  assertRejects(
    resolveFromCatalog(fixtureInput({
      executionManifest: validExecutionManifest({
        lifecyclePolicy: {
          onUnhealthy: "bad",
        },
      }),
    })),
    "POLICY_REJECTED",
  );

  assertRejects(
    resolveFromCatalog(fixtureInput({
      executionManifest: validExecutionManifest({
        healthChecks: [
          {
            intervalSeconds: 0,
            name: "ready",
            target: "http://127.0.0.1:8787/health",
            timeoutSeconds: 1,
            type: "http",
          },
        ],
      }),
    })),
    "POLICY_REJECTED",
  );
});

test("capsule ExecutionManifest packageClass must match the signed package contract", () => {
  assertRejects(
    resolveFromCatalog(fixtureInput({
      executionManifest: validExecutionManifest({
        packageClass: "oci-service",
        runtime: {
          oci: {
            image: {
              digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              entrypoint: ["/init"],
            },
          },
        },
      }),
      packageContract: validPackageContract({ packageClass: "ts-service" }),
    })),
    "POLICY_REJECTED",
  );
});

test("capsule ExecutionManifest integer fields reject float and exponent tokens", () => {
  const manifestJson = JSON.stringify(validExecutionManifest()).replace('"tasksMax":64', '"tasksMax":6.4e1');
  const artifactBytes = packageArtifactBytesFromManifestJson(manifestJson);

  assertRejects(
    resolveFromCatalog({
      appId: "com.vita.notes",
      catalog: signCatalog(validCatalog({
        artifactIntegrity: sri(artifactBytes, "sha512"),
        entry: validInstallEntry(),
        lockfile: validNpmLockfile(),
      })),
      mirrorStore: validMirrorStore(artifactBytes),
      trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
      version: "1.2.3",
    }),
    "POLICY_REJECTED",
  );
});

test("catalog install entry own __proto__ field rejects instead of mutating the candidate prototype", () => {
  const entry = validInstallEntry() as InstallEntryFixture & MutableJsonObject;
  Object.defineProperty(entry, "__proto__", {
    configurable: true,
    enumerable: true,
    value: {
      package: validPackageContract({ id: "com.other.app" }),
    },
    writable: true,
  });
  const artifactBytes = packageArtifactBytes({ manifest: validExecutionManifest() });
  const result = resolveFromCatalog({
    appId: "com.vita.notes",
    catalog: signCatalog(validCatalog({
      artifactIntegrity: sri(artifactBytes, "sha512"),
      entry,
      lockfile: validNpmLockfile(),
    })),
    mirrorStore: validMirrorStore(artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  });

  assertRejects(result, "CATALOG_UNVERIFIED");
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
    readonly packageContract?: PackageContract;
    readonly executionManifest?: ExecutionManifestFixture;
  } = {},
): {
  readonly artifactBytes: Uint8Array;
  readonly artifactIntegrity: string;
  readonly catalog: SignedCatalogManifest;
} {
  const entry = validInstallEntry(options);
  const lockfile = validNpmLockfile();
  const artifactBytes = packageArtifactBytes({
    manifest: options.executionManifest ?? validExecutionManifest(),
  });
  const artifactIntegrity = sri(artifactBytes, "sha512");

  return {
    artifactBytes,
    artifactIntegrity,
    catalog: signCatalog(validCatalog({
      artifactIntegrity,
      entry,
      lockfile,
    })),
  };
}

function fixtureInput(
  options: {
    readonly requestedCapabilities?: readonly CapabilityGrant[];
    readonly packageContract?: PackageContract;
    readonly executionManifest?: ExecutionManifestFixture;
  } = {},
): Parameters<typeof resolveFromCatalog>[0] {
  const fixture = signedFixture(options);

  return {
    appId: "com.vita.notes",
    catalog: fixture.catalog,
    mirrorStore: validMirrorStore(fixture.artifactBytes),
    trustedKeys: TEST_CATALOG_TRUSTED_KEYS,
    version: "1.2.3",
  };
}

function packageArtifactBytes(value: {
  readonly manifest: ExecutionManifestFixture | MutableJsonObject;
}): Uint8Array {
  return packageArtifactBytesFromManifestJson(JSON.stringify(value.manifest));
}

function packageArtifactBytesFromManifestJson(manifestJson: string): Uint8Array {
  return zstdCompressSync(tarArchive({
    "main.ts": bytes("export default {};\n"),
    "manifest.json": bytes(manifestJson),
  }));
}

function tarArchive(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const chunks: Buffer[] = [];
  const paths = Object.keys(files).sort();

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (path === undefined) continue;

    const content = files[path];
    if (content === undefined) continue;

    chunks[chunks.length] = tarHeader(path, content.length);
    chunks[chunks.length] = Buffer.from(content);

    const padding = roundUpToTarBlock(content.length) - content.length;
    if (padding > 0) {
      chunks[chunks.length] = Buffer.alloc(padding);
    }
  }

  chunks[chunks.length] = Buffer.alloc(TAR_BLOCK_BYTES * 2);
  return Buffer.concat(chunks);
}

function tarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeTarString(header, path, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);

  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += header[index] ?? 0;
  }

  writeTarChecksum(header, checksum);
  return header;
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, "utf8");
  assert.ok(encoded.length <= length, "test tar path must fit in one header field");
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = Buffer.from(value.toString(8).padStart(length - 1, "0"), "ascii");
  assert.equal(encoded.length, length - 1);
  encoded.copy(header, offset);
}

function writeTarChecksum(header: Buffer, checksum: number): void {
  const encoded = Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii");
  assert.equal(encoded.length, 8);
  encoded.copy(header, 148);
}

function roundUpToTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function validCatalog(options: {
  readonly artifactIntegrity: string;
  readonly entry: InstallEntryFixture;
  readonly lockfile: MutableJsonObject;
}): CatalogPayload {
  return {
    apps: [
      {
        id: "com.vita.notes",
        versions: [
          {
            entry: plainJsonObject(options.entry),
            grantsSummary: ["capability.network.ingress", "capability.storage.app-state"],
            integrity: options.artifactIntegrity,
            lockfile: plainJsonObject(options.lockfile),
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
    readonly packageContract?: PackageContract;
  } = {},
): InstallEntryFixture {
  const contract = options.packageContract ?? validPackageContract();

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

function validExecutionManifest(
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly integrity?: string;
    readonly packageClass?: ExecutionManifestFixture["packageClass"];
    readonly runtime?: PlainJsonObject;
    readonly resourceLimits?: ExecutionManifestFixture["resourceLimits"];
    readonly data?: PlainJsonObject | null;
    readonly healthChecks?: readonly PlainJson[] | null;
    readonly lifecyclePolicy?: PlainJsonObject | null;
    readonly network?: PlainJsonObject | null;
  } = {},
): ExecutionManifestFixture {
  const manifest: MutableJsonObject = {
    id: options.id ?? "com.vita.notes",
    integrity: options.integrity ?? sri(bytes("execution manifest declared integrity"), "sha256"),
    packageClass: options.packageClass ?? "ts-service",
    resourceLimits: options.resourceLimits ?? {
      cpuCores: 1,
      ramMiB: 256,
      storageMiB: 512,
      tasksMax: 64,
    },
    runtime: options.runtime ?? {
      typescript: {
        entrypoint: "main.ts",
      },
    },
    version: options.version ?? "1.2.3",
  };

  if (Object.hasOwn(options, "data")) {
    manifest.data = options.data;
  }
  if (Object.hasOwn(options, "healthChecks")) {
    manifest.healthChecks = options.healthChecks;
  }
  if (Object.hasOwn(options, "lifecyclePolicy")) {
    manifest.lifecyclePolicy = options.lifecyclePolicy;
  }
  if (Object.hasOwn(options, "network")) {
    manifest.network = options.network;
  }

  return manifest as unknown as ExecutionManifestFixture;
}

function validPackageContract(
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly packageClass?: PackageContract["packageClass"];
  } = {},
): PackageContract {
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
      id: options.id ?? "com.vita.notes",
      name: "Vita Notes",
    },
    network: {
      egress: [],
      ingress: [{ name: "private-api", port: 8443, protocol: "https", public: false }],
    },
    packageClass: options.packageClass ?? "ts-service",
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
    version: options.version ?? "1.2.3",
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
        versions: app.versions.map(reorderedCatalogVersion),
        id: app.id,
      })),
      schemaVersion: manifest.catalog.schemaVersion,
    },
  };
}

function reorderedCatalogVersion(
  version: CatalogAppVersion,
): CatalogAppVersion {
  const out = {
    grantsSummary: version.grantsSummary,
    integrity: version.integrity,
    packageRef: version.packageRef,
    riskSummary: version.riskSummary,
    version: version.version,
  };

  if (version.entry !== undefined && version.lockfile !== undefined) {
    return {
      ...out,
      entry: version.entry,
      lockfile: version.lockfile,
    };
  }

  if (version.entry !== undefined) {
    return {
      ...out,
      entry: version.entry,
    };
  }

  if (version.lockfile !== undefined) {
    return {
      ...out,
      lockfile: version.lockfile,
    };
  }

  return out;
}

function sri(value: Uint8Array, algorithm: SriAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(value).digest("base64")}`;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function plainJsonObject(value: unknown): PlainJsonObject {
  const normalized = safeNormalize(value, { maxDepth: 128, maxNodes: 100_000 });
  if (!normalized.ok || !isPlainJsonObject(normalized.value)) {
    assert.fail("expected JSON object fixture");
  }

  return normalized.value;
}

function isPlainJsonObject(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

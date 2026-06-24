import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { test } from "node:test";

import { canonicalizeCatalog, canonicalizeCatalogBytes } from "../src/catalog-canonical.ts";
import { verifyCatalog } from "../src/catalog-manifest.ts";
import type {
  CatalogAppVersion,
  CatalogPayload,
  CatalogVerificationError,
  CatalogVerificationResult,
  SignedCatalogManifest,
  TrustedCatalogKeys,
} from "../src/catalog-manifest.ts";
import {
  signCatalog,
  TEST_CATALOG_KEY_ID,
  TEST_CATALOG_PUBLIC_KEY_PEM,
  TEST_CATALOG_TRUSTED_KEYS,
} from "./fixtures/catalog-test-signing.ts";

test("valid catalog signed with the TEST key verifies and round-trips apps and versions", () => {
  const signed = signCatalog(validCatalog());
  const result = verifyCatalog(signed, TEST_CATALOG_TRUSTED_KEYS);

  assertOk(result);
  assert.deepEqual(result.catalog, signed.catalog);
  assert.equal(result.catalog.apps[0]?.id, "com.vita.notes");
  assert.equal(result.catalog.apps[0]?.versions[0]?.packageRef, "package://vita/notes/1.2.3");
});

test("canonical catalog bytes are deterministic and key-order insensitive", () => {
  const catalog = validCatalog();
  const reordered = reorderedCatalog(catalog);

  assert.equal(canonicalizeCatalog(catalog), canonicalizeCatalog(catalog));
  assert.equal(canonicalizeCatalog(catalog), canonicalizeCatalog(reordered));

  const signed = signCatalog(catalog);
  const signedReordered = signCatalog(reordered);

  assert.equal(signed.signature.value, signedReordered.signature.value);
  assertOk(verifyCatalog(signedReordered, TEST_CATALOG_TRUSTED_KEYS));
});

test("tampering any catalog field after signing is rejected", () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (manifest: SignedCatalogManifest) => SignedCatalogManifest;
  }[] = [
    {
      name: "app id",
      mutate: (manifest) =>
        replaceFirstApp(manifest, (app) => ({
          ...app,
          id: "com.vita.notes.tampered",
        })),
    },
    {
      name: "version",
      mutate: (manifest) =>
        replaceFirstVersion(manifest, (version) => ({
          ...version,
          version: "9.9.9",
        })),
    },
    {
      name: "packageRef",
      mutate: (manifest) =>
        replaceFirstVersion(manifest, (version) => ({
          ...version,
          packageRef: "package://vita/notes/9.9.9",
        })),
    },
    {
      name: "integrity",
      mutate: (manifest) =>
        replaceFirstVersion(manifest, (version) => ({
          ...version,
          integrity: sri("z"),
        })),
    },
    {
      name: "riskSummary",
      mutate: (manifest) =>
        replaceFirstVersion(manifest, (version) => ({
          ...version,
          riskSummary: "R4",
        })),
    },
    {
      name: "grant",
      mutate: (manifest) =>
        replaceFirstVersion(manifest, (version) => ({
          ...version,
          grantsSummary: ["capability.filesystem", version.grantsSummary[1] ?? "capability.storage"],
        })),
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected tamper test case");
    }

    assertReject(item.mutate(signCatalog(validCatalog())), item.name);
  }
});

test("reordering apps or versions changes canonical bytes and is rejected", () => {
  const signed = signCatalog(validCatalog());
  const reorderedApps: SignedCatalogManifest = {
    ...signed,
    catalog: {
      ...signed.catalog,
      apps: [required(signed.catalog.apps[1]), required(signed.catalog.apps[0])],
    },
  };

  assert.notEqual(canonicalizeCatalog(signed.catalog), canonicalizeCatalog(reorderedApps.catalog));
  assertReject(reorderedApps, "app array reorder");

  const reorderedVersions = replaceFirstApp(signed, (app) => ({
    ...app,
    versions: [required(app.versions[1]), required(app.versions[0])],
  }));

  assert.notEqual(canonicalizeCatalog(signed.catalog), canonicalizeCatalog(reorderedVersions.catalog));
  assertReject(reorderedVersions, "version array reorder");
});

test("unsigned, empty-signature, forged-signature, and unknown-key catalogs reject fail-closed", () => {
  assertReject({ catalog: validCatalog() }, "unsigned catalog");
  assertReject(
    {
      catalog: validCatalog(),
      signature: {
        algorithm: "ed25519",
        keyId: TEST_CATALOG_KEY_ID,
        value: "",
      },
    },
    "empty signature",
  );

  const signed = signCatalog(validCatalog());
  const otherKey = generateKeyPairSync("ed25519");
  const forgedSignature = signEd25519(null, canonicalizeCatalogBytes(signed.catalog), otherKey.privateKey);

  assertReject(
    {
      ...signed,
      signature: {
        ...signed.signature,
        value: forgedSignature.toString("base64"),
      },
    },
    "forged signature",
  );

  assertReject(
    {
      ...signed,
      signature: {
        ...signed.signature,
        keyId: "vita-catalog-unknown",
      },
    },
    "unknown key",
  );
});

test("per-entry integrity rejects malformed or missing SRI and accepts padded or raw SRI", () => {
  const malformed = signCatalog(
    replaceFirstVersionInPayload(validCatalog(), (version) => ({
      ...version,
      integrity: "sha256-AAAA",
    })),
  );
  const malformedErrors = assertReject(malformed, "malformed integrity");

  assert.equal(paths(malformedErrors).includes("catalog/apps/0/versions/0/integrity"), true);

  const validRawSri = signCatalog(
    replaceFirstVersionInPayload(validCatalog(), (version) => ({
      ...version,
      integrity: sri("r").replace(/=+$/u, ""),
    })),
  );

  assertOk(verifyCatalog(validRawSri, TEST_CATALOG_TRUSTED_KEYS));

  const missingIntegrity = removeFirstIntegrity(signCatalog(validCatalog()));

  assert.equal(
    paths(assertReject(missingIntegrity, "missing integrity")).includes(
      "catalog/apps/0/versions/0/integrity",
    ),
    true,
  );
});

test("malformed, cyclic, deep, accessor, symbol, method-shadowed, and exotic inputs never throw", () => {
  const badInputs: readonly unknown[] = [
    null,
    "bad",
    42,
    new Date(),
    new Map(),
    new Proxy(signCatalog(validCatalog()), {}),
    cyclicInput(),
    deeplyNestedInput(),
    accessorInput(),
    symbolKeyInput(),
    methodShadowedArrayInput(),
    hostileIteratorInput(),
  ];

  for (let index = 0; index < badInputs.length; index += 1) {
    const input = badInputs[index];

    assert.doesNotThrow(() => verifyCatalog(input, TEST_CATALOG_TRUSTED_KEYS));
    assertReject(input, `fail-closed input ${index}`);
  }
});

test("trusted key lookup handles __proto__ and constructor key ids as own map entries", () => {
  const trustedKeys = Object.create(null) as Record<string, string>;

  Object.defineProperty(trustedKeys, "__proto__", {
    configurable: true,
    enumerable: true,
    value: TEST_CATALOG_PUBLIC_KEY_PEM,
    writable: true,
  });
  Object.defineProperty(trustedKeys, "constructor", {
    configurable: true,
    enumerable: true,
    value: TEST_CATALOG_PUBLIC_KEY_PEM,
    writable: true,
  });

  assertOk(verifyCatalog(signCatalog(validCatalog(), "__proto__"), trustedKeys));
  assertOk(verifyCatalog(signCatalog(validCatalog(), "constructor"), trustedKeys));
});

function assertOk(
  result: CatalogVerificationResult,
): asserts result is Extract<CatalogVerificationResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }
}

function assertReject(
  value: unknown,
  label: string,
  trustedKeys: TrustedCatalogKeys = TEST_CATALOG_TRUSTED_KEYS,
): readonly CatalogVerificationError[] {
  const result = verifyCatalog(value, trustedKeys);

  assert.equal(result.ok, false, label);

  if (result.ok) {
    assert.fail(`expected catalog verification to reject: ${label}`);
  }

  return result.errors;
}

function replaceFirstApp(
  manifest: SignedCatalogManifest,
  mutate: (app: SignedCatalogManifest["catalog"]["apps"][number]) => SignedCatalogManifest["catalog"]["apps"][number],
): SignedCatalogManifest {
  return {
    ...manifest,
    catalog: {
      ...manifest.catalog,
      apps: manifest.catalog.apps.map((app, index) => (index === 0 ? mutate(app) : app)),
    },
  };
}

function replaceFirstVersion(
  manifest: SignedCatalogManifest,
  mutate: (version: CatalogAppVersion) => CatalogAppVersion,
): SignedCatalogManifest {
  return replaceFirstApp(manifest, (app) => ({
    ...app,
    versions: app.versions.map((version, index) => (index === 0 ? mutate(version) : version)),
  }));
}

function replaceFirstVersionInPayload(
  catalog: CatalogPayload,
  mutate: (version: CatalogAppVersion) => CatalogAppVersion,
): CatalogPayload {
  return {
    ...catalog,
    apps: catalog.apps.map((app, appIndex) =>
      appIndex === 0
        ? {
            ...app,
            versions: app.versions.map((version, versionIndex) =>
              versionIndex === 0 ? mutate(version) : version,
            ),
          }
        : app,
    ),
  };
}

function removeFirstIntegrity(manifest: SignedCatalogManifest): unknown {
  return {
    ...manifest,
    catalog: {
      ...manifest.catalog,
      apps: manifest.catalog.apps.map((app, appIndex) =>
        appIndex === 0
          ? {
              ...app,
              versions: app.versions.map((version, versionIndex) =>
                versionIndex === 0 ? withoutIntegrity(version) : version,
              ),
            }
          : app,
      ),
    },
  };
}

function withoutIntegrity(
  version: CatalogAppVersion,
): Omit<CatalogAppVersion, "integrity"> {
  const { integrity: _integrity, ...rest } = version;

  return rest;
}

function accessorInput(): unknown {
  const signed = signCatalog(validCatalog());

  Object.defineProperty(signed.catalog, "catalogVersion", {
    enumerable: true,
    get() {
      throw new Error("getter should not be invoked");
    },
  });

  return signed;
}

function symbolKeyInput(): unknown {
  const signed = signCatalog(validCatalog());

  Object.defineProperty(signed, Symbol("catalog-extra"), {
    enumerable: true,
    value: true,
  });

  return signed;
}

function methodShadowedArrayInput(): unknown {
  const signed = signCatalog(validCatalog());

  Object.defineProperty(signed.catalog.apps, "some", {
    enumerable: true,
    value: () => true,
  });

  return signed;
}

function hostileIteratorInput(): unknown {
  const signed = signCatalog(validCatalog());

  Object.defineProperty(signed.catalog.apps, Symbol.iterator, {
    enumerable: true,
    value: function* hostileIterator() {
      yield { id: "com.vita.evil", versions: [] };
    },
  });

  return signed;
}

function cyclicInput(): unknown {
  const input: Record<string, unknown> = {};

  input.catalog = input;
  input.signature = {
    algorithm: "ed25519",
    keyId: TEST_CATALOG_KEY_ID,
    value: "AAAA",
  };

  return input;
}

function deeplyNestedInput(): unknown {
  const root: Record<string, unknown> = {};
  let cursor = root;

  for (let index = 0; index < 160; index += 1) {
    const child: Record<string, unknown> = {};

    cursor.child = child;
    cursor = child;
  }

  return root;
}

function validCatalog(): CatalogPayload {
  return {
    apps: [
      {
        id: "com.vita.notes",
        versions: [
          {
            grantsSummary: ["capability.network.egress", "capability.storage.app-state"],
            integrity: sri("a"),
            packageRef: "package://vita/notes/1.2.3",
            riskSummary: "R1",
            version: "1.2.3",
          },
          {
            grantsSummary: ["capability.network.egress", "capability.storage.app-state"],
            integrity: sri("b"),
            packageRef: "package://vita/notes/1.2.4",
            riskSummary: "R1",
            version: "1.2.4",
          },
        ],
      },
      {
        id: "com.vita.photos",
        versions: [
          {
            grantsSummary: ["capability.backup", "capability.network.egress"],
            integrity: sri("p"),
            packageRef: "package://vita/photos/2.0.0",
            riskSummary: "R2",
            version: "2.0.0",
          },
        ],
      },
    ],
    catalogVersion: "2026.06.23",
    generatedAt: "2026-06-23T12:00:00.000Z",
    schemaVersion: "vita.catalog.v1",
  };
}

function reorderedCatalog(catalog: CatalogPayload): CatalogPayload {
  return {
    apps: catalog.apps.map((app) => ({
      versions: app.versions.map((version) => ({
        grantsSummary: version.grantsSummary,
        riskSummary: version.riskSummary,
        integrity: version.integrity,
        packageRef: version.packageRef,
        version: version.version,
      })),
      id: app.id,
    })),
    generatedAt: catalog.generatedAt,
    catalogVersion: catalog.catalogVersion,
    schemaVersion: catalog.schemaVersion,
  };
}

function sri(seed: string): string {
  const first = seed.charCodeAt(0);
  const byte = Number.isFinite(first) ? first : 0;

  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    assert.fail("expected fixture value");
  }

  return value;
}

function paths(errors: readonly CatalogVerificationError[]): string[] {
  return errors.map((error) => error.path).sort(compareStrings);
}

function formatErrors(errors: readonly CatalogVerificationError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizeCatalogBytes } from "../src/catalog-canonical.ts";
import { publishCatalog } from "../src/catalog-publish.ts";
import type {
  CatalogPublishResult,
  CatalogSigner,
  PublishCatalogParams,
} from "../src/catalog-publish.ts";
import { verifyCatalog } from "../src/catalog-manifest.ts";
import type {
  CatalogApp,
  CatalogAppVersion,
  CatalogPayload,
  SignedCatalogManifest,
} from "../src/catalog-manifest.ts";
import type { CatalogEntry } from "../src/catalog-entry.ts";
import {
  signCatalogBytes,
  TEST_CATALOG_KEY_ID,
  TEST_CATALOG_PUBLIC_KEY_PEM,
  TEST_CATALOG_TRUSTED_KEYS,
} from "./fixtures/catalog-test-signing.ts";

test("publishCatalog assembles, dev-signs, and round-trips through verifyCatalog", () => {
  const signed = assertSigned(publishCatalog(validPublishParams()));
  const catalog = assertVerified(signed);

  assert.deepEqual(catalog, signed.catalog);
  assert.deepEqual(
    catalog.apps.map((app) => app.id),
    ["com.vita.notes", "com.vita.photos"],
  );

  const notes = required(catalog.apps[0]);

  assert.deepEqual(
    notes.versions.map((version) => version.version),
    ["1.2.3", "1.2.4"],
  );
  assert.deepEqual(required(notes.versions[0]).grantsSummary, [
    "capability.network.egress",
    "capability.storage.app-state",
  ]);
  assert.equal(required(notes.versions[0]).packageRef, "package://vita/notes/1.2.3");
});

test("publishCatalog rejects invalid catalog entries and produces no signed manifest", () => {
  const result = publishCatalog(
    validPublishParams({
      entries: [withoutSbom(validEntry("notes", "1.2.3"))],
    }),
  );
  const failure = assertPublishFailure(result);

  assert.equal(Object.hasOwn(failure, "catalog"), false);
  assert.equal(Object.hasOwn(failure, "signature"), false);
  assert.equal(paths(failure.errors).includes("entries/0/sbom"), true, formatErrors(failure.errors));
});

test("published canonical payload bytes are key-order insensitive", () => {
  const first = assertSigned(publishCatalog(validPublishParams()));
  const reordered = assertSigned(
    publishCatalog(
      validPublishParams({
        apps: reorderedApps(),
        entries: reorderedEntries(),
      }),
    ),
  );

  assert.equal(
    hex(canonicalizeCatalogBytes(first.catalog)),
    hex(canonicalizeCatalogBytes(reordered.catalog)),
  );
  assertVerified(first);
  assertVerified(reordered);
});

test("dev signer is wired only to the TEST catalog key fixture", () => {
  const signer = devCatalogSigner();

  assert.equal(signer.keyId, TEST_CATALOG_KEY_ID);
  assert.equal(TEST_CATALOG_TRUSTED_KEYS[signer.keyId], TEST_CATALOG_PUBLIC_KEY_PEM);
  assert.deepEqual(Object.keys(TEST_CATALOG_TRUSTED_KEYS), [TEST_CATALOG_KEY_ID]);
});

function validPublishParams(
  overrides: {
    readonly entries?: readonly unknown[];
    readonly apps?: readonly CatalogApp[];
  } = {},
): PublishCatalogParams {
  return {
    apps: overrides.apps ?? validApps(),
    catalogVersion: "2026.06.23",
    entries: overrides.entries ?? validEntries(),
    generatedAt: "2026-06-23T12:00:00.000Z",
    schemaVersion: "vita.catalog.v1",
    signer: devCatalogSigner(),
  };
}

function devCatalogSigner(): CatalogSigner {
  return {
    keyId: TEST_CATALOG_KEY_ID,
    sign(bytes) {
      return signCatalogBytes(bytes);
    },
  };
}

function validEntries(): readonly CatalogEntry[] {
  return [
    validEntry("photos", "2.0.0"),
    validEntry("notes", "1.2.3"),
    validEntry("notes", "1.2.4"),
  ];
}

function reorderedEntries(): readonly CatalogEntry[] {
  return [
    reorderedEntry(validEntry("photos", "2.0.0")),
    reorderedEntry(validEntry("notes", "1.2.3")),
    reorderedEntry(validEntry("notes", "1.2.4")),
  ];
}

function validApps(): readonly CatalogApp[] {
  return [
    {
      id: "com.vita.photos",
      versions: [
        versionRow("2.0.0", "package://vita/photos/2.0.0", "R2", [
          "capability.network.egress",
          "capability.backup",
          "capability.backup",
        ]),
      ],
    },
    {
      id: "com.vita.notes",
      versions: [
        versionRow("1.2.3", "package://vita/notes/1.2.3", "R1", [
          "capability.storage.app-state",
          "capability.network.egress",
          "capability.storage.app-state",
        ]),
        versionRow("1.2.4", "package://vita/notes/1.2.4", "R1", [
          "capability.network.egress",
          "capability.storage.app-state",
        ]),
      ],
    },
  ];
}

function reorderedApps(): readonly CatalogApp[] {
  return [
    {
      versions: [
        {
          grantsSummary: [
            "capability.network.egress",
            "capability.backup",
            "capability.backup",
          ],
          riskSummary: "R2",
          integrity: sri("p"),
          packageRef: "package://vita/photos/2.0.0",
          version: "2.0.0",
        },
      ],
      id: "com.vita.photos",
    },
    {
      versions: [
        {
          packageRef: "package://vita/notes/1.2.3",
          version: "1.2.3",
          grantsSummary: [
            "capability.storage.app-state",
            "capability.network.egress",
            "capability.storage.app-state",
          ],
          riskSummary: "R1",
          integrity: sri("a"),
        },
        {
          riskSummary: "R1",
          grantsSummary: [
            "capability.network.egress",
            "capability.storage.app-state",
          ],
          version: "1.2.4",
          integrity: sri("b"),
          packageRef: "package://vita/notes/1.2.4",
        },
      ],
      id: "com.vita.notes",
    },
  ];
}

function versionRow(
  version: string,
  packageRef: string,
  riskSummary: CatalogAppVersion["riskSummary"],
  grantsSummary: readonly string[],
): CatalogAppVersion {
  return {
    grantsSummary,
    integrity: version.endsWith(".4") ? sri("b") : packageRef.includes("photos") ? sri("p") : sri("a"),
    packageRef,
    riskSummary,
    version,
  };
}

function validEntry(handle: "notes" | "photos", version: string): CatalogEntry {
  return {
    digest: digest(handle === "notes" ? "8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25" : "7c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
    endOfSupport: "2028-12-31",
    package: `package://vita/${handle}/${version}`,
    sbom: {
      digest: digest(handle === "notes" ? "497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e" : "397f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e"),
      format: "spdx-json",
      generatedAt: "2026-06-01T12:00:00.000Z",
      ref: `sbom://vita/${handle}/${version}/spdx`,
    },
    signatures: [
      {
        algorithm: "sigstore-bundle",
        digest: digest(handle === "notes" ? "a34d88f8f4f5b74051f10b39a6f8a62ffb1a4d993db1ea5744d70d7f4a7dd04f" : "b34d88f8f4f5b74051f10b39a6f8a62ffb1a4d993db1ea5744d70d7f4a7dd04f"),
        keyRef: "publisher-key://vita/first-party/stable",
        ref: `signature://vita/${handle}/${version}/sigstore`,
        signedAt: "2026-06-01T12:20:00.000Z",
      },
    ],
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    trustTier: handle === "notes" ? "verified" : "community",
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

function reorderedEntry(entry: CatalogEntry): CatalogEntry {
  return {
    trustTier: entry.trustTier,
    digest: entry.digest,
    endOfSupport: entry.endOfSupport,
    vulnerabilityStatus: entry.vulnerabilityStatus,
    sbom: entry.sbom,
    signatures: entry.signatures,
    signingPublisher: entry.signingPublisher,
    package: entry.package,
  };
}

function withoutSbom(entry: CatalogEntry): Omit<CatalogEntry, "sbom"> {
  const { sbom: _sbom, ...rest } = entry;

  return rest;
}

function assertSigned(result: CatalogPublishResult): SignedCatalogManifest {
  if (isPublishFailure(result)) {
    assert.fail(formatErrors(result.errors));
  }

  return result;
}

function assertPublishFailure(
  result: CatalogPublishResult,
): Extract<CatalogPublishResult, { readonly ok: false }> {
  if (!isPublishFailure(result)) {
    assert.fail("expected catalog publish to reject");
  }

  return result;
}

function isPublishFailure(
  result: CatalogPublishResult,
): result is Extract<CatalogPublishResult, { readonly ok: false }> {
  return result.ok === false;
}

function assertVerified(signed: SignedCatalogManifest): CatalogPayload {
  const result = verifyCatalog(signed, TEST_CATALOG_TRUSTED_KEYS);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result.catalog;
}

function digest(value: string): { readonly algorithm: "sha256"; readonly value: string } {
  return {
    algorithm: "sha256",
    value,
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

function paths(errors: readonly { readonly path: string }[]): string[] {
  return errors.map((error) => error.path).sort(compareStrings);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function formatErrors(errors: readonly { readonly path: string; readonly message: string }[]): string {
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

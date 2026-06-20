import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCatalogEntry } from "../src/catalog-entry.ts";
import type { CatalogEntry } from "../src/catalog-entry.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";

const FAKE_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "not-a-real-key",
  "-----END PRIVATE KEY-----",
].join("\n");

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key];
};

test("valid complete verified catalog entry validates and preserves trust tier", () => {
  const result = validateCatalogEntry(validCatalogEntry());

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);

  const entry: CatalogEntry = result.entry;

  assert.equal(entry.trustTier, "verified");
  assert.equal(entry.signingPublisher.id, "vita.first-party");
  assert.equal(entry.sbom.ref, "sbom://vita/notes/1.2.3/spdx");
});

test("package contract reference entries validate and preserve community trust tier", () => {
  const entry = validCatalogEntry();

  (entry as unknown as Record<string, unknown>).package = {
    ref: "package-contract://vita/notes/1.2.3",
    version: "1.2.3",
    digest: digest("8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
  };
  (entry as unknown as Record<string, unknown>).trustTier = "community";

  const result = validateCatalogEntry(entry);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);

  assert.equal(result.entry.trustTier, "community");
});

test("required catalog fields and trust tier are rejected with precise paths", () => {
  const cases: readonly {
    readonly path: string;
    readonly mutate: (entry: CatalogEntry) => void;
  }[] = [
    {
      path: "signatures",
      mutate(entry) {
        (entry as unknown as Record<string, unknown>).signatures = [];
      },
    },
    {
      path: "signatures/0/ref",
      mutate(entry) {
        const signature = entry.signatures[0];

        if (signature === undefined || typeof signature === "string") {
          assert.fail("expected descriptor signature fixture");
        }

        const mutableSignature: Mutable<typeof signature> = signature;
        mutableSignature.ref = FAKE_PRIVATE_KEY;
      },
    },
    {
      path: "digest",
      mutate(entry) {
        delete (entry as unknown as Record<string, unknown>).digest;
      },
    },
    {
      path: "trustTier",
      mutate(entry) {
        (entry as unknown as Record<string, unknown>).trustTier = "partner";
      },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected catalog validation case fixture");
    }

    const entry = validCatalogEntry();
    item.mutate(entry);

    const errors = reject(entry);

    assert.equal(paths(errors).includes(item.path), true, `${item.path}\n${formatErrors(errors)}`);
  }
});

test("embedded package contract validation is reused and package refs are checked", () => {
  const entry = validCatalogEntry();
  const contract = entry.package as PackageContract;
  const secret = contract.secrets[0];

  if (secret === undefined) {
    assert.fail("expected secret fixture");
  }

  const mutableSecret: Mutable<typeof secret> = secret;
  mutableSecret.ref = FAKE_PRIVATE_KEY;

  const errors = reject(entry);

  assert.equal(paths(errors).includes("package/secrets/0/ref"), true, formatErrors(errors));
});

test("malformed, cyclic, and exotic inputs reject without throwing", () => {
  for (const input of [null, "bad", 42, new Date(), new Map()]) {
    assert.doesNotThrow(() => validateCatalogEntry(input));
    assert.equal(validateCatalogEntry(input).ok, false);
  }

  const cyclic = validCatalogEntry();
  const sbom = cyclic.sbom as unknown as Record<string, unknown>;
  sbom.self = cyclic;

  assert.doesNotThrow(() => validateCatalogEntry(cyclic));
  assert.equal(paths(reject(cyclic)).includes("sbom/self"), true);
});

test("method-shadowed arrays and hostile iterators reject before validation", () => {
  const shadowed = validCatalogEntry();
  const signatures = shadowed.signatures as unknown as Record<string, unknown>;

  signatures.some = () => true;
  signatures.includes = () => true;
  signatures.find = () => ({ ref: "signature://evil.example.invalid/bundle" });
  signatures.forEach = () => undefined;

  assert.doesNotThrow(() => validateCatalogEntry(shadowed));
  assert.equal(paths(reject(shadowed)).includes("signatures/some"), true);

  const hostileIterator = validCatalogEntry();

  Object.defineProperty(hostileIterator.signatures, Symbol.iterator, {
    value: function* hostile() {
      yield { ref: "signature://evil.example.invalid/bundle" };
    },
  });

  assert.doesNotThrow(() => validateCatalogEntry(hostileIterator));
  assert.equal(
    paths(reject(hostileIterator)).includes("signatures/Symbol(Symbol.iterator)"),
    true,
  );
});

test("throwing getters and proxies fail closed without throwing", () => {
  const getterEntry = validCatalogEntry();
  const sbom = getterEntry.sbom as unknown as Record<string, unknown>;

  Object.defineProperty(sbom, "ref", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape");
    },
  });

  assert.doesNotThrow(() => validateCatalogEntry(getterEntry));
  assert.equal(paths(reject(getterEntry)).includes("sbom/ref"), true);

  const proxyEntry = validCatalogEntry();
  const signatures = proxyEntry.signatures as unknown[];

  (proxyEntry as unknown as Record<string, unknown>).signatures = new Proxy(signatures, {
    get(target, key, receiver) {
      if (key === "length") {
        throw new Error("length should not escape");
      }

      return Reflect.get(target, key, receiver);
    },
  });

  assert.doesNotThrow(() => validateCatalogEntry(proxyEntry));
  assert.equal(paths(reject(proxyEntry)).includes("signatures"), true);

  const ownKeysProxy = new Proxy(validCatalogEntry(), {
    ownKeys() {
      throw new Error("ownKeys should not escape");
    },
  });

  assert.doesNotThrow(() => validateCatalogEntry(ownKeysProxy));
  assert.equal(validateCatalogEntry(ownKeysProxy).ok, false);
});

function reject(value: unknown): readonly { readonly path: string; readonly message: string }[] {
  const result = validateCatalogEntry(value);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected catalog entry validation to fail");
  }

  return result.errors;
}

function paths(errors: readonly { readonly path: string }[]): string[] {
  return errors.map((error) => error.path).sort(compareStrings);
}

function formatErrors(errors: readonly { readonly path: string; readonly message: string }[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

function validCatalogEntry(): CatalogEntry {
  return {
    package: validPackageContract(),
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
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
    vulnerabilityStatus: {
      status: "clean",
      scannedAt: "2026-06-01T12:10:00.000Z",
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    endOfSupport: "2028-12-31",
    digest: digest("8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
    trustTier: "verified",
  };
}

function validPackageContract(): PackageContract {
  return {
    packageClass: "ts-service",
    identity: {
      id: "com.vita.notes",
      name: "Vita Notes",
      description: "First-party notes service.",
    },
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    version: "1.2.3",
    digest: digest("8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25"),
    architectures: ["x86_64", "arm64"],
    resources: {
      cpuCores: 2,
      ramMiB: 512,
      storageMiB: 1024,
    },
    accelerators: {
      required: [{ kind: "intel.npu", generation: "core-ultra" }],
      optional: [{ kind: "nvidia.cuda", memoryGB: 8, compute: "8.6" }],
      preference: ["npu", "gpu", "cpu"],
    },
    network: {
      ingress: [{ name: "web", protocol: "https", port: 443, public: false }],
      egress: [
        {
          name: "updates",
          protocol: "https",
          destinations: ["updates.example.invalid"],
          ports: [443],
        },
      ],
    },
    data: {
      classes: ["user-content", "app-state"],
      volumes: [
        {
          name: "state",
          mountPath: "/var/lib/vita-notes",
          class: "app-state",
          access: "read-write",
          persistence: "persistent",
          backup: true,
          sizeMiB: 1024,
        },
      ],
    },
    secrets: [
      {
        name: "sync-token",
        ref: "secret://vita/notes/sync-token",
        purpose: "Authenticate outbound sync requests.",
        optional: false,
      },
    ],
    backup: {
      strategy: "application-consistent",
      includeVolumes: ["state"],
      quiesceHooks: [{ name: "flush", entrypoint: "hooks.flush", timeoutSeconds: 30 }],
      backupHooks: [{ name: "snapshot", entrypoint: "hooks.snapshot", timeoutSeconds: 60 }],
    },
    restore: {
      requireCleanVerification: true,
      verificationHooks: [{ name: "verify", entrypoint: "hooks.verify", timeoutSeconds: 45 }],
    },
    healthChecks: [
      {
        name: "http",
        type: "http",
        target: "/healthz",
        intervalSeconds: 30,
        timeoutSeconds: 5,
      },
    ],
    updates: {
      channel: "stable",
      strategy: "replace",
      schemaMigrations: [
        {
          id: "notes-1.2.0-to-1.2.3",
          fromVersion: "1.2.0",
          toVersion: "1.2.3",
          hook: { name: "migrate", entrypoint: "hooks.migrate", timeoutSeconds: 120 },
          reversible: true,
        },
      ],
    },
    rollback: {
      maxRollbackVersions: 2,
      maxRollbackAgeDays: 30,
      requiresFreshBackup: true,
    },
    exportFormats: ["vita-capsule", "json"],
    endOfSupportDate: "2028-12-31",
    sbom: {
      format: "spdx-json",
      digest: digest("497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e"),
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
    requiredSimulationProfiles: ["baseline-x86_64", "network-partition"],
  };
}

function digest(value: string): { readonly algorithm: "sha256"; readonly value: string } {
  return {
    algorithm: "sha256",
    value,
  };
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

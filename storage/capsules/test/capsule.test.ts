import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCapsule } from "../src/capsule.ts";
import type { Capsule } from "../src/capsule.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";

const FAKE_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "not-a-real-key",
  "-----END PRIVATE KEY-----",
].join("\n");

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key];
};

test("valid complete capsule validates and yields Capsule", () => {
  const capsule = validCapsule();
  const result = validateCapsule(capsule);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);

  const typedCapsule: Capsule = result.capsule;
  const source = typedCapsule.runtime.typescript.source;

  if (source === undefined) {
    assert.fail("expected TypeScript source fixture");
  }

  assert.equal(typedCapsule.manifest.package.identity.id, "com.vita.notes");
  assert.equal(typedCapsule.state.snapshot.architectureNeutral, true);
  assert.equal(source.ref, "artifact://vita/notes/1.2.3/source");
});

test("missing required sections and fields are rejected with precise paths", () => {
  const capsule = validCapsule() as unknown as Record<string, unknown>;
  const state = capsule.state as Record<string, unknown>;
  const snapshot = state.snapshot as Record<string, unknown>;

  delete capsule.runtime;
  delete snapshot.architectureNeutral;

  const errors = reject(capsule);

  assert.deepEqual(
    paths(errors).filter((path) => path === "runtime" || path === "state/snapshot/architectureNeutral"),
    ["runtime", "state/snapshot/architectureNeutral"],
  );
});

test("embedded private keys are rejected in artifact and state ref fields", () => {
  const cases: readonly {
    readonly path: string;
    readonly mutate: (capsule: Capsule) => void;
  }[] = [
    {
      path: "runtime/ociImageIndexes/0/ref",
      mutate(capsule) {
        const descriptor: Mutable<(typeof capsule.runtime.ociImageIndexes)[number]> = first(
          capsule.runtime.ociImageIndexes,
          "OCI image index",
        );
        descriptor.ref = FAKE_PRIVATE_KEY;
      },
    },
    {
      path: "runtime/wasmComponents/0/ref",
      mutate(capsule) {
        const descriptor: Mutable<(typeof capsule.runtime.wasmComponents)[number]> = first(
          capsule.runtime.wasmComponents,
          "WASM component",
        );
        descriptor.ref = FAKE_PRIVATE_KEY;
      },
    },
    {
      path: "runtime/typescript/source/ref",
      mutate(capsule) {
        const source = capsule.runtime.typescript.source;

        if (source === undefined) {
          assert.fail("expected TypeScript source fixture");
        }

        const descriptor: Mutable<typeof source> = source;
        descriptor.ref = FAKE_PRIVATE_KEY;
      },
    },
    {
      path: "runtime/typescript/compiled/ref",
      mutate(capsule) {
        const compiled = capsule.runtime.typescript.compiled;

        if (compiled === undefined) {
          assert.fail("expected TypeScript compiled fixture");
        }

        const descriptor: Mutable<typeof compiled> = compiled;
        descriptor.ref = FAKE_PRIVATE_KEY;
      },
    },
    {
      path: "state/exports/0/ref",
      mutate(capsule) {
        const descriptor: Mutable<(typeof capsule.state.exports)[number]> = first(
          capsule.state.exports,
          "state export",
        );
        descriptor.ref = FAKE_PRIVATE_KEY;
      },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected capsule validation case fixture");
    }

    const capsule = validCapsule();
    item.mutate(capsule);

    const errors = reject(capsule);

    assert.equal(paths(errors).includes(item.path), true, item.path);
  }
});

test("embedded key material in package refs and signature refs is rejected", () => {
  const capsule = validCapsule();
  const signature = first(capsule.manifest.signatures, "signature reference");
  const secret = first(capsule.manifest.package.secrets, "package secret");

  if (typeof signature === "string") {
    assert.fail("expected signature descriptor fixture");
  }

  const mutableSignature: Mutable<typeof signature> = signature;
  const mutableSecret: Mutable<typeof secret> = secret;
  mutableSignature.ref = FAKE_PRIVATE_KEY;
  mutableSecret.ref = FAKE_PRIVATE_KEY;

  const errors = reject(capsule);

  assert.equal(paths(errors).includes("manifest/signatures/0/ref"), true);
  assert.equal(paths(errors).includes("manifest/package/secrets/0/ref"), true);
});

test("manifest must contain at least one signature reference", () => {
  const capsule = validCapsule();

  (capsule.manifest as unknown as Record<string, unknown>).signatures = [];

  const errors = reject(capsule);

  assert.deepEqual(paths(errors), ["manifest/signatures"]);
});

test("partial typed capsule rejects instead of partially honoring present fields", () => {
  const capsule = validCapsule() as unknown as Record<string, unknown>;
  const policy = capsule.policy as Record<string, unknown>;

  delete policy.networkGrants;

  const errors = reject(capsule);

  assert.equal(paths(errors).includes("policy/networkGrants"), true);
});

test("malformed and cyclic inputs are rejected without throwing", () => {
  for (const input of [null, "bad", 42]) {
    assert.doesNotThrow(() => validateCapsule(input));
    assert.equal(validateCapsule(input).ok, false);
  }

  const cyclic = validCapsule() as unknown as Record<string, unknown>;
  const state = cyclic.state as Record<string, unknown>;
  state.self = cyclic;

  assert.doesNotThrow(() => validateCapsule(cyclic));

  const errors = reject(cyclic);

  assert.equal(paths(errors).includes("state/self"), true);
});

test("method-shadowed arrays are rejected before validation", () => {
  const capsule = validCapsule();
  const indexes = capsule.runtime.ociImageIndexes as unknown as Record<string, unknown>;

  indexes.some = () => true;
  indexes.includes = () => true;
  indexes.find = () => ({ ref: "oci://evil.example.invalid/image" });

  assert.doesNotThrow(() => validateCapsule(capsule));

  const errors = reject(capsule);

  assert.equal(paths(errors).includes("runtime/ociImageIndexes/some"), true);
});

test("hostile iterators are rejected before validation", () => {
  const capsule = validCapsule();

  Object.defineProperty(capsule.state.exports, Symbol.iterator, {
    value: function* hostile() {
      yield { ref: "export://evil.example.invalid/state" };
    },
  });

  assert.doesNotThrow(() => validateCapsule(capsule));

  const errors = reject(capsule);

  assert.equal(paths(errors).includes("state/exports/Symbol(Symbol.iterator)"), true);
});

test("throwing getters and proxies fail closed without throwing", () => {
  const getterCapsule = validCapsule() as unknown as Record<string, unknown>;
  const runtime = getterCapsule.runtime as Record<string, unknown>;

  Object.defineProperty(runtime, "wasmComponents", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape");
    },
  });

  assert.doesNotThrow(() => validateCapsule(getterCapsule));
  assert.equal(paths(reject(getterCapsule)).includes("runtime/wasmComponents"), true);

  const proxyCapsule = validCapsule() as unknown as Record<string, unknown>;
  const state = proxyCapsule.state as Record<string, unknown>;
  const stateExports = (state.exports as unknown[]) ?? [];

  state.exports = new Proxy(stateExports, {
    get(target, key, receiver) {
      if (key === "length") {
        throw new Error("length should not escape");
      }

      return Reflect.get(target, key, receiver);
    },
  });

  assert.doesNotThrow(() => validateCapsule(proxyCapsule));
  assert.equal(paths(reject(proxyCapsule)).includes("state/exports"), true);
});

function reject(value: unknown): readonly { readonly path: string; readonly message: string }[] {
  const result = validateCapsule(value);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected capsule validation to fail");
  }

  return result.errors;
}

function paths(errors: readonly { readonly path: string }[]): string[] {
  return errors.map((error) => error.path).sort(compareStrings);
}

function formatErrors(errors: readonly { readonly path: string; readonly message: string }[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];

  if (value === undefined) {
    assert.fail(`expected ${label} fixture`);
  }

  return value;
}

function validCapsule(): Capsule {
  return {
    manifest: {
      package: validPackageContract(),
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
          platforms: [
            { os: "linux", architecture: "x86_64" },
            { os: "linux", architecture: "arm64" },
          ],
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
        architectureNeutral: true,
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
          access: "read-write",
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
      requiredProfiles: ["baseline-x86_64", "baseline-arm64"],
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

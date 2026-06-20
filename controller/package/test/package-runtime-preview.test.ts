import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogEntry, TrustTier } from "../../../packages/catalog/src/catalog-entry.ts";
import {
  notesManifest,
  notesPackageContract,
  notesRequestedCapabilities,
} from "../../../packages/first-party/notes/manifest.ts";
import {
  VOLUME_MOUNT_ROOT,
} from "../../../packages/runtime/src/sandbox.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";
import { previewPackageRuntime } from "../src/package-runtime-preview.ts";
import type {
  PackageRuntimePreview,
  PackageRuntimePreviewRejectionCode,
  PackageRuntimePreviewRejectionSource,
} from "../src/package-runtime-preview.ts";

interface RuntimePreviewEntry extends CatalogEntry {
  readonly requestedCapabilities: readonly CapabilityGrant[];
}

type MutableJsonObject = { [key: string]: unknown };

const egressGrant: CapabilityGrant = {
  destination: "updates.example.invalid",
  direction: "egress",
  kind: "network",
  port: 443,
  protocol: "https",
};

test("valid entry and pinned lockfile preview install plan, grants, and scoped sandbox", () => {
  const preview = previewPackageRuntime(validEntry(), validNpmLockfile());

  if (!preview.ok) {
    assert.fail(formatRejections(preview.rejections));
  }

  assert.equal(preview.ok, true);
  assert.equal(preview.installPlan.package.id, notesPackageContract.identity.id);
  assert.deepEqual(
    preview.installPlan.steps.map((step) => `${step.name}@${step.version}`),
    ["alpha@1.2.3"],
  );
  assert.equal(preview.grants, preview.installPlan.capabilityGrants);
  assert.deepEqual(preview.grants, notesRequestedCapabilities);
  assert.deepEqual(preview.sandboxPolicy, {
    allowEnv: [],
    allowFfi: [],
    allowNet: ["127.0.0.1:8443"],
    allowRead: [`${VOLUME_MOUNT_ROOT}/notes`, `${VOLUME_MOUNT_ROOT}/state`],
    allowRun: [],
    allowWrite: [`${VOLUME_MOUNT_ROOT}/notes`, `${VOLUME_MOUNT_ROOT}/state`],
    defaultDeny: true,
  });
  assert.equal(Object.hasOwn(preview.sandboxPolicy, "allowAll"), false);
});

test("resolver rejections return typed rejections with no sandbox or partial result", () => {
  const unpinned = validNpmLockfile();
  objectAt(objectAt(unpinned, "packages"), "node_modules/alpha").version = "^1.2.3";

  const scriptBearing = validNpmLockfile();
  objectAt(objectAt(scriptBearing, "packages"), "node_modules/alpha").scripts = {
    postinstall: "node install.js",
  };

  const outOfTierEntry = validEntry({
    contract: contractWithEgress("updates.example.invalid"),
    requestedCapabilities: [egressGrant],
    trustTier: "community",
  });

  const cases: readonly {
    readonly preview: PackageRuntimePreview;
    readonly code: PackageRuntimePreviewRejectionCode;
  }[] = [
    {
      code: "INVALID_LOCKFILE_POLICY",
      preview: previewPackageRuntime(validEntry(), unpinned),
    },
    {
      code: "INVALID_LOCKFILE_POLICY",
      preview: previewPackageRuntime(validEntry(), scriptBearing),
    },
    {
      code: "CAPABILITY_DENIED",
      preview: previewPackageRuntime(outOfTierEntry, validNpmLockfile()),
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item !== undefined) {
      assertRejected(item.preview, "resolver", item.code);
      assertNoPartialRuntime(item.preview);
    }
  }
});

test("sandbox rejection returns typed rejection when a resolved grant cannot be bounded", () => {
  const unboundedEgress: CapabilityGrant = {
    ...egressGrant,
    destination: "*",
  };
  const preview = previewPackageRuntime(
    validEntry({
      contract: contractWithEgress("*"),
      requestedCapabilities: [unboundedEgress],
    }),
    validNpmLockfile(),
  );

  assertRejected(preview, "sandbox", "UNMAPPABLE_GRANT");
  assertNoPartialRuntime(preview);

  if (!preview.ok) {
    assert.equal(preview.rejections[0]?.path, "grants/0");
    assert.equal(preview.rejections[0]?.grantIndex, 0);
  }
});

test("hostile inputs fail closed without throwing", () => {
  const getterEntry = validEntry() as unknown as MutableJsonObject;
  Object.defineProperty(getterEntry, "requestedCapabilities", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape preview");
    },
  });

  const cyclicLockfile = validNpmLockfile();
  objectAt(cyclicLockfile, "packages").self = cyclicLockfile;

  assert.doesNotThrow(() => previewPackageRuntime(getterEntry, validNpmLockfile()));
  assert.doesNotThrow(() => previewPackageRuntime(validEntry(), cyclicLockfile));

  assertRejected(
    previewPackageRuntime(getterEntry, validNpmLockfile()),
    "resolver",
    "NORMALIZATION_FAILED",
  );
  assertRejected(
    previewPackageRuntime(validEntry(), cyclicLockfile),
    "resolver",
    "NORMALIZATION_FAILED",
  );
});

function validEntry(
  options: {
    readonly contract?: PackageContract;
    readonly requestedCapabilities?: readonly CapabilityGrant[];
    readonly trustTier?: TrustTier;
  } = {},
): RuntimePreviewEntry {
  const contract = options.contract ?? notesPackageContract;

  return {
    ...notesManifest,
    digest: contract.digest,
    endOfSupport: contract.endOfSupportDate,
    package: contract,
    requestedCapabilities: options.requestedCapabilities ?? notesRequestedCapabilities,
    sbom: {
      ...notesManifest.sbom,
      digest: contract.sbom.digest,
      generatedAt: contract.sbom.generatedAt,
    },
    signingPublisher: contract.signingPublisher,
    trustTier: options.trustTier ?? "verified",
    vulnerabilityStatus: contract.vulnerabilityStatus,
  };
}

function contractWithEgress(destination: string): PackageContract {
  return {
    ...notesPackageContract,
    network: {
      egress: [
        {
          destinations: [destination],
          name: "updates",
          ports: [443],
          protocol: "https",
        },
      ],
      ingress: notesPackageContract.network.ingress,
    },
  };
}

function validNpmLockfile(): MutableJsonObject {
  return {
    lockfileVersion: 3,
    name: "vita-notes",
    packages: {
      "": {
        dependencies: {
          alpha: "1.2.3",
        },
        name: "vita-notes",
        version: "1.0.0",
      },
      "node_modules/alpha": {
        integrity: sri("a"),
        resolved: "alpha@1.2.3",
        version: "1.2.3",
      },
    },
    requires: true,
    version: "1.0.0",
  };
}

function assertRejected(
  preview: PackageRuntimePreview,
  source: PackageRuntimePreviewRejectionSource,
  code: PackageRuntimePreviewRejectionCode,
): void {
  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected package runtime preview to reject");
  }

  assert.equal(
    preview.rejections.some(
      (rejection) => rejection.source === source && rejection.code === code,
    ),
    true,
    formatRejections(preview.rejections),
  );
}

function assertNoPartialRuntime(preview: PackageRuntimePreview): void {
  assert.equal(preview.ok, false);
  assert.equal(Object.hasOwn(preview, "installPlan"), false);
  assert.equal(Object.hasOwn(preview, "grants"), false);
  assert.equal(Object.hasOwn(preview, "sandboxPolicy"), false);
}

function sri(seed: string): string {
  const first = seed.charCodeAt(0);
  const byte = Number.isFinite(first) ? first : 0;

  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
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

function formatRejections(
  rejections: readonly {
    readonly source: string;
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[],
): string {
  return rejections
    .map((rejection) => `${rejection.source}:${rejection.code}:${rejection.path}: ${rejection.message}`)
    .join("\n");
}

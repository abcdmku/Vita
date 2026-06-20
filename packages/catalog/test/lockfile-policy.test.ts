import assert from "node:assert/strict";
import { test } from "node:test";

import { validateLockfilePolicy } from "../src/lockfile-policy.ts";
import type { LockfilePolicyViolation } from "../src/lockfile-policy.ts";

type MutableJsonObject = { [key: string]: unknown };

test("fully pinned npm lockfile without scripts or remote sources passes", () => {
  const result = validateLockfilePolicy(validNpmLockfile());

  if (!result.ok) {
    assert.fail(formatViolations(result.violations));
  }

  assert.equal(result.ok, true);
});

test("fully pinned JSR/Deno specifier lockfile passes", () => {
  const result = validateLockfilePolicy(validJsrLockfile());

  if (!result.ok) {
    assert.fail(formatViolations(result.violations));
  }

  assert.equal(result.ok, true);
});

test("range versions and missing integrity are rejected", () => {
  const rangeLockfile = validNpmLockfile();
  objectAt(objectAt(rangeLockfile, "packages"), "node_modules/alpha").version = "^1.2.3";

  assert.equal(
    paths(reject(rangeLockfile)).includes("packages/node_modules~1alpha/version"),
    true,
  );

  const missingIntegrity = validNpmLockfile();
  delete objectAt(objectAt(missingIntegrity, "packages"), "node_modules/beta").integrity;

  assert.equal(
    paths(reject(missingIntegrity)).includes("packages/node_modules~1beta/integrity"),
    true,
  );
});

test("transitive dependencies must resolve to entries with exact versions and integrity", () => {
  const missingTransitiveIntegrity = validNpmLockfile();
  delete objectAt(objectAt(missingTransitiveIntegrity, "packages"), "node_modules/beta").integrity;

  const violations = reject(missingTransitiveIntegrity);
  assert.equal(
    paths(violations).includes("packages/node_modules~1alpha/dependencies/beta"),
    true,
    formatViolations(violations),
  );

  const missingTransitiveEntry = validNpmLockfile();
  delete objectAt(missingTransitiveEntry, "packages")["node_modules/beta"];

  assert.equal(
    paths(reject(missingTransitiveEntry)).includes(
      "packages/node_modules~1alpha/dependencies/beta",
    ),
    true,
  );
});

test("non-object dependency containers cannot bypass validation", () => {
  const arrayContainer = validNpmLockfile();
  objectAt(objectAt(arrayContainer, "packages"), "node_modules/alpha").dependencies = [
    "jsr:@scope/pkg@^1.0.0",
  ];

  assert.equal(
    paths(reject(arrayContainer)).includes("packages/node_modules~1alpha/dependencies"),
    true,
  );

  const stringContainer = validJsrLockfile();
  objectAt(objectAt(stringContainer, "resolved"), "@scope/root@1.0.0").dependencies =
    "jsr:@scope/pkg@^1.0.0";

  assert.equal(
    paths(reject(stringContainer)).includes("resolved/@scope~1root@1.0.0/dependencies"),
    true,
  );
});

test("lifecycle scripts and ambiguous lifecycle indicators are rejected", () => {
  for (const scriptName of ["preinstall", "install", "postinstall", "prepare"]) {
    const lockfile = validNpmLockfile();
    objectAt(objectAt(lockfile, "packages"), "node_modules/alpha")[scriptName] =
      "node-gyp rebuild";

    const scriptPath = `packages/node_modules~1alpha/${scriptName}`;
    assert.equal(paths(reject(lockfile)).includes(scriptPath), true, scriptPath);
  }

  const scriptContainer = validNpmLockfile();
  objectAt(objectAt(scriptContainer, "packages"), "node_modules/alpha").scripts = {
    preinstall: "node install.js",
  };

  assert.equal(
    paths(reject(scriptContainer)).includes("packages/node_modules~1alpha/scripts/preinstall"),
    true,
  );

  const stringIndicator = validNpmLockfile();
  objectAt(objectAt(stringIndicator, "packages"), "node_modules/alpha").hasInstallScript = "true";

  assert.equal(
    paths(reject(stringIndicator)).includes("packages/node_modules~1alpha/hasInstallScript"),
    true,
  );

  const objectIndicator = validJsrLockfile();
  objectAt(objectAt(objectIndicator, "resolved"), "@scope/root@1.0.0").requiresBuild = {};

  assert.equal(
    paths(reject(objectIndicator)).includes("resolved/@scope~1root@1.0.0/requiresBuild"),
    true,
  );
});

test("malformed SRI and URL-like sources are rejected by allowlist", () => {
  const malformedIntegrity = validNpmLockfile();
  objectAt(objectAt(malformedIntegrity, "packages"), "node_modules/alpha").integrity =
    "sha512-not-a-real-digest";

  assert.equal(
    paths(reject(malformedIntegrity)).includes("packages/node_modules~1alpha/integrity"),
    true,
  );

  for (const source of [
    "https://registry.npmjs.example.invalid/alpha.tgz",
    "ipfs://bafyalpha",
    "data:text/plain;base64,YWxwaGE=",
    "//cdn.example.invalid/alpha.tgz",
  ]) {
    const lockfile = validNpmLockfile();
    objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").resolved = source;

    assert.equal(
      paths(reject(lockfile)).includes("packages/node_modules~1alpha/resolved"),
      true,
      source,
    );
  }
});

test("JSR specifiers without resolved integrity and unknown container shapes reject", () => {
  const missingResolvedIntegrity = validJsrLockfile();
  delete objectAt(objectAt(missingResolvedIntegrity, "resolved"), "@scope/pkg@2.0.0").integrity;

  assert.equal(
    paths(reject(missingResolvedIntegrity)).includes("specifiers/jsr:@scope~1pkg@2.0.0"),
    true,
  );

  const unknownContainer = validNpmLockfile();
  unknownContainer.snapshots = {};

  assert.equal(paths(reject(unknownContainer)).includes("snapshots"), true);
});

test("safeNormalize fail-closed behavior rejects garbage, cyclic, and accessor inputs", () => {
  for (const input of [null, "bad", 42, new Date(), new Map()]) {
    assert.doesNotThrow(() => validateLockfilePolicy(input));
    assert.equal(validateLockfilePolicy(input).ok, false);
  }

  const cyclic = validNpmLockfile();
  objectAt(cyclic, "packages").self = cyclic;

  assert.doesNotThrow(() => validateLockfilePolicy(cyclic));
  assert.equal(validateLockfilePolicy(cyclic).ok, false);

  const accessor = validNpmLockfile();
  Object.defineProperty(objectAt(accessor, "packages"), "flipping", {
    enumerable: true,
    get() {
      throw new Error("getter should not be read");
    },
  });

  assert.doesNotThrow(() => validateLockfilePolicy(accessor));
  assert.equal(validateLockfilePolicy(accessor).ok, false);
});

function reject(value: unknown): readonly LockfilePolicyViolation[] {
  const result = validateLockfilePolicy(value);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected lockfile validation to fail");
  }

  return result.violations;
}

function paths(violations: readonly LockfilePolicyViolation[]): string[] {
  return violations.map((violation) => violation.path).sort(compareStrings);
}

function formatViolations(violations: readonly LockfilePolicyViolation[]): string {
  return violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n");
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
        optionalDependencies: {
          gamma: "3.0.0",
        },
        peerDependencies: {
          "peer-lib": "4.0.0",
        },
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
      "node_modules/gamma": {
        integrity: sri("g"),
        resolved: "gamma@3.0.0",
        version: "3.0.0",
      },
      "node_modules/peer-lib": {
        integrity: sri("p"),
        resolved: "peer-lib@4.0.0",
        version: "4.0.0",
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
    },
    specifiers: {
      "jsr:@scope/root@1.0.0": "1.0.0",
      "jsr:@scope/pkg@2.0.0": "@scope/pkg@2.0.0",
    },
    version: "1",
  };
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

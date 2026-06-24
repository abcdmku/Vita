import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { resolveFromMirror } from "../src/mirror.ts";
import type {
  MirrorResolution,
  MirrorResolutionResult,
  MirrorStore,
} from "../src/mirror.ts";

type MutableJsonObject = { [key: string]: unknown };
type SriAlgorithm = "sha256" | "sha384" | "sha512";
type MirrorResolutionErrorCode =
  Extract<MirrorResolutionResult, { readonly ok: false }>["errors"][number]["code"];

const alphaBytes = bytes("alpha package tarball");
const betaBytes = bytes("beta package tarball");
const jsrRootBytes = bytes("jsr root package tarball");
const jsrDependencyBytes = bytes("jsr dependency package tarball");

test("happy path verifies npm and JSR artifacts from the mirror and sorts by package key", () => {
  const npmResolution = assertResolution(resolveFromMirror(validNpmLockfile(), validNpmStore()));

  assert.deepEqual(
    npmResolution.packages.map((entry) => entry.key),
    ["alpha@1.0.0", "beta@2.0.0"],
  );
  assert.deepEqual(npmResolution.packages[0], {
    integrity: sri(alphaBytes, "sha256"),
    key: "alpha@1.0.0",
    name: "alpha",
    version: "1.0.0",
  });
  assert.deepEqual(npmResolution.packages[1], {
    integrity: sri(betaBytes, "sha512"),
    key: "beta@2.0.0",
    name: "beta",
    version: "2.0.0",
  });

  const jsrResolution = assertResolution(resolveFromMirror(validJsrLockfile(), validJsrStore()));

  assert.deepEqual(
    jsrResolution.packages.map((entry) => entry.key),
    ["@scope/pkg@2.0.0", "@scope/root@1.0.0"],
  );
  assert.deepEqual(jsrResolution.packages[0], {
    integrity: sri(jsrDependencyBytes, "sha256"),
    key: "@scope/pkg@2.0.0",
    name: "@scope/pkg",
    version: "2.0.0",
  });
  assert.deepEqual(jsrResolution.packages[1], {
    integrity: sri(jsrRootBytes, "sha512"),
    key: "@scope/root@1.0.0",
    name: "@scope/root",
    version: "1.0.0",
  });
});

test("resolution is byte-identical for equivalent inputs with different key order", () => {
  const first = assertResolution(resolveFromMirror(validNpmLockfile(), validNpmStore()));
  const second = assertResolution(resolveFromMirror(reorderedNpmLockfile(), validNpmStore()));

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("missing mirror artifact rejects without a remote fallback or partial resolution", () => {
  const result = resolveFromMirror(validNpmLockfile(), mirrorStore([["alpha@1.0.0", alphaBytes]]));

  assertRejects(result, "NOT_IN_MIRROR");
  assert.equal("resolution" in result, false);
  assert.match(formatErrors(rejectErrors(result)), /beta@2\.0\.0/u);
});

test("integrity mismatch rejects at the offending integrity path while correct bytes pass", () => {
  const mismatch = resolveFromMirror(
    validNpmLockfile(),
    mirrorStore([
      ["alpha@1.0.0", alphaBytes],
      ["beta@2.0.0", bytes("tampered beta package tarball")],
    ]),
  );

  assertRejects(mismatch, "INTEGRITY_MISMATCH");
  assert.match(
    formatErrors(rejectErrors(mismatch)),
    /packages\/node_modules~1beta\/integrity/u,
  );

  assertResolution(resolveFromMirror(validNpmLockfile(), validNpmStore()));
});

test("sha256, sha384, and sha512 integrities verify; malformed SRI is delegated to policy", () => {
  const lockfile = npmLockfileForPackages([
    {
      bytes: bytes("sha256 fixture"),
      integrityAlgorithm: "sha256",
      name: "alpha",
      version: "1.0.0",
    },
    {
      bytes: bytes("sha384 fixture"),
      integrityAlgorithm: "sha384",
      name: "beta",
      version: "2.0.0",
    },
    {
      bytes: bytes("sha512 fixture"),
      integrityAlgorithm: "sha512",
      name: "gamma",
      version: "3.0.0",
    },
  ]);
  const store = mirrorStore([
    ["alpha@1.0.0", bytes("sha256 fixture")],
    ["beta@2.0.0", bytes("sha384 fixture")],
    ["gamma@3.0.0", bytes("sha512 fixture")],
  ]);

  assert.deepEqual(
    assertResolution(resolveFromMirror(lockfile, store)).packages.map((entry) => entry.key),
    ["alpha@1.0.0", "beta@2.0.0", "gamma@3.0.0"],
  );

  const malformed = validNpmLockfile();
  objectAt(objectAt(malformed, "packages"), "node_modules/alpha").integrity =
    `sha512-${Buffer.alloc(32, 1).toString("base64")}`;

  assertRejects(resolveFromMirror(malformed, validNpmStore()), "POLICY_REJECTED");
});

test("policy rejected lockfiles return POLICY_REJECTED with no resolved artifacts", () => {
  const cases: readonly (readonly [string, () => MutableJsonObject])[] = [
    [
      "un-pinned range",
      () => {
        const lockfile = validNpmLockfile();
        objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").version = "^1.0.0";
        return lockfile;
      },
    ],
    [
      "remote source",
      () => {
        const lockfile = validNpmLockfile();
        objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").resolved =
          "https://registry.example.invalid/alpha.tgz";
        return lockfile;
      },
    ],
    [
      "unknown field",
      () => {
        const lockfile = validNpmLockfile();
        lockfile.mystery = true;
        return lockfile;
      },
    ],
    [
      "lifecycle script",
      () => {
        const lockfile = validNpmLockfile();
        objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").scripts = {
          postinstall: "node install.js",
        };
        return lockfile;
      },
    ],
    [
      "hasInstallScript indicator",
      () => {
        const lockfile = validNpmLockfile();
        objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").hasInstallScript = true;
        return lockfile;
      },
    ],
    [
      "requiresBuild indicator",
      () => {
        const lockfile = validNpmLockfile();
        objectAt(objectAt(lockfile, "packages"), "node_modules/alpha").requiresBuild = true;
        return lockfile;
      },
    ],
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    if (testCase === undefined) {
      continue;
    }

    const [label, buildLockfile] = testCase;
    const result = resolveFromMirror(buildLockfile(), validNpmStore());

    assertRejects(result, "POLICY_REJECTED", label);
    assert.equal("resolution" in result, false, label);
  }
});

test("trust-boundary inputs reject fail-closed without throwing", () => {
  const cyclic = validNpmLockfile();
  cyclic.self = cyclic;
  assertRejectsWithoutThrow(cyclic);

  const getterLockfile = validNpmLockfile();
  let getterCalled = false;
  Object.defineProperty(getterLockfile, "packages", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error("getter should not escape");
    },
  });

  assertRejectsWithoutThrow(getterLockfile);
  assert.equal(getterCalled, false);

  const protoKeyed = validNpmLockfile();
  Object.defineProperty(objectAt(protoKeyed, "packages"), "__proto__", {
    configurable: true,
    enumerable: true,
    value: {
      integrity: sri(bytes("proto package"), "sha512"),
      resolved: "__proto__@1.0.0",
      version: "1.0.0",
    },
    writable: true,
  });
  assertRejectsWithoutThrow(protoKeyed);

  const hostileIterator: unknown[] = [];
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    value() {
      throw new Error("iterator should not be called");
    },
  });
  const hostileArrayLockfile = validNpmLockfile();
  objectAt(objectAt(objectAt(hostileArrayLockfile, "packages"), ""), "dependencies").alpha =
    hostileIterator;
  assertRejectsWithoutThrow(hostileArrayLockfile);
});

function assertResolution(result: MirrorResolutionResult): MirrorResolution {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result.resolution;
}

function assertRejects(
  result: MirrorResolutionResult,
  code: MirrorResolutionErrorCode,
  label?: string,
): void {
  if (label === undefined) {
    assert.equal(result.ok, false);
  } else {
    assert.equal(result.ok, false, label);
  }

  if (result.ok) {
    assert.fail("expected mirror resolution to reject");
  }

  assert.equal(
    result.errors.some((entry) => entry.code === code),
    true,
    formatErrors(result.errors),
  );
}

function assertRejectsWithoutThrow(lockfile: unknown): void {
  assert.doesNotThrow(() => resolveFromMirror(lockfile, validNpmStore()));
  assertRejects(resolveFromMirror(lockfile, validNpmStore()), "POLICY_REJECTED");
}

function rejectErrors(
  result: MirrorResolutionResult,
): Extract<MirrorResolutionResult, { readonly ok: false }>["errors"] {
  if (result.ok) {
    assert.fail("expected mirror resolution to reject");
  }

  return result.errors;
}

function validNpmLockfile(): MutableJsonObject {
  return {
    lockfileVersion: 3,
    name: "vita-app",
    packages: {
      "": {
        dependencies: {
          alpha: "1.0.0",
          beta: "2.0.0",
        },
        name: "vita-app",
        version: "1.0.0",
      },
      "node_modules/beta": {
        integrity: sri(betaBytes, "sha512"),
        resolved: "vita-mirror://beta-2.0.0.tgz",
        version: "2.0.0",
      },
      "node_modules/alpha": {
        hasInstallScript: false,
        integrity: sri(alphaBytes, "sha256"),
        requiresBuild: false,
        resolved: "alpha@1.0.0",
        version: "1.0.0",
      },
    },
    requires: true,
    version: "1.0.0",
  };
}

function reorderedNpmLockfile(): MutableJsonObject {
  return {
    version: "1.0.0",
    requires: true,
    packages: {
      "node_modules/alpha": {
        version: "1.0.0",
        resolved: "alpha@1.0.0",
        requiresBuild: false,
        integrity: sri(alphaBytes, "sha256"),
        hasInstallScript: false,
      },
      "node_modules/beta": {
        version: "2.0.0",
        resolved: "vita-mirror://beta-2.0.0.tgz",
        integrity: sri(betaBytes, "sha512"),
      },
      "": {
        version: "1.0.0",
        name: "vita-app",
        dependencies: {
          beta: "2.0.0",
          alpha: "1.0.0",
        },
      },
    },
    name: "vita-app",
    lockfileVersion: 3,
  };
}

function validJsrLockfile(): MutableJsonObject {
  return {
    resolved: {
      "@scope/root@1.0.0": {
        dependencies: {
          "@scope/pkg": "2.0.0",
        },
        integrity: sri(jsrRootBytes, "sha512"),
        source: "@scope/root@1.0.0",
        version: "1.0.0",
      },
      "@scope/pkg@2.0.0": {
        integrity: sri(jsrDependencyBytes, "sha256"),
        source: "local-mirror://scope-pkg-2.0.0.tgz",
      },
    },
    specifiers: {
      "jsr:@scope/root@1.0.0": "1.0.0",
    },
    version: "1",
  };
}

function npmLockfileForPackages(
  packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly bytes: Uint8Array;
    readonly integrityAlgorithm: SriAlgorithm;
  }[],
): MutableJsonObject {
  const dependencies: MutableJsonObject = {};
  const packageMap: MutableJsonObject = {
    "": {
      dependencies,
      name: "vita-app",
      version: "1.0.0",
    },
  };

  for (let index = 0; index < packages.length; index += 1) {
    const entry = packages[index];
    if (entry === undefined) {
      continue;
    }

    dependencies[entry.name] = entry.version;
    packageMap[`node_modules/${entry.name}`] = {
      integrity: sri(entry.bytes, entry.integrityAlgorithm),
      resolved: `${entry.name}@${entry.version}`,
      version: entry.version,
    };
  }

  return {
    lockfileVersion: 3,
    name: "vita-app",
    packages: packageMap,
    requires: true,
    version: "1.0.0",
  };
}

function validNpmStore(): MirrorStore {
  return mirrorStore([
    ["alpha@1.0.0", alphaBytes],
    ["beta@2.0.0", betaBytes],
  ]);
}

function validJsrStore(): MirrorStore {
  return mirrorStore([
    ["@scope/pkg@2.0.0", jsrDependencyBytes],
    ["@scope/root@1.0.0", jsrRootBytes],
  ]);
}

function mirrorStore(entries: readonly (readonly [string, Uint8Array])[]): MirrorStore {
  return new Map(entries);
}

function sri(bytesValue: Uint8Array, algorithm: SriAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(bytesValue).digest("base64")}`;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
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

function formatErrors(
  errors: readonly {
    readonly code?: string;
    readonly path: string;
    readonly message: string;
  }[],
): string {
  return errors.map((entry) => `${entry.code ?? "ERROR"} ${entry.path}: ${entry.message}`).join("\n");
}

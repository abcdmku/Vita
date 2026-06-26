import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { buildMirrorStore } from "../src/mirror-build.ts";
import type { MirrorBuildResult } from "../src/mirror-build.ts";
import { OnDiskMirrorStore } from "../src/mirror-store.ts";

type MutableJsonObject = { [key: string]: unknown };
type SriAlgorithm = "sha256" | "sha384" | "sha512";
type MirrorBuildErrorCode = Extract<MirrorBuildResult, { readonly ok: false }>["errors"][number]["code"];

const alphaBytes = bytes("alpha package tarball");
const betaBytes = bytes("beta package tarball");
const jsrRootBytes = bytes("jsr root package tarball");
const jsrDependencyBytes = bytes("jsr dependency package tarball");

test("happy path builds npm and JSR stores readable by OnDiskMirrorStore", async (t) => {
  const npmRoot = tempStore(t);
  const npmBuild = assertBuild(await buildMirrorStore({
    lockfile: validNpmLockfile(),
    root: npmRoot,
    tarballs: {
      "alpha@1.0.0": alphaBytes,
      "beta@2.0.0": betaBytes,
    },
  }));

  assert.deepEqual(npmBuild.manifest, {
    "alpha@1.0.0": {
      path: deterministicPath(npmRoot, alphaBytes, "sha256"),
      sri: sri(alphaBytes, "sha256"),
    },
    "beta@2.0.0": {
      path: deterministicPath(npmRoot, betaBytes, "sha512"),
      sri: sri(betaBytes, "sha512"),
    },
  });

  const npmStore = new OnDiskMirrorStore(npmRoot);
  assert.deepEqual(npmStore.get("alpha@1.0.0"), alphaBytes);
  assert.deepEqual(npmStore.get("beta@2.0.0"), betaBytes);

  const jsrRoot = tempStore(t);
  const jsrBuild = assertBuild(await buildMirrorStore({
    lockfile: validJsrLockfile(),
    root: jsrRoot,
    tarballs: new Map<string, Uint8Array>([
      ["@scope/root@1.0.0", jsrRootBytes],
      ["@scope/pkg@2.0.0", jsrDependencyBytes],
    ]),
  }));

  assert.deepEqual(jsrBuild.manifest, {
    "@scope/pkg@2.0.0": {
      path: deterministicPath(jsrRoot, jsrDependencyBytes, "sha256"),
      sri: sri(jsrDependencyBytes, "sha256"),
    },
    "@scope/root@1.0.0": {
      path: deterministicPath(jsrRoot, jsrRootBytes, "sha512"),
      sri: sri(jsrRootBytes, "sha512"),
    },
  });

  const jsrStore = new OnDiskMirrorStore(jsrRoot);
  assert.deepEqual(jsrStore.get("@scope/pkg@2.0.0"), jsrDependencyBytes);
  assert.deepEqual(jsrStore.get("@scope/root@1.0.0"), jsrRootBytes);
});

test("SRI mismatch rejects before committing any store entries", async (t) => {
  const root = tempStore(t);
  const result = await buildMirrorStore({
    lockfile: validNpmLockfile(),
    root,
    tarballs: {
      "alpha@1.0.0": alphaBytes,
      "beta@2.0.0": bytes("tampered beta package tarball"),
    },
  });

  assertRejects(result, "INTEGRITY_MISMATCH");
  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("missing tarball rejects before committing any store entries", async (t) => {
  const root = tempStore(t);
  const result = await buildMirrorStore({
    lockfile: validNpmLockfile(),
    root,
    tarballs: {
      "alpha@1.0.0": alphaBytes,
    },
  });

  assertRejects(result, "MISSING_TARBALL");
  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("building twice from identical inputs yields byte-identical index and manifest", async (t) => {
  const root = tempStore(t);
  const input = {
    lockfile: validNpmLockfile(),
    root,
    tarballs: {
      "alpha@1.0.0": alphaBytes,
      "beta@2.0.0": betaBytes,
    },
  };

  const first = assertBuild(await buildMirrorStore(input));
  const firstIndex = readFileSync(join(root, "index.json"), "utf8");
  const firstManifest = JSON.stringify(first.manifest);

  const second = assertBuild(await buildMirrorStore(input));
  const secondIndex = readFileSync(join(root, "index.json"), "utf8");
  const secondManifest = JSON.stringify(second.manifest);

  assert.equal(secondIndex, firstIndex);
  assert.equal(secondManifest, firstManifest);
  assert.deepEqual(second.manifest, first.manifest);
});

test("malformed trust-boundary inputs reject without writing", async (t) => {
  const root = tempStore(t);

  const accessorInput = {
    lockfile: validNpmLockfile(),
    tarballs: {
      "alpha@1.0.0": alphaBytes,
      "beta@2.0.0": betaBytes,
    },
  };
  Object.defineProperty(accessorInput, "root", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    },
  });
  assertRejects(await buildMirrorStore(accessorInput), "INVALID_INPUT");

  const accessorTarballs: MutableJsonObject = {};
  Object.defineProperty(accessorTarballs, "alpha@1.0.0", {
    enumerable: true,
    get() {
      throw new Error("tarball getter should not run");
    },
  });
  assertRejects(await buildMirrorStore({
    lockfile: validNpmLockfile(),
    root,
    tarballs: accessorTarballs,
  }), "INVALID_INPUT");

  const cyclic = validNpmLockfile();
  cyclic.self = cyclic;
  assertRejects(await buildMirrorStore({
    lockfile: cyclic,
    root,
    tarballs: {
      "alpha@1.0.0": alphaBytes,
      "beta@2.0.0": betaBytes,
    },
  }), "POLICY_REJECTED");

  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

function assertBuild(result: MirrorBuildResult): Extract<MirrorBuildResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result;
}

function assertRejects(result: MirrorBuildResult, code: MirrorBuildErrorCode): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected mirror build to reject");
  }

  assert.equal(
    result.errors.some((entry) => entry.code === code),
    true,
    formatErrors(result.errors),
  );
}

function tempStore(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "vita-mirror-build-"));
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
  });
  return root;
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

function deterministicPath(root: string, payload: Uint8Array, algorithm: SriAlgorithm): string {
  const hex = createHash(algorithm).update(payload).digest("hex");
  return join(root, algorithm, hex.slice(0, 2), hex);
}

function sri(value: Uint8Array, algorithm: SriAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(value).digest("base64")}`;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
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

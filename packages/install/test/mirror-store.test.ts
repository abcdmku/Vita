import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { resolveFromMirror } from "../src/mirror.ts";
import type { MirrorResolutionResult } from "../src/mirror.ts";
import {
  OnDiskMirrorStore,
  fetchAndStore,
} from "../src/mirror-store.ts";
import type {
  FetchAndStoreResult,
  MirrorFetcher,
  StoreError,
} from "../src/mirror-store.ts";

type MutableJsonObject = { [key: string]: unknown };
type SriAlgorithm = "sha256" | "sha384" | "sha512";

const artifactBytes = bytes("alpha package tarball");
const artifactIntegrity = sri(artifactBytes, "sha256");
const artifactSpec = {
  integrity: artifactIntegrity,
  mirrorUrl: "local-mirror://alpha-1.0.0.tgz",
  name: "alpha",
  version: "1.0.0",
};
const mirrorBaseUrl = "https://mirror.example.test/cache/";

test("happy path stores a pinned artifact at deterministic content-addressed layout and updates the index", async (t) => {
  const root = tempStore(t);
  const fetcher = memoryFetcher(artifactBytes);

  const first = assertStored(await fetchAndStore(artifactSpec, { fetcher, mirrorBaseUrl, root }));
  const expectedPath = deterministicPath(root, artifactBytes, "sha256");

  assert.equal(first.path, expectedPath);
  assert.equal(existsSync(expectedPath), true);
  assert.deepEqual(readFileSync(expectedPath), Buffer.from(artifactBytes));
  assert.deepEqual(readIndex(root), {
    "alpha@1.0.0": artifactIntegrity,
  });

  const second = assertStored(await fetchAndStore(artifactSpec, { fetcher, mirrorBaseUrl, root }));
  assert.equal(second.path, expectedPath);
  assert.deepEqual(readFileSync(second.path), readFileSync(first.path));
});

test("read-back verifies blobs and fails closed for tampered blobs, bad index integrity, and unknown keys", async (t) => {
  const root = tempStore(t);
  const stored = assertStored(await fetchAndStore(artifactSpec, {
    fetcher: memoryFetcher(artifactBytes),
    mirrorBaseUrl,
    root,
  }));
  const store = new OnDiskMirrorStore(root);

  assert.deepEqual(store.get("alpha@1.0.0"), artifactBytes);
  assert.equal(store.get("missing@1.0.0"), undefined);
  assert.equal(store.get("../alpha@1.0.0"), undefined);
  assert.equal(store.get("alpha@1.0.0\n"), undefined);

  writeFileSync(stored.path, bytes("tampered"));
  assert.equal(store.get("alpha@1.0.0"), undefined);

  assertStored(await fetchAndStore(artifactSpec, {
    fetcher: memoryFetcher(artifactBytes),
    mirrorBaseUrl,
    root,
  }));
  writeFileSync(join(root, "index.json"), JSON.stringify({ "alpha@1.0.0": "sha256-not-base64" }));
  assert.equal(store.get("alpha@1.0.0"), undefined);
});

test("integrity mismatch rejects and leaves no blob or index entry", async (t) => {
  const root = tempStore(t);
  const result = await fetchAndStore(artifactSpec, {
    fetcher: memoryFetcher(bytes("wrong tarball")),
    mirrorBaseUrl,
    root,
  });

  assertRejects(result, "INTEGRITY_MISMATCH");
  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("remote origins, unpinned versions, and malformed integrity reject before fetch", async (t) => {
  const root = tempStore(t);

  let localWithoutBaseCalls = 0;
  const localWithoutBase = await fetchAndStore(artifactSpec, {
    fetcher: {
      async fetch(): Promise<Uint8Array> {
        localWithoutBaseCalls += 1;
        return artifactBytes;
      },
    },
    root,
  });
  assertRejects(localWithoutBase, "REMOTE_REJECTED");
  assert.equal(localWithoutBaseCalls, 0);

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      mirrorUrl: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
    },
    root,
    "REMOTE_REJECTED",
  );

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      mirrorUrl: "https://example.invalid/alpha-1.0.0.tgz",
    },
    root,
    "REMOTE_REJECTED",
  );

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      version: "^1.0.0",
    },
    root,
    "INVALID_SPEC",
  );

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      integrity: "sha256-not-base64",
    },
    root,
    "INVALID_SPEC",
  );

  await assertRejectsBeforeFetch(
    {
      mirrorUrl: "local-mirror://alpha-1.0.0.tgz",
      name: "alpha",
      version: "1.0.0",
    },
    root,
    "INVALID_SPEC",
  );
});

test("local mirror references cannot escape the configured base path after URL normalization", async (t) => {
  const root = tempStore(t);

  const cases = [
    "local-mirror://%2e%2e/evil.tgz",
    "local-mirror://..\\..\\evil.tgz",
    "vita-mirror://pkg/%2e%2e\\..\\evil.tgz",
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const mirrorUrl = cases[index];
    if (mirrorUrl === undefined) {
      continue;
    }

    await assertRejectsBeforeFetch(
      {
        ...artifactSpec,
        mirrorUrl,
      },
      root,
      "REMOTE_REJECTED",
      "https://mirror.example.test/cache/subdir/",
    );
  }
});

test("explicit allowed mirror origins and local references resolved against a base URL are the only fetch URLs accepted", async (t) => {
  const root = tempStore(t);
  const calls: string[] = [];
  const fetcher: MirrorFetcher = {
    async fetch(url: string): Promise<Uint8Array> {
      calls[calls.length] = url;
      return artifactBytes;
    },
  };

  assertStored(await fetchAndStore(
    {
      ...artifactSpec,
      mirrorUrl: "https://mirror.example.test/packages/alpha-1.0.0.tgz",
    },
    {
      allowedMirrorOrigins: ["https://mirror.example.test"],
      fetcher,
      root,
    },
  ));
  assert.equal(calls[0], "https://mirror.example.test/packages/alpha-1.0.0.tgz");

  assertStored(await fetchAndStore(
    artifactSpec,
    {
      fetcher,
      mirrorBaseUrl: "https://mirror.example.test/cache/",
      root,
    },
  ));
  assert.equal(calls[1], "https://mirror.example.test/cache/alpha-1.0.0.tgz");
});

test("lifecycle indicators reject before fetch", async (t) => {
  const root = tempStore(t);

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      hasInstallScript: true,
    },
    root,
    "LIFECYCLE_REJECTED",
  );

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      requiresBuild: true,
    },
    root,
    "LIFECYCLE_REJECTED",
  );

  await assertRejectsBeforeFetch(
    {
      ...artifactSpec,
      scripts: {
        postinstall: "node install.js",
      },
    },
    root,
    "LIFECYCLE_REJECTED",
  );
});

test("fetch failures, timeouts, and non-byte fetch results reject without throwing or writing", async (t) => {
  const root = tempStore(t);

  assertRejects(
    await fetchAndStore(artifactSpec, {
      fetcher: {
        async fetch(): Promise<Uint8Array> {
          throw new Error("network down");
        },
      },
      mirrorBaseUrl,
      root,
    }),
    "FETCH_FAILED",
  );

  assertRejects(
    await fetchAndStore(artifactSpec, {
      fetcher: {
        async fetch(): Promise<never> {
          return await new Promise<never>(() => undefined);
        },
      },
      mirrorBaseUrl,
      root,
      timeoutMs: 5,
    }),
    "FETCH_FAILED",
  );

  assertRejects(
    await fetchAndStore(artifactSpec, {
      fetcher: {
        fetch(): string {
          return "not bytes";
        },
      },
      mirrorBaseUrl,
      root,
    }),
    "FETCH_FAILED",
  );

  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("post-fetch mutation of returned bytes is rejected before publish", async (t) => {
  const root = tempStore(t);
  const mutableBytes = bytes("alpha package tarball");
  const fetcher: MirrorFetcher = {
    async fetch(): Promise<Uint8Array> {
      queueMicrotask(() => {
        mutableBytes[0] = 0;
      });
      return mutableBytes;
    },
  };

  const result = await fetchAndStore(artifactSpec, {
    fetcher,
    mirrorBaseUrl,
    root,
  });

  assertRejects(result, "INTEGRITY_MISMATCH");
  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("a SharedArrayBuffer-backed fetch result that mutates after hashing cannot publish unverified bytes", async (t) => {
  const root = tempStore(t);

  // Build a view over a SharedArrayBuffer that initially holds the CORRECT
  // bytes (so its digest matches the pinned SRI at the instant it is read), but
  // mutate it concurrently. Under the old copy-after-verify ordering, a hostile
  // fetcher could flip a byte in the TOCTOU window between hash and snapshot and
  // get unverified bytes published. The downloader must instead reject the
  // shared-buffer-backed view outright (defense in depth) and write nothing.
  const shared = new SharedArrayBuffer(artifactBytes.byteLength);
  const sharedView = new Uint8Array(shared);
  sharedView.set(artifactBytes);

  const fetcher: MirrorFetcher = {
    async fetch(): Promise<Uint8Array> {
      // Simulate a concurrent writer racing the verify/publish path.
      queueMicrotask(() => {
        sharedView[0] = (sharedView[0] ?? 0) ^ 0xff;
      });
      return sharedView;
    },
  };

  const result = await fetchAndStore(artifactSpec, {
    fetcher,
    mirrorBaseUrl,
    root,
  });

  assertRejects(result, "FETCH_FAILED");
  // Fail-closed: no blob, no index — no unverified bytes ever published.
  assert.equal(existsSync(join(root, "index.json")), false);
  assert.deepEqual(readdirSync(root), []);
});

test("store I/O errors return structured STORE_IO rejections", async (t) => {
  const root = tempStore(t);
  const rootFile = join(root, "not-a-directory");
  writeFileSync(rootFile, "occupied");

  const result = await fetchAndStore(artifactSpec, {
    fetcher: memoryFetcher(artifactBytes),
    mirrorBaseUrl,
    root: rootFile,
  });

  assertRejects(result, "STORE_IO");
  assert.equal(readFileSync(rootFile, "utf8"), "occupied");
});

test("trust-boundary hostile specs and unsafe mirror references fail closed without writing outside the store", async (t) => {
  const root = tempStore(t);
  const before = readdirSync(root);

  const getterSpec: MutableJsonObject = {
    integrity: artifactIntegrity,
    mirrorUrl: "local-mirror://alpha-1.0.0.tgz",
    name: "alpha",
    version: "1.0.0",
  };
  Object.defineProperty(getterSpec, "name", {
    enumerable: true,
    get() {
      throw new Error("getter should not run");
    },
  });
  await assertDoesNotThrowRejects(getterSpec, root, "INVALID_SPEC");

  const protoSpec: MutableJsonObject = {
    ...artifactSpec,
  };
  Object.defineProperty(protoSpec, "__proto__", {
    configurable: true,
    enumerable: true,
    value: "polluted",
    writable: true,
  });
  await assertDoesNotThrowRejects(protoSpec, root, "INVALID_SPEC");

  const cyclic: MutableJsonObject = {
    ...artifactSpec,
  };
  cyclic.self = cyclic;
  await assertDoesNotThrowRejects(cyclic, root, "INVALID_SPEC");

  await assertDoesNotThrowRejects(
    {
      ...artifactSpec,
      mirrorUrl: "local-mirror://../alpha-1.0.0.tgz",
    },
    root,
    "REMOTE_REJECTED",
  );

  await assertDoesNotThrowRejects(
    {
      ...artifactSpec,
      mirrorUrl: "local-mirror://alpha-\u0000.tgz",
    },
    root,
    "REMOTE_REJECTED",
  );

  assert.deepEqual(readdirSync(root), before);
});

test("fetchAndStore output backs resolveFromMirror end to end", async (t) => {
  const root = tempStore(t);
  assertStored(await fetchAndStore(artifactSpec, {
    fetcher: memoryFetcher(artifactBytes),
    mirrorBaseUrl,
    root,
  }));

  const resolution = resolveFromMirror(lockfileForArtifact(), new OnDiskMirrorStore(root));
  if (!resolution.ok) {
    assert.fail(formatErrors(resolution.errors));
  }

  assert.deepEqual(resolution.resolution.packages, [
    {
      integrity: artifactIntegrity,
      key: "alpha@1.0.0",
      name: "alpha",
      version: "1.0.0",
    },
  ]);
});

function tempStore(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "vita-mirror-store-"));
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
  });
  return root;
}

function memoryFetcher(payload: Uint8Array): MirrorFetcher {
  return {
    async fetch(): Promise<Uint8Array> {
      return payload;
    },
  };
}

async function assertRejectsBeforeFetch(
  spec: unknown,
  root: string,
  code: StoreError["code"],
  baseUrl = mirrorBaseUrl,
): Promise<void> {
  let calls = 0;
  const result = await fetchAndStore(spec, {
    fetcher: {
      async fetch(): Promise<Uint8Array> {
        calls += 1;
        return artifactBytes;
      },
    },
    mirrorBaseUrl: baseUrl,
    root,
  });

  assertRejects(result, code);
  assert.equal(calls, 0);
}

async function assertDoesNotThrowRejects(
  spec: unknown,
  root: string,
  code: StoreError["code"],
): Promise<void> {
  const result = await fetchAndStore(spec, {
    fetcher: memoryFetcher(artifactBytes),
    mirrorBaseUrl,
    root,
  });
  assertRejects(result, code);
}

function assertStored(result: FetchAndStoreResult): {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly key: string;
  readonly path: string;
} {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  return result.stored;
}

function assertRejects(result: FetchAndStoreResult, code: StoreError["code"]): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected fetchAndStore to reject");
  }

  assert.equal(
    result.errors.some((entry) => entry.code === code),
    true,
    formatErrors(result.errors),
  );
}

function deterministicPath(root: string, payload: Uint8Array, algorithm: SriAlgorithm): string {
  const hex = createHash(algorithm).update(payload).digest("hex");
  return join(root, algorithm, hex.slice(0, 2), hex);
}

function readIndex(root: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
  if (!recordObject(parsed)) {
    assert.fail("expected index object");
  }

  const out: Record<string, string> = {};
  const keys = Object.keys(parsed).sort();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }

    const value = parsed[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }

  return out;
}

function lockfileForArtifact(): MutableJsonObject {
  return {
    lockfileVersion: 3,
    name: "vita-app",
    packages: {
      "": {
        dependencies: {
          alpha: "1.0.0",
        },
        name: "vita-app",
        version: "1.0.0",
      },
      "node_modules/alpha": {
        integrity: artifactIntegrity,
        resolved: "local-mirror://alpha-1.0.0.tgz",
        version: "1.0.0",
      },
    },
    requires: true,
    version: "1.0.0",
  };
}

function sri(value: Uint8Array, algorithm: SriAlgorithm): string {
  return `${algorithm}-${createHash(algorithm).update(value).digest("base64")}`;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function recordObject(value: unknown): value is { readonly [key: string]: unknown } {
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CAPABILITY_MANIFESTS,
  HOSTNAME_MANIFEST,
  NODE_CONFIG_MANIFEST,
  TIMESYNC_MANIFEST,
  defaultCapabilityRegistry,
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GENERATED_PATH = resolve(
  REPO_ROOT,
  "sdk",
  "typescript",
  "src",
  "generated",
  "capability-manifests.generated.ts",
);

test("default capability manifests are keyed by agent operation names", () => {
  assert.equal(Object.isFrozen(DEFAULT_CAPABILITY_MANIFESTS), true);
  assert.deepEqual(Object.keys(DEFAULT_CAPABILITY_MANIFESTS).sort(), [
    "hostname.set",
    "node.config",
    "time.sync",
  ]);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["hostname.set"], HOSTNAME_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["node.config"], NODE_CONFIG_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["time.sync"], TIMESYNC_MANIFEST);
  assert.equal(Object.hasOwn(TIMESYNC_MANIFEST, "defaultRegistry"), false);
  assert.equal(Object.isFrozen(DEFAULT_CAPABILITY_MANIFESTS["hostname.set"]?.fields.desired), true);
});

test("defaultCapabilityRegistry exposes every generated manifest", () => {
  const registry = defaultCapabilityRegistry();

  assert.equal(registry.get("hostname.set"), HOSTNAME_MANIFEST);
  assert.equal(registry.get("node.config"), NODE_CONFIG_MANIFEST);
  assert.equal(registry.get("time.sync"), TIMESYNC_MANIFEST);
  assert.equal(registry.size, 3);
});

test("generated capability manifests are fresh", () => {
  const expected = execFileSync(
    process.execPath,
    ["tools/schema/gen-capability-manifests.mjs", "--stdout"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(readFileSync(GENERATED_PATH, "utf8"), expected);
});

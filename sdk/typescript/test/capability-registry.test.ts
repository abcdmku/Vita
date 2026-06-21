import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACCOUNTS_MANIFEST,
  CAPSULE_MANIFEST,
  DEFAULT_CAPABILITY_MANIFESTS,
  HOSTNAME_MANIFEST,
  IDENTITY_MANIFEST,
  NODE_CONFIG_MANIFEST,
  SERVICES_MANIFEST,
  TIME_MANIFEST,
  TIMESYNC_MANIFEST,
  UPDATE_MANIFEST,
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
    "accounts.config",
    "capsule.registry",
    "hostname.set",
    "identity.attestation",
    "node.config",
    "services.config",
    "time.set",
    "time.sync",
    "update.plan",
  ]);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["accounts.config"], ACCOUNTS_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["capsule.registry"], CAPSULE_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["hostname.set"], HOSTNAME_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["identity.attestation"], IDENTITY_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["node.config"], NODE_CONFIG_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["services.config"], SERVICES_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["time.set"], TIME_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["time.sync"], TIMESYNC_MANIFEST);
  assert.equal(DEFAULT_CAPABILITY_MANIFESTS["update.plan"], UPDATE_MANIFEST);
  assert.equal(Object.hasOwn(TIMESYNC_MANIFEST, "defaultRegistry"), false);
  assert.equal(Object.isFrozen(DEFAULT_CAPABILITY_MANIFESTS["hostname.set"]?.fields.desired), true);
});

test("defaultCapabilityRegistry exposes every generated manifest", () => {
  const registry = defaultCapabilityRegistry();

  assert.equal(registry.get("accounts.config"), ACCOUNTS_MANIFEST);
  assert.equal(registry.get("capsule.registry"), CAPSULE_MANIFEST);
  assert.equal(registry.get("hostname.set"), HOSTNAME_MANIFEST);
  assert.equal(registry.get("identity.attestation"), IDENTITY_MANIFEST);
  assert.equal(registry.get("node.config"), NODE_CONFIG_MANIFEST);
  assert.equal(registry.get("services.config"), SERVICES_MANIFEST);
  assert.equal(registry.get("time.set"), TIME_MANIFEST);
  assert.equal(registry.get("time.sync"), TIMESYNC_MANIFEST);
  assert.equal(registry.get("update.plan"), UPDATE_MANIFEST);
  assert.equal(registry.size, 9);
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

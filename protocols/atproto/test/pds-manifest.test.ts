import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPdsManifest,
  defaultPdsConfig,
  pdsManifest,
  type PdsConfig,
} from "../src/pds-manifest.ts";
import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";

test("buildPdsManifest returns a valid PackageContract for a valid config", () => {
  const manifest = buildPdsManifest(defaultPdsConfig);
  const result = validatePackageContract(manifest);

  assert.equal(result.ok, true);

  if (!result.ok) {
    assert.fail(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  }

  assert.equal(result.contract.packageClass, "oci-service");
});

test("pdsManifest default contract validates", () => {
  const result = validatePackageContract(pdsManifest);

  assert.equal(result.ok, true);

  if (!result.ok) {
    assert.fail(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  }
});

test("PDS manifest declares ingress, architectures, and backup/restore hooks", () => {
  const manifest = buildPdsManifest(defaultPdsConfig);

  assert.deepEqual(manifest.architectures, ["x86_64", "arm64"]);
  assert.equal(
    manifest.network.ingress.some((rule) => rule.public && rule.protocol === "https"),
    true,
  );
  assert.equal(manifest.backup.quiesceHooks.length > 0, true);
  assert.equal(manifest.backup.backupHooks.length > 0, true);
  assert.equal(manifest.restore.verificationHooks.length > 0, true);
});

test("invalid config produces validation failure without throwing", () => {
  const invalidConfig: PdsConfig = {
    ...defaultPdsConfig,
    storageVolume: {
      sizeMiB: defaultPdsConfig.storageVolume.sizeMiB,
    } as PdsConfig["storageVolume"],
  };

  assert.doesNotThrow(() => buildPdsManifest(invalidConfig));

  const result = validatePackageContract(buildPdsManifest(invalidConfig));

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected invalid PDS config to produce an invalid package contract");
  }

  assert.equal(
    result.errors.some(
      (error) => error.path === "data/volumes/0/name" && error.message === "Required field is missing.",
    ),
    true,
  );
  assert.equal(
    result.errors.some(
      (error) => error.path === "backup/includeVolumes/0" && error.message === "Expected non-empty string.",
    ),
    true,
  );
});

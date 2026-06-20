import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type {
  DataVolumeRequirement,
  ImmutableDigest,
  NetworkEgressRule,
  NetworkIngressRule,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import { decideGrants } from "../../../runtime/permission-broker/src/decide.ts";
import type {
  BrokerPolicy,
  CapabilityGrant,
  DataGrantPolicy,
} from "../../../runtime/permission-broker/src/grants.ts";

import {
  notesManifest,
  notesPackageContract,
  notesRequestedCapabilities,
} from "../notes/manifest.ts";
import {
  searchManifest,
  searchPackageContract,
  searchRequestedCapabilities,
} from "../search/manifest.ts";

interface ManifestFixture {
  readonly handle: "notes" | "search";
  readonly entry: CatalogEntry;
  readonly contract: PackageContract;
  readonly requestedCapabilities: readonly CapabilityGrant[];
  readonly maxResources: {
    readonly cpuCores: number;
    readonly ramMiB: number;
    readonly storageMiB: number;
  };
}

const FIXTURES: readonly ManifestFixture[] = [
  {
    handle: "notes",
    entry: notesManifest,
    contract: notesPackageContract,
    requestedCapabilities: notesRequestedCapabilities,
    maxResources: {
      cpuCores: 0.5,
      ramMiB: 512,
      storageMiB: 1024,
    },
  },
  {
    handle: "search",
    entry: searchManifest,
    contract: searchPackageContract,
    requestedCapabilities: searchRequestedCapabilities,
    maxResources: {
      cpuCores: 1,
      ramMiB: 1024,
      storageMiB: 2048,
    },
  },
];

test("first-party app manifests validate against catalog and package contracts", () => {
  for (const fixture of FIXTURES) {
    assertValidCatalogEntry(fixture.entry);
    assertValidPackageContract(fixture.contract);

    assert.equal(fixture.entry.package, fixture.contract);
    assert.equal(fixture.entry.trustTier, "verified");
    assert.deepEqual(fixture.entry.signingPublisher, fixture.contract.signingPublisher);
    assert.deepEqual(fixture.entry.digest, fixture.contract.digest);
    assert.equal(fixture.entry.endOfSupport, fixture.contract.endOfSupportDate);
  }
});

test("first-party app ids, handles, and pinned references are well formed", () => {
  for (const fixture of FIXTURES) {
    assert.equal(fixture.contract.packageClass, "ts-service");
    assert.match(fixture.contract.identity.id, /^com\.vita\.[a-z][a-z0-9-]*$/u);
    assert.equal(fixture.contract.identity.id, `com.vita.${fixture.handle}`);
    assert.equal(fixture.contract.signingPublisher.id, "vita.first-party");
    assert.match(fixture.contract.signingPublisher.signingKeyRef, /^publisher-key:\/\/vita\//u);

    assertSha256Digest(fixture.contract.digest);
    assertSha256Digest(fixture.entry.digest);
    assertSha256Digest(fixture.contract.sbom.digest);
    assertSha256Digest(fixture.entry.sbom.digest);
    assert.equal(fixture.entry.sbom.ref, `sbom://vita/first-party/${fixture.handle}/1.0.0/spdx`);
    assert.equal(fixture.contract.version, "1.0.0");

    assertSignatureReferences(fixture.entry, fixture.handle);
  }
});

test("requested capabilities use the broker vocabulary and match declarations", () => {
  for (const fixture of FIXTURES) {
    assertDeclaredCapabilities(fixture.contract, fixture.requestedCapabilities);

    const declarationCount =
      fixture.contract.data.volumes.length +
      fixture.contract.network.ingress.length +
      fixture.contract.network.egress.length;

    assert.equal(fixture.requestedCapabilities.length, declarationCount);

    const decision = decideGrants(
      {
        packageContract: fixture.contract,
        capabilities: fixture.requestedCapabilities,
      },
      policyFromContract(fixture.contract),
    );

    assert.deepEqual(decision.denied, []);
    assert.deepEqual(decision.granted, fixture.requestedCapabilities);
  }
});

test("resource limits are bounded and least-privilege defaults stay narrow", () => {
  for (const fixture of FIXTURES) {
    const { resources } = fixture.contract;

    assert.equal(resources.cpuCores > 0 && resources.cpuCores <= fixture.maxResources.cpuCores, true);
    assert.equal(resources.ramMiB > 0 && resources.ramMiB <= fixture.maxResources.ramMiB, true);
    assert.equal(
      resources.storageMiB > 0 && resources.storageMiB <= fixture.maxResources.storageMiB,
      true,
    );
    assert.equal(totalVolumeSizeMiB(fixture.contract.data.volumes) <= resources.storageMiB, true);
    assert.deepEqual(fixture.contract.accelerators.required, []);
    assert.deepEqual(fixture.contract.accelerators.optional, []);
    assert.deepEqual(fixture.contract.network.egress, []);
    assert.deepEqual(fixture.contract.secrets, []);

    for (const ingress of fixture.contract.network.ingress) {
      assert.equal(ingress.public, false);
    }
  }
});

function assertValidCatalogEntry(entry: CatalogEntry): void {
  const result = validateCatalogEntry(entry);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);
}

function assertValidPackageContract(contract: PackageContract): void {
  const result = validatePackageContract(contract);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);
}

function assertSignatureReferences(entry: CatalogEntry, handle: string): void {
  for (let index = 0; index < entry.signatures.length; index += 1) {
    const signature = entry.signatures[index];

    if (signature === undefined) {
      assert.fail(`missing signature at ${index}`);
    }

    if (typeof signature === "string") {
      assert.match(signature, new RegExp(`^signature://vita/first-party/${handle}/`, "u"));
      continue;
    }

    assert.equal(signature.ref, `signature://vita/first-party/${handle}/1.0.0/sigstore`);
    assert.equal(signature.keyRef, "publisher-key://vita/first-party/stable");

    if (signature.digest !== undefined) {
      assertSha256Digest(signature.digest);
    }
  }
}

function assertSha256Digest(digest: ImmutableDigest): void {
  assert.equal(digest.algorithm, "sha256");
  assert.match(digest.value, /^[a-f0-9]{64}$/u);
}

function assertDeclaredCapabilities(
  contract: PackageContract,
  capabilities: readonly CapabilityGrant[],
): void {
  for (const capability of capabilities) {
    switch (capability.kind) {
      case "data":
        assertDataCapabilityDeclared(contract, capability);
        break;
      case "network":
        assertNetworkCapabilityDeclared(contract, capability);
        break;
      default: {
        const exhaustive: never = capability;
        assert.fail(`unexpected capability kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function assertDataCapabilityDeclared(
  contract: PackageContract,
  capability: Extract<CapabilityGrant, { readonly kind: "data" }>,
): void {
  assert.equal(contract.data.classes.includes(capability.class), true);

  let declared = false;

  for (const volume of contract.data.volumes) {
    if (
      volume.name === capability.scope &&
      volume.class === capability.class &&
      volume.access === capability.access
    ) {
      declared = true;
      break;
    }
  }

  assert.equal(declared, true, `undeclared data capability ${capability.scope}`);
}

function assertNetworkCapabilityDeclared(
  contract: PackageContract,
  capability: Extract<CapabilityGrant, { readonly kind: "network" }>,
): void {
  if (capability.direction === "ingress") {
    assert.equal(hasIngress(contract.network.ingress, capability), true);
    return;
  }

  assert.equal(hasEgress(contract.network.egress, capability), true);
}

function hasIngress(
  rules: readonly NetworkIngressRule[],
  capability: Extract<CapabilityGrant, { readonly direction: "ingress" }>,
): boolean {
  for (const rule of rules) {
    if (
      rule.protocol === capability.protocol &&
      rule.port === capability.port &&
      rule.public === capability.public
    ) {
      return true;
    }
  }

  return false;
}

function hasEgress(
  rules: readonly NetworkEgressRule[],
  capability: Extract<CapabilityGrant, { readonly direction: "egress" }>,
): boolean {
  for (const rule of rules) {
    if (
      rule.protocol === capability.protocol &&
      rule.destinations.includes(capability.destination) &&
      rule.ports.includes(capability.port)
    ) {
      return true;
    }
  }

  return false;
}

function policyFromContract(contract: PackageContract): BrokerPolicy {
  return {
    data: dataPolicyFromVolumes(contract.data.volumes),
    network: contract.network,
  };
}

function dataPolicyFromVolumes(volumes: readonly DataVolumeRequirement[]): readonly DataGrantPolicy[] {
  return volumes.map((volume) => ({
    class: volume.class,
    access: volume.access,
    scope: volume.name,
  }));
}

function totalVolumeSizeMiB(volumes: readonly DataVolumeRequirement[]): number {
  let total = 0;

  for (const volume of volumes) {
    total += volume.sizeMiB;
  }

  return total;
}

function formatErrors(errors: readonly { readonly path: string; readonly message: string }[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

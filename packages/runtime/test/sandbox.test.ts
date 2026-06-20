import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGrants } from "../../../runtime/permission-broker/src/decide.ts";
import type {
  BrokerPolicy,
  CapabilityGrant,
  DataGrantPolicy,
} from "../../../runtime/permission-broker/src/grants.ts";
import type {
  DataVolumeRequirement,
  NetworkEgressRule,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import {
  notesPackageContract,
  notesRequestedCapabilities,
} from "../../first-party/notes/manifest.ts";
import {
  denoSandboxPolicy,
  VOLUME_MOUNT_ROOT,
} from "../src/sandbox.ts";
import type {
  DenoSandboxPermissions,
  DenoSandboxPolicyErrorCode,
} from "../src/sandbox.ts";

test("maps real broker-granted data and ingress capabilities to scoped Deno allowlists", () => {
  const decision = decideGrants(
    {
      packageContract: notesPackageContract,
      capabilities: notesRequestedCapabilities,
    },
    policyFromContract(notesPackageContract),
  );

  assert.deepEqual(decision.denied, []);

  const policy = assertPolicy(decision.granted);

  assert.equal(policy.defaultDeny, true);
  assert.deepEqual(policy.allowRead, [
    `${VOLUME_MOUNT_ROOT}/notes`,
    `${VOLUME_MOUNT_ROOT}/state`,
  ]);
  assert.deepEqual(policy.allowWrite, [
    `${VOLUME_MOUNT_ROOT}/notes`,
    `${VOLUME_MOUNT_ROOT}/state`,
  ]);
  assert.deepEqual(policy.allowNet, ["127.0.0.1:8443"]);
  assert.deepEqual(policy.allowEnv, []);
  assert.deepEqual(policy.allowRun, []);
  assert.deepEqual(policy.allowFfi, []);
});

test("maps real broker-granted egress network capability to destination and port", () => {
  const egressRule: NetworkEgressRule = {
    name: "updates",
    protocol: "https",
    destinations: ["updates.example.invalid"],
    ports: [443],
  };
  const packageContract: PackageContract = {
    ...notesPackageContract,
    network: {
      ingress: [],
      egress: [egressRule],
    },
  };
  const requestedCapabilities: readonly CapabilityGrant[] = [
    {
      kind: "network",
      direction: "egress",
      protocol: "https",
      destination: "updates.example.invalid",
      port: 443,
    },
  ];
  const decision = decideGrants(
    {
      packageContract,
      capabilities: requestedCapabilities,
    },
    policyFromContract(packageContract),
  );

  assert.deepEqual(decision.denied, []);

  const policy = assertPolicy(decision.granted);

  assert.deepEqual(policy.allowNet, ["updates.example.invalid:443"]);
  assert.deepEqual(policy.allowRead, []);
  assert.deepEqual(policy.allowWrite, []);
  assert.deepEqual(policy.allowEnv, []);
  assert.deepEqual(policy.allowRun, []);
  assert.deepEqual(policy.allowFfi, []);
});

test("empty grants produce a fully denied default-deny policy", () => {
  const policy = assertPolicy([]);

  assert.equal(policy.defaultDeny, true);
  assert.deepEqual(policy.allowNet, []);
  assert.deepEqual(policy.allowRead, []);
  assert.deepEqual(policy.allowWrite, []);
  assert.deepEqual(policy.allowEnv, []);
  assert.deepEqual(policy.allowRun, []);
  assert.deepEqual(policy.allowFfi, []);
});

test("rejects synthetic, forbidden, partial, and over-broad grant shapes", () => {
  const rejected: readonly {
    readonly grants: unknown;
    readonly code: DenoSandboxPolicyErrorCode;
  }[] = [
    { grants: ["net:updates.example.invalid:443"], code: "MALFORMED_GRANTS" },
    { grants: [{ kind: "fs", access: "read", path: "/etc/passwd" }], code: "MALFORMED_GRANTS" },
    { grants: [{ kind: "env", name: "HOME" }], code: "MALFORMED_GRANTS" },
    { grants: [{ kind: "run", command: "sh" }], code: "FORBIDDEN_GRANT" },
    { grants: [{ kind: "ffi", library: "native.node" }], code: "FORBIDDEN_GRANT" },
    {
      grants: [{ kind: "data", class: "app-state", access: "read-write" }],
      code: "MALFORMED_GRANTS",
    },
    {
      grants: [{ kind: "data", class: "app-state", access: "read-write", scope: "../state" }],
      code: "UNMAPPABLE_GRANT",
    },
    {
      grants: [
        {
          kind: "network",
          direction: "egress",
          protocol: "https",
          destination: "*",
          port: 443,
        },
      ],
      code: "UNMAPPABLE_GRANT",
    },
    {
      grants: [
        {
          kind: "network",
          direction: "egress",
          protocol: "https",
          destination: "updates.example.invalid",
          port: 443,
          allowRun: true,
        },
      ],
      code: "MALFORMED_GRANTS",
    },
  ];

  for (let index = 0; index < rejected.length; index += 1) {
    const item = rejected[index];

    if (item !== undefined) {
      assertRejected(item.grants, item.code);
    }
  }
});

test("safeNormalize rejects hostile inputs without throwing or granting", () => {
  const cyclic: unknown[] = [];
  cyclic[0] = cyclic;

  const getterArray: unknown[] = [];
  Object.defineProperty(getterArray, "0", {
    enumerable: true,
    get() {
      throw new Error("getter must not execute");
    },
  });

  const methodShadow = [
    {
      kind: "data",
      class: "app-state",
      access: "read-write",
      scope: "state",
    },
  ];
  Object.defineProperty(methodShadow, "includes", {
    enumerable: true,
    value: () => true,
  });

  const proxy = new Proxy([], {});

  for (const input of [cyclic, getterArray, methodShadow, proxy]) {
    assert.doesNotThrow(() => denoSandboxPolicy(input));
    assertRejected(input, "MALFORMED_GRANTS");
  }
});

test("produced policy never contains allow-all, unscoped network, run, or ffi permissions", () => {
  const decision = decideGrants(
    {
      packageContract: notesPackageContract,
      capabilities: notesRequestedCapabilities,
    },
    policyFromContract(notesPackageContract),
  );
  const policy = assertPolicy(decision.granted);

  assert.equal(Object.hasOwn(policy, "allowAll"), false);
  assert.deepEqual(policy.allowRun, []);
  assert.deepEqual(policy.allowFfi, []);

  for (const scope of [
    ...policy.allowNet,
    ...policy.allowRead,
    ...policy.allowWrite,
    ...policy.allowEnv,
  ]) {
    assert.notEqual(scope, "");
    assert.notEqual(scope, "*");
    assert.equal(scope.startsWith("--allow-"), false);
  }
});

function assertPolicy(input: unknown): DenoSandboxPermissions {
  const result = denoSandboxPolicy(input);

  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.reason}`);
  }

  return result.policy;
}

function assertRejected(input: unknown, code: DenoSandboxPolicyErrorCode): void {
  const result = denoSandboxPolicy(input);

  if (result.ok) {
    assert.fail(`expected rejection, got ${JSON.stringify(result.policy)}`);
  }

  assert.equal(result.error.code, code);
}

function policyFromContract(contract: PackageContract): BrokerPolicy {
  return {
    data: dataPolicyFromVolumes(contract.data.volumes),
    network: contract.network,
  };
}

function dataPolicyFromVolumes(volumes: readonly DataVolumeRequirement[]): readonly DataGrantPolicy[] {
  const grants: DataGrantPolicy[] = [];

  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index];

    if (volume !== undefined) {
      grants[grants.length] = {
        class: volume.class,
        access: volume.access,
        scope: volume.name,
      };
    }
  }

  return grants;
}

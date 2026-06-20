import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGrants } from "../src/decide.ts";
import type { BrokerPolicy, CapabilityGrant, CapabilityRequest } from "../src/grants.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";

const dataRead: CapabilityGrant = {
  kind: "data",
  class: "app-state",
  access: "read-only",
  scope: "state",
};

const dataWrite: CapabilityGrant = {
  kind: "data",
  class: "app-state",
  access: "read-write",
  scope: "state",
};

const declaredEgress: CapabilityGrant = {
  kind: "network",
  direction: "egress",
  protocol: "https",
  destination: "updates.example.invalid",
  port: 443,
};

const undeclaredEgress: CapabilityGrant = {
  kind: "network",
  direction: "egress",
  protocol: "https",
  destination: "evil.example.invalid",
  port: 443,
};

test("grants only capabilities that policy allows and package declares", () => {
  const decision = decideGrants(
    request([dataRead, declaredEgress, undeclaredEgress]),
    policy({ egress: [] }),
  );

  assert.deepEqual(decision.granted, [dataRead]);
  assert.deepEqual(
    decision.denied.map((denial) => denial.code),
    ["POLICY_DENIED", "NOT_DECLARED"],
  );
});

test("default-denies unknown capabilities", () => {
  const decision = decideGrants(
    {
      packageContract: validContract(),
      capabilities: [{ kind: "filesystem", path: "/etc/passwd" }],
    } as unknown as CapabilityRequest,
    policy(),
  );

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "UNKNOWN_CAPABILITY");
});

test("denies import escalation beyond destination policy", () => {
  const decision = decideGrants(request([dataWrite]), policy({ dataAccess: "read-only" }));

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "POLICY_DENIED");
});

test("malformed, cyclic, and unknown inputs fail closed without throwing", () => {
  const cyclic = { packageContract: validContract(), capabilities: [dataRead] };
  cyclic.packageContract.identity = cyclic.packageContract as PackageContract["identity"];

  for (const input of [null, "bad", cyclic]) {
    assert.doesNotThrow(() =>
      decideGrants(input as unknown as CapabilityRequest, policy()),
    );

    const decision = decideGrants(input as unknown as CapabilityRequest, policy());
    assert.deepEqual(decision.granted, []);
    assert.equal(decision.denied.length > 0, true);
  }
});

test("partial-but-typed data declarations do not authorize grants", () => {
  const contract = validContract() as unknown as Record<string, unknown>;
  contract.data = {
    classes: ["app-state"],
    volumes: [{ name: "state", class: "app-state", access: "read-write" }],
  };

  const decision = decideGrants(
    request([dataRead], contract as unknown as PackageContract),
    policy(),
  );

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "INVALID_PACKAGE_CONTRACT");
});

test("destination network policy missing either side is all-denied", () => {
  const malformedPolicy = {
    data: [{ class: "app-state", access: "read-write", scope: "state" }],
    network: {
      egress: [
        {
          name: "updates",
          protocol: "https",
          destinations: ["updates.example.invalid"],
          ports: [443],
        },
      ],
    },
  };

  const decision = decideGrants(
    request([declaredEgress]),
    malformedPolicy as unknown as BrokerPolicy,
  );

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "MALFORMED_POLICY");
});

test("package alias without packageContract is ignored and denied", () => {
  const decision = decideGrants(
    { package: validContract(), capabilities: [dataRead] } as unknown as CapabilityRequest,
    policy(),
  );

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "MALFORMED_REQUEST");
});

test("shadowed array methods in package or policy fail closed", () => {
  const contract = validContract();
  const egress = contract.network.egress as unknown as Record<string, unknown>;
  egress.some = () => true;
  egress.includes = () => true;
  egress.find = () => ({ protocol: "https", destinations: ["evil.example.invalid"], ports: [443] });

  const policyWithShadow = policy();
  const policyData = policyWithShadow.data as unknown as Record<string, unknown>;
  policyData.some = () => true;

  const packageDecision = decideGrants(request([undeclaredEgress], contract), policy());
  const policyDecision = decideGrants(request([dataRead]), policyWithShadow);

  assert.deepEqual(packageDecision.granted, []);
  assert.equal(packageDecision.denied[0]?.code, "MALFORMED_REQUEST");
  assert.deepEqual(policyDecision.granted, []);
  assert.equal(policyDecision.denied[0]?.code, "MALFORMED_POLICY");
});

test("hostile Symbol.iterator is rejected before deciding", () => {
  const contract = validContract();
  Object.defineProperty(contract.data.classes, Symbol.iterator, {
    value: function* hostile() {
      yield "app-state";
    },
  });

  const decision = decideGrants(request([dataRead], contract), policy());

  assert.deepEqual(decision.granted, []);
  assert.equal(decision.denied[0]?.code, "MALFORMED_REQUEST");
});

test("getters and unstable proxies fail closed", () => {
  const getterRequest = {
    get packageContract() {
      return validContract();
    },
    capabilities: [dataRead],
  };

  const allowedNetwork = policy().network;
  const proxyPolicy = new Proxy(policy({ egress: [] }), {
    get(target, key, receiver) {
      if (key === "network") {
        return allowedNetwork;
      }

      return Reflect.get(target, key, receiver);
    },
  });

  const getterDecision = decideGrants(
    getterRequest as unknown as CapabilityRequest,
    policy(),
  );
  const proxyDecision = decideGrants(
    request([declaredEgress]),
    proxyPolicy as unknown as BrokerPolicy,
  );

  assert.deepEqual(getterDecision.granted, []);
  assert.equal(getterDecision.denied[0]?.code, "MALFORMED_REQUEST");
  assert.deepEqual(proxyDecision.granted, []);
  assert.equal(proxyDecision.denied[0]?.code, "MALFORMED_POLICY");
});

function request(
  capabilities: readonly CapabilityGrant[],
  packageContract: PackageContract = validContract(),
): CapabilityRequest {
  return {
    packageContract,
    capabilities,
  };
}

function policy(
  options: {
    readonly dataAccess?: "read-only" | "read-write";
    readonly egress?: BrokerPolicy["network"]["egress"];
  } = {},
): BrokerPolicy {
  return {
    data: [
      {
        class: "app-state",
        access: options.dataAccess ?? "read-write",
        scope: "state",
      },
    ],
    network: {
      ingress: [{ name: "web", protocol: "https", port: 443, public: false }],
      egress: options.egress ?? [
        {
          name: "updates",
          protocol: "https",
          destinations: ["updates.example.invalid"],
          ports: [443],
        },
      ],
    },
  };
}

function validContract(): PackageContract {
  return {
    packageClass: "ts-service",
    identity: {
      id: "com.vita.notes",
      name: "Vita Notes",
    },
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    version: "1.2.3",
    digest: {
      algorithm: "sha256",
      value: "8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25",
    },
    architectures: ["x86_64"],
    resources: {
      cpuCores: 1,
      ramMiB: 256,
      storageMiB: 512,
    },
    accelerators: {
      required: [],
      optional: [],
      preference: ["cpu"],
    },
    network: {
      ingress: [{ name: "web", protocol: "https", port: 443, public: false }],
      egress: [
        {
          name: "updates",
          protocol: "https",
          destinations: ["updates.example.invalid"],
          ports: [443],
        },
      ],
    },
    data: {
      classes: ["app-state"],
      volumes: [
        {
          name: "state",
          mountPath: "/var/lib/vita-notes",
          class: "app-state",
          access: "read-write",
          persistence: "persistent",
          backup: true,
          sizeMiB: 512,
        },
      ],
    },
    secrets: [],
    backup: {
      strategy: "none",
      includeVolumes: [],
      quiesceHooks: [],
      backupHooks: [],
    },
    restore: {
      requireCleanVerification: true,
      verificationHooks: [],
    },
    healthChecks: [],
    updates: {
      channel: "stable",
      strategy: "replace",
      schemaMigrations: [],
    },
    rollback: {
      maxRollbackVersions: 2,
      maxRollbackAgeDays: 30,
      requiresFreshBackup: true,
    },
    exportFormats: ["json"],
    endOfSupportDate: "2028-12-31",
    sbom: {
      format: "spdx-json",
      digest: {
        algorithm: "sha256",
        value: "497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e",
      },
      generatedAt: "2026-06-01T12:00:00.000Z",
    },
    vulnerabilityStatus: {
      status: "clean",
      scannedAt: "2026-06-01T12:10:00.000Z",
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    requiredSimulationProfiles: [],
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  summarizeExposure,
} from "./protection-dashboard-model.ts";
import type {
  ExposureSummary,
  ExposureSummaryResult,
} from "./protection-dashboard-model.ts";

test("capsules classify as exposed-ingress, egress-only, and network-mute with stable sorting", () => {
  const exposure = mustExposure({
    capsuleNetworkGrants: [
      {
        capsuleId: "capsule.z",
        egressGrants: 0,
        ingressGrants: 2,
      },
      {
        capsuleId: "capsule.a",
        egressGrants: 1,
        ingressGrants: 0,
      },
    ],
    capsuleRegistry: [
      capsule("capsule.z"),
      capsule("capsule.mute"),
      capsule("capsule.a"),
    ],
  });

  assert.deepEqual(
    exposure.capsules.map((entry) => entry.capsuleId),
    ["capsule.a", "capsule.mute", "capsule.z"],
  );
  assert.deepEqual(
    exposure.capsules.map((entry) => entry.exposure),
    ["egress-only", "network-mute", "exposed-ingress"],
  );
  assert.deepEqual(exposure.counts, {
    egressOnly: 1,
    exposedIngress: 1,
    networkMute: 1,
  });
});

test("host ingress flags unsafe and all-source rules as wide-open and sorts ports deterministically", () => {
  const unsafe = mustExposure({
    networkPolicy: {
      allow: [
        {
          port: 443,
          proto: "tcp",
          sourceCidr: "192.168.1.0/24",
        },
        {
          port: 22,
          proto: "tcp",
          sourceCidr: "10.0.0.0/8",
          unsafeWideOpen: true,
        },
      ],
    },
  });

  assert.equal(unsafe.host.wideOpen, true);
  assert.deepEqual(unsafe.host.openIngressPorts, [
    {
      port: 22,
      proto: "tcp",
    },
    {
      port: 443,
      proto: "tcp",
    },
  ]);
  assert.equal(unsafe.host.rules[0]?.wideOpen, true);

  const ipv4Wide = mustExposure({
    networkPolicy: {
      allow: [
        {
          port: 443,
          proto: "tcp",
          sourceCidr: "0.0.0.0/0",
        },
      ],
    },
  });
  assert.equal(ipv4Wide.host.wideOpen, true);

  const ipv6Wide = mustExposure({
    networkPolicy: {
      allow: [
        {
          port: 8443,
          proto: "tcp",
          sourceCidr: "::/0",
        },
      ],
    },
  });
  assert.equal(ipv6Wide.host.wideOpen, true);

  const scoped = mustExposure({
    networkPolicy: {
      allow: [
        {
          port: 443,
          proto: "tcp",
          sourceCidr: "192.168.1.0/24",
        },
      ],
    },
  });
  assert.equal(scoped.host.wideOpen, false);

  const actualReadState = mustExposure({
    networkPolicy: {
      exists: true,
      policy: {
        allow: [
          {
            interface: "eth0",
            port: 443,
            proto: "tcp",
            sourceCidr: "10.0.0.0/8",
          },
        ],
      },
      raw: "eyJhbGxvdyI6W119Cg==",
    },
  });
  assert.deepEqual(actualReadState.host.openIngressPorts, [
    {
      port: 443,
      proto: "tcp",
    },
  ]);
});

test("network config shape is accepted and converted without leaking interface details", () => {
  const exposure = mustExposure({
    networkPolicy: {
      firewall: {
        allow: [
          {
            port: 53,
            protocol: "udp",
            sourceCidr: "192.168.1.0/24",
          },
        ],
        unsafeWideOpen: false,
      },
      interfaces: [
        {
          kind: "ethernet",
          name: "eth0",
        },
      ],
    },
  });

  assert.deepEqual(exposure.host.rules, [
    {
      port: 53,
      proto: "udp",
      sourceCidr: "192.168.1.0/24",
      wideOpen: false,
    },
  ]);
  assert.equal(JSON.stringify(exposure).includes("eth0"), false);
});

test("exposure model rejects malformed network, capsule, and grant inputs without throwing", () => {
  assertRejected(
    summarizeExposure({
      networkPolicy: {
        allow: "tcp/443",
      },
    }),
    ["networkPolicy/allow"],
  );

  assertRejected(
    summarizeExposure({
      capsuleRegistry: [
        {
          id: "capsule.bad",
          state: "running",
          version: "1.0.0",
        },
      ],
    }),
    ["capsuleRegistry/0/state"],
  );

  assertRejected(
    summarizeExposure({
      capsuleNetworkGrants: [
        {
          capsuleId: "capsule.a",
          egressGrants: 1.5,
          ingressGrants: 0,
        },
      ],
      capsuleRegistry: [capsule("capsule.a")],
    }),
    ["capsuleNetworkGrants/0/egressGrants"],
  );

  const proxy = new Proxy({}, {
    get() {
      throw new Error("proxy getter must not run");
    },
  });
  assertRejected(summarizeExposure(proxy), [""]);

  const methodShadowedGrants = [
    {
      capsuleId: "capsule.a",
      egressGrants: 0,
      ingressGrants: 0,
    },
  ];
  Object.defineProperty(methodShadowedGrants, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  assertRejected(
    summarizeExposure({
      capsuleNetworkGrants: methodShadowedGrants,
      capsuleRegistry: [capsule("capsule.a")],
    }),
    [""],
  );
});

test("absent network policy gives an empty host surface and deterministic mute counts", () => {
  const first = summarizeExposure({
    capsuleRegistry: [capsule("capsule.mute")],
  });
  const second = summarizeExposure({
    capsuleRegistry: [capsule("capsule.mute")],
  });

  if (!first.ok || !second.ok) {
    assert.fail("expected exposure summary to pass");
  }

  assert.deepEqual(first.exposure.host, {
    openIngressPorts: [],
    rules: [],
    wideOpen: false,
  });
  assert.deepEqual(first.exposure.counts, {
    egressOnly: 0,
    exposedIngress: 0,
    networkMute: 1,
  });
  assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));

  const registryReadState = mustExposure({
    capsuleRegistry: {
      exists: true,
      raw: "eyJjYXBzdWxlcyI6W119Cg==",
      registry: {
        capsules: [
          capsule("capsule.readstate"),
        ],
      },
    },
    networkPolicy: {
      exists: false,
      policy: {},
      raw: null,
    },
  });
  assert.equal(registryReadState.host.wideOpen, false);
  assert.equal(registryReadState.counts.networkMute, 1);
});

function mustExposure(input: unknown): ExposureSummary {
  const result = summarizeExposure(input);

  if (!result.ok) {
    assert.fail(`expected exposure summary to pass: ${JSON.stringify(result.errors)}`);
  }

  return result.exposure;
}

function assertRejected(result: ExposureSummaryResult, paths: readonly string[]): void {
  assert.doesNotThrow(() => {
    if (result.ok) {
      assert.fail(`expected rejection, got ${JSON.stringify(result.value)}`);
    }
  });

  if (result.ok) {
    assert.fail("expected rejection");
  }

  assert.deepEqual(result.errors.map((error) => error.path).sort(), [...paths].sort());
}

function capsule(id: string): unknown {
  return {
    id,
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    state: "installed",
    version: "1.0.0",
  };
}

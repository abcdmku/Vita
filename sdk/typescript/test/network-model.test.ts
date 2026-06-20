import test from "node:test";
import assert from "node:assert/strict";

import { validateNetworkConfig } from "../src/network-model.ts";

function validConfig(): unknown {
  return {
    interfaces: [
      { name: "eth0", kind: "ethernet" },
      { name: "lo", kind: "loopback" },
    ],
    firewall: {
      allow: [
        { protocol: "tcp", port: 443, sourceCidr: "10.0.0.0/8" },
        { protocol: "udp", port: 53, sourceCidr: "192.168.1.0/24" },
      ],
    },
  };
}

test("a well-formed network config validates", () => {
  const result = validateNetworkConfig(validConfig());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.interfaces.length, 2);
    assert.equal(result.config.firewall.allow.length, 2);
    assert.equal(result.config.firewall.unsafeWideOpen, false);
  }
});

test("an explicit empty allow list is accepted as deny-all", () => {
  const config = validConfig() as { firewall: { allow: unknown[] } };
  config.firewall.allow = [];
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.firewall.allow.length, 0);
});

test("an absent allow field is rejected fail-closed (not defaulted)", () => {
  const config = { interfaces: [{ name: "eth0", kind: "ethernet" }], firewall: {} };
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.path === "firewall/allow"));
  }
});

test("missing required top-level fields are rejected", () => {
  for (const missing of ["interfaces", "firewall"]) {
    const config = validConfig() as Record<string, unknown>;
    delete config[missing];
    const result = validateNetworkConfig(config);
    assert.equal(result.ok, false, `missing ${missing} must reject`);
  }
});

test("malformed interface name and kind are rejected with paths", () => {
  const config = validConfig() as { interfaces: { name: string; kind: string }[] };
  config.interfaces[0]!.name = "Eth 0!";
  config.interfaces[1]!.kind = "quantum";
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.path === "interfaces/0/name"));
    assert.ok(result.errors.some((e) => e.path === "interfaces/1/kind"));
  }
});

test("duplicate interface names are rejected", () => {
  const config = validConfig() as { interfaces: { name: string; kind: string }[] };
  config.interfaces[1] = { name: "eth0", kind: "bridge" };
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, false);
});

test("bad protocol, port, and CIDR are rejected", () => {
  const bad = [
    { protocol: "icmp", port: 443, sourceCidr: "10.0.0.0/8" },
    { protocol: "tcp", port: 0, sourceCidr: "10.0.0.0/8" },
    { protocol: "tcp", port: 70000, sourceCidr: "10.0.0.0/8" },
    { protocol: "tcp", port: 443, sourceCidr: "10.0.0.0/33" },
    { protocol: "tcp", port: 443, sourceCidr: "256.0.0.1/8" },
    { protocol: "tcp", port: 443, sourceCidr: "not-a-cidr" },
  ];
  for (const rule of bad) {
    const config = validConfig() as { firewall: { allow: unknown[] } };
    config.firewall.allow = [rule];
    const result = validateNetworkConfig(config);
    assert.equal(result.ok, false, `${JSON.stringify(rule)} must reject`);
  }
});

test("a valid IPv6 CIDR is accepted", () => {
  const config = validConfig() as { firewall: { allow: unknown[] } };
  config.firewall.allow = [{ protocol: "tcp", port: 443, sourceCidr: "fd00::/8" }];
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, true);
});

test("an implicit wide-open rule is rejected unless unsafeWideOpen", () => {
  const wide = validConfig() as { firewall: { allow: unknown[]; unsafeWideOpen?: boolean } };
  wide.firewall.allow = [{ protocol: "tcp", port: 443, sourceCidr: "0.0.0.0/0" }];
  assert.equal(validateNetworkConfig(wide).ok, false);

  const allowed = validConfig() as { firewall: { allow: unknown[]; unsafeWideOpen?: boolean } };
  allowed.firewall.allow = [{ protocol: "tcp", port: 443, sourceCidr: "0.0.0.0/0" }];
  allowed.firewall.unsafeWideOpen = true;
  assert.equal(validateNetworkConfig(allowed).ok, true);
});

test("unknown fields are rejected", () => {
  const config = validConfig() as Record<string, unknown>;
  config.extra = "nope";
  const result = validateNetworkConfig(config);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.path === "extra"));
});

test("hostile and partial untrusted inputs fail closed without throwing", () => {
  const cyclic: Record<string, unknown> = { interfaces: [] };
  cyclic.self = cyclic;
  for (const input of [undefined, null, 42, "x", [], {}, cyclic]) {
    const result = validateNetworkConfig(input);
    assert.equal(result.ok, false);
  }
});

test("an array with a method-shadowed length is rejected, never trusted", () => {
  const hostile = { interfaces: { length: 1, 0: { name: "eth0", kind: "ethernet" } }, firewall: { allow: [] } };
  const result = validateNetworkConfig(hostile as unknown);
  assert.equal(result.ok, false);
});

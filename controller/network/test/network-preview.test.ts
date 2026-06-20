import assert from "node:assert/strict";
import { test } from "node:test";

import { previewNetworkChange } from "../src/network-preview.ts";

function validConfig(): unknown {
  return {
    firewall: {
      allow: [
        { port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" },
        { port: 53, protocol: "udp", sourceCidr: "192.168.1.0/24" },
      ],
    },
    interfaces: [
      { kind: "ethernet", name: "eth0" },
      { kind: "loopback", name: "lo" },
    ],
  };
}

test("identical configs produce an empty diff without widening inbound", () => {
  const preview = previewNetworkChange(validConfig(), validConfig());

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.wideningInbound, false);
  assert.deepEqual(preview.rejections, []);
  assert.deepEqual(preview.diff, {
    firewall: {
      added: [],
      removed: [],
    },
    interfaces: {
      added: [],
      modified: [],
      removed: [],
    },
  });
});

test("an added allow rule is diffed and marks inbound widening", () => {
  const desired = validConfig() as {
    firewall: {
      allow: { port: number; protocol: string; sourceCidr: string }[];
    };
  };
  const addedRule = { port: 8443, protocol: "tcp", sourceCidr: "10.1.0.0/16" };
  desired.firewall.allow[desired.firewall.allow.length] = addedRule;

  const preview = previewNetworkChange(validConfig(), desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.wideningInbound, true);
  assert.deepEqual(preview.diff.firewall.added, [addedRule]);
  assert.deepEqual(preview.diff.firewall.removed, []);
});

test("removed rules and changed interfaces are classified", () => {
  const current = validConfig() as {
    firewall: {
      allow: { port: number; protocol: string; sourceCidr: string }[];
    };
  };
  current.firewall.allow[current.firewall.allow.length] = {
    port: 22,
    protocol: "tcp",
    sourceCidr: "10.2.0.0/16",
  };

  const desired = validConfig() as {
    interfaces: { kind: string; name: string }[];
  };
  desired.interfaces[0] = { kind: "bridge", name: "eth0" };

  const preview = previewNetworkChange(current, desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.wideningInbound, false);
  assert.deepEqual(preview.diff.firewall.added, []);
  assert.deepEqual(preview.diff.firewall.removed, [
    { port: 22, protocol: "tcp", sourceCidr: "10.2.0.0/16" },
  ]);
  assert.deepEqual(preview.diff.interfaces.modified, [
    {
      current: { kind: "ethernet", name: "eth0" },
      desired: { kind: "bridge", name: "eth0" },
      name: "eth0",
    },
  ]);
});

test("invalid current or desired configs return typed rejections with no diff", () => {
  const invalidCurrent = {
    firewall: {
      allow: [],
    },
    interfaces: [],
  };
  const invalidDesired = {
    firewall: {},
    interfaces: [{ kind: "ethernet", name: "eth0" }],
  };

  for (const [current, desired, side] of [
    [invalidCurrent, validConfig(), "current"],
    [validConfig(), invalidDesired, "desired"],
  ] as const) {
    const preview = previewNetworkChange(current, desired);

    assert.equal(preview.valid, false);

    if (preview.valid) {
      assert.fail("expected invalid preview");
    }

    assert.equal(preview.diff, undefined);
    assert.equal(preview.wideningInbound, false);
    assert.ok(preview.rejections.length > 0);
    assert.ok(preview.rejections.every((rejection) => rejection.side === side));
  }
});

test("hostile inputs fail closed without throwing", () => {
  const current = validConfig();
  const desired: Record<string, unknown> = {
    firewall: {
      allow: [],
    },
  };

  Object.defineProperty(desired, "interfaces", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape preview");
    },
  });

  assert.doesNotThrow(() => previewNetworkChange(current, desired));

  const preview = previewNetworkChange(current, desired);

  assert.equal(preview.valid, false);

  if (preview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.equal(preview.diff, undefined);
  assert.equal(preview.wideningInbound, false);
  assert.ok(preview.rejections.some((rejection) => rejection.side === "desired"));
});

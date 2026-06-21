import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchNodeSnapshot } from "../src/snapshot-client.ts";
import type {
  FetchNodeSnapshotResult,
  SnapshotTransport,
  SnapshotTransportResponse,
} from "../src/snapshot-client.ts";

test("200 with a valid capabilities envelope splits configs and sorts names", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(200, {
      capabilities: {
        "system.timezone": { value: "UTC" },
        "system.hostname": { value: "node-1" },
        "network.firewall": { enabled: true, rules: ["allow-22"] },
      },
    }),
  );

  const ok = assertOk(result);
  assert.deepEqual(ok.capabilityNames, [
    "network.firewall",
    "system.hostname",
    "system.timezone",
  ]);
  assert.deepEqual(ok.configs["system.hostname"], { value: "node-1" });
  assert.deepEqual(ok.configs["network.firewall"], {
    enabled: true,
    rules: ["allow-22"],
  });
  assert.deepEqual(Object.keys(ok.errors), []);
});

test("a capability whose entry is { error } is surfaced in errors, not configs", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(200, {
      capabilities: {
        "system.hostname": { value: "node-1" },
        "storage.pool": { error: { code: "READ_FAILED", message: "disk busy" } },
      },
    }),
  );

  const ok = assertOk(result);
  assert.deepEqual(ok.capabilityNames, ["storage.pool", "system.hostname"]);
  // The errored capability is NOT carried as a config.
  assert.equal("storage.pool" in ok.configs, false);
  assert.deepEqual(ok.configs["system.hostname"], { value: "node-1" });
  // The error payload is carried as plain data.
  assert.deepEqual(ok.errors["storage.pool"], {
    error: { code: "READ_FAILED", message: "disk busy" },
  });
});

test("an empty capabilities map is a valid, empty snapshot", async () => {
  const result = await fetchNodeSnapshot(transportOf(200, { capabilities: {} }));

  const ok = assertOk(result);
  assert.deepEqual(ok.capabilityNames, []);
  assert.deepEqual(Object.keys(ok.configs), []);
  assert.deepEqual(Object.keys(ok.errors), []);
});

test("config and error entries are split independently within one snapshot", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(200, {
      capabilities: {
        b: { ok: true },
        a: { error: "boom" },
        c: { error: null },
        d: { nested: { deep: [1, 2, 3] } },
      },
    }),
  );

  const ok = assertOk(result);
  assert.deepEqual(ok.capabilityNames, ["a", "b", "c", "d"]);
  assert.deepEqual(Object.keys(ok.configs).sort(), ["b", "d"]);
  assert.deepEqual(Object.keys(ok.errors).sort(), ["a", "c"]);
  assert.deepEqual(ok.errors["a"], { error: "boom" });
  assert.deepEqual(ok.errors["c"], { error: null });
  assert.deepEqual(ok.configs["d"], { nested: { deep: [1, 2, 3] } });
});

test("an entry that has error alongside other keys is treated as a config, not an error", async () => {
  // `{ error: ... }` is only a read-error when error is the SOLE key. A config
  // that happens to carry an `error` field plus other data is carried through.
  const result = await fetchNodeSnapshot(
    transportOf(200, {
      capabilities: {
        "app.thing": { error: "noted", value: 7 },
      },
    }),
  );

  const ok = assertOk(result);
  assert.deepEqual(Object.keys(ok.errors), []);
  assert.deepEqual(ok.configs["app.thing"], { error: "noted", value: 7 });
});

test("status 503 maps to state_unavailable", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(503, { capabilities: {} }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "state_unavailable");
  assert.equal(rejection.status, 503);
});

test("a non-200, non-503 status is an unexpected_status rejection", async () => {
  const result = await fetchNodeSnapshot(transportOf(500, { error: "boom" }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "unexpected_status");
  assert.equal(rejection.status, 500);
});

test("a 404 is rejected without inspecting the body", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(404, { capabilities: "ignored" }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "unexpected_status");
  assert.equal(rejection.status, 404);
});

test("a transport that throws synchronously maps to transport_error", async () => {
  const transport: SnapshotTransport = () => {
    throw new Error("connection refused");
  };
  const result = await fetchNodeSnapshot(transport);

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "transport_error");
});

test("a transport that rejects asynchronously maps to transport_error", async () => {
  const transport: SnapshotTransport = async () => {
    await Promise.resolve();
    throw new Error("socket hang up");
  };
  const result = await fetchNodeSnapshot(transport);

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "transport_error");
});

test("a non-object body fails closed", async () => {
  const result = await fetchNodeSnapshot(transportOf(200, "not-json-object"));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a bare scalar body (number) fails closed", async () => {
  const result = await fetchNodeSnapshot(transportOf(200, 42));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a body missing capabilities fails closed", async () => {
  const result = await fetchNodeSnapshot(transportOf(200, { other: true }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  assert.equal(
    (rejection.rejections ?? []).some((entry) => entry.path === "capabilities"),
    true,
  );
});

test("a non-object capabilities field fails closed", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(200, { capabilities: ["system.hostname"] }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("an unknown top-level envelope key fails closed", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(200, { capabilities: {}, extra: "nope" }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  assert.equal(
    (rejection.rejections ?? []).some((entry) => entry.path === "extra"),
    true,
  );
});

test("a config value carrying a hostile accessor is never invoked (external counter stays 0)", async () => {
  // External-counter probe: a getter on a config value. If the client ever reads
  // it, the counter moves off 0. safeNormalize rejects the accessor descriptor
  // BEFORE any field is read, so the body fails closed and the getter never fires.
  let getterReads = 0;
  const hostileConfig: Record<string, unknown> = {};
  Object.defineProperty(hostileConfig, "secret", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return "leaked";
    },
  });

  const result = await fetchNodeSnapshot(
    transportOf(200, { capabilities: { "system.hostname": hostileConfig } }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  // The accessor was NEVER invoked: the body is rejected on shape, not read.
  assert.equal(getterReads, 0);
});

test("a hostile accessor directly on a capabilities entry never fires (counter stays 0)", async () => {
  let getterReads = 0;
  const capabilities: Record<string, unknown> = {};
  Object.defineProperty(capabilities, "system.hostname", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return { value: "node-1" };
    },
  });

  const result = await fetchNodeSnapshot(
    transportOf(200, { capabilities }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  assert.equal(getterReads, 0);
});

test("a Proxy body fails closed", async () => {
  const proxyBody = new Proxy(
    { capabilities: { "system.hostname": { value: "node-1" } } },
    {
      get(target, key, receiver) {
        return Reflect.get(target, key, receiver);
      },
    },
  );

  const result = await fetchNodeSnapshot(transportOf(200, proxyBody));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a cyclic body fails closed without throwing", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  let result: FetchNodeSnapshotResult | undefined;
  await assert.doesNotReject(async () => {
    result = await fetchNodeSnapshot(transportOf(200, { capabilities: cyclic }));
  });

  if (result === undefined) {
    assert.fail("expected a result");
  }
  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a non-integer status fails closed", async () => {
  const result = await fetchNodeSnapshot(
    transportOf(Number.NaN, { capabilities: {} }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("fetchNodeSnapshot never throws on a hostile capabilities map shape", async () => {
  const capabilities: Record<string, unknown> = {
    "system.hostname": { value: "node-1" },
  };
  // Shadow a method to prove the client never calls a method off the untrusted map.
  Object.defineProperty(capabilities, "hasOwnProperty", {
    enumerable: true,
    value() {
      throw new Error("shadowed method must not be invoked");
    },
  });

  let result: FetchNodeSnapshotResult | undefined;
  await assert.doesNotReject(async () => {
    result = await fetchNodeSnapshot(transportOf(200, { capabilities }));
  });

  if (result === undefined) {
    assert.fail("expected a result");
  }
  // safeNormalize rejects the method-bearing shape (function value), so the
  // snapshot fails closed — the shadowed method is never invoked.
  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

function transportOf(status: number, body: unknown): SnapshotTransport {
  const response: SnapshotTransportResponse = { status, body };
  return async () => {
    await Promise.resolve();
    return response;
  };
}

function assertOk(
  result: FetchNodeSnapshotResult,
): Extract<FetchNodeSnapshotResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(`expected ok snapshot: ${JSON.stringify(result)}`);
  }

  return result;
}

function assertRejected(
  result: FetchNodeSnapshotResult,
): Extract<FetchNodeSnapshotResult, { readonly ok: false }> {
  if (result.ok) {
    assert.fail(`expected rejected snapshot: ${JSON.stringify(result)}`);
  }

  return result;
}

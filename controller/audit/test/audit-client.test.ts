import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchAuditTrail } from "../src/audit-client.ts";
import type {
  AuditTransport,
  AuditTransportResponse,
  FetchAuditTrailResult,
} from "../src/audit-client.ts";
import { summarizeAuditLog } from "../src/audit-viewer.ts";

test("200 with a valid monotonic envelope returns the events, not tampered", async () => {
  const events = [
    event({ sequence: 1, outcome: "committed" }),
    event({ sequence: 2, outcome: "rejected" }),
    event({ sequence: 3, outcome: "failed" }),
  ];
  const result = await fetchAuditTrail(transportOf(200, { events }));

  const ok = assertOk(result);
  assert.equal(ok.tampered, false);
  assert.equal(ok.events.length, 3);
  assert.deepEqual(
    ok.events.map((entry) => entry.sequence),
    [1, 2, 3],
  );
});

test("the returned events feed summarizeAuditLog (P2-021) directly", async () => {
  const events = [
    event({ sequence: 1, outcome: "committed", actorKind: "human" }),
    event({ sequence: 2, outcome: "failed", actorKind: "agent" }),
  ];
  const result = await fetchAuditTrail(transportOf(200, { events }));
  const ok = assertOk(result);

  const summary = summarizeAuditLog(ok.events);
  assert.equal(summary.ok, true);
  if (summary.ok) {
    assert.equal(summary.monotonic, true);
    assert.equal(summary.totalsByOutcome.committed, 1);
    assert.equal(summary.totalsByOutcome.failed, 1);
  }
});

test("an empty events array is a valid, non-tampered trail", async () => {
  const result = await fetchAuditTrail(transportOf(200, { events: [] }));
  const ok = assertOk(result);

  assert.equal(ok.tampered, false);
  assert.equal(ok.events.length, 0);
});

test("status 503 maps to audit_unavailable", async () => {
  const result = await fetchAuditTrail(transportOf(503, { events: [] }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "audit_unavailable");
});

test("a non-200, non-503 status is an unexpected_status rejection", async () => {
  const result = await fetchAuditTrail(transportOf(500, { error: "boom" }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "unexpected_status");
  assert.equal(rejection.status, 500);
});

test("a 404 is rejected without inspecting the body", async () => {
  const result = await fetchAuditTrail(transportOf(404, { events: "ignored" }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "unexpected_status");
  assert.equal(rejection.status, 404);
});

test("a transport that throws synchronously maps to transport_error", async () => {
  const transport: AuditTransport = () => {
    throw new Error("connection refused");
  };
  const result = await fetchAuditTrail(transport);

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "transport_error");
});

test("a transport that rejects asynchronously maps to transport_error", async () => {
  const transport: AuditTransport = async () => {
    await Promise.resolve();
    throw new Error("socket hang up");
  };
  const result = await fetchAuditTrail(transport);

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "transport_error");
});

test("any invalid event fails the whole trail with no partial trail", async () => {
  const invalid = mutableEvent({ sequence: 2 });
  invalid.outcome = "succeeded"; // not a valid AuditOutcome
  delete invalid.actor;

  const result = await fetchAuditTrail(
    transportOf(200, {
      events: [event({ sequence: 1 }), invalid, event({ sequence: 3 })],
    }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_event");
  assert.equal(rejection.rejections !== undefined, true);
  assert.equal((rejection.rejections ?? []).length > 0, true);
  // No partial trail is leaked on the rejection.
  assert.equal("events" in rejection, false);
  // Paths are anchored to the offending event index.
  for (const entry of rejection.rejections ?? []) {
    assert.match(entry.path, /^events\/1(\/|$)/u);
  }
});

test("non-monotonic events are returned but flagged tampered without reordering", async () => {
  const events = [
    event({ sequence: 3, outcome: "committed" }),
    event({ sequence: 1, outcome: "failed" }),
    event({ sequence: 2, outcome: "rolled_back" }),
  ];
  const result = await fetchAuditTrail(transportOf(200, { events }));

  const ok = assertOk(result);
  assert.equal(ok.tampered, true);
  // Original order is preserved exactly — tamper evidence, never silent repair.
  assert.deepEqual(
    ok.events.map((entry) => entry.sequence),
    [3, 1, 2],
  );
});

test("duplicate sequence numbers are non-monotonic and flagged tampered", async () => {
  const events = [
    event({ sequence: 1 }),
    event({ sequence: 1 }),
  ];
  const result = await fetchAuditTrail(transportOf(200, { events }));

  const ok = assertOk(result);
  assert.equal(ok.tampered, true);
  assert.equal(ok.events.length, 2);
});

test("a non-object body fails closed", async () => {
  const result = await fetchAuditTrail(transportOf(200, "not-json-object"));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a bare scalar body (number) fails closed", async () => {
  const result = await fetchAuditTrail(transportOf(200, 42));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a missing events field fails closed", async () => {
  const result = await fetchAuditTrail(transportOf(200, { other: true }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a non-array events field fails closed", async () => {
  const result = await fetchAuditTrail(transportOf(200, { events: { "0": event({ sequence: 1 }) } }));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("an unknown envelope key fails closed", async () => {
  const result = await fetchAuditTrail(
    transportOf(200, { events: [event({ sequence: 1 })], extra: "nope" }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  assert.equal(
    (rejection.rejections ?? []).some((entry) => entry.path === "extra"),
    true,
  );
});

test("hostile body with an accessor property fails closed without firing the getter (external counter stays 0)", async () => {
  let getterReads = 0;
  const hostileBody: Record<string, unknown> = {};
  Object.defineProperty(hostileBody, "events", {
    configurable: true,
    enumerable: true,
    get() {
      // External-counter probe: if safeNormalize ever invokes this getter the
      // counter moves off 0. We do NOT assert.fail here (a catch could swallow
      // it); we prove accessor-safety with the external counter below.
      getterReads += 1;
      return [event({ sequence: 1 })];
    },
  });

  const result = await fetchAuditTrail(transportOf(200, hostileBody));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  // The accessor was never invoked: the body is rejected on shape, not read.
  assert.equal(getterReads, 0);
});

test("a hostile nested accessor inside events fails closed without firing the getter", async () => {
  let getterReads = 0;
  const hostileEvent: Record<string, unknown> = { sequence: 1 };
  Object.defineProperty(hostileEvent, "outcome", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return "committed";
    },
  });

  const result = await fetchAuditTrail(
    transportOf(200, { events: [hostileEvent] }),
  );

  // safeNormalize walks the whole body and rejects the accessor descriptor on
  // the nested event BEFORE any event is read, so this is an invalid_response
  // (envelope-level) rejection — and the getter is never invoked.
  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
  assert.equal(getterReads, 0);
});

test("a Proxy body fails closed", async () => {
  const proxyBody = new Proxy(
    { events: [event({ sequence: 1 })] },
    {
      get(target, key, receiver) {
        return Reflect.get(target, key, receiver);
      },
    },
  );

  const result = await fetchAuditTrail(transportOf(200, proxyBody));

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a cyclic body fails closed without throwing", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  let result: FetchAuditTrailResult | undefined;
  await assert.doesNotReject(async () => {
    result = await fetchAuditTrail(transportOf(200, cyclic));
  });

  if (result === undefined) {
    assert.fail("expected a result");
  }
  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("a non-integer status fails closed", async () => {
  const result = await fetchAuditTrail(
    transportOf(Number.NaN, { events: [] }),
  );

  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

test("fetchAuditTrail never throws on a hostile event array shape", async () => {
  const events: unknown[] = [event({ sequence: 1 })];
  Object.defineProperty(events, "map", {
    enumerable: true,
    value() {
      throw new Error("shadowed method must not be invoked");
    },
  });

  let result: FetchAuditTrailResult | undefined;
  await assert.doesNotReject(async () => {
    result = await fetchAuditTrail(transportOf(200, { events }));
  });

  if (result === undefined) {
    assert.fail("expected a result");
  }
  // safeNormalize rejects the method-shadowed array shape.
  const rejection = assertRejected(result);
  assert.equal(rejection.reason, "invalid_response");
});

function transportOf(status: number, body: unknown): AuditTransport {
  const response: AuditTransportResponse = { status, body };
  return async () => {
    await Promise.resolve();
    return response;
  };
}

function assertOk(
  result: FetchAuditTrailResult,
): Extract<FetchAuditTrailResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(`expected ok audit trail: ${JSON.stringify(result)}`);
  }

  return result;
}

function assertRejected(
  result: FetchAuditTrailResult,
): Extract<FetchAuditTrailResult, { readonly ok: false }> {
  if (result.ok) {
    assert.fail(`expected rejected audit trail: ${JSON.stringify(result)}`);
  }

  return result;
}

interface MutableAuditActorRef extends Record<string, unknown> {
  id?: string;
  kind?: "human" | "agent" | "system";
}

interface MutableAuditEvent extends Record<string, unknown> {
  actor?: MutableAuditActorRef;
  capability?: string;
  operation?: "apply" | "read";
  outcome?: "committed" | "rejected" | "rolled_back" | "failed" | "succeeded";
  reason?: string;
  sequence?: number;
  timestampMillis?: number;
}

function event(overrides: {
  readonly sequence?: number;
  readonly outcome?: "committed" | "rejected" | "rolled_back" | "failed";
  readonly actorKind?: "human" | "agent" | "system";
}): MutableAuditEvent {
  const sequence = overrides.sequence ?? 1;
  const actorKind = overrides.actorKind ?? "agent";

  return {
    actor: {
      id: `${actorKind}:fixture`,
      kind: actorKind,
    },
    capability: "system.hostname",
    operation: "apply",
    outcome: overrides.outcome ?? "committed",
    reason: "fixture event",
    sequence,
    timestampMillis: 1_717_171_717_000 + sequence,
  };
}

function mutableEvent(overrides: {
  readonly sequence?: number;
  readonly outcome?: "committed" | "rejected" | "rolled_back" | "failed";
  readonly actorKind?: "human" | "agent" | "system";
}): MutableAuditEvent {
  return event(overrides);
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { runOperatorSession } from "../src/operator-session.ts";
import type {
  OperatorSessionResult,
  OperatorSessionTransport,
  OperatorSessionTransportResponse,
} from "../src/operator-session.ts";
import type { AuditEvent } from "../../../sdk/typescript/src/audit-event-model.ts";
import type { NodeChangeSet } from "../../../sdk/typescript/src/node-changeset-model.ts";
import type { NodeHealth } from "../../../sdk/typescript/src/node-health-model.ts";

test("happy path composes snapshot, audit, health, operations report, and preview", async () => {
  const calls: string[] = [];
  const result = await runOperatorSession(
    validTransport(calls),
    currentChangeSet(),
    desiredChangeSet(),
  );

  const session = assertSessionOk(result);

  assert.deepEqual(calls, ["/state", "/audit", "/health"]);
  assert.deepEqual(session.snapshot.capabilityNames, [
    "node.config",
    "services",
  ]);
  assert.deepEqual(session.snapshot.configs["node.config"], {
    managed: true,
  });
  assert.equal(session.auditSummary.monotonic, true);
  assert.equal(session.auditSummary.totalsByOutcome.committed, 1);
  assert.equal(session.auditSummary.totalsByOutcome.rejected, 1);
  assert.equal(session.operationsReport.verdict, "ok");
  assert.equal(session.operationsReport.health.ok, true);
  assert.equal(session.operationsReport.audit.ok, true);
  assert.equal(session.changePreview.subsystems.services?.kind, "changed");
  assert.equal(session.changePreview.summary.newlyEnabledServices, 1);
});

test("audit 503 short-circuits at the audit stage without reading health", async () => {
  const calls: string[] = [];
  const result = await runOperatorSession(
    transportOf(
      [
        route("/state", 200, validStateBody()),
        route("/audit", 503, { error: "audit unavailable" }),
        route("/health", 200, healthyReport()),
      ],
      calls,
    ),
    currentChangeSet(),
    desiredChangeSet(),
  );

  const rejection = assertSessionRejected(result);

  assert.equal(rejection.stage, "audit");
  assert.equal(rejection.reason, "audit_unavailable");
  assert.deepEqual(calls, ["/state", "/audit"]);
});

test("invalid desired change-set fails closed at preview after prior stages pass", async () => {
  const result = await runOperatorSession(
    validTransport(),
    currentChangeSet(),
    {
      services: {
        services: [{ name: "ssh.service" }],
      },
    },
  );

  const rejection = assertSessionRejected(result);

  assert.equal(rejection.stage, "preview");
  assert.equal(rejection.reason, "preview_rejected");
});

test("transport exceptions at any GET become typed session failures", async () => {
  const throwingImmediately: OperatorSessionTransport = async () => {
    throw new Error("loopback refused");
  };
  const throwingOnHealth: OperatorSessionTransport = async (path) => {
    if (path === "/health") {
      throw new Error("health refused");
    }

    if (path === "/state") {
      return {
        body: validStateBody(),
        status: 200,
      };
    }

    return {
      body: {
        events: auditEvents(),
      },
      status: 200,
    };
  };

  let snapshotFailure: OperatorSessionResult | undefined;
  let healthFailure: OperatorSessionResult | undefined;

  await assert.doesNotReject(async () => {
    snapshotFailure = await runOperatorSession(
      throwingImmediately,
      currentChangeSet(),
      desiredChangeSet(),
    );
  });
  await assert.doesNotReject(async () => {
    healthFailure = await runOperatorSession(
      throwingOnHealth,
      currentChangeSet(),
      desiredChangeSet(),
    );
  });

  if (snapshotFailure === undefined || healthFailure === undefined) {
    assert.fail("expected session results");
  }

  const snapshotRejection = assertSessionRejected(snapshotFailure);
  const healthRejection = assertSessionRejected(healthFailure);

  assert.equal(snapshotRejection.stage, "snapshot");
  assert.equal(snapshotRejection.reason, "transport_error");
  assert.equal(healthRejection.stage, "health");
  assert.equal(healthRejection.reason, "transport_error");
});

test("session does not throw for malformed health or hostile change-set inputs", async () => {
  const hostileDesired: Record<string, unknown> = {
    services: {
      services: [],
    },
  };
  let getterReads = 0;

  Object.defineProperty(hostileDesired, "accounts", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("desired accessor must not be invoked");
    },
  });

  await assert.doesNotReject(async () => {
    const result = await runOperatorSession(
      transportOf([
        route("/state", 200, validStateBody()),
        route("/audit", 200, { events: auditEvents() }),
        route("/health", 200, { healthy: true }),
      ]),
      currentChangeSet(),
      desiredChangeSet(),
    );
    const rejection = assertSessionRejected(result);

    assert.equal(rejection.stage, "health");
    assert.equal(rejection.reason, "health_summary_rejected");
  });

  await assert.doesNotReject(async () => {
    const result = await runOperatorSession(
      validTransport(),
      currentChangeSet(),
      hostileDesired,
    );
    const rejection = assertSessionRejected(result);

    assert.equal(rejection.stage, "preview");
    assert.equal(rejection.reason, "preview_rejected");
  });

  assert.equal(getterReads, 0);
});

function validTransport(calls?: string[]): OperatorSessionTransport {
  return transportOf(
    [
      route("/state", 200, validStateBody()),
      route("/audit", 200, { events: auditEvents() }),
      route("/health", 200, healthyReport()),
    ],
    calls,
  );
}

function transportOf(
  routes: readonly Route[],
  calls?: string[],
): OperatorSessionTransport {
  return async (path) => {
    if (calls !== undefined) {
      calls[calls.length] = path;
    }

    await Promise.resolve();

    for (let index = 0; index < routes.length; index += 1) {
      const item = routes[index];

      if (item !== undefined && item.path === path) {
        return item.response;
      }
    }

    return {
      body: { error: "not found" },
      status: 404,
    };
  };
}

function route(path: string, status: number, body: unknown): Route {
  return {
    path,
    response: {
      body,
      status,
    },
  };
}

function validStateBody(): unknown {
  return {
    capabilities: {
      "node.config": {
        managed: true,
      },
      services: {
        count: 1,
      },
    },
  };
}

function auditEvents(): readonly AuditEvent[] {
  return [
    event({ outcome: "committed", sequence: 1 }),
    event({ outcome: "rejected", sequence: 2 }),
  ];
}

function event(
  overrides: {
    readonly outcome?: AuditEvent["outcome"];
    readonly sequence?: number;
  } = {},
): AuditEvent {
  const sequence = overrides.sequence ?? 1;

  return {
    actor: {
      id: "agent:fixture",
      kind: "agent",
    },
    capability: "system.hostname",
    operation: "apply",
    outcome: overrides.outcome ?? "committed",
    reason: "fixture event",
    sequence,
    timestampMillis: 1_717_171_717_000 + sequence,
  };
}

function healthyReport(): NodeHealth {
  return {
    capabilities: [
      {
        name: "storage.disk",
        status: "healthy",
      },
      {
        name: "updates",
        status: "healthy",
      },
    ],
    cpu: {
      total: 100,
      used: 37,
    },
    healthy: true,
    memory: {
      total: 32_768,
      used: 12_288,
    },
    storage: {
      total: 1_099_511_627_776,
      used: 274_877_906_944,
    },
    uptimeSeconds: 86_400,
  };
}

function currentChangeSet(): NodeChangeSet {
  return {
    services: {
      services: [
        {
          enabled: false,
          name: "ssh.service",
        },
      ],
    },
  };
}

function desiredChangeSet(): NodeChangeSet {
  return {
    services: {
      services: [
        {
          enabled: true,
          name: "ssh.service",
        },
      ],
    },
  };
}

function assertSessionOk(
  result: OperatorSessionResult,
): Extract<OperatorSessionResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(`expected successful session: ${JSON.stringify(result)}`);
  }

  return result;
}

function assertSessionRejected(
  result: OperatorSessionResult,
): Extract<OperatorSessionResult, { readonly ok: false }> {
  if (result.ok) {
    assert.fail(`expected rejected session: ${JSON.stringify(result)}`);
  }

  return result;
}

interface Route {
  readonly path: string;
  readonly response: OperatorSessionTransportResponse;
}

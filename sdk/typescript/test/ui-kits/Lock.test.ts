import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";
import type {
  LockAuthenticateRequest,
  LockAuthPort,
  LockAuthSession,
  LockUser,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";

const UNLOCKED_USER = Object.freeze({
  displayName: "Vita Owner",
  id: "vita-owner",
  initials: "VO",
}) satisfies LockUser;

test("lock view-model starts locked with deterministic user and clock display", () => {
  const calls: LockAuthenticateRequest[] = [];
  const model = createLockViewModel({
    auth: acceptingAuth(calls),
  });

  const first = model.snapshot();
  const second = model.snapshot();

  assert.equal(first, second);
  assert.equal(first.lockState, "locked");
  assert.deepEqual(first.user, {
    displayName: "Vita User",
    id: "vita-user",
    initials: "V",
  });
  assert.equal(first.clock.date, "Tuesday, June 25");
  assert.equal(first.clock.time, "10:24");
  assert.equal(first.attemptCount, 0);
  assert.equal(first.remainingAttempts, 5);
  assert.equal(first.canSubmit, true);
  assert.equal(first.error, undefined);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(calls, []);
});

test("tick updates only the injected clock and rejects invalid times without mutation", () => {
  const model = createLockViewModel({
    auth: acceptingAuth([]),
  });

  const ticked = model.tick(Date.UTC(2026, 0, 1, 5, 7, 0));

  assert.equal(ticked.ok, true);
  assert.equal(ticked.state.clock.date, "Thursday, January 1");
  assert.equal(ticked.state.clock.time, "05:07");
  assert.equal(ticked.state.lockState, "locked");
  assert.equal(ticked.state.attemptCount, 0);

  const before = model.snapshot();
  const invalid = model.tick(Number.NaN);

  assert.equal(invalid.ok, false);
  if (invalid.ok) {
    assert.fail("expected invalid clock tick to fail closed");
  }
  assert.equal(invalid.error.code, "INVALID_TIME");
  assert.equal(invalid.state, before);
  assert.equal(model.snapshot(), before);
});

test("submit authenticates through the injected port and never echoes the raw credential", async () => {
  const calls: LockAuthenticateRequest[] = [];
  const model = createLockViewModel({
    auth: acceptingAuth(calls, authenticatedSession(UNLOCKED_USER)),
  });
  const secret = "secret-passphrase-032";

  const unlocked = await model.submit(secret);

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) {
    assert.fail("expected submit to unlock");
  }
  assert.deepEqual(calls, [
    {
      attemptNumber: 1,
      credential: secret,
      userId: "vita-user",
    },
  ]);
  assert.equal(unlocked.state.lockState, "unlocked");
  assert.deepEqual(unlocked.state.user, UNLOCKED_USER);
  assert.equal(unlocked.state.error, undefined);
  assert.equal(JSON.stringify(unlocked).includes(secret), false);
  assert.equal(JSON.stringify(model.snapshot()).includes(secret), false);

  const second = await model.submit("another-secret");

  assert.equal(second.ok, false);
  if (second.ok) {
    assert.fail("expected unlocked submit to fail closed");
  }
  assert.equal(second.error.code, "ALREADY_UNLOCKED");
  assert.equal(calls.length, 1);
});

test("rejected credentials increment attempts and stop calling the port after the limit", async () => {
  const calls: LockAuthenticateRequest[] = [];
  const secret = "raw-credential-that-must-not-echo";
  const model = createLockViewModel({
    auth: rejectingAuth(calls, secret),
    maxAttempts: 2,
  });

  const first = await model.submit(secret);

  assert.equal(first.ok, false);
  if (first.ok) {
    assert.fail("expected rejected credential to fail closed");
  }
  assert.equal(first.error.code, "AUTHENTICATION_REJECTED");
  assert.equal(first.state.attemptCount, 1);
  assert.equal(first.state.remainingAttempts, 1);
  assert.equal(first.state.canSubmit, true);
  assert.equal(JSON.stringify(first).includes(secret), false);

  const second = await model.submit(secret);

  assert.equal(second.ok, false);
  if (second.ok) {
    assert.fail("expected second rejected credential to fail closed");
  }
  assert.equal(second.error.code, "AUTHENTICATION_REJECTED");
  assert.equal(second.state.attemptCount, 2);
  assert.equal(second.state.remainingAttempts, 0);
  assert.equal(second.state.canSubmit, false);
  assert.deepEqual(calls.map((request) => request.attemptNumber), [1, 2]);

  const limited = await model.submit(secret);

  assert.equal(limited.ok, false);
  if (limited.ok) {
    assert.fail("expected rate-limited submit to fail closed");
  }
  assert.equal(limited.error.code, "RATE_LIMITED");
  assert.equal(limited.state.attemptCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(limited).includes(secret), false);
});

test("submit fails closed for invalid credentials, missing auth ports, thrown ports, and malformed results", async () => {
  const invalidCalls: LockAuthenticateRequest[] = [];
  const invalidModel = createLockViewModel({
    auth: acceptingAuth(invalidCalls),
  });

  const invalid = await invalidModel.submit("");

  assert.equal(invalid.ok, false);
  if (invalid.ok) {
    assert.fail("expected empty credential to fail closed");
  }
  assert.equal(invalid.error.code, "INVALID_CREDENTIAL");
  assert.equal(invalid.state.attemptCount, 1);
  assert.deepEqual(invalidCalls, []);

  const missingPort = createLockViewModel();
  const unavailable = await missingPort.submit("credential");

  assert.equal(unavailable.ok, false);
  if (unavailable.ok) {
    assert.fail("expected missing auth port to fail closed");
  }
  assert.equal(unavailable.error.code, "AUTH_PORT_UNAVAILABLE");
  assert.equal(unavailable.state.attemptCount, 0);

  const thrown = await createLockViewModel({
    auth: throwingAuth(),
  }).submit("credential");

  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail("expected throwing auth port to fail closed");
  }
  assert.equal(thrown.error.code, "AUTH_PORT_FAILED");
  assert.equal(thrown.state.lockState, "locked");
  assert.equal(thrown.state.attemptCount, 1);

  const malformed = await createLockViewModel({
    auth: malformedAuth(),
  }).submit("credential");

  assert.equal(malformed.ok, false);
  if (malformed.ok) {
    assert.fail("expected malformed auth result to fail closed");
  }
  assert.equal(malformed.error.code, "AUTH_PORT_MALFORMED");
  assert.equal(malformed.state.lockState, "locked");
  assert.equal(malformed.state.attemptCount, 1);
});

test("auth result normalization rejects accessor properties without reading them", async () => {
  let getterReads = 0;
  const hostileResult: Record<string, unknown> = {
    ok: true,
  };

  Object.defineProperty(hostileResult, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return authenticatedSession(UNLOCKED_USER);
    },
  });

  const model = createLockViewModel({
    auth: Object.freeze({
      authenticate(): unknown {
        return hostileResult;
      },
    }),
  });

  const rejected = await model.submit("credential");

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected accessor result to fail closed");
  }
  assert.equal(rejected.error.code, "AUTH_PORT_MALFORMED");
  assert.equal(getterReads, 0);
  assert.equal(model.state.lockState, "locked");
});

test("cancel aborts an in-flight authentication and ignores the late port result", async () => {
  const calls: LockAuthenticateRequest[] = [];
  const pending = pendingAuth(calls);
  const model = createLockViewModel({
    auth: pending.auth,
  });

  const submitted = model.submit("credential");

  assert.equal(model.state.lockState, "authenticating");
  assert.equal(model.state.canSubmit, false);
  assert.equal(calls.length, 1);

  const cancelled = model.cancel();

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state.lockState, "locked");
  assert.equal(cancelled.state.attemptCount, 0);
  assert.equal(cancelled.state.error, undefined);

  pending.resolve({
    ok: true,
    value: authenticatedSession(UNLOCKED_USER),
  });

  const completed = await submitted;

  assert.equal(completed.ok, false);
  if (completed.ok) {
    assert.fail("expected cancelled authentication to fail closed");
  }
  assert.equal(completed.error.code, "AUTHENTICATION_CANCELLED");
  assert.equal(completed.state.lockState, "locked");
  assert.equal(model.state.lockState, "locked");
  assert.deepEqual(model.state.user, {
    displayName: "Vita User",
    id: "vita-user",
    initials: "V",
  });
});

function acceptingAuth(
  calls: LockAuthenticateRequest[],
  session: LockAuthSession = authenticatedSession(UNLOCKED_USER),
): LockAuthPort {
  return Object.freeze({
    authenticate(request: LockAuthenticateRequest): unknown {
      calls.push(request);
      return Object.freeze({
        ok: true,
        value: session,
      });
    },
  });
}

function rejectingAuth(calls: LockAuthenticateRequest[], secretInPortError: string): LockAuthPort {
  return Object.freeze({
    authenticate(request: LockAuthenticateRequest): unknown {
      calls.push(request);
      return Object.freeze({
        error: Object.freeze({
          code: "NO_MATCH",
          message: `credential '${secretInPortError}' was rejected by fake auth`,
          path: "/fake/auth",
        }),
        ok: false,
      });
    },
  });
}

function throwingAuth(): LockAuthPort {
  return Object.freeze({
    authenticate(): unknown {
      throw new Error("fake auth port unavailable");
    },
  });
}

function malformedAuth(): LockAuthPort {
  return Object.freeze({
    authenticate(): unknown {
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          user: Object.freeze({
            displayName: "",
            id: "",
            initials: "",
          }),
        }),
      });
    },
  });
}

function pendingAuth(calls: LockAuthenticateRequest[]): {
  readonly auth: LockAuthPort;
  resolve(value: unknown): void;
} {
  let resolveAuth: ((value: unknown) => void) | undefined;

  return Object.freeze({
    auth: Object.freeze({
      authenticate(request: LockAuthenticateRequest): Promise<unknown> {
        calls.push(request);
        return new Promise<unknown>((resolve) => {
          resolveAuth = resolve;
        });
      },
    }),
    resolve(value: unknown): void {
      if (resolveAuth === undefined) {
        assert.fail("auth request was not started");
      }

      resolveAuth(value);
    },
  });
}

function authenticatedSession(user: LockUser): LockAuthSession {
  return Object.freeze({
    authenticatedAtMs: Date.UTC(2026, 5, 25, 14, 30, 0),
    sessionId: `session:${user.id}`,
    user,
  });
}

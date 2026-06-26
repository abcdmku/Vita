import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionViewModel,
} from "../../../../ui_kits/desktop/viewmodels/session.ts";
import type {
  SessionState,
  SessionViewModel,
  SessionViewModelActionResult,
} from "../../../../ui_kits/desktop/viewmodels/session.ts";
import type {
  LockAuthenticateRequest,
  LockAuthPort,
  LockAuthSession,
  LockUser,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";

const INITIAL_NOW = Date.UTC(2026, 5, 25, 14, 0, 0);
const UNLOCKED_USER = Object.freeze({
  displayName: "Vita Owner",
  id: "vita-owner",
  initials: "VO",
}) satisfies LockUser;

test("session boots from cold-boot into the locked lock surface", () => {
  const model = createSessionViewModel({
    auth: acceptingAuth([]),
    initialNow: INITIAL_NOW,
  });

  const cold = model.snapshot();

  assert.equal(cold.kind, "cold-boot");
  assert.equal(Object.isFrozen(cold), true);

  const booted = model.boot();

  assert.equal(booted.ok, true);
  if (!booted.ok) {
    assert.fail("expected boot to succeed");
  }
  assertFrozenResult(booted);
  assert.equal(booted.transition.action, "boot");
  assert.equal(booted.transition.from, "cold-boot");
  assert.equal(booted.transition.to, "locked");
  assert.equal(booted.transition.reason, "boot");
  assert.equal(booted.state.kind, "locked");
  if (booted.state.kind !== "locked") {
    assert.fail("expected boot to enter locked state");
  }
  assert.equal(booted.state.reason, "boot");
  assert.equal(booted.state.lock.lockState, "locked");
  assert.equal(booted.state.lock.clock.epochMs, INITIAL_NOW);
  assert.equal(model.snapshot(), booted.state);
});

test("submit exposes authenticating immediately and accepted auth unlocks the desktop", async () => {
  const calls: LockAuthenticateRequest[] = [];
  const pending = pendingAuth(calls);
  const model = bootedSession({
    auth: pending.auth,
    initialNow: INITIAL_NOW,
    idleTimeoutMs: 1_000,
  });

  const submitted = model.submit("correct-passphrase");
  const authenticating = model.snapshot();

  assert.equal(authenticating.kind, "authenticating");
  if (authenticating.kind !== "authenticating") {
    assert.fail("expected submit to enter authenticating state");
  }
  assert.equal(Object.isFrozen(authenticating), true);
  assert.equal(authenticating.lock.lockState, "authenticating");
  assert.equal(authenticating.startedAtMs, INITIAL_NOW);
  assert.deepEqual(calls, [
    {
      attemptNumber: 1,
      credential: "correct-passphrase",
      userId: "vita-user",
    },
  ]);

  pending.resolve({
    ok: true,
    value: authenticatedSession(UNLOCKED_USER),
  });

  const unlocked = await submitted;

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) {
    assert.fail("expected accepted auth to unlock");
  }
  assertFrozenResult(unlocked);
  assert.equal(unlocked.transition.action, "submit");
  assert.equal(unlocked.transition.from, "locked");
  assert.equal(unlocked.transition.to, "unlocked");
  assert.equal(unlocked.transition.reason, "auth-accepted");
  assert.equal(unlocked.state.kind, "unlocked");
  if (unlocked.state.kind !== "unlocked") {
    assert.fail("expected accepted auth to unlock");
  }
  assert.deepEqual(unlocked.state.user, UNLOCKED_USER);
  assert.equal(unlocked.state.lock.lockState, "unlocked");
  assert.equal(unlocked.state.unlockedAtMs, INITIAL_NOW);
  assert.equal(unlocked.state.idleDeadlineMs, INITIAL_NOW + 1_000);
  assert.equal(model.snapshot(), unlocked.state);
  assert.equal(JSON.stringify(unlocked).includes("correct-passphrase"), false);
});

test("rejected auth returns to locked, fails closed, and surfaces the lock error", async () => {
  const calls: LockAuthenticateRequest[] = [];
  const model = bootedSession({
    auth: rejectingAuth(calls),
    initialNow: INITIAL_NOW,
  });

  const rejected = await model.submit("wrong-passphrase");

  assert.equal(rejected.ok, false);
  assertFrozenResult(rejected);
  if (rejected.ok) {
    assert.fail("expected rejected auth to fail closed");
  }
  assert.equal(rejected.error.code, "AUTHENTICATION_REJECTED");
  assert.equal(rejected.transition?.action, "submit");
  assert.equal(rejected.transition?.from, "locked");
  assert.equal(rejected.transition?.to, "locked");
  assert.equal(rejected.transition?.reason, "auth-rejected");
  assert.equal(rejected.state.kind, "locked");
  if (rejected.state.kind !== "locked") {
    assert.fail("expected rejected auth to return to locked");
  }
  assert.equal(rejected.state.reason, "auth-rejected");
  assert.equal(rejected.state.lock.lockState, "locked");
  assert.equal(rejected.state.lock.error?.code, "AUTHENTICATION_REJECTED");
  assert.deepEqual(calls.map((call) => call.attemptNumber), [1]);
  assert.equal(model.snapshot(), rejected.state);
});

test("idle tick past the budget re-locks the desktop with idle reason", async () => {
  const model = await unlockedSession({
    auth: acceptingAuth([]),
    idleTimeoutMs: 1_000,
    initialNow: INITIAL_NOW,
  });

  const notYetIdle = model.tick(INITIAL_NOW + 999);

  assert.equal(notYetIdle.ok, true);
  if (!notYetIdle.ok) {
    assert.fail("expected tick before idle budget to succeed");
  }
  assert.equal(notYetIdle.state.kind, "unlocked");
  if (notYetIdle.state.kind !== "unlocked") {
    assert.fail("expected desktop to remain unlocked before idle budget");
  }
  assert.equal(notYetIdle.state.idleDeadlineMs, INITIAL_NOW + 1_000);

  const idle = model.tick(INITIAL_NOW + 1_000);

  assert.equal(idle.ok, true);
  if (!idle.ok) {
    assert.fail("expected idle tick to succeed");
  }
  assertFrozenResult(idle);
  assert.equal(idle.transition.action, "tick");
  assert.equal(idle.transition.from, "unlocked");
  assert.equal(idle.transition.to, "locked");
  assert.equal(idle.transition.reason, "idle");
  assert.equal(idle.state.kind, "locked");
  if (idle.state.kind !== "locked") {
    assert.fail("expected idle tick to re-lock");
  }
  assert.equal(idle.state.reason, "idle");
  assert.equal(idle.state.lock.lockState, "locked");
  assert.equal(idle.state.lock.clock.epochMs, INITIAL_NOW + 1_000);
  assert.deepEqual(idle.state.lock.user, UNLOCKED_USER);
});

test("manual lock while unlocked returns to locked with manual reason", async () => {
  const model = await unlockedSession({
    auth: acceptingAuth([]),
    idleTimeoutMs: 1_000,
    initialNow: INITIAL_NOW,
  });

  const locked = model.lock("manual");

  assert.equal(locked.ok, true);
  if (!locked.ok) {
    assert.fail("expected manual lock to succeed");
  }
  assertFrozenResult(locked);
  assert.equal(locked.transition.action, "lock");
  assert.equal(locked.transition.from, "unlocked");
  assert.equal(locked.transition.to, "locked");
  assert.equal(locked.transition.reason, "manual");
  assert.equal(locked.state.kind, "locked");
  if (locked.state.kind !== "locked") {
    assert.fail("expected manual lock to return locked");
  }
  assert.equal(locked.state.reason, "manual");
  assert.equal(locked.state.lock.lockState, "locked");
  assert.deepEqual(locked.state.lock.user, UNLOCKED_USER);
});

test("requestShutdown records a frozen shutdown intent", async () => {
  const model = await unlockedSession({
    auth: acceptingAuth([]),
    initialNow: INITIAL_NOW,
  });

  const shutdown = model.requestShutdown("logout");

  assert.equal(shutdown.ok, true);
  if (!shutdown.ok) {
    assert.fail("expected shutdown request to succeed");
  }
  assertFrozenResult(shutdown);
  assert.equal(shutdown.transition.action, "requestShutdown");
  assert.equal(shutdown.transition.from, "unlocked");
  assert.equal(shutdown.transition.to, "shutdown");
  assert.equal(shutdown.transition.reason, "logout");
  assert.equal(shutdown.state.kind, "shutdown");
  if (shutdown.state.kind !== "shutdown") {
    assert.fail("expected shutdown intent");
  }
  assert.equal(shutdown.state.reason, "logout");
  assert.equal(shutdown.state.previousKind, "unlocked");
  assert.equal(shutdown.state.requestedAtMs, INITIAL_NOW);
  assert.equal(Object.isFrozen(shutdown.state), true);
});

test("session actions fail closed for out-of-order and malformed inputs without mutation", async () => {
  const model = await unlockedSession({
    auth: acceptingAuth([]),
    initialNow: INITIAL_NOW,
  });

  const unlocked = model.snapshot();
  const outOfOrder = await model.submit("second-passphrase");

  assert.equal(outOfOrder.ok, false);
  assertFrozenResult(outOfOrder);
  if (outOfOrder.ok) {
    assert.fail("expected submit while unlocked to fail closed");
  }
  assert.equal(outOfOrder.error.code, "ALREADY_UNLOCKED");
  assert.equal(outOfOrder.state, unlocked);
  assert.equal(model.snapshot(), unlocked);

  const badTick = model.tick(Number.NaN);

  assert.equal(badTick.ok, false);
  assertFrozenResult(badTick);
  if (badTick.ok) {
    assert.fail("expected bad tick to fail closed");
  }
  assert.equal(badTick.error.code, "INVALID_TIME");
  assert.equal(badTick.state, unlocked);
  assert.equal(model.snapshot(), unlocked);

  const badLock = model.lock("automatic");

  assert.equal(badLock.ok, false);
  if (badLock.ok) {
    assert.fail("expected malformed lock reason to fail closed");
  }
  assert.equal(badLock.error.code, "INVALID_LOCK_REASON");
  assert.equal(badLock.state, unlocked);
  assert.equal(model.snapshot(), unlocked);

  const badShutdown = model.requestShutdown("");

  assert.equal(badShutdown.ok, false);
  if (badShutdown.ok) {
    assert.fail("expected malformed shutdown reason to fail closed");
  }
  assert.equal(badShutdown.error.code, "INVALID_SHUTDOWN_REASON");
  assert.equal(badShutdown.state, unlocked);
  assert.equal(model.snapshot(), unlocked);
});

test("identical inputs produce byte-stable deterministic session results", async () => {
  const first = await deterministicTrace();
  const second = await deterministicTrace();

  assert.equal(first, second);
});

function bootedSession(options: {
  readonly auth: LockAuthPort;
  readonly idleTimeoutMs?: number;
  readonly initialNow?: number;
}): SessionViewModel {
  const model = createSessionViewModel(options);
  const booted = model.boot();

  assert.equal(booted.ok, true);
  if (!booted.ok) {
    assert.fail("expected boot to succeed");
  }

  return model;
}

async function unlockedSession(options: {
  readonly auth: LockAuthPort;
  readonly idleTimeoutMs?: number;
  readonly initialNow?: number;
}): Promise<SessionViewModel> {
  const model = bootedSession(options);
  const unlocked = await model.submit("correct-passphrase");

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) {
    assert.fail("expected unlock to succeed");
  }
  assert.equal(unlocked.state.kind, "unlocked");

  return model;
}

async function deterministicTrace(): Promise<string> {
  const calls: LockAuthenticateRequest[] = [];
  const model = bootedSession({
    auth: acceptingAuth(calls),
    idleTimeoutMs: 10_000,
    initialNow: INITIAL_NOW,
  });
  const unlocked = await model.submit("same-passphrase");
  const ticked = model.tick(INITIAL_NOW + 123);
  const locked = model.lock("manual");

  return JSON.stringify(Object.freeze({
    calls,
    locked,
    ticked,
    unlocked,
  }));
}

function assertFrozenResult(result: SessionViewModelActionResult): void {
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.state), true);
  if (result.transition !== undefined) {
    assert.equal(Object.isFrozen(result.transition), true);
  }
  if (!result.ok) {
    assert.equal(Object.isFrozen(result.error), true);
  }
  assertFrozenState(result.state);
}

function assertFrozenState(state: SessionState): void {
  switch (state.kind) {
    case "cold-boot":
    case "shutdown":
      assert.equal(Object.isFrozen(state), true);
      break;
    case "locked":
    case "authenticating":
    case "unlocked":
      assert.equal(Object.isFrozen(state), true);
      assert.equal(Object.isFrozen(state.lock), true);
      assert.equal(Object.isFrozen(state.lock.clock), true);
      assert.equal(Object.isFrozen(state.lock.user), true);
      break;
  }
}

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

function rejectingAuth(calls: LockAuthenticateRequest[]): LockAuthPort {
  return Object.freeze({
    authenticate(request: LockAuthenticateRequest): unknown {
      calls.push(request);
      return Object.freeze({
        error: Object.freeze({
          code: "NO_MATCH",
          message: "credential rejected by fake auth",
          path: "/fake/auth",
        }),
        ok: false,
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
    authenticatedAtMs: INITIAL_NOW,
    sessionId: `session:${user.id}`,
    user,
  });
}

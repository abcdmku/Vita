import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createIdleLockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/idle-lock.ts";
import type {
  IdleLockActionResult,
  IdleLockHostPort,
  IdleLockSessionPort,
  IdleLockState,
} from "../../../../ui_kits/desktop/viewmodels/idle-lock.ts";
import type {
  SessionLockReason,
  SessionStateKind,
} from "../../../../ui_kits/desktop/viewmodels/session.ts";

const IDLE_BUDGET_MS = 1_000;

test("activity while unlocked resets remaining idle budget", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  const before = controller.tick(250);

  assert.equal(before.ok, true);
  assert.equal(before.state.remainingMs, 750);
  assert.equal(before.state.armed, true);

  const active = controller.activity(500);

  assert.equal(active.ok, true);
  assertFrozenResult(active);
  assert.equal(active.transition?.action, "activity");
  assert.equal(active.transition?.from, "unlocked");
  assert.equal(active.transition?.to, "unlocked");
  assert.equal(active.transition?.reason, "activity");
  assert.deepEqual(active.state, {
    armed: true,
    idleBudgetMs: IDLE_BUDGET_MS,
    lastActivityMs: 500,
    remainingMs: IDLE_BUDGET_MS,
  });
  assert.equal(harness.unmountCount(), 0);
  assert.deepEqual(harness.lockReasons, []);
});

test("idle tick crossing the budget locks idle and unmounts exactly once", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(100).ok, true);

  const idle = controller.tick(1_100);

  assert.equal(idle.ok, true);
  assertFrozenResult(idle);
  assert.equal(idle.transition?.action, "tick");
  assert.equal(idle.transition?.from, "unlocked");
  assert.equal(idle.transition?.to, "locked");
  assert.equal(idle.transition?.reason, "idle");
  assert.deepEqual(harness.lockReasons, ["idle"]);
  assert.equal(harness.kind(), "locked");
  assert.equal(harness.unmountCount(), 1);
  assert.equal(idle.state.armed, false);
  assert.equal(idle.state.remainingMs, 0);

  const secondTick = controller.tick(1_200);

  assert.equal(secondTick.ok, true);
  assert.deepEqual(harness.lockReasons, ["idle"]);
  assert.equal(harness.unmountCount(), 1);
});

test("tick before the budget elapses leaves the unlocked session mounted", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(100).ok, true);

  const ticked = controller.tick(1_099);

  assert.equal(ticked.ok, true);
  assertFrozenResult(ticked);
  assert.equal(ticked.transition, undefined);
  assert.deepEqual(ticked.state, {
    armed: true,
    idleBudgetMs: IDLE_BUDGET_MS,
    lastActivityMs: 100,
    remainingMs: 1,
  });
  assert.equal(harness.kind(), "unlocked");
  assert.deepEqual(harness.lockReasons, []);
  assert.equal(harness.unmountCount(), 0);
});

test("manual lock command locks immediately and unmounts once regardless of remaining budget", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(10_000).ok, true);

  const locked = controller.lockCommand();

  assert.equal(locked.ok, true);
  assertFrozenResult(locked);
  assert.equal(locked.transition?.action, "lockCommand");
  assert.equal(locked.transition?.from, "unlocked");
  assert.equal(locked.transition?.to, "locked");
  assert.equal(locked.transition?.reason, "manual");
  assert.deepEqual(harness.lockReasons, ["manual"]);
  assert.equal(harness.unmountCount(), 1);
  assert.equal(locked.state.armed, false);
  assert.equal(locked.state.remainingMs, 0);
});

test("activity tick and manual lock are inert while the session is not unlocked", () => {
  for (const kind of ["cold-boot", "locked", "authenticating", "shutdown"] as const) {
    const harness = idleLockHarness(kind);
    const controller = createIdleLockViewModel({
      host: harness.host,
      idleBudgetMs: IDLE_BUDGET_MS,
      session: harness.session,
    });

    const activity = controller.activity(100);
    const ticked = controller.tick(1_000);
    const locked = controller.lockCommand();

    assert.equal(activity.ok, true);
    assert.equal(ticked.ok, true);
    assert.equal(locked.ok, true);
    assert.equal(activity.transition, undefined);
    assert.equal(ticked.transition, undefined);
    assert.equal(locked.transition, undefined);
    assert.equal(activity.state.armed, false);
    assert.equal(ticked.state.armed, false);
    assert.equal(locked.state.armed, false);
    assert.deepEqual(harness.lockReasons, []);
    assert.equal(harness.unmountCount(), 0);
  }
});

test("dispose unmounts once and is idempotent", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(100).ok, true);

  const first = controller.dispose();
  const second = controller.dispose();

  assert.equal(first.ok, true);
  assertFrozenResult(first);
  assert.equal(first.transition?.action, "dispose");
  assert.equal(first.transition?.reason, "dispose");
  assert.equal(second.ok, true);
  assertFrozenResult(second);
  assert.equal(second.transition, undefined);
  assert.equal(harness.unmountCount(), 1);
  assert.equal(first.state.armed, false);
  assert.equal(second.state.armed, false);

  const activeAfterDispose = controller.activity(200);
  const tickAfterDispose = controller.tick(1_200);
  const lockAfterDispose = controller.lockCommand();

  assert.equal(activeAfterDispose.ok, true);
  assert.equal(tickAfterDispose.ok, true);
  assert.equal(lockAfterDispose.ok, true);
  assert.deepEqual(harness.lockReasons, []);
  assert.equal(harness.unmountCount(), 1);
});

test("dispose after a re-lock does not double-unmount", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(0).ok, true);

  const idle = controller.tick(IDLE_BUDGET_MS);
  const disposed = controller.dispose();

  assert.equal(idle.ok, true);
  assert.equal(disposed.ok, true);
  assert.equal(disposed.transition, undefined);
  assert.deepEqual(harness.lockReasons, ["idle"]);
  assert.equal(harness.unmountCount(), 1);
});

test("malformed now values fail closed without mutation", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(controller.activity(500).ok, true);
  const before = controller.snapshot();

  for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "500"]) {
    const rejected = controller.tick(badNow);

    assert.equal(rejected.ok, false);
    assertFrozenResult(rejected);
    if (rejected.ok) {
      assert.fail("expected malformed time to fail closed");
    }
    assert.equal(rejected.error.code, "INVALID_TIME");
    assert.equal(rejected.state, before);
    assert.equal(controller.snapshot(), before);
  }

  const regressedActivity = controller.activity(499);

  assert.equal(regressedActivity.ok, false);
  if (regressedActivity.ok) {
    assert.fail("expected regressed activity time to fail closed");
  }
  assert.equal(regressedActivity.error.code, "TIME_REGRESSED");
  assert.equal(regressedActivity.state, before);
  assert.equal(controller.snapshot(), before);
  assert.deepEqual(harness.lockReasons, []);
  assert.equal(harness.unmountCount(), 0);
});

test("snapshots and action results are frozen", () => {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  assert.equal(Object.isFrozen(controller.snapshot()), true);

  const active = controller.activity(100);
  const ticked = controller.tick(150);
  const locked = controller.lockCommand();

  assertFrozenResult(active);
  assertFrozenResult(ticked);
  assertFrozenResult(locked);
  assert.equal(Object.isFrozen(controller.snapshot()), true);
});

test("identical input sequences produce byte-stable deterministic output", () => {
  const first = deterministicTrace();
  const second = deterministicTrace();

  assert.equal(first, second);
});

interface IdleLockHarness {
  readonly host: IdleLockHostPort;
  readonly session: IdleLockSessionPort;
  readonly lockReasons: SessionLockReason[];
  kind(): SessionStateKind;
  unmountCount(): number;
}

function idleLockHarness(initialKind: SessionStateKind): IdleLockHarness {
  let kind = initialKind;
  let unmounts = 0;
  const lockReasons: SessionLockReason[] = [];
  const session: IdleLockSessionPort = Object.freeze({
    get kind() {
      return kind;
    },
    lock(reason: SessionLockReason) {
      lockReasons.push(reason);
      kind = "locked";

      return Object.freeze({
        ok: true,
        transition: Object.freeze({
          action: "lock",
          from: "unlocked",
          reason,
          to: "locked",
        }),
      });
    },
  });
  const host: IdleLockHostPort = Object.freeze({
    unmount(): void {
      unmounts += 1;
    },
  });

  return Object.freeze({
    host,
    kind: () => kind,
    lockReasons,
    session,
    unmountCount: () => unmounts,
  });
}

function deterministicTrace(): string {
  const harness = idleLockHarness("unlocked");
  const controller = createIdleLockViewModel({
    host: harness.host,
    idleBudgetMs: IDLE_BUDGET_MS,
    session: harness.session,
  });

  const initial = controller.snapshot();
  const active = controller.activity(100);
  const ticked = controller.tick(300);
  const locked = controller.lockCommand();
  const disposed = controller.dispose();

  return JSON.stringify(Object.freeze({
    disposed,
    initial,
    locked,
    lockReasons: harness.lockReasons,
    ticked,
    unmounts: harness.unmountCount(),
    active,
  }));
}

function assertFrozenResult(result: IdleLockActionResult): void {
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.state), true);
  assertFrozenState(result.state);
  if (result.transition !== undefined) {
    assert.equal(Object.isFrozen(result.transition), true);
  }
  if (!result.ok) {
    assert.equal(Object.isFrozen(result.error), true);
  }
}

function assertFrozenState(state: IdleLockState): void {
  assert.equal(Object.isFrozen(state), true);
}

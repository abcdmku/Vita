// REGRESSION: the privileged compat capabilities (control / exec / meta) MUST be DISTINCT under the
// PRODUCTION broker permission model. The pre-fix model mapped control/exec/meta to the IDENTICAL broker
// tuple { class: configuration, access: read-write, scope: apps/<id>/configuration }, so they were
// INTERCHANGEABLE — a control-only app would satisfy an exec or meta request (capability confusion,
// CRITICAL finding). This test drives the REAL `createBrokerPermissionModel` against the REAL
// `DEFAULT_SHELL_APPS` grants and proves each app holds EXACTLY its privileged plane and is DENIED the
// other two.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-cap-separation.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAppGrantRegistry,
  createBrokerPermissionModel,
} from "../../../../ui_kits/desktop/runtime/puter/permission-model.ts";
import type { PuterCapability, PermissionDecisionInput } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import {
  DEFAULT_SHELL_APPS,
  findShellApp,
} from "../../../../ui_kits/desktop/runtime/puter/shell/app-registry.ts";

// The three privileged planes the finding is about.
const PRIVILEGED: readonly PuterCapability[] = ["control", "exec", "meta"];

// Build the production broker model seeded from the REAL shell catalog grants (the same grants the
// service declares for each app at boot). This is the PRODUCTION enforcement path, not a stub.
function modelFromShellCatalog(): ReturnType<typeof createBrokerPermissionModel> {
  const seed: Record<string, readonly PuterCapability[]> = {};

  for (const app of DEFAULT_SHELL_APPS) seed[app.id] = app.grants;

  const grants = createAppGrantRegistry(seed);

  return createBrokerPermissionModel({ grants });
}

function decideFor(
  model: ReturnType<typeof createBrokerPermissionModel>,
  appId: string,
  capability: PuterCapability,
): boolean {
  const input: PermissionDecisionInput = {
    appId,
    appInstanceId: "inst",
    capability,
    // The broker model ignores declaredGrants and consults its own per-app policy keyed by appId, but
    // the field is required by the interface — pass the empty set to prove it is NOT what is consulted.
    declaredGrants: new Set<PuterCapability>(),
  };

  return model.decide(input);
}

// Assert exactly ONE of the three privileged planes is allowed for `appId`, and the other two denied.
function assertExactlyOnePrivileged(appId: string, allowed: PuterCapability): void {
  const model = modelFromShellCatalog();

  for (const cap of PRIVILEGED) {
    const got = decideFor(model, appId, cap);
    const want = cap === allowed;

    assert.equal(
      got,
      want,
      `${appId}: capability '${cap}' should be ${want ? "ALLOWED" : "DENIED"} (only '${allowed}' is held), got ${got}`,
    );
  }
}

test("cap-separation: the shell catalog actually distributes the privileged caps as expected (sanity)", () => {
  // Guard against the catalog drifting out from under the regression: the three privileged apps must
  // each hold exactly their one privileged cap, and the third-party apps must hold none.
  const term = findShellApp([...DEFAULT_SHELL_APPS], "vita.app.terminal");
  const pkg = findShellApp([...DEFAULT_SHELL_APPS], "vita.app.package-manager");
  const console_ = findShellApp([...DEFAULT_SHELL_APPS], "vita.app.deploy-console");

  assert.ok(term && pkg && console_, "the three privileged shell apps must exist in the catalog");
  assert.ok(term.grants.includes("exec") && !term.grants.includes("control") && !term.grants.includes("meta"));
  assert.ok(pkg.grants.includes("meta") && !pkg.grants.includes("control") && !pkg.grants.includes("exec"));
  assert.ok(console_.grants.includes("control") && !console_.grants.includes("exec") && !console_.grants.includes("meta"));
});

test("cap-separation: Terminal holds exec ONLY — control and meta are DENIED", () => {
  assertExactlyOnePrivileged("vita.app.terminal", "exec");
});

test("cap-separation: Package Manager holds meta ONLY — control and exec are DENIED", () => {
  assertExactlyOnePrivileged("vita.app.package-manager", "meta");
});

test("cap-separation: Deploy Console holds control ONLY — exec and meta are DENIED", () => {
  assertExactlyOnePrivileged("vita.app.deploy-console", "control");
});

test("cap-separation: an ordinary app (no privileged grant) is DENIED control, exec AND meta", () => {
  const model = modelFromShellCatalog();

  // The third-party todo app holds fs/kv/ui/auth but NONE of the privileged planes.
  for (const cap of PRIVILEGED) {
    assert.equal(
      decideFor(model, "com.puter-apps.serverless-todo", cap),
      false,
      `ordinary app must be denied privileged capability '${cap}'`,
    );
  }

  // An app the registry never declared is denied everything (fail-closed).
  for (const cap of PRIVILEGED) {
    assert.equal(decideFor(model, "totally.unknown.app", cap), false, `unknown app must be denied '${cap}'`);
  }
});

test("cap-separation: a control-only app cannot exercise exec or meta even though all three share the configuration class", () => {
  // The HEART of the finding: with control/exec/meta all in the `configuration` class, the ONLY thing
  // keeping them apart is the DISTINCT broker scope. Declare an app with control alone and prove it
  // cannot reach the other two planes.
  const grants = createAppGrantRegistry({ "app.controller": ["control", "auth"] });
  const model = createBrokerPermissionModel({ grants });
  const mk = (capability: PuterCapability): PermissionDecisionInput => ({
    appId: "app.controller",
    appInstanceId: "i",
    capability,
    declaredGrants: new Set<PuterCapability>(),
  });

  assert.equal(model.decide(mk("control")), true, "control-only app may use control");
  assert.equal(model.decide(mk("exec")), false, "control-only app must NOT use exec");
  assert.equal(model.decide(mk("meta")), false, "control-only app must NOT use meta");
  // And its ordinary auth still works (separation does not break the non-privileged caps).
  assert.equal(model.decide(mk("auth")), true, "auth still allowed");
});

test("cap-separation: exec-only and meta-only apps are likewise confined to their own plane", () => {
  const execGrants = createAppGrantRegistry({ "app.exec": ["exec", "auth"] });
  const execModel = createBrokerPermissionModel({ grants: execGrants });
  const meta = createAppGrantRegistry({ "app.meta": ["meta", "auth"] });
  const metaModel = createBrokerPermissionModel({ grants: meta });
  const mk = (appId: string, capability: PuterCapability): PermissionDecisionInput => ({
    appId,
    appInstanceId: "i",
    capability,
    declaredGrants: new Set<PuterCapability>(),
  });

  assert.equal(execModel.decide(mk("app.exec", "exec")), true);
  assert.equal(execModel.decide(mk("app.exec", "control")), false);
  assert.equal(execModel.decide(mk("app.exec", "meta")), false);

  assert.equal(metaModel.decide(mk("app.meta", "meta")), true);
  assert.equal(metaModel.decide(mk("app.meta", "control")), false);
  assert.equal(metaModel.decide(mk("app.meta", "exec")), false);
});

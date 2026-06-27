// Owner-identity wiring (§16) — the LIVE owner-auth path consults the node's REAL owner identity,
// not a hardcoded default. Proves:
//   - startPuterPlatformService({ ownerIdentity }) makes /whoami answer as the configured owner
//     (the live owner-auth source flows end-to-end through the shared registry → api_origin).
//   - With NO ownerIdentity, /whoami falls back to the trust-on-host default "owner" (backward compat).
//   - The registry validates the identity fail-closed: a malformed identity refuses to mint a session,
//     and a per-mint owner.uuid override that names a DIFFERENT owner is rejected (no identity forgery).
//   - The owner identity is NEVER taken from request content — only from the host-supplied config.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-owner-identity.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createCapabilityRegistry,
  type PuterOwner,
} from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import {
  startPuterPlatformService,
} from "../../../../ui_kits/desktop/runtime/puter/server/service.ts";

const REAL_OWNER: PuterOwner = Object.freeze({
  emailConfirmed: true,
  username: "lewis",
  uuid: "vita-owner-7f3a-0001",
});

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("LIVE /whoami answers as the configured node owner identity (not the hardcoded default)", async () => {
  const root = freshDir("vita-owner-id-");
  const svc = await startPuterPlatformService({
    appsRoot: root,
    faces: { localHost: "127.0.0.1" },
    mode: "local-desktop",
    ownerIdentity: REAL_OWNER,
    storeAppId: "vita.kiosk",
  });

  try {
    const app = svc.mintApp({ appId: "vita.kiosk", grants: ["auth"], instanceId: "boot-id-test" });
    const who = await fetch(`${svc.localUrl}/api/whoami`, { headers: { authorization: `Bearer ${app.token}` } });

    assert.equal(who.status, 200);
    const body = (await who.json()) as { username?: string; uuid?: string; email_confirmed?: boolean };

    // The live owner-auth path reflects the REAL owner identity, end-to-end.
    assert.equal(body.username, REAL_OWNER.username);
    assert.equal(body.uuid, REAL_OWNER.uuid);
    assert.equal(body.email_confirmed, true);
  } finally {
    await svc.close();
  }
});

test("LIVE /whoami falls back to the trust-on-host default owner when no identity is configured", async () => {
  const root = freshDir("vita-owner-id-default-");
  const svc = await startPuterPlatformService({
    appsRoot: root,
    faces: { localHost: "127.0.0.1" },
    mode: "local-desktop",
    storeAppId: "vita.kiosk",
  });

  try {
    const app = svc.mintApp({ appId: "vita.kiosk", grants: ["auth"], instanceId: "boot-default-test" });
    const who = await fetch(`${svc.localUrl}/api/whoami`, { headers: { authorization: `Bearer ${app.token}` } });

    assert.equal(who.status, 200);
    const body = (await who.json()) as { username?: string };

    assert.equal(body.username, "owner");
  } finally {
    await svc.close();
  }
});

test("the registry validates ownerIdentity fail-closed (malformed identity throws)", () => {
  // Missing uuid.
  assert.throws(() => createCapabilityRegistry({
    ownerIdentity: { emailConfirmed: true, username: "x", uuid: "" } as PuterOwner,
  }), /uuid must be a non-empty string/u);

  // Wrong field type.
  assert.throws(() => createCapabilityRegistry({
    ownerIdentity: { emailConfirmed: true, username: 7, uuid: "id" } as unknown as PuterOwner,
  }), /username must be a non-empty string/u);

  // Unexpected field (strict field set — defeats smuggling extra identity claims).
  assert.throws(() => createCapabilityRegistry({
    ownerIdentity: { emailConfirmed: true, role: "admin", username: "x", uuid: "id" } as unknown as PuterOwner,
  }), /unexpected field/u);

  // Non-plain (prototype-bearing) object.
  assert.throws(() => createCapabilityRegistry({
    ownerIdentity: new Date(0) as unknown as PuterOwner,
  }), /must be a plain object/u);
});

test("a per-mint owner.uuid override that names a DIFFERENT owner is rejected (no identity forgery)", () => {
  const registry = createCapabilityRegistry({ ownerIdentity: REAL_OWNER });

  // A caller cannot smuggle a different owner uuid into a minted session.
  assert.throws(() => registry.mintAppSession({
    appId: "app.evil",
    appInstanceId: "i-evil",
    grants: ["auth"],
    owner: { uuid: "forged-owner-9999" },
  }), /does not match the trusted owner identity/u);

  // A mint with NO override binds to the trusted owner.
  const session = registry.mintAppSession({ appId: "app.ok", appInstanceId: "i-ok", grants: ["auth"] });

  assert.equal(session.owner.uuid, REAL_OWNER.uuid);
  assert.equal(session.owner.username, REAL_OWNER.username);

  // An override that AGREES on uuid (but narrows username) is allowed, still bound to the trusted uuid.
  const narrowed = registry.mintAppSession({
    appId: "app.narrow",
    appInstanceId: "i-narrow",
    grants: ["auth"],
    owner: { uuid: REAL_OWNER.uuid, username: "lewis-display" },
  });

  assert.equal(narrowed.owner.uuid, REAL_OWNER.uuid);
  assert.equal(narrowed.owner.username, "lewis-display");
});

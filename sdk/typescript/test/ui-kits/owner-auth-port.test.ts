import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDesktopHostForPackage,
  createOwnerAuthPort,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopTheme,
  DesktopUiPackageManifest,
  OwnerAuthAgentdCapability,
  OwnerAuthAgentdTransport,
  OwnerAuthAssertion,
  OwnerAuthRequest,
  OwnerAuthSession,
  OwnerAuthUser,
} from "../../src/desktop-sdk/index.ts";
import {
  createLockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";

// The node's single, trusted owner identity. On a real node this is supplied by the
// host from agentd's owner-credential record / node owner config — never from the
// transport request and never from the agentd verify verdict.
const OWNER_USER = Object.freeze({
  displayName: "Vita Owner",
  id: "vita-owner",
  initials: "VO",
}) satisfies OwnerAuthUser;

const FORGED_USER = Object.freeze({
  displayName: "Forged Owner",
  id: "forged-owner",
  initials: "FO",
}) satisfies OwnerAuthUser;

const OWNER_ASSERTION = Object.freeze({
  action: "unlock",
  authenticatorData: "authenticator-data-base64url",
  clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiY2hhbGxlbmdlIiwib3JpZ2luIjoiaHR0cHM6Ly92aXRhLmxvY2FsIn0",
  credentialId: "credential-id-base64url",
  signature: "signature-base64url",
}) satisfies OwnerAuthAssertion;

// VerifyResponse shapes MIRROR the real Go owner verifier
// (agent/capabilities/owner/owner.go, VerifyResponse at lines 242-248):
//   type VerifyResponse struct {
//     Verified bool   `json:"verified"`
//     Action   string `json:"action,omitempty"`
//     Reason   string `json:"reason,omitempty"`
//   }
// There is NO `user` field. On success agentd echoes the asserted action; on a deny it
// may carry a reason. The identity is the node's known owner, not anything in this reply.

test("a real verified VerifyResponse (no user field) yields a session bound to the trusted owner", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const authenticated = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) assert.fail("expected owner auth to succeed against the real VerifyResponse shape");
  // Identity comes from the trusted host source, NOT from the verdict.
  assert.deepEqual(authenticated.value.user, OWNER_USER);
  assert.equal(authenticated.value.sessionId, "owner:vita-owner:unlock");
  assert.deepEqual(agentd.calls, [
    {
      capability: "webauthn.get",
      request: {
        assertion: OWNER_ASSERTION,
      },
    },
  ]);

  const lock = createLockViewModel({
    auth: createOwnerAuthPort(scoped),
    user: OWNER_USER,
  });
  const unlocked = await lock.submit(JSON.stringify(OWNER_ASSERTION));

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) assert.fail("expected Lock view-model to accept owner auth adapter session");
  assert.equal(unlocked.state.lockState, "unlocked");
  assert.deepEqual(unlocked.state.user, OWNER_USER);
  assert.equal(agentd.calls.length, 2);
});

test("a verified VerifyResponse without an action still yields a session bound to the trusted owner", async () => {
  // `action` is omitempty in VerifyResponse; a verified reply with only `verified:true`
  // is well-formed and must authenticate (it must NOT be treated as MALFORMED).
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      verified: true,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const authenticated = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) assert.fail("expected a minimal verified reply to authenticate");
  assert.deepEqual(authenticated.value.user, OWNER_USER);
  assert.equal(authenticated.value.sessionId, "owner:vita-owner");
});

test("a forged `user` in the verify verdict is ignored — session identity is the trusted owner", async () => {
  // A malicious/compromised transport tries to smuggle a forged identity in the reply.
  // The verdict carries no identity in the real protocol, so any extra `user` field
  // makes the reply MALFORMED (strict field set) — it must NOT mint a forged session.
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      user: FORGED_USER,
      verified: true,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const rejected = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected an extra user field in the verdict to fail closed, not forge a session");
  assert.equal(rejected.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");
});

test("the session identity is the host-trusted owner even when the assertion names a different action", async () => {
  // The trusted identity never derives from caller- or transport-supplied data: prove
  // a different configured owner flows through verbatim regardless of the assertion.
  const altOwner = Object.freeze({
    displayName: "Alt Owner",
    id: "alt-owner",
    initials: "AO",
  }) satisfies OwnerAuthUser;
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "approve-transaction",
      verified: true,
    }),
  });
  const scoped = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: altOwner,
  });
  const authenticated = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) assert.fail("expected owner auth to succeed");
  assert.deepEqual(authenticated.value.user, altOwner);
  assert.notEqual(authenticated.value.user.id, FORGED_USER.id);
  assert.equal(authenticated.value.sessionId, "owner:alt-owner:approve-transaction");
});

test("mutating a returned session's user does NOT poison a subsequently-minted session", async () => {
  // The host captures the configured identity once. If sessions returned the captured
  // object by reference, a UI package could reassign `.user.id` on a returned session
  // and every later session would inherit the mutated identity. The returned user must
  // be a frozen snapshot that shares no reference with the host-side identity.
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);

  const first = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(first.ok, true);
  if (!first.ok) assert.fail("expected the first owner auth to succeed");

  // Attempt to tamper with the returned session's identity. Frozen objects throw on
  // assignment in strict mode (ESM is strict); either way the mutation must not take.
  const mutableUser = first.value.user as { id: string; displayName: string };

  try {
    mutableUser.id = FORGED_USER.id;
    mutableUser.displayName = FORGED_USER.displayName;
  } catch {
    // Frozen — assignment threw, which is the desired protection.
  }

  // The returned user must be frozen and unchanged by the tamper attempt.
  assert.equal(Object.isFrozen(first.value.user), true);
  assert.equal(first.value.user.id, OWNER_USER.id);

  // A subsequently-minted session must carry the pristine trusted identity.
  const second = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(second.ok, true);
  if (!second.ok) assert.fail("expected the second owner auth to succeed");
  assert.deepEqual(second.value.user, OWNER_USER);
  assert.equal(second.value.user.id, OWNER_USER.id);
  assert.notEqual(second.value.user.id, FORGED_USER.id);
  assert.equal(second.value.sessionId, "owner:vita-owner:unlock");
});

test("the snapshot does not share a reference with the configured ownerIdentity", async () => {
  // Even mutating the ORIGINAL config object after construction must not change minted
  // sessions — the host deep-clones the identity once at construction.
  const mutableIdentity = {
    displayName: "Vita Owner",
    id: "vita-owner",
    initials: "VO",
  };
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: mutableIdentity,
  });

  mutableIdentity.id = FORGED_USER.id;

  const authenticated = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) assert.fail("expected owner auth to succeed");
  assert.equal(authenticated.value.user.id, "vita-owner");
  assert.notEqual(authenticated.value.user.id, FORGED_USER.id);
});

test("an invalid or non-plain ownerIdentity config is rejected fail-closed", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });

  // Missing/empty id.
  const emptyId = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: Object.freeze({ displayName: "Vita Owner", id: "", initials: "VO" }),
  });
  const emptyIdResult = await callAuthenticateOwner(emptyId, ownerAuthRequest());

  assert.equal(emptyIdResult.ok, false);
  if (emptyIdResult.ok) assert.fail("expected empty owner id to fail closed");
  assert.equal(emptyIdResult.error.code, "OWNER_AUTH_PORT_UNAVAILABLE");
  assert.equal(agentd.calls.length, 0);

  // Wrong field type.
  const wrongType = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: Object.freeze({ displayName: "Vita Owner", id: 7, initials: "VO" }) as unknown as OwnerAuthUser,
  });
  const wrongTypeResult = await callAuthenticateOwner(wrongType, ownerAuthRequest());

  assert.equal(wrongTypeResult.ok, false);
  if (wrongTypeResult.ok) assert.fail("expected non-string owner id to fail closed");
  assert.equal(wrongTypeResult.error.code, "OWNER_AUTH_PORT_UNAVAILABLE");

  // Non-plain (prototype-bearing / exotic) identity object.
  const nonPlain = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: new Date(0) as unknown as OwnerAuthUser,
  });
  const nonPlainResult = await callAuthenticateOwner(nonPlain, ownerAuthRequest());

  assert.equal(nonPlainResult.ok, false);
  if (nonPlainResult.ok) assert.fail("expected non-plain owner identity to fail closed");
  assert.equal(nonPlainResult.error.code, "OWNER_AUTH_PORT_UNAVAILABLE");

  // Extra/unknown field on the identity (strict field set).
  const extraField = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
    ownerIdentity: Object.freeze({
      displayName: "Vita Owner",
      id: "vita-owner",
      initials: "VO",
      role: "admin",
    }) as unknown as OwnerAuthUser,
  });
  const extraFieldResult = await callAuthenticateOwner(extraField, ownerAuthRequest());

  assert.equal(extraFieldResult.ok, false);
  if (extraFieldResult.ok) assert.fail("expected an extra identity field to fail closed");
  assert.equal(extraFieldResult.error.code, "OWNER_AUTH_PORT_UNAVAILABLE");
});

test("a verified:false VerifyResponse fails closed without leaking a session", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      reason: "signature_invalid",
      verified: false,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const rejected = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected owner auth denial");
  assert.equal(rejected.error.code, "AUTHENTICATION_REJECTED");
  assert.equal(Object.hasOwn(rejected, "value"), false);
  assert.equal(agentd.calls.length, 1);
});

test("a verified:false VerifyResponse with no reason still fails closed", async () => {
  // `reason` is omitempty; a bare deny verdict must still reject, never authenticate.
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      verified: false,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const rejected = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected a bare deny verdict to fail closed");
  assert.equal(rejected.error.code, "AUTHENTICATION_REJECTED");
});

test("authenticateOwner fails closed for non-plain or malformed agentd replies", async () => {
  // A reply missing `verified` is malformed against the real VerifyResponse shape.
  const missingVerified = await callAuthenticateOwner(scopedHost(["owner.auth"], agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
    }),
  })), ownerAuthRequest());

  assert.equal(missingVerified.ok, false);
  if (missingVerified.ok) assert.fail("expected a reply missing `verified` to fail closed");
  assert.equal(missingVerified.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");

  // A non-boolean `verified` is malformed.
  const nonBoolVerified = await callAuthenticateOwner(scopedHost(["owner.auth"], agentdStub({
    ok: true,
    value: Object.freeze({
      verified: "true",
    }),
  })), ownerAuthRequest());

  assert.equal(nonBoolVerified.ok, false);
  if (nonBoolVerified.ok) assert.fail("expected a non-boolean verified to fail closed");
  assert.equal(nonBoolVerified.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");

  const nonPlain = await callAuthenticateOwner(scopedHost(["owner.auth"], agentdStub({
    ok: true,
    value: new Date(0),
  })), ownerAuthRequest());

  assert.equal(nonPlain.ok, false);
  if (nonPlain.ok) assert.fail("expected non-plain reply to fail closed");
  assert.equal(nonPlain.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");
});

test("authenticateOwner fails closed when the verdict echoes a non-string action", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: 42,
      verified: true,
    }),
  });
  const rejected = await callAuthenticateOwner(scopedHost(["owner.auth"], agentd), ownerAuthRequest());

  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected a non-string action to fail closed");
  assert.equal(rejected.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");
});

test("authenticateOwner missing owner.auth grant fails closed before invoking agentd", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = scopedHost([], agentd);
  const denied = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail("expected missing owner.auth grant to fail closed");
  assert.equal(denied.error.code, "MISSING_CAPABILITY");
  assert.equal(agentd.calls.length, 0);
});

test("authenticateOwner fails closed when no trusted owner identity is configured", async () => {
  // Without a host-supplied owner identity there is no trusted source for the session,
  // so the node must refuse to authenticate rather than invent one.
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", ["owner.auth"]), {
    ownerAuthAgentd: agentd,
  });
  const denied = await callAuthenticateOwner(scoped, ownerAuthRequest());

  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail("expected missing owner identity to fail closed");
  assert.equal(denied.error.code, "OWNER_AUTH_PORT_UNAVAILABLE");
  assert.equal(agentd.calls.length, 0);
});

test("Lock adapter ignores a forged user inside the submitted credential", async () => {
  const requests: OwnerAuthRequest[] = [];
  const auth = createOwnerAuthPort(Object.freeze({
    authenticateOwner(request: OwnerAuthRequest): DesktopHostResult<OwnerAuthSession> {
      requests.push(request);

      return {
        ok: true,
        value: Object.freeze({
          sessionId: `owner:${OWNER_USER.id}:unlock`,
          user: OWNER_USER,
        }),
      };
    },
  }));
  const lock = createLockViewModel({
    auth,
    user: OWNER_USER,
  });
  const unlocked = await lock.submit(JSON.stringify({
    assertion: OWNER_ASSERTION,
    user: FORGED_USER,
  }));

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) assert.fail("expected forged credential user to be ignored");
  assert.equal(requests.length, 1);

  const request = requests[0];

  if (request === undefined) assert.fail("expected adapter to call authenticateOwner");
  assert.equal(Object.hasOwn(request, "user"), false);
  assert.equal(unlocked.state.user.id, OWNER_USER.id);
  assert.notEqual(unlocked.state.user.id, FORGED_USER.id);
});

test("authenticateOwner rejects a request-side forged user before invoking agentd", async () => {
  const agentd = agentdStub({
    ok: true,
    value: Object.freeze({
      action: "unlock",
      verified: true,
    }),
  });
  const scoped = scopedHost(["owner.auth"], agentd);
  const authenticateOwner = scoped.authenticateOwner;

  if (authenticateOwner === undefined) {
    assert.fail("expected authenticateOwner to be installed on the scoped host");
  }

  const forgedRequest = Object.freeze({
    assertion: OWNER_ASSERTION,
    user: FORGED_USER,
  });
  const rejected = await authenticateOwner(forgedRequest);

  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected request-side user to be rejected");
  assert.equal(rejected.error.code, "UNEXPECTED_FIELD");
  assert.equal(agentd.calls.length, 0);
});

test("Lock adapter normalizes malformed and throwing host results fail closed", async () => {
  const malformedAuth = createOwnerAuthPort(Object.freeze({
    authenticateOwner(): DesktopHostResult<OwnerAuthSession> {
      return JSON.parse("{\"ok\":false}");
    },
  }));
  const malformed = await malformedAuth.authenticate(lockAuthenticateRequest());

  assert.deepEqual(malformed, {
    error: {
      code: "AUTH_PORT_MALFORMED",
      message: "owner authentication port returned malformed result.",
      path: "/auth/result/error",
    },
    ok: false,
  });

  const throwingAuth = createOwnerAuthPort(Object.freeze({
    authenticateOwner(): never {
      throw new Error("host auth failed");
    },
  }));
  const thrown = await throwingAuth.authenticate(lockAuthenticateRequest());

  assert.deepEqual(thrown, {
    error: {
      code: "AUTH_PORT_FAILED",
      message: "owner authentication port failed closed.",
      path: "/auth",
    },
    ok: false,
  });
});

function ownerAuthRequest(): OwnerAuthRequest {
  return Object.freeze({
    assertion: OWNER_ASSERTION,
  });
}

function lockAuthenticateRequest() {
  return Object.freeze({
    attemptNumber: 1,
    credential: JSON.stringify(OWNER_ASSERTION),
    userId: OWNER_USER.id,
  });
}

function scopedHost(
  capabilities: readonly DesktopCapabilityGrant["capability"][],
  ownerAuthAgentd: OwnerAuthAgentdTransport,
): DesktopHost {
  return createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", capabilities), {
    ownerAuthAgentd,
    ownerIdentity: OWNER_USER,
  });
}

function agentdStub(reply: unknown): OwnerAuthAgentdTransport & {
  readonly calls: {
    readonly capability: OwnerAuthAgentdCapability;
    readonly request: unknown;
  }[];
} {
  const calls: {
    capability: OwnerAuthAgentdCapability;
    request: unknown;
  }[] = [];

  return {
    calls,
    call(capability, request): unknown {
      calls.push({
        capability,
        request,
      });

      return reply;
    },
  };
}

async function callAuthenticateOwner(
  host: DesktopHost,
  request: OwnerAuthRequest,
): Promise<DesktopHostResult<OwnerAuthSession>> {
  const authenticateOwner = host.authenticateOwner;

  if (authenticateOwner === undefined) {
    assert.fail("expected authenticateOwner to be installed on the scoped host");
  }

  return await authenticateOwner(request);
}

function fakeHost(): DesktopHost {
  return Object.freeze({
    applyShell(): never {
      throw new Error("applyShell backend should not be used by owner auth tests");
    },
    launchApp(): never {
      throw new Error("launchApp backend should not be used by owner auth tests");
    },
    package: manifest("host", []),
    postNotification(): never {
      throw new Error("postNotification backend should not be used by owner auth tests");
    },
    previewShell(): never {
      throw new Error("previewShell backend should not be used by owner auth tests");
    },
    readTheme() {
      return desktopTheme();
    },
    registerComponent(): never {
      throw new Error("registerComponent backend should not be used by owner auth tests");
    },
    registerTrayItem(): never {
      throw new Error("registerTrayItem backend should not be used by owner auth tests");
    },
    rollbackShell(): never {
      throw new Error("rollbackShell backend should not be used by owner auth tests");
    },
    stopApp(): never {
      throw new Error("stopApp backend should not be used by owner auth tests");
    },
  });
}

function manifest(id: string, capabilities: readonly DesktopCapabilityGrant["capability"][]): DesktopUiPackageManifest {
  const grants: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];

    if (capability !== undefined) {
      grants.push(Object.freeze({
        capability,
      }));
    }
  }

  return Object.freeze({
    capabilityGrants: Object.freeze(grants),
    entry: "index.html",
    id,
    sdkVersion: "0.0.0",
    version: "1.0.0",
  });
}

function desktopTheme(): DesktopTheme {
  return Object.freeze({
    id: "vita.test.theme",
    tokens: Object.freeze({
      colors: Object.freeze({
        background: "#101418",
      }),
      radii: Object.freeze({
        sm: 4,
      }),
      spacing: Object.freeze({
        sm: 8,
      }),
      typography: Object.freeze({
        body: "system-ui",
      }),
    }),
    version: "1.0.0",
  });
}

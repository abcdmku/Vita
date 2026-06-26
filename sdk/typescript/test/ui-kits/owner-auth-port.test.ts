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

const OWNER_USER = Object.freeze({
  displayName: "Vita Owner",
  id: "vita-owner",
  initials: "VO",
}) satisfies OwnerAuthUser;

const OWNER_ASSERTION = Object.freeze({
  action: "unlock",
  authenticatorData: "authenticator-data-base64url",
  clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiY2hhbGxlbmdlIiwib3JpZ2luIjoiaHR0cHM6Ly92aXRhLmxvY2FsIn0",
  credentialId: "credential-id-base64url",
  signature: "signature-base64url",
}) satisfies OwnerAuthAssertion;

test("authenticateOwner accepts an ok webauthn.get verdict and the Lock adapter yields a session", async () => {
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
  if (!authenticated.ok) assert.fail("expected owner auth to succeed");
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
    auth: createOwnerAuthPort(scoped, {
      user: OWNER_USER,
    }),
    user: OWNER_USER,
  });
  const unlocked = await lock.submit(JSON.stringify(OWNER_ASSERTION));

  assert.equal(unlocked.ok, true);
  if (!unlocked.ok) assert.fail("expected Lock view-model to accept owner auth adapter session");
  assert.equal(unlocked.state.lockState, "unlocked");
  assert.deepEqual(unlocked.state.user, OWNER_USER);
  assert.equal(agentd.calls.length, 2);
});

test("authenticateOwner rejects a deny webauthn.get verdict without leaking a session", async () => {
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

test("authenticateOwner fails closed for non-plain or missing-field agentd replies", async () => {
  const missingField = await callAuthenticateOwner(scopedHost(["owner.auth"], agentdStub({
    ok: true,
    value: Object.freeze({
      verified: true,
    }),
  })), ownerAuthRequest());

  assert.equal(missingField.ok, false);
  if (missingField.ok) assert.fail("expected missing action to fail closed");
  assert.equal(missingField.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");

  const nonPlain = await callAuthenticateOwner(scopedHost(["owner.auth"], agentdStub({
    ok: true,
    value: new Date(0),
  })), ownerAuthRequest());

  assert.equal(nonPlain.ok, false);
  if (nonPlain.ok) assert.fail("expected non-plain reply to fail closed");
  assert.equal(nonPlain.error.code, "MALFORMED_OWNER_AUTH_RESPONSE");
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

function ownerAuthRequest(): OwnerAuthRequest {
  return Object.freeze({
    assertion: OWNER_ASSERTION,
    user: OWNER_USER,
  });
}

function scopedHost(
  capabilities: readonly DesktopCapabilityGrant["capability"][],
  ownerAuthAgentd: OwnerAuthAgentdTransport,
): DesktopHost {
  return createDesktopHostForPackage(fakeHost(), manifest("ui.owner-auth", capabilities), {
    ownerAuthAgentd,
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

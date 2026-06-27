// SECURITY: the opaque session/owner token is a TRUST ANCHOR — it is the bearer the api_origin honors
// and the sole remote-authn secret. `randomOpaqueToken` MUST come from a CSPRNG and MUST HARD-FAIL when
// `crypto.getRandomValues` is absent (the pre-fix code fell back to Date.now()/Math.random(), which is
// predictable and would let an attacker forge a session). This test proves both the happy path (32-byte
// CSPRNG hex) and the fail-closed behavior.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-token-security.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { randomOpaqueToken } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";

test("randomOpaqueToken: returns 64 hex chars (32 CSPRNG bytes) when crypto is available", () => {
  const tok = randomOpaqueToken();

  assert.match(tok, /^[0-9a-f]{64}$/u, "token must be 32 bytes of lowercase hex");

  // Two draws must differ (a constant token would be a catastrophic auth bug).
  assert.notEqual(randomOpaqueToken(), tok);
});

test("randomOpaqueToken: HARD-FAILS (throws) when crypto.getRandomValues is unavailable — no insecure fallback", () => {
  const g = globalThis as { crypto?: { getRandomValues?: unknown } };
  const original = g.crypto;

  try {
    // Simulate a runtime with no WebCrypto. Deleting the global makes g.crypto?.getRandomValues
    // undefined, which the (fixed) implementation must treat as fatal rather than falling back to
    // Date.now()/Math.random().
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });

    assert.throws(
      () => randomOpaqueToken(),
      /crypto\.getRandomValues is unavailable/u,
      "must throw, not return a predictable token",
    );

    // Also cover the case where crypto exists but getRandomValues is not a function.
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    assert.throws(() => randomOpaqueToken(), /crypto\.getRandomValues is unavailable/u);
  } finally {
    // Restore the real crypto global so the rest of the suite is unaffected.
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
  }

  // Sanity: with crypto restored, minting works again.
  assert.match(randomOpaqueToken(), /^[0-9a-f]{64}$/u);
});

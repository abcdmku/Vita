import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateUpdateApplicability } from "../src/update-applicability.ts";
import type {
  UpdateApplicabilityInput,
  UpdateApplicabilityVerdict,
} from "../src/update-applicability.ts";

test("a higher bundle version is an applicable upgrade", () => {
  const input: UpdateApplicabilityInput = {
    currentVersion: "1.2.0",
    bundle: { version: "1.3.0" },
  };
  const verdict = evaluateUpdateApplicability(input);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.kind, "upgrade");
});

test("an equal bundle version is a reinstall and NOT applied (no-op)", () => {
  const input: UpdateApplicabilityInput = {
    currentVersion: "1.2.0",
    bundle: { version: "1.2.0" },
  };
  const verdict = evaluateUpdateApplicability(input);
  assert.equal(verdict.kind, "reinstall");
  assert.equal(verdict.applicable, false);
});

test("a lower bundle version is a downgrade, NOT applicable by default (rollback-protection)", () => {
  const input: UpdateApplicabilityInput = {
    currentVersion: "1.2.0",
    bundle: { version: "1.1.0" },
  };
  const verdict = evaluateUpdateApplicability(input);
  assert.equal(verdict.kind, "downgrade");
  assert.equal(verdict.applicable, false);
});

test("a lower bundle version IS applicable when allowDowngrade is true", () => {
  const input: UpdateApplicabilityInput = {
    currentVersion: "1.2.0",
    bundle: { version: "1.1.0", allowDowngrade: true },
  };
  const verdict = evaluateUpdateApplicability(input);
  assert.equal(verdict.kind, "downgrade");
  assert.equal(verdict.applicable, true);
});

test("allowDowngrade:false keeps the downgrade blocked (explicit default)", () => {
  const input: UpdateApplicabilityInput = {
    currentVersion: "1.2.0",
    bundle: { version: "1.1.0", allowDowngrade: false },
  };
  const verdict = evaluateUpdateApplicability(input);
  assert.equal(verdict.kind, "downgrade");
  assert.equal(verdict.applicable, false);
});

test("allowDowngrade has no effect on a non-downgrade transition (upgrade)", () => {
  const verdict = evaluateUpdateApplicability({
    currentVersion: "1.2.0",
    bundle: { version: "1.5.0", allowDowngrade: true },
  });
  assert.equal(verdict.kind, "upgrade");
  assert.equal(verdict.applicable, true);
});

test("a bundle version inside compatibleRange behaves per the precedence rules", () => {
  const verdict = evaluateUpdateApplicability({
    currentVersion: "1.2.0",
    bundle: { version: "1.5.0", compatibleRange: { min: "1.0.0", max: "2.0.0" } },
  });
  assert.equal(verdict.kind, "upgrade");
  assert.equal(verdict.applicable, true);
});

test("a version OUTSIDE compatibleRange is incompatible even though it is higher", () => {
  // 2.5.0 > current 1.2.0 (would be an upgrade) but it is outside the declared compatible range.
  const verdict = evaluateUpdateApplicability({
    currentVersion: "1.2.0",
    bundle: { version: "2.5.0", compatibleRange: { min: "1.0.0", max: "2.0.0" } },
  });
  assert.equal(verdict.kind, "incompatible");
  assert.equal(verdict.applicable, false);
});

test("the compatibility gate is checked BEFORE the downgrade gate", () => {
  // A lower version that is also out of range is reported as incompatible, not downgrade.
  const verdict = evaluateUpdateApplicability({
    currentVersion: "1.5.0",
    bundle: { version: "0.9.0", compatibleRange: { min: "1.0.0", max: "2.0.0" }, allowDowngrade: true },
  });
  assert.equal(verdict.kind, "incompatible");
  assert.equal(verdict.applicable, false);
});

test("an exact-pin compatibleRange that matches the bundle version is allowed", () => {
  const verdict = evaluateUpdateApplicability({
    currentVersion: "1.0.0",
    bundle: {
      version: "1.4.0",
      compatibleRange: { min: "1.4.0", minInclusive: true, max: "1.4.0", maxInclusive: true },
    },
  });
  assert.equal(verdict.kind, "upgrade");
  assert.equal(verdict.applicable, true);
});

test("invalid currentVersion fails closed (not applicable, incompatible, no throw)", () => {
  assert.doesNotThrow(() => {
    const verdict = evaluateUpdateApplicability({
      currentVersion: "not-a-version",
      bundle: { version: "1.0.0" },
    });
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("invalid bundle.version fails closed", () => {
  assert.doesNotThrow(() => {
    const verdict = evaluateUpdateApplicability({
      currentVersion: "1.0.0",
      bundle: { version: "^1.0.0" },
    });
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("invalid compatibleRange fails closed", () => {
  assert.doesNotThrow(() => {
    const verdict = evaluateUpdateApplicability({
      currentVersion: "1.0.0",
      bundle: { version: "1.5.0", compatibleRange: { min: "garbage" } },
    });
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("a non-boolean allowDowngrade is rejected fail-closed", () => {
  assert.doesNotThrow(() => {
    // Cast through unknown: allowDowngrade is typed boolean, but the validator must reject at runtime.
    const verdict = evaluateUpdateApplicability({
      currentVersion: "1.2.0",
      bundle: { version: "1.1.0", allowDowngrade: "yes" as unknown as boolean },
    });
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("unknown top-level and bundle keys are rejected fail-closed", () => {
  assert.doesNotThrow(() => {
    const topUnknown = evaluateUpdateApplicability({
      currentVersion: "1.0.0",
      bundle: { version: "1.1.0" },
      extra: "x",
    } as unknown);
    assert.equal(topUnknown.applicable, false);
    assert.equal(topUnknown.kind, "incompatible");

    const bundleUnknown = evaluateUpdateApplicability({
      currentVersion: "1.0.0",
      bundle: { version: "1.1.0", surprise: true },
    } as unknown);
    assert.equal(bundleUnknown.applicable, false);
    assert.equal(bundleUnknown.kind, "incompatible");
  });
});

test("missing currentVersion or bundle fails closed", () => {
  assert.doesNotThrow(() => {
    assert.equal(
      evaluateUpdateApplicability({ bundle: { version: "1.0.0" } } as unknown).applicable,
      false,
    );
    assert.equal(
      evaluateUpdateApplicability({ currentVersion: "1.0.0" } as unknown).applicable,
      false,
    );
  });
});

test("scalar / null / array / exotic top-level inputs fail closed (no throw)", () => {
  assert.doesNotThrow(() => {
    for (const hostile of ["1.0.0", 42, null, undefined, [], new Date(), new Map()] as unknown[]) {
      const verdict = evaluateUpdateApplicability(hostile);
      assert.equal(verdict.applicable, false);
      assert.equal(verdict.kind, "incompatible");
    }
  });
});

test("a non-object bundle fails closed", () => {
  assert.doesNotThrow(() => {
    const verdict = evaluateUpdateApplicability({
      currentVersion: "1.0.0",
      bundle: "1.1.0" as unknown as UpdateApplicabilityInput["bundle"],
    });
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("a Proxy input is rejected fail-closed (no throw)", () => {
  assert.doesNotThrow(() => {
    const proxied = new Proxy(
      { currentVersion: "1.0.0", bundle: { version: "1.1.0" } },
      {},
    );
    const verdict = evaluateUpdateApplicability(proxied);
    assert.equal(verdict.applicable, false);
    assert.equal(verdict.kind, "incompatible");
  });
});

test("the verdict is always one of the four closed kinds", () => {
  const kinds = new Set<UpdateApplicabilityVerdict["kind"]>([
    "upgrade",
    "downgrade",
    "reinstall",
    "incompatible",
  ]);
  const samples: unknown[] = [
    { currentVersion: "1.0.0", bundle: { version: "1.1.0" } },
    { currentVersion: "1.0.0", bundle: { version: "1.0.0" } },
    { currentVersion: "1.0.0", bundle: { version: "0.9.0" } },
    { currentVersion: "bad", bundle: { version: "1.0.0" } },
  ];
  for (const sample of samples) {
    assert.equal(kinds.has(evaluateUpdateApplicability(sample).kind), true);
  }
});

test("hostile accessor properties are never invoked (external-counter probe)", () => {
  // A hostile input with getter/accessor properties at the top level, on `bundle`, and inside
  // `compatibleRange` must be rejected by safeNormalize WITHOUT any getter running. We track
  // invocations with an EXTERNAL counter — a throw inside a getter could be swallowed by an internal
  // catch, so we assert on the counter, not via assert.fail-in-getter.
  let getterReads = 0;
  const observe = (returnValue: unknown): (() => unknown) => {
    return () => {
      getterReads += 1;
      return returnValue;
    };
  };

  // Top-level accessor.
  const topAccessor: Record<string, unknown> = { bundle: { version: "1.1.0" } };
  Object.defineProperty(topAccessor, "currentVersion", {
    enumerable: true,
    configurable: true,
    get: observe("1.0.0"),
  });

  // Accessor on the nested bundle.
  const hostileBundle: Record<string, unknown> = {};
  Object.defineProperty(hostileBundle, "version", {
    enumerable: true,
    configurable: true,
    get: observe("1.1.0"),
  });
  const bundleAccessor = { currentVersion: "1.0.0", bundle: hostileBundle };

  // Accessor inside compatibleRange.
  const hostileRange: Record<string, unknown> = {};
  Object.defineProperty(hostileRange, "min", {
    enumerable: true,
    configurable: true,
    get: observe("1.0.0"),
  });
  const rangeAccessor = {
    currentVersion: "1.0.0",
    bundle: { version: "1.5.0", compatibleRange: hostileRange },
  };

  assert.doesNotThrow(() => {
    for (const hostile of [topAccessor, bundleAccessor, rangeAccessor] as unknown[]) {
      const verdict = evaluateUpdateApplicability(hostile);
      assert.equal(verdict.applicable, false);
      assert.equal(verdict.kind, "incompatible");
    }
  });

  assert.equal(getterReads, 0); // no untrusted accessor was ever invoked at the trust boundary
});

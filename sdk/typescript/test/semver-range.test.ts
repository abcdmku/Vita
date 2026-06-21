import assert from "node:assert/strict";
import { test } from "node:test";

import { maxSatisfying, parseRange, satisfies } from "../src/semver-range.ts";
import type { NormalizedRange, ParseRangeResult, SemverRange } from "../src/semver-range.ts";

function mustParseRange(input: SemverRange): NormalizedRange {
  const result: ParseRangeResult = parseRange(input);
  if (!result.ok) {
    assert.fail(`expected range to parse: ${result.reason}`);
  }
  return result.value;
}

test("a valid bounded range parses and resolves defaults", () => {
  const range = mustParseRange({ min: "1.2.0", max: "2.0.0" });

  assert.equal(range.min?.version, "1.2.0");
  assert.equal(range.max?.version, "2.0.0");
  // Defaults: min inclusive, max exclusive (>=min <max).
  assert.equal(range.min?.inclusive, true);
  assert.equal(range.max?.inclusive, false);
});

test("single-bound ranges are valid (min-only and max-only)", () => {
  assert.equal(parseRange({ min: "1.0.0" }).ok, true);
  assert.equal(parseRange({ max: "2.0.0" }).ok, true);
});

test("explicit inclusivity flags are honored", () => {
  const range = mustParseRange({
    min: "1.0.0",
    minInclusive: false,
    max: "2.0.0",
    maxInclusive: true,
  });
  assert.equal(range.min?.inclusive, false);
  assert.equal(range.max?.inclusive, true);
});

test("a range with no bounds is rejected", () => {
  assert.equal(parseRange({}).ok, false);
  // Inclusivity flags alone do not constitute a bound.
  assert.equal(parseRange({ minInclusive: true }).ok, false);
});

test("unknown fields are rejected", () => {
  assert.equal(parseRange({ min: "1.0.0", extra: "x" }).ok, false);
  // No npm-style range grammar leaks in via a field name.
  assert.equal(parseRange({ range: "^1.0.0" }).ok, false);
});

test("an inclusivity flag without its bound is rejected", () => {
  assert.equal(parseRange({ max: "2.0.0", minInclusive: true }).ok, false);
  assert.equal(parseRange({ min: "1.0.0", maxInclusive: false }).ok, false);
});

test("non-boolean inclusivity and invalid bound strings are rejected fail-closed", () => {
  assert.equal(parseRange({ min: "1.0.0", minInclusive: "yes" }).ok, false);
  assert.equal(parseRange({ min: "not-a-version" }).ok, false);
  assert.equal(parseRange({ min: "^1.0.0" }).ok, false); // caret is not a semver string
  assert.equal(parseRange({ min: "1.0" }).ok, false);
  assert.equal(parseRange({ min: 1 }).ok, false);
});

test("contradictory ranges are rejected", () => {
  // min > max
  assert.equal(parseRange({ min: "2.0.0", max: "1.0.0" }).ok, false);
  // equal bounds, both exclusive -> empty interval
  assert.equal(
    parseRange({ min: "1.0.0", minInclusive: false, max: "1.0.0", maxInclusive: false }).ok,
    false,
  );
  // equal bounds, one side exclusive -> empty interval
  assert.equal(
    parseRange({ min: "1.0.0", minInclusive: true, max: "1.0.0", maxInclusive: false }).ok,
    false,
  );
});

test("equal bounds with both inclusive is a valid exact-version range", () => {
  const range: SemverRange = {
    min: "1.0.0",
    minInclusive: true,
    max: "1.0.0",
    maxInclusive: true,
  };
  // It parses (not contradictory) ...
  assert.equal(parseRange(range).ok, true);
  // ... and behaves as an exact pin.
  assert.equal(satisfies("1.0.0", range), true);
  assert.equal(satisfies("1.0.1", range), false);
});

test("satisfies honors inclusive/exclusive bounds at the boundaries", () => {
  // Default >=1.2.0 <2.0.0
  const def: SemverRange = { min: "1.2.0", max: "2.0.0" };
  assert.equal(satisfies("1.2.0", def), true); // min inclusive
  assert.equal(satisfies("1.9.9", def), true);
  assert.equal(satisfies("2.0.0", def), false); // max exclusive
  assert.equal(satisfies("1.1.9", def), false); // below min
  assert.equal(satisfies("2.0.1", def), false); // above max

  // Flip inclusivity: >1.2.0 <=2.0.0
  const flipped: SemverRange = {
    min: "1.2.0",
    minInclusive: false,
    max: "2.0.0",
    maxInclusive: true,
  };
  assert.equal(satisfies("1.2.0", flipped), false); // min exclusive
  assert.equal(satisfies("2.0.0", flipped), true); // max inclusive
});

test("a prerelease is NOT matched by a plain stable range", () => {
  const range: SemverRange = { min: "1.0.0", max: "2.0.0" };
  assert.equal(satisfies("1.5.0-rc.1", range), false);
  assert.equal(satisfies("1.0.0-alpha", range), false);
});

test("a prerelease IS matched when a same-core bound is present", () => {
  // Same major.minor.patch as the min bound -> prerelease opt-in.
  const minRange: SemverRange = { min: "1.5.0-rc.1", max: "2.0.0" };
  assert.equal(satisfies("1.5.0-rc.1", minRange), true);
  assert.equal(satisfies("1.5.0-rc.2", minRange), true);
  // A prerelease whose core differs from any bound is still excluded.
  assert.equal(satisfies("1.6.0-rc.1", minRange), false);

  // Same-core on the max bound also opts the prerelease in.
  const maxRange: SemverRange = { min: "1.0.0", max: "2.0.0-rc.1", maxInclusive: true };
  assert.equal(satisfies("2.0.0-rc.1", maxRange), true);
  // But a prerelease lower than the prerelease min bound is excluded by ordering.
  assert.equal(satisfies("1.5.0-rc.1", { min: "1.5.0-rc.2", max: "2.0.0" }), false);
});

test("maxSatisfying returns the highest match and null when none", () => {
  const range: SemverRange = { min: "1.0.0", max: "2.0.0" };
  assert.equal(
    maxSatisfying(["1.0.0", "1.9.9", "1.2.3", "2.0.0", "0.9.0"], range),
    "1.9.9",
  );
  // 1.10.0 > 1.9.0 numerically (not lexically).
  assert.equal(maxSatisfying(["1.9.0", "1.10.0", "1.2.0"], range), "1.10.0");
  // None in range.
  assert.equal(maxSatisfying(["2.0.0", "2.1.0", "0.1.0"], range), null);
  // Empty list.
  assert.equal(maxSatisfying([], range), null);
});

test("maxSatisfying skips invalid version strings without throwing", () => {
  const range: SemverRange = { min: "1.0.0", max: "2.0.0" };
  assert.doesNotThrow(() => {
    const result = maxSatisfying(["1.5.0", "not-a-version", "^1.0.0", "1.7.0", null, 3], range);
    assert.equal(result, "1.7.0");
  });
});

test("invalid version, range, and hostile input fail closed (no throw)", () => {
  const range: SemverRange = { min: "1.0.0", max: "2.0.0" };

  assert.doesNotThrow(() => {
    // Invalid version inputs.
    assert.equal(satisfies("not-a-version", range), false);
    assert.equal(satisfies(123, range), false);
    assert.equal(satisfies(null, range), false);
    assert.equal(satisfies({ toString: () => "1.5.0" }, range), false);

    // Invalid / hostile range inputs.
    assert.equal(satisfies("1.5.0", "1.5.0"), false); // scalar range rejected
    assert.equal(satisfies("1.5.0", null), false);
    assert.equal(satisfies("1.5.0", []), false); // array is not a plain range object
    assert.equal(satisfies("1.5.0", { min: "^1.0.0" }), false);

    // maxSatisfying hostile inputs.
    assert.equal(maxSatisfying("not-an-array", range), null);
    assert.equal(maxSatisfying(["1.5.0"], { min: "garbage" }), null);
    assert.equal(maxSatisfying(["1.5.0"], null), null);
  });
});

test("range accessor/getter properties are never invoked (external-counter probe)", () => {
  // A hostile range object with a getter must be rejected by safeNormalize WITHOUT the getter ever
  // running. We track invocations with an EXTERNAL counter (a throw inside the getter could be
  // swallowed by an internal catch, so we assert on the counter, not via assert.fail-in-getter).
  let getterReads = 0;
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "min", {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return "1.0.0";
    },
  });

  let directResult: ParseRangeResult | undefined;
  assert.doesNotThrow(() => {
    directResult = parseRange(hostile);
  });
  assert.equal(directResult?.ok, false);

  // The same hostile object routed through satisfies / maxSatisfying must also stay fail-closed.
  assert.doesNotThrow(() => {
    assert.equal(satisfies("1.0.0", hostile), false);
    assert.equal(maxSatisfying(["1.0.0"], hostile), null);
  });

  assert.equal(getterReads, 0); // accessor never invoked at the trust boundary
});

test("exotic range objects (Date/Map/Proxy/array subclass) are rejected fail-closed", () => {
  assert.doesNotThrow(() => {
    assert.equal(parseRange(new Date()).ok, false);
    assert.equal(parseRange(new Map()).ok, false);
    assert.equal(parseRange(new Proxy({ min: "1.0.0" }, {})).ok, false);
  });
});

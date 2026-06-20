import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, isValidSemver, parseSemver, type Semver } from "../src/semver.ts";

function mustParse(input: string): Semver {
  const result = parseSemver(input);
  assert.equal(result.ok, true, `expected ${input} to parse`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

test("valid versions parse, including prerelease and build", () => {
  const plain = mustParse("1.2.3");
  assert.deepEqual(
    { major: plain.major, minor: plain.minor, patch: plain.patch },
    { major: 1, minor: 2, patch: 3 },
  );
  assert.deepEqual(plain.prerelease, []);
  assert.deepEqual(plain.build, []);

  const full = mustParse("1.0.0-alpha.1+build.7");
  assert.deepEqual(full.prerelease, ["alpha", "1"]);
  assert.deepEqual(full.build, ["build", "7"]);

  assert.equal(isValidSemver("0.0.0"), true);
  assert.equal(isValidSemver("10.20.30"), true);
  assert.equal(isValidSemver("1.0.0-0.3.7"), true);
  assert.equal(isValidSemver("1.0.0-x-y-z.--"), true);
});

test("malformed versions are rejected fail-closed", () => {
  for (const bad of [
    "",
    "v1.0.0", // leading v
    "1.0", // missing patch
    "1.0.0.0", // extra component
    "01.0.0", // leading zero major
    "1.00.0", // leading zero minor
    "1.0.00", // leading zero patch
    "1.0.0-01", // leading-zero numeric prerelease identifier
    "1.0.0-", // empty prerelease
    "1.0.0+", // empty build
    "1.0.0-beta_1", // underscore not allowed
    "1.0.0 ", // trailing space
    "latest",
  ]) {
    assert.equal(isValidSemver(bad), false, `expected ${JSON.stringify(bad)} to be invalid`);
  }
});

test("hostile and non-string inputs fail closed", () => {
  assert.equal(parseSemver(123).ok, false);
  assert.equal(parseSemver(null).ok, false);
  assert.equal(parseSemver({ toString: () => "1.0.0" }).ok, false);
  const accessor: Record<string, unknown> = {};
  let reads = 0;
  Object.defineProperty(accessor, "evil", {
    enumerable: true,
    get() {
      reads += 1;
      return "1.0.0";
    },
  });
  assert.equal(parseSemver(accessor).ok, false);
  assert.equal(reads, 0); // accessor never invoked at the trust boundary
});

test("compareSemver follows core numeric precedence", () => {
  const ordered = ["1.0.0", "2.0.0", "2.1.0", "2.1.1"].map(mustParse);
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    assert.equal(compareSemver(ordered[i]!, ordered[i + 1]!), -1);
    assert.equal(compareSemver(ordered[i + 1]!, ordered[i]!), 1);
    assert.equal(compareSemver(ordered[i]!, ordered[i]!), 0);
  }
  // natural-string ordering would wrongly put 1.9.0 above 1.10.0
  assert.equal(compareSemver(mustParse("1.9.0"), mustParse("1.10.0")), -1);
});

test("compareSemver implements the spec §11 prerelease chain", () => {
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ].map(mustParse);
  for (let i = 0; i + 1 < chain.length; i += 1) {
    assert.equal(
      compareSemver(chain[i]!, chain[i + 1]!),
      -1,
      `expected element ${i} < ${i + 1}`,
    );
  }
});

test("build metadata does not affect precedence", () => {
  assert.equal(compareSemver(mustParse("1.0.0+a"), mustParse("1.0.0+b")), 0);
  assert.equal(compareSemver(mustParse("1.0.0+build.1"), mustParse("1.0.0")), 0);
});

test("compare is a total order on a sample (antisymmetric + transitive)", () => {
  const sample = [
    "1.0.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "2.0.0",
    "1.2.3",
    "1.2.3-rc.1",
  ].map(mustParse);
  for (const a of sample) {
    for (const b of sample) {
      const reverse = compareSemver(b, a);
      // Normalize away -0 so the strict (Object.is) comparison treats 0 and -0 alike.
      const expected: -1 | 0 | 1 = reverse === 0 ? 0 : ((-reverse) as -1 | 1);
      assert.equal(compareSemver(a, b), expected);
    }
  }
  for (const a of sample) {
    for (const b of sample) {
      for (const c of sample) {
        if (compareSemver(a, b) <= 0 && compareSemver(b, c) <= 0) {
          assert.ok(compareSemver(a, c) <= 0, "transitivity violated");
        }
      }
    }
  }
});

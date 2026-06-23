// Strict, fail-closed Semantic Versioning 2.0.0 utility (P0-025).
// Parse + precedence compare only — no ranges/caret/tilde/satisfies. Pure, deterministic, no I/O.
// The input is a SCALAR: a primitive string is inherently trusted plain data (no accessors/proxies),
// so the trust-boundary check is a strict `typeof === "string"` — `safeNormalize` is for object/array
// envelopes and structurally rejects bare scalars, so it does not apply here. A `String` object or any
// other exotic value fails the `typeof` check and is rejected fail-closed without reading any property.

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers (empty when absent). */
  readonly prerelease: readonly string[];
  /** Dot-separated build identifiers (empty when absent). Ignored for precedence. */
  readonly build: readonly string[];
}

export type ParseSemverResult =
  | { readonly ok: true; readonly value: Semver }
  | { readonly ok: false; readonly reason: string };

// Official SemVer 2.0.0 grammar (semver.org). Numeric identifiers forbid leading zeros;
// prerelease identifiers are numeric (no leading zero) or contain a letter/hyphen;
// build identifiers are any non-empty alphanumeric-or-hyphen runs (leading zeros allowed).
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

// JS numbers lose integer precision past 2^53-1; reject versions whose core ints exceed it.
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const NUMERIC_IDENTIFIER = /^(?:0|[1-9]\d*)$/u;

/** Parse a string into a `Semver`, fail-closed. Rejects exotic input, leading `v`, leading zeros, etc. */
export function parseSemver(input: unknown): ParseSemverResult {
  // A primitive string is the only accepted input; a String object / object-with-getter / any exotic
  // value fails this check without any property read, so no untrusted accessor is ever invoked.
  if (typeof input !== "string") {
    return { ok: false, reason: "semver must be a string" };
  }
  const value = input;
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    return { ok: false, reason: `not a valid semver string: ${value}` };
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > MAX_SAFE || minor > MAX_SAFE || patch > MAX_SAFE) {
    return { ok: false, reason: "semver core number out of safe-integer range" };
  }

  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  const build = match[5] === undefined ? [] : match[5].split(".");

  return {
    ok: true,
    value: Object.freeze({
      major,
      minor,
      patch,
      prerelease: Object.freeze(prerelease),
      build: Object.freeze(build),
    }),
  };
}

/** True iff `input` is a valid semver string. */
export function isValidSemver(input: unknown): boolean {
  return parseSemver(input).ok;
}

function isNumericIdentifier(identifier: string): boolean {
  return NUMERIC_IDENTIFIER.test(identifier);
}

// Compare two prerelease identifiers per SemVer §11: numeric < non-numeric; numerics compared
// numerically; otherwise ASCII lexical.
function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }
  if (aNumeric) return -1; // numeric has lower precedence than alphanumeric
  if (bNumeric) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Compare prerelease tuples per SemVer §11. A version WITHOUT prerelease outranks one WITH it.
function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  const aHas = a.length > 0;
  const bHas = b.length > 0;
  if (!aHas && !bHas) return 0;
  if (!aHas) return 1; // no prerelease > has prerelease
  if (!bHas) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    // Indices are bounded by len; values are present.
    const cmp = compareIdentifier(a[i] as string, b[i] as string);
    if (cmp !== 0) return cmp;
  }
  if (a.length < b.length) return -1; // a larger set of fields wins when all prior equal
  if (a.length > b.length) return 1;
  return 0;
}

/**
 * Total-order precedence compare of two parsed `Semver` values per SemVer §11.
 * Build metadata is IGNORED. Returns -1 if a < b, 1 if a > b, 0 if equal precedence.
 */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

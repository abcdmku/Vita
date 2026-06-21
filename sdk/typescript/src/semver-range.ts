// Explicit, fail-closed semver compatibility utility (P0-026), built on P0-025 (`semver.ts`).
//
// DELIBERATELY NOT an npm-style range grammar: there is no `^`, `~`, `||`, `*`/wildcard, or hyphen
// syntax. A range is an explicit, auditable bounded interval `{ min?, minInclusive?, max?,
// maxInclusive? }` so capsule/update compatibility checks are unambiguous (`>=1.2.0 <2.0.0` style).
//
// Trust-boundary discipline (AGENTS.md): the range INPUT is an object envelope, so it is run through
// `safeNormalize` FIRST — that intrinsic-safe pass rejects accessors/getters, proxies, exotic
// prototypes (`Date`/`Map`/…), array subclasses, symbols and cycles, yielding plain trusted data. We
// then reject unknown keys and validate each bound via `parseSemver`. Bare scalar inputs (the
// `version` argument and each already-normalized bound string) are validated with `parseSemver`,
// whose own `typeof === "string"` gate never touches an untrusted accessor. Pure, deterministic,
// no I/O; never throws on hostile input.

import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";
import { compareSemver, parseSemver } from "./semver.ts";
import type { Semver } from "./semver.ts";

/**
 * An explicit bounded version range. At least one of `min`/`max` must be present.
 * Inclusivity defaults to `>=min` (minInclusive=true) and `<max` (maxInclusive=false).
 */
export interface SemverRange {
  readonly min?: string;
  readonly minInclusive?: boolean;
  readonly max?: string;
  readonly maxInclusive?: boolean;
}

/** A fully-resolved, validated range: bounds are parsed `Semver` values and inclusivity is explicit. */
export interface NormalizedRange {
  readonly min?: { readonly version: string; readonly semver: Semver; readonly inclusive: boolean };
  readonly max?: { readonly version: string; readonly semver: Semver; readonly inclusive: boolean };
}

export type ParseRangeResult =
  | { readonly ok: true; readonly value: NormalizedRange }
  | { readonly ok: false; readonly reason: string };

const RANGE_FIELDS = new Set<string>(["min", "minInclusive", "max", "maxInclusive"]);

/**
 * Validate an untrusted range object, fail-closed.
 *
 * Steps: `safeNormalize` the object (rejects accessors/proxies/exotic prototypes/symbols/cycles);
 * reject unknown keys; require at least one bound; validate each present bound string with
 * `parseSemver`; require each present inclusivity flag to be a boolean; apply defaults
 * (minInclusive=true, maxInclusive=false); reject a contradictory range (min > max, or min == max
 * unless BOTH bounds are inclusive — an equal exclusive endpoint is empty).
 */
export function parseRange(input: unknown): ParseRangeResult {
  const normalized = safeNormalize(input);
  if (!normalized.ok) {
    return { ok: false, reason: `invalid range input: ${normalized.reason}` };
  }

  const value = normalized.value;
  if (!isPlainObject(value)) {
    return { ok: false, reason: "range must be a plain object" };
  }

  // Reject unknown keys. After safeNormalize the keys are plain string data properties.
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !RANGE_FIELDS.has(key)) {
      return { ok: false, reason: `unknown range field: ${key}` };
    }
  }

  const hasMin = Object.prototype.hasOwnProperty.call(value, "min");
  const hasMax = Object.prototype.hasOwnProperty.call(value, "max");
  if (!hasMin && !hasMax) {
    return { ok: false, reason: "range must have at least one bound (min or max)" };
  }

  const min = parseBound(value, "min", "minInclusive", true);
  if (!min.ok) {
    return { ok: false, reason: min.reason };
  }
  const max = parseBound(value, "max", "maxInclusive", false);
  if (!max.ok) {
    return { ok: false, reason: max.reason };
  }

  if (min.bound !== undefined && max.bound !== undefined) {
    const order = compareSemver(min.bound.semver, max.bound.semver);
    if (order > 0) {
      return { ok: false, reason: "contradictory range: min is greater than max" };
    }
    if (order === 0 && !(min.bound.inclusive && max.bound.inclusive)) {
      return {
        ok: false,
        reason: "contradictory range: empty interval (equal bounds with an exclusive endpoint)",
      };
    }
  }

  return { ok: true, value: freezeRange(min.bound, max.bound) };
}

interface BoundField {
  readonly version: string;
  readonly semver: Semver;
  readonly inclusive: boolean;
}

type ParseBoundResult =
  | { readonly ok: true; readonly bound: BoundField | undefined }
  | { readonly ok: false; readonly reason: string };

function parseBound(
  value: PlainJsonObject,
  boundKey: "min" | "max",
  inclusiveKey: "minInclusive" | "maxInclusive",
  inclusiveDefault: boolean,
): ParseBoundResult {
  const hasBound = Object.prototype.hasOwnProperty.call(value, boundKey);
  const hasInclusive = Object.prototype.hasOwnProperty.call(value, inclusiveKey);

  if (!hasBound) {
    // An inclusivity flag without its bound is a malformed range, reject it rather than ignore.
    if (hasInclusive) {
      return { ok: false, reason: `${inclusiveKey} given without ${boundKey}` };
    }
    return { ok: true, bound: undefined };
  }

  const rawBound = value[boundKey];
  const parsed = parseSemver(rawBound);
  if (!parsed.ok) {
    return { ok: false, reason: `invalid ${boundKey} bound: ${parsed.reason}` };
  }
  // `rawBound` parsed, so it is a string; capture the original text for round-tripping.
  const version = rawBound as string;

  let inclusive = inclusiveDefault;
  if (hasInclusive) {
    const rawInclusive = value[inclusiveKey];
    if (typeof rawInclusive !== "boolean") {
      return { ok: false, reason: `${inclusiveKey} must be a boolean` };
    }
    inclusive = rawInclusive;
  }

  return {
    ok: true,
    bound: Object.freeze({ version, semver: parsed.value, inclusive }),
  };
}

function freezeRange(
  min: BoundField | undefined,
  max: BoundField | undefined,
): NormalizedRange {
  return Object.freeze({
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  });
}

/**
 * True iff `version` is within `range`, fail-closed. `version` and `range` are both parsed
 * defensively; any invalid/hostile input yields `false` (never a throw).
 *
 * PRERELEASE POLICY (opt-in): a prerelease version (e.g. `1.2.3-rc.1`) satisfies the range ONLY when
 * the range has a bound whose major.minor.patch equals that of the version. A plain stable range such
 * as `>=1.0.0 <2.0.0` therefore never matches `1.5.0-rc.1`, mirroring node-semver's `includePrerelease`
 * default. This prevents an upgrade check from silently accepting an unreleased prerelease.
 */
export function satisfies(version: unknown, range: SemverRange | unknown): boolean {
  const parsedVersion = parseSemver(version);
  if (!parsedVersion.ok) {
    return false;
  }
  const normalized = parseRange(range);
  if (!normalized.ok) {
    return false;
  }
  return satisfiesNormalized(parsedVersion.value, normalized.value);
}

function satisfiesNormalized(version: Semver, range: NormalizedRange): boolean {
  if (version.prerelease.length > 0 && !prereleaseAllowed(version, range)) {
    return false;
  }

  const { min, max } = range;
  if (min !== undefined) {
    const cmp = compareSemver(version, min.semver);
    if (cmp < 0 || (cmp === 0 && !min.inclusive)) {
      return false;
    }
  }
  if (max !== undefined) {
    const cmp = compareSemver(version, max.semver);
    if (cmp > 0 || (cmp === 0 && !max.inclusive)) {
      return false;
    }
  }
  return true;
}

/** A prerelease version is allowed only when a bound shares its exact major.minor.patch core. */
function prereleaseAllowed(version: Semver, range: NormalizedRange): boolean {
  return sameCore(version, range.min) || sameCore(version, range.max);
}

function sameCore(version: Semver, bound: BoundField | undefined): boolean {
  if (bound === undefined) {
    return false;
  }
  const b = bound.semver;
  return version.major === b.major && version.minor === b.minor && version.patch === b.patch;
}

/**
 * Return the highest input version (by `compareSemver`) that `satisfies` the range, or `null` when
 * none do. Fail-closed: invalid range or a non-array `versions` yields `null`; individual invalid
 * version strings are skipped, not throwing.
 */
export function maxSatisfying(
  versions: unknown,
  range: SemverRange | unknown,
): string | null {
  const normalized = parseRange(range);
  if (!normalized.ok) {
    return null;
  }
  if (!Array.isArray(versions)) {
    return null;
  }

  let bestText: string | null = null;
  let bestSemver: Semver | undefined;

  for (let index = 0; index < versions.length; index += 1) {
    const candidate: unknown = versions[index];
    const parsed = parseSemver(candidate);
    if (!parsed.ok) {
      continue;
    }
    if (!satisfiesNormalized(parsed.value, normalized.value)) {
      continue;
    }
    if (bestSemver === undefined || compareSemver(parsed.value, bestSemver) > 0) {
      bestSemver = parsed.value;
      // `candidate` parsed, so it is a string.
      bestText = candidate as string;
    }
  }

  return bestText;
}

function isPlainObject(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

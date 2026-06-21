// Fail-closed update-applicability policy (P0-027), built on P0-025 (`semver.ts`) and P0-026
// (`semver-range.ts`). Decides whether an update bundle MAY be applied to a node — gated on declared
// OS-version compatibility, with rollback/downgrade protection on by default and reinstall treated as
// a no-op. Decision only: pure, deterministic, no I/O, never throws (FR-012).
//
// Trust-boundary discipline (AGENTS.md): the WHOLE `input` object is its own trust boundary, so it is
// run through `safeNormalize` FIRST. That intrinsic-safe pass rejects accessors/getters, proxies,
// exotic prototypes (`Date`/`Map`/…), array subclasses, symbols and cycles at EVERY level — including
// the top-level params and the nested `bundle`/`compatibleRange` objects — yielding plain trusted
// data. We then reject unknown keys and validate the bare-string version fields with `parseSemver`
// (whose own `typeof === "string"` gate never touches an untrusted accessor), the optional
// `compatibleRange` with `parseRange`, and `allowDowngrade` as a strict boolean. Hostile/invalid input
// is reported as `{ applicable: false, kind: "incompatible", reason }`, never thrown.

import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";
import { compareSemver, parseSemver } from "./semver.ts";
import { parseRange, satisfies } from "./semver-range.ts";
import type { SemverRange } from "./semver-range.ts";

/** The kind of transition an update bundle represents relative to the node's current version. */
export type UpdateApplicabilityKind = "upgrade" | "downgrade" | "reinstall" | "incompatible";

/** The update bundle under consideration. `compatibleRange` is the declared OS-version gate. */
export interface UpdateBundle {
  readonly version: string;
  readonly compatibleRange?: SemverRange;
  readonly allowDowngrade?: boolean;
}

/** The input to `evaluateUpdateApplicability`: the node's current version + the candidate bundle. */
export interface UpdateApplicabilityInput {
  readonly currentVersion: string;
  readonly bundle: UpdateBundle;
}

/** The typed verdict: may this bundle be applied, what kind of transition is it, and why. */
export interface UpdateApplicabilityVerdict {
  readonly applicable: boolean;
  readonly kind: UpdateApplicabilityKind;
  readonly reason: string;
}

const INPUT_FIELDS = new Set<string>(["currentVersion", "bundle"]);
const BUNDLE_FIELDS = new Set<string>(["version", "compatibleRange", "allowDowngrade"]);

/**
 * Decide whether `input.bundle` may be applied to a node currently at `input.currentVersion`.
 *
 * Rules (fail-closed):
 *  1. `safeNormalize` the whole input (rejects accessors/proxies/exotic/cycles); reject unknown keys;
 *     `currentVersion` + `bundle.version` must `parseSemver`-validate; `compatibleRange` (if present)
 *     must `parseRange`-validate; `allowDowngrade` (if present) must be a boolean.
 *  2. If `compatibleRange` is present and `bundle.version` does NOT satisfy it ⇒ `incompatible`
 *     (not applicable) — the OS-version compatibility gate, even for a higher version.
 *  3. Else compare `bundle.version` vs `currentVersion`:
 *     - `>` ⇒ `upgrade` (applicable);
 *     - `==` ⇒ `reinstall` (NOT applicable — a reinstall is a no-op, not auto-applied);
 *     - `<` ⇒ `downgrade`, applicable ONLY if `allowDowngrade === true` (else not applicable;
 *       rollback-protection is on by default).
 *
 * Never throws. Any hostile/invalid input yields `{ applicable: false, kind: "incompatible", reason }`.
 */
export function evaluateUpdateApplicability(input: unknown): UpdateApplicabilityVerdict {
  try {
    const normalized = safeNormalize(input);
    if (!normalized.ok) {
      return incompatible(`invalid update-applicability input: ${normalized.reason}`);
    }

    const value = normalized.value;
    if (!isPlainObject(value)) {
      return incompatible("update-applicability input must be a plain object");
    }

    const unknownTop = firstUnknownKey(value, INPUT_FIELDS);
    if (unknownTop !== undefined) {
      return incompatible(`unknown input field: ${unknownTop}`);
    }

    // currentVersion — required, must be a valid semver string.
    if (!hasOwn(value, "currentVersion")) {
      return incompatible("currentVersion is required");
    }
    const currentParsed = parseSemver(value.currentVersion);
    if (!currentParsed.ok) {
      return incompatible(`invalid currentVersion: ${currentParsed.reason}`);
    }

    // bundle — required plain object.
    if (!hasOwn(value, "bundle")) {
      return incompatible("bundle is required");
    }
    const bundle = value.bundle;
    if (!isPlainObject(bundle)) {
      return incompatible("bundle must be a plain object");
    }

    const unknownBundle = firstUnknownKey(bundle, BUNDLE_FIELDS);
    if (unknownBundle !== undefined) {
      return incompatible(`unknown bundle field: ${unknownBundle}`);
    }

    // bundle.version — required, must be a valid semver string.
    if (!hasOwn(bundle, "version")) {
      return incompatible("bundle.version is required");
    }
    const bundleParsed = parseSemver(bundle.version);
    if (!bundleParsed.ok) {
      return incompatible(`invalid bundle.version: ${bundleParsed.reason}`);
    }
    // `bundle.version` parsed, so it is a string; capture it for `satisfies`.
    const bundleVersion = bundle.version as string;

    // bundle.allowDowngrade — optional, must be a strict boolean if present.
    let allowDowngrade = false;
    if (hasOwn(bundle, "allowDowngrade")) {
      const rawAllow = bundle.allowDowngrade;
      if (typeof rawAllow !== "boolean") {
        return incompatible("bundle.allowDowngrade must be a boolean");
      }
      allowDowngrade = rawAllow;
    }

    // bundle.compatibleRange — optional OS-version compatibility gate. Must `parseRange`-validate.
    if (hasOwn(bundle, "compatibleRange")) {
      const rawRange = bundle.compatibleRange;
      const parsedRange = parseRange(rawRange);
      if (!parsedRange.ok) {
        return incompatible(`invalid bundle.compatibleRange: ${parsedRange.reason}`);
      }
      // The gate: the bundle's own version must satisfy its declared compatible range. `satisfies`
      // re-parses both fail-closed; we already proved both validate, so a `false` here is a genuine
      // out-of-range result, not a parse rejection.
      if (!satisfies(bundleVersion, rawRange)) {
        return {
          applicable: false,
          kind: "incompatible",
          reason: `bundle version ${bundleVersion} is outside its declared compatibleRange`,
        };
      }
    }

    // Compatibility gate passed (or absent). Decide the transition by precedence.
    const order = compareSemver(bundleParsed.value, currentParsed.value);
    if (order > 0) {
      return {
        applicable: true,
        kind: "upgrade",
        reason: `bundle version ${bundleVersion} is newer than current ${value.currentVersion as string}`,
      };
    }
    if (order === 0) {
      return {
        applicable: false,
        kind: "reinstall",
        reason: `bundle version ${bundleVersion} equals current version; reinstall is a no-op`,
      };
    }
    // order < 0 ⇒ downgrade. Rollback-protected unless explicitly allowed.
    if (allowDowngrade) {
      return {
        applicable: true,
        kind: "downgrade",
        reason: `bundle version ${bundleVersion} is older than current ${value.currentVersion as string}; downgrade explicitly allowed`,
      };
    }
    return {
      applicable: false,
      kind: "downgrade",
      reason: `bundle version ${bundleVersion} is older than current ${value.currentVersion as string}; downgrade blocked by rollback-protection (allowDowngrade not set)`,
    };
  } catch {
    // Defense-in-depth: the helpers above are fail-closed, but never let a throw escape the boundary.
    return incompatible("update-applicability evaluation failed");
  }
}

function incompatible(reason: string): UpdateApplicabilityVerdict {
  return Object.freeze({ applicable: false, kind: "incompatible", reason });
}

function firstUnknownKey(value: PlainJsonObject, allowed: ReadonlySet<string>): string | undefined {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !allowed.has(key)) {
      return key;
    }
  }
  return undefined;
}

function hasOwn(value: PlainJsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

// Vendored from sdk/typescript/src/transaction-plan-diff.ts for P1-034.
// Byte-identical to upstream except this header and the import paths for the
// already-vendored ./evaluate.ts (TransactionPlan/PlanOperation types) and
// ./safe-normalize.ts (the JSON guardian) in this same directory.
// preview.test.ts asserts upstream parity (zero vendoring drift).
//
// Transaction-plan PREVIEW diff (P1-034).
//
// Pure, deterministic, fail-CLOSED diff of two `TransactionPlan`s (the evaluator's
// own output, ADR-0007) by capability. Given a CURRENT plan and a DESIRED plan it
// reports which capabilities are added / removed / changed:
//
//   - added   : a capability with an operation in DESIRED but not CURRENT
//   - removed : a capability with an operation in CURRENT but not DESIRED
//   - changed : a capability present in BOTH whose `request` differs structurally
//
// Each list is SORTED for determinism: identical inputs always yield an
// identical, byte-stable result.
//
// Trust boundary (AGENTS.md §General): although the two plans are normally the
// evaluator's own trusted output, this module treats them as UNTRUSTED so it can
// be reused by the controller's preview over operator-supplied plans. It is
// **validate-or-throw, never a benign fallback** — on any malformed/exotic input
// it REFUSES (throws `TransactionPlanDiffError`) instead of returning a benign
// "no changes" result (which would be fail-OPEN: silently claiming "nothing
// changed" when it could not actually compute the diff).
//
// SINGLE-GATE design (no bypass): the ENTIRE plan envelope is run through the
// proven JSON guardian `safeNormalize` (P1-033) FIRST, before any `length`/index
// of the raw input is ever trusted. `safeNormalize`:
//   - rejects Proxies at EVERY level via `util.types.isProxy` — including a LYING
//     Proxy over an array that passes `Array.isArray` and reports a fake
//     `length: 0` without throwing. Such a Proxy is rejected HERE (the envelope
//     contains it), so it can never make the per-operation loop iterate zero ops
//     and collapse to a benign empty diff.
//   - rejects accessor/getter properties, array subclasses, exotic prototypes
//     (`Date`/`Map`/`Set`/`RegExp` → "Only plain objects are accepted"), symbols,
//     cycles, BigInt, and non-finite numbers — at every level.
// If `safeNormalize` returns `{ ok: false }` for either plan → THROW.
//
// AFTER normalization we hold guaranteed-plain `PlainJson`: a REAL array, REAL
// strings, REAL plain objects (no Proxy, no accessor, no exotic prototype). ALL
// subsequent structural checks and the diff itself operate ONLY on that plain
// snapshot — there are NO raw-input `length`/index reads anywhere. We then:
//   - verify the normalized `operations` is a real array (else throw),
//   - verify each operation is a plain object with a string `capability` and a
//     plain-object `request` (else throw),
//   - compare requests by their canonical (key-sorted) JSON, so "changed" is a
//     deterministic string compare over trusted plain data only,
//   - build capability-keyed maps with `Object.create(null)` so a spec-valid but
//     JS-special capability name (`__proto__`, `constructor`) becomes a real own
//     key instead of mutating a prototype.

import type { PlanOperation, TransactionPlan } from "./evaluate.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson } from "./safe-normalize.ts";

export interface TransactionPlanChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * Thrown when a plan is malformed or hostile and the diff cannot be computed on
 * validated data. The diff REFUSES rather than returning a benign empty/unchanged
 * result (fail-closed-by-throwing). Callers at a trust boundary must catch this
 * and surface a fail-safe error, NOT treat it as "no changes".
 */
export class TransactionPlanDiffError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TransactionPlanDiffError";
  }
}

/**
 * Diff two transaction plans by capability. Pure, deterministic, and
 * fail-CLOSED-by-throwing: any malformed/exotic input throws
 * `TransactionPlanDiffError` rather than returning a benign result. The normal
 * evaluator-output path is always clean, so this never throws there.
 */
export function diffTransactionPlans(
  current: TransactionPlan,
  desired: TransactionPlan,
): TransactionPlanChange {
  const currentByCapability = indexPlanByCapability(current, "current");
  const desiredByCapability = indexPlanByCapability(desired, "desired");

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  const currentNames = ownKeys(currentByCapability);
  for (let index = 0; index < currentNames.length; index += 1) {
    const capability = currentNames[index];

    if (capability === undefined) {
      continue;
    }

    if (!hasOwnKey(desiredByCapability, capability)) {
      removed.push(capability);
      continue;
    }

    // Present in both: compare the canonicalized requests. Both forms are stable
    // JSON strings of `safeNormalize`d PlainJson, so equality is a plain string
    // compare over trusted data.
    if (currentByCapability[capability] !== desiredByCapability[capability]) {
      changed.push(capability);
    }
  }

  const desiredNames = ownKeys(desiredByCapability);
  for (let index = 0; index < desiredNames.length; index += 1) {
    const capability = desiredNames[index];

    if (capability === undefined) {
      continue;
    }

    if (!hasOwnKey(currentByCapability, capability)) {
      added.push(capability);
    }
  }

  return Object.freeze({
    added: Object.freeze(added.sort(compareStrings)),
    changed: Object.freeze(changed.sort(compareStrings)),
    removed: Object.freeze(removed.sort(compareStrings)),
  });
}

/** capability -> canonical (stable-JSON) form of its normalized request. */
type CapabilityMap = Record<string, string>;

/**
 * Build a null-prototype map { capability -> canonical request } from a plan.
 *
 * SINGLE-GATE: the WHOLE plan envelope is passed through `safeNormalize` FIRST.
 * `safeNormalize` rejects Proxies (including a lying Proxy array reporting a fake
 * `length`), accessor/getter properties, array subclasses, exotic prototypes,
 * symbols, cycles, etc. at EVERY level — so a hostile plan is refused BEFORE any
 * `length`/index of the raw input is ever read or trusted. If it returns
 * `{ ok: false }` → the plan is malformed → THROW.
 *
 * Everything after the gate operates on guaranteed-plain `PlainJson` (a real
 * array, real strings, real plain objects). There are NO raw-input length/index
 * reads anywhere below. Duplicate capabilities overwrite earlier ones (last-wins)
 * deterministically.
 */
function indexPlanByCapability(plan: TransactionPlan, side: string): CapabilityMap {
  // The ONE gate. After this, `normalized` is trusted plain JSON.
  const normalizedPlan = safeNormalize(plan);

  if (!normalizedPlan.ok) {
    throw new TransactionPlanDiffError(
      `The ${side} plan is malformed: ${normalizedPlan.reason}`,
    );
  }

  const planValue = normalizedPlan.value;

  if (Array.isArray(planValue) || !isPlainJsonObject(planValue)) {
    throw new TransactionPlanDiffError(`The ${side} plan must be an object.`);
  }

  // `operations` is now a real (own, data, plain) value or absent — a plain read
  // of trusted PlainJson, never an accessor or a Proxy trap.
  const operations = planValue["operations"];

  if (!Array.isArray(operations)) {
    throw new TransactionPlanDiffError(
      `The ${side} plan operations must be an array.`,
    );
  }

  const map: CapabilityMap = Object.create(null) as CapabilityMap;

  // `operations` is a real array of trusted PlainJson; `.length` and index access
  // are intrinsic reads over plain data (no Proxy, no getter).
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];

    if (operation === null || typeof operation !== "object" || Array.isArray(operation)) {
      throw new TransactionPlanDiffError(
        `The ${side} plan operations[${index}] must be an object.`,
      );
    }

    const capability = operation["capability"];

    if (typeof capability !== "string") {
      throw new TransactionPlanDiffError(
        `The ${side} plan operations[${index}] has a non-string capability.`,
      );
    }

    const request = operation["request"];

    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new TransactionPlanDiffError(
        `The ${side} plan operation "${capability}" has a non-object request.`,
      );
    }

    // Canonicalize the (already plain, already validated) request to a stable,
    // key-sorted JSON string so "changed" is a deterministic string compare.
    const canonicalRequest = canonicalize(request);

    // Define as an own key (null-proto map ⇒ no prototype pollution even for
    // `__proto__`/`constructor` capability names).
    Object.defineProperty(map, capability, {
      configurable: true,
      enumerable: true,
      value: canonicalRequest,
      writable: true,
    });
  }

  return map;
}

/**
 * Deterministic canonical JSON of already-validated PlainJson: object keys sorted,
 * arrays in order. The input is trusted (post-`safeNormalize`), so this is a pure
 * structural serialization with no trust-boundary concerns.
 */
function canonicalize(value: PlainJson): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (!isPlainJsonObject(value)) {
    // A readonly PlainJson array.
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      items.push(item === undefined ? "null" : canonicalize(item));
    }

    return `[${items.join(",")}]`;
  }

  return canonicalizeObject(value);
}

function canonicalizeObject(value: { readonly [key: string]: PlainJson }): string {
  const keys = Object.keys(value).sort(compareStrings);
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    const child = value[key];
    entries.push(`${JSON.stringify(key)}:${child === undefined ? "null" : canonicalize(child)}`);
  }

  return `{${entries.join(",")}}`;
}

/** Own enumerable string keys of a null-prototype CapabilityMap. */
function ownKeys(map: CapabilityMap): string[] {
  const keys: string[] = [];
  const names = Object.keys(map);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];

    if (name !== undefined) {
      keys.push(name);
    }
  }

  return keys;
}

function hasOwnKey(map: CapabilityMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

function isPlainJsonObject(value: PlainJson): value is { readonly [key: string]: PlainJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export type { PlanOperation, TransactionPlan };

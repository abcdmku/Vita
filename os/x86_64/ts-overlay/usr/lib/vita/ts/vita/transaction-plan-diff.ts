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
// changed" when it could not actually compute the diff). Concretely:
//   - It reuses the proven JSON guardian `safeNormalize` (P1-033) on EVERY
//     operation. `safeNormalize` rejects Proxies, accessor/getter properties, and
//     non-plain values (exotic prototypes like `Date`/`Map`/`Set`/`RegExp` are
//     rejected as "Only plain objects are accepted" — verified). If it returns
//     `{ ok: false }` for any operation, the plan is malformed → THROW.
//   - It compares requests by their `safeNormalize`d canonical form (a stable,
//     key-sorted JSON string of validated PlainJson data) — "changed" is decided
//     on validated data only, never by invoking attacker-controlled accessors.
//   - It iterates the operations array safely: it confirms a real array
//     (`Array.isArray`, else throw), snapshots `length`, and index-accesses inside
//     a try that rethrows as `TransactionPlanDiffError` (a Proxy index-trap throw
//     SURFACES as a throw, it is never swallowed to an empty diff).
//   - It builds capability-keyed maps with `Object.create(null)` so a spec-valid
//     but JS-special capability name (`__proto__`, `constructor`) becomes a real
//     own key instead of mutating a prototype.

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
  const currentByCapability = indexPlanByCapability(current);
  const desiredByCapability = indexPlanByCapability(desired);

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

    // Present in both: compare the validated, canonicalized requests. Both forms
    // are stable JSON strings of `safeNormalize`d PlainJson, so equality is a
    // plain string compare over trusted data.
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

/** capability -> canonical (stable-JSON) form of its `safeNormalize`d request. */
type CapabilityMap = Record<string, string>;

/**
 * Build a null-prototype map { capability -> canonical request } from a plan's
 * operations. The whole plan and every operation go through the `safeNormalize`
 * guardian; anything it rejects (Proxy, accessor/getter, exotic prototype,
 * non-string capability, non-object request) makes the plan malformed and THROWS
 * `TransactionPlanDiffError` — it is never coerced to a benign value or skipped.
 * Later duplicate capabilities overwrite earlier ones (last-wins) deterministically.
 */
function indexPlanByCapability(plan: TransactionPlan): CapabilityMap {
  const map: CapabilityMap = Object.create(null) as CapabilityMap;

  if (plan === null || typeof plan !== "object") {
    throw new TransactionPlanDiffError("Plan must be an object.");
  }

  // Read `operations` without invoking accessors: an accessor `operations` is a
  // TOCTOU hazard, so reject it rather than reading it. A Proxy whose descriptor
  // trap throws surfaces as a typed error (never swallowed to an empty diff).
  let operations: unknown;
  try {
    operations = readDataProperty(plan, "operations");
  } catch (cause) {
    throw new TransactionPlanDiffError(
      `Plan operations could not be read: ${describe(cause)}`,
    );
  }

  if (!Array.isArray(operations)) {
    throw new TransactionPlanDiffError("Plan operations must be an array.");
  }

  // Snapshot the length once via a data descriptor; never trust a getter. A Proxy
  // index/length trap that throws is rethrown as a typed error so it SURFACES.
  let length: number;
  try {
    length = readArrayLength(operations);
  } catch (cause) {
    throw new TransactionPlanDiffError(
      `Plan operations length could not be read: ${describe(cause)}`,
    );
  }

  for (let index = 0; index < length; index += 1) {
    // A Proxy index-trap (or any hostile descriptor read) throws here; rethrow it
    // as a typed error so it SURFACES rather than being swallowed to an empty diff.
    let operation: unknown;
    try {
      operation = readIndex(operations, index);
    } catch (cause) {
      throw new TransactionPlanDiffError(
        `Plan operations[${index}] could not be read: ${describe(cause)}`,
      );
    }

    // Validate the ENTIRE operation through the proven guardian. This rejects
    // Proxies, accessor/getter properties, and exotic prototypes at every level
    // (verified: Date/Map/Set/RegExp -> "Only plain objects are accepted").
    const normalized = safeNormalize(operation);

    if (!normalized.ok) {
      throw new TransactionPlanDiffError(
        `Plan operations[${index}] is malformed: ${normalized.reason}`,
      );
    }

    const normalizedOperation = normalized.value;

    if (Array.isArray(normalizedOperation) || !isPlainJsonObject(normalizedOperation)) {
      throw new TransactionPlanDiffError(
        `Plan operations[${index}] must be an object.`,
      );
    }

    const capability = normalizedOperation["capability"];

    if (typeof capability !== "string") {
      throw new TransactionPlanDiffError(
        `Plan operations[${index}] has a non-string capability.`,
      );
    }

    const request = normalizedOperation["request"];

    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new TransactionPlanDiffError(
        `Plan operation "${capability}" has a non-object request.`,
      );
    }

    // Canonicalize the validated request to a stable, key-sorted JSON string so
    // "changed" is a deterministic string compare over trusted data only.
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

/** Read `obj[key]` as a value ONLY if it is an own enumerable data property. */
function readDataProperty(obj: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);

  if (!isReadableData(descriptor)) {
    return undefined;
  }

  return descriptor.value;
}

/**
 * Read array element at `index` via its own data descriptor. Returns `undefined`
 * for an accessor/missing element. May throw if a hostile (e.g. Proxy) descriptor
 * read itself throws — the caller rethrows that as `TransactionPlanDiffError`.
 */
function readIndex(array: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));

  if (!isReadableData(descriptor)) {
    return undefined;
  }

  return descriptor.value;
}

/**
 * Read an array's `length` from its own data descriptor, never via a getter.
 * Returns 0 for a non-integer / out-of-range / accessor length (fail-closed).
 */
function readArrayLength(array: unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(array, "length");

  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return 0;
  }

  const length: unknown = descriptor.value;

  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return 0;
  }

  return length;
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

function isReadableData(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  if (descriptor === undefined) {
    return false;
  }

  if (descriptor.enumerable !== true) {
    return false;
  }

  // A data descriptor has `value`; an accessor descriptor has `get`/`set`.
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isPlainJsonObject(value: PlainJson): value is { readonly [key: string]: PlainJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return "unreadable";
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

// Vendored from sdk/typescript/src/transaction-plan-diff.ts for P1-034.
// Byte-identical to upstream except this header and the import path for the
// evaluator's TransactionPlan/PlanOperation types (the already-vendored
// ./evaluate.ts in this same directory). preview.test.ts asserts upstream parity.
//
// Transaction-plan PREVIEW diff (P1-034).
//
// Pure, deterministic, trust-boundary-safe diff of two `TransactionPlan`s (the
// evaluator's own output, ADR-0007) by capability. Given a CURRENT plan and a
// DESIRED plan it reports which capabilities are added / removed / changed:
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
// be reused by the controller's preview over operator-supplied plans. It MUST
// NOT be subverted by a shape-valid but hostile input:
//   - It iterates with indexed `for` loops over `Object.keys(...)` / a snapshotted
//     array length — it never calls `.forEach`/`.map`/`.some`/`for…of` off the
//     untrusted operation arrays (a shadowed/throwing method or hostile iterator
//     would otherwise lie to or crash the diff).
//   - It builds capability-keyed maps with `Object.create(null)` so a spec-valid
//     but JS-special capability name (`__proto__`, `constructor`) becomes a real
//     own key instead of mutating a prototype.
//   - It deep-compares requests by reading ONLY own enumerable DATA properties via
//     `Object.getOwnPropertyDescriptor` — it never invokes attacker-controlled
//     getters/accessors. An accessor property, exotic prototype, or otherwise
//     un-readable shape compares as NOT-equal (fail-closed: a capability it cannot
//     prove identical is reported as `changed`, never silently treated as same).
//   - It never throws on malformed input; it returns a well-formed result.

import type { PlanOperation, TransactionPlan } from "./evaluate.ts";

export interface TransactionPlanChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * Diff two transaction plans by capability. Pure, deterministic, fail-closed,
 * and trust-boundary-safe (see file header). Never throws.
 */
export function diffTransactionPlans(
  current: TransactionPlan,
  desired: TransactionPlan,
): TransactionPlanChange {
  try {
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

      // Present in both: compare requests structurally. Fail-closed — if either
      // request cannot be proven structurally identical (accessor, exotic shape),
      // it is reported as `changed`.
      const currentRequest = currentByCapability[capability];
      const desiredRequest = desiredByCapability[capability];

      if (!deepEqual(currentRequest, desiredRequest)) {
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
  } catch {
    // A trust boundary must never throw (a throw at a trust boundary is a DoS).
    // Fail closed with an empty diff if the structural walk hit an unexpected
    // hostile shape that escaped the per-step guards.
    return Object.freeze({
      added: Object.freeze<string[]>([]),
      changed: Object.freeze<string[]>([]),
      removed: Object.freeze<string[]>([]),
    });
  }
}

type CapabilityMap = Record<string, unknown>;

/**
 * Build a null-prototype map { capability -> request } from a plan's operations.
 * Reads the operations array by index off a snapshotted length and reads
 * `capability`/`request` via own-data-property descriptors only — never invoking
 * a shadowed method or attacker getter. Later duplicate capabilities overwrite
 * earlier ones (last-wins) deterministically; a missing/non-string capability or
 * an exotic operation entry is skipped (fail-closed).
 */
function indexPlanByCapability(plan: TransactionPlan): CapabilityMap {
  const map: CapabilityMap = Object.create(null) as CapabilityMap;

  if (plan === null || typeof plan !== "object") {
    return map;
  }

  const operations = readDataProperty(plan, "operations");

  if (!Array.isArray(operations)) {
    return map;
  }

  // Snapshot the length once via a data descriptor; never trust a getter.
  const length = readArrayLength(operations);

  for (let index = 0; index < length; index += 1) {
    const operation = readIndex(operations, index);

    if (operation === null || typeof operation !== "object") {
      continue;
    }

    const capability = readDataProperty(operation as object, "capability");

    if (typeof capability !== "string") {
      continue;
    }

    const request = readDataProperty(operation as object, "request");

    // Define as an own key (null-proto map ⇒ no prototype pollution even for
    // `__proto__`/`constructor` capability names).
    Object.defineProperty(map, capability, {
      configurable: true,
      enumerable: true,
      value: request,
      writable: true,
    });
  }

  return map;
}

/**
 * Deep structural equality over JSON-shaped data, reading ONLY own enumerable
 * data properties (never accessors). Returns false (fail-closed) for any shape it
 * cannot prove identical: mismatched types, accessor properties, exotic objects,
 * cycles handled by the node budget. Pure; never throws on its own.
 */
function deepEqual(left: unknown, right: unknown): boolean {
  return deepEqualBounded(left, right, 0);
}

const MAX_DEPTH = 200;

function deepEqualBounded(left: unknown, right: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftType = typeof left;
  const rightType = typeof right;

  if (leftType !== rightType) {
    return false;
  }

  if (left === null || right === null) {
    // One is null and (since `left === right` failed) the other is not.
    return false;
  }

  if (leftType !== "object") {
    // Primitives that were not `===` (e.g. NaN, or differing values) → not equal.
    return false;
  }

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);

  if (leftIsArray !== rightIsArray) {
    return false;
  }

  if (leftIsArray && rightIsArray) {
    return deepEqualArray(left, right, depth);
  }

  return deepEqualObject(left as object, right as object, depth);
}

function deepEqualArray(left: unknown[], right: unknown[], depth: number): boolean {
  const leftLength = readArrayLength(left);
  const rightLength = readArrayLength(right);

  if (leftLength !== rightLength) {
    return false;
  }

  for (let index = 0; index < leftLength; index += 1) {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, String(index));
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, String(index));

    if (!isReadableData(leftDescriptor) || !isReadableData(rightDescriptor)) {
      return false;
    }

    if (!deepEqualBounded(leftDescriptor.value, rightDescriptor.value, depth + 1)) {
      return false;
    }
  }

  return true;
}

function deepEqualObject(left: object, right: object, depth: number): boolean {
  const leftKeys = ownStringKeys(left);
  const rightKeys = ownStringKeys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  // Sort both key sets so order differences do not count as a change.
  const leftSorted = leftKeys.slice().sort(compareStrings);
  const rightSorted = rightKeys.slice().sort(compareStrings);

  for (let index = 0; index < leftSorted.length; index += 1) {
    if (leftSorted[index] !== rightSorted[index]) {
      return false;
    }
  }

  for (let index = 0; index < leftSorted.length; index += 1) {
    const key = leftSorted[index];

    if (key === undefined) {
      return false;
    }

    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);

    if (!isReadableData(leftDescriptor) || !isReadableData(rightDescriptor)) {
      // An accessor (or otherwise un-readable own property) cannot be proven
      // equal without invoking attacker code → fail-closed (not equal).
      return false;
    }

    if (!deepEqualBounded(leftDescriptor.value, rightDescriptor.value, depth + 1)) {
      return false;
    }
  }

  return true;
}

/** Read `obj[key]` as a value ONLY if it is an own enumerable data property. */
function readDataProperty(obj: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);

  if (!isReadableData(descriptor)) {
    return undefined;
  }

  return descriptor.value;
}

/** Read array element at `index` ONLY if it is an own enumerable data property. */
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

/** Own string keys of an object whose descriptors are enumerable. Symbols ignored. */
function ownStringKeys(obj: object): string[] {
  const keys = Reflect.ownKeys(obj);
  const out: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || typeof key === "symbol") {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(obj, key);

    if (descriptor === undefined || descriptor.enumerable !== true) {
      continue;
    }

    out.push(key);
  }

  return out;
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

export interface DeterminismOptions {
  readonly runs?: number;
}

type JsonPrimitive = string | number | boolean | null;
type CanonicalValue = JsonPrimitive | readonly CanonicalValue[] | CanonicalRecord;

interface CanonicalRecord {
  readonly [key: string]: CanonicalValue;
}

const DEFAULT_RUNS = 50;

export function assertDeterministic<I, O>(
  fn: (input: I) => O,
  input: I,
  opts: DeterminismOptions = {},
): void {
  const runs = normalizeRuns(opts.runs);
  const first = canonicalSerialize(fn(input));

  for (let run = 2; run <= runs; run += 1) {
    const next = canonicalSerialize(fn(input));

    if (next !== first) {
      throw new Error(
        [
          `Function is not deterministic: run ${run} differed from run 1.`,
          `Expected canonical result: ${first}`,
          `Received canonical result: ${next}`,
        ].join("\n"),
      );
    }
  }
}

export function isDeterministic<I, O>(
  fn: (input: I) => O,
  input: I,
  opts: DeterminismOptions = {},
): boolean {
  try {
    assertDeterministic(fn, input, opts);
    return true;
  } catch {
    return false;
  }
}

function normalizeRuns(runs: number | undefined): number {
  if (runs === undefined) {
    return DEFAULT_RUNS;
  }

  if (!Number.isInteger(runs) || runs < 1) {
    throw new TypeError("Determinism runs must be a positive integer.");
  }

  return runs;
}

function canonicalSerialize(value: unknown): string {
  const canonical = canonicalize(value, new WeakSet<object>());

  return JSON.stringify(canonical);
}

function canonicalize(value: unknown, seen: WeakSet<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Determinism results must contain only finite numbers.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    guardAcyclic(value, seen);

    const items = value.map((item) => canonicalize(item, seen));
    seen.delete(value);

    return items;
  }

  if (isPlainRecord(value)) {
    guardAcyclic(value, seen);

    const output: Record<string, CanonicalValue> = {};

    for (const key of Object.keys(value).sort(compareStrings)) {
      const next = value[key];

      if (next !== undefined) {
        output[key] = canonicalize(next, seen);
      }
    }

    seen.delete(value);

    return output;
  }

  throw new TypeError(`Unsupported determinism result type: ${typeof value}.`);
}

function guardAcyclic(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) {
    throw new TypeError("Determinism results cannot contain cyclic references.");
  }

  seen.add(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
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

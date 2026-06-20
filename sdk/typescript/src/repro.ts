export interface DeterminismOptions {
  readonly runs?: number;
}

type CanonicalValue =
  | {
      readonly kind: "undefined";
    }
  | {
      readonly kind: "null";
    }
  | {
      readonly kind: "string";
      readonly value: string;
    }
  | {
      readonly kind: "boolean";
      readonly value: boolean;
    }
  | {
      readonly kind: "number";
      readonly value: string;
    }
  | {
      readonly kind: "bigint";
      readonly value: string;
    }
  | {
      readonly kind: "array";
      readonly items: readonly CanonicalValue[];
    }
  | {
      readonly kind: "object";
      readonly entries: readonly CanonicalEntry[];
    };

type CanonicalEntry = readonly [string, CanonicalValue];

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
  if (value === undefined) {
    return {
      kind: "undefined",
    };
  }

  if (value === null) {
    return {
      kind: "null",
    };
  }

  if (typeof value === "string") {
    return {
      kind: "string",
      value,
    };
  }

  if (typeof value === "boolean") {
    return {
      kind: "boolean",
      value,
    };
  }

  if (typeof value === "number") {
    return {
      kind: "number",
      value: serializeNumber(value),
    };
  }

  if (typeof value === "bigint") {
    return {
      kind: "bigint",
      value: value.toString(),
    };
  }

  if (Array.isArray(value)) {
    guardAcyclic(value, seen);

    const items = Array.from({ length: value.length }, (_item, index) =>
      canonicalize(value[index], seen),
    );
    seen.delete(value);

    return {
      kind: "array",
      items,
    };
  }

  if (isPlainRecord(value)) {
    guardAcyclic(value, seen);

    const entries: CanonicalEntry[] = [];

    for (const key of Object.keys(value).sort(compareStrings)) {
      entries.push([key, canonicalize(value[key], seen)]);
    }

    seen.delete(value);

    return {
      kind: "object",
      entries,
    };
  }

  throw new TypeError(`Unsupported determinism result type: ${typeof value}.`);
}

function serializeNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }

  if (Object.is(value, -0)) {
    return "-0";
  }

  return String(value);
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

import { types as nodeTypes } from "node:util";

export type PlainJsonPrimitive = string | number | boolean | null;
export type PlainJson = PlainJsonPrimitive | PlainJsonObject | readonly PlainJson[];

export interface PlainJsonObject {
  readonly [key: string]: PlainJson;
}

export interface SafeNormalizeOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  /**
   * BigInt values are rejected by default because JSON has no BigInt type.
   * Set to "string" to encode BigInt primitives as decimal strings.
   */
  readonly bigint?: "reject" | "string";
}

export type SafeNormalizeResult =
  | {
      readonly ok: true;
      readonly value: PlainJson;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface NormalizedOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly bigint: "reject" | "string";
}

interface NormalizeState {
  nodes: number;
  readonly ancestors: Set<object>;
  readonly options: NormalizedOptions;
}

type NormalizeSuccess = Extract<SafeNormalizeResult, { readonly ok: true }>;
type NormalizeFailure = Extract<SafeNormalizeResult, { readonly ok: false }>;

const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_NODES = 100_000;
const MAX_DEPTH_LIMIT = 1_000;
const MAX_NODES_LIMIT = 1_000_000;
const ARRAY_LENGTH_KEY = "length";

const DEFAULT_OPTIONS: NormalizedOptions = Object.freeze({
  bigint: "reject",
  maxDepth: DEFAULT_MAX_DEPTH,
  maxNodes: DEFAULT_MAX_NODES,
});

export function safeNormalize(
  value: unknown,
  opts?: SafeNormalizeOptions,
): SafeNormalizeResult {
  try {
    const optionsResult = normalizeOptions(opts);

    if (!optionsResult.ok) {
      return optionsResult;
    }

    if (value === null || typeof value !== "object") {
      return reject("Top-level value must be a plain object or array.");
    }

    const state: NormalizeState = {
      ancestors: new Set<object>(),
      nodes: 0,
      options: optionsResult.value,
    };
    const result = normalizeValue(value, state, 0);

    if (!result.ok) {
      return result;
    }

    if (
      result.value === null ||
      typeof result.value !== "object" ||
      (!Array.isArray(result.value) && !isPlainJsonObject(result.value))
    ) {
      return reject("Top-level value must be a plain object or array.");
    }

    return result;
  } catch {
    return reject("Normalization failed.");
  }
}

function normalizeOptions(opts: SafeNormalizeOptions | undefined):
  | {
      readonly ok: true;
      readonly value: NormalizedOptions;
    }
  | NormalizeFailure {
  if (opts === undefined) {
    return {
      ok: true,
      value: DEFAULT_OPTIONS,
    };
  }

  if (opts === null || typeof opts !== "object") {
    return reject("Options must be a plain object.");
  }

  if (nodeTypes.isProxy(opts) || Array.isArray(opts)) {
    return reject("Options must be a plain object.");
  }

  const prototype = Object.getPrototypeOf(opts);

  if (prototype !== Object.prototype && prototype !== null) {
    return reject("Options must be a plain object.");
  }

  const keys = Reflect.ownKeys(opts);
  let maxDepth = DEFAULT_MAX_DEPTH;
  let maxNodes = DEFAULT_MAX_NODES;
  let bigint: "reject" | "string" = "reject";

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || typeof key === "symbol") {
      return reject("Options must contain only supported data properties.");
    }

    if (key !== "maxDepth" && key !== "maxNodes" && key !== "bigint") {
      return reject("Options must contain only supported data properties.");
    }

    const descriptor = Object.getOwnPropertyDescriptor(opts, key);

    if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      return reject("Options must contain only supported data properties.");
    }

    const optionValue: unknown = descriptor.value;

    if (key === "maxDepth") {
      if (!isAllowedInteger(optionValue, 0, MAX_DEPTH_LIMIT)) {
        return reject("Options must contain only supported data properties.");
      }

      maxDepth = optionValue;
    } else if (key === "maxNodes") {
      if (!isAllowedInteger(optionValue, 1, MAX_NODES_LIMIT)) {
        return reject("Options must contain only supported data properties.");
      }

      maxNodes = optionValue;
    } else if (optionValue === "reject" || optionValue === "string") {
      bigint = optionValue;
    } else {
      return reject("Options must contain only supported data properties.");
    }
  }

  return {
    ok: true,
    value: {
      bigint,
      maxDepth,
      maxNodes,
    },
  };
}

function normalizeValue(
  value: unknown,
  state: NormalizeState,
  depth: number,
): SafeNormalizeResult {
  if (!reserveNode(state)) {
    return reject("Node budget exceeded.");
  }

  if (depth > state.options.maxDepth) {
    return reject("Depth budget exceeded.");
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return accept(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? accept(value) : reject("Only finite numbers are accepted.");
  }

  if (typeof value === "bigint") {
    if (state.options.bigint === "string") {
      return accept(`${value}`);
    }

    return reject("BigInt values are not accepted.");
  }

  if (typeof value !== "object") {
    return reject("Only JSON data values are accepted.");
  }

  if (nodeTypes.isProxy(value)) {
    return reject("Proxy objects are not accepted.");
  }

  if (Array.isArray(value)) {
    return normalizeArray(value, state, depth);
  }

  return normalizeObject(value, state, depth);
}

function normalizeArray(
  value: readonly unknown[],
  state: NormalizeState,
  depth: number,
): SafeNormalizeResult {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Array.prototype) {
    return reject("Array subclasses are not accepted.");
  }

  if (state.ancestors.has(value)) {
    return reject("Cycles are not accepted.");
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, ARRAY_LENGTH_KEY);

  if (lengthDescriptor === undefined || !isDataDescriptor(lengthDescriptor)) {
    return reject("Arrays must contain only dense indexed data.");
  }

  const length = lengthDescriptor.value;

  if (!isAllowedInteger(length, 0, Number.MAX_SAFE_INTEGER)) {
    return reject("Arrays must contain only dense indexed data.");
  }

  if (state.nodes + length > state.options.maxNodes) {
    return reject("Node budget exceeded.");
  }

  const keys = Reflect.ownKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !isAllowedArrayOwnKey(key, length)) {
      return reject("Arrays must contain only dense indexed data.");
    }
  }

  const output: PlainJson[] = [];
  state.ancestors.add(value);

  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject("Arrays must contain only dense indexed data.");
      }

      const child = normalizeValue(descriptor.value, state, depth + 1);

      if (!child.ok) {
        return child;
      }

      output.push(child.value);
    }
  } finally {
    state.ancestors.delete(value);
  }

  return accept(Object.freeze(output));
}

function normalizeObject(
  value: object,
  state: NormalizeState,
  depth: number,
): SafeNormalizeResult {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return reject("Only plain objects are accepted.");
  }

  if (state.ancestors.has(value)) {
    return reject("Cycles are not accepted.");
  }

  const keys = Reflect.ownKeys(value);

  if (state.nodes + keys.length > state.options.maxNodes) {
    return reject("Node budget exceeded.");
  }

  const output: Record<string, PlainJson> = {};
  state.ancestors.add(value);

  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return reject("Objects must contain only string data properties.");
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject("Objects must contain only string data properties.");
      }

      const child = normalizeValue(descriptor.value, state, depth + 1);

      if (!child.ok) {
        return child;
      }

      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
  } finally {
    state.ancestors.delete(value);
  }

  return accept(Object.freeze(output));
}

function reserveNode(state: NormalizeState): boolean {
  if (state.nodes >= state.options.maxNodes) {
    return false;
  }

  state.nodes += 1;
  return true;
}

function isAllowedArrayOwnKey(key: string | symbol, length: number): boolean {
  if (typeof key === "symbol") {
    return false;
  }

  if (key === ARRAY_LENGTH_KEY) {
    return true;
  }

  const index = Number(key);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isAllowedInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPlainJsonObject(value: object): value is PlainJsonObject {
  return !Array.isArray(value);
}

function accept(value: PlainJson): NormalizeSuccess {
  return {
    ok: true,
    value,
  };
}

function reject(reason: string): NormalizeFailure {
  return {
    ok: false,
    reason,
  };
}

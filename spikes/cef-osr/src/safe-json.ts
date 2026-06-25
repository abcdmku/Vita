export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: string): Result<never> {
  return { ok: false, error };
}

const maxDepth = 64;
const maxArrayLength = 100_000;
const objectPrototype = Object.prototype;
const hasOwn = objectPrototype.hasOwnProperty;

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFiniteJsonNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readOwnKeys(value: object, path: string): Result<readonly PropertyKey[]> {
  try {
    return ok(Reflect.ownKeys(value));
  } catch (caught) {
    return err(`${path}: cannot inspect object keys (${caught instanceof Error ? caught.message : "unknown error"})`);
  }
}

function readDescriptor(value: object, key: PropertyKey, path: string): Result<PropertyDescriptor> {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return err(`${path}: missing descriptor for ${String(key)}`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
      return err(`${path}: accessor properties are rejected at ${String(key)}`);
    }
    return ok(descriptor);
  } catch (caught) {
    return err(`${path}: cannot inspect ${String(key)} (${caught instanceof Error ? caught.message : "unknown error"})`);
  }
}

function readPrototype(value: object, path: string): Result<object | null> {
  try {
    return ok(Object.getPrototypeOf(value) as object | null);
  } catch (caught) {
    return err(`${path}: cannot inspect prototype (${caught instanceof Error ? caught.message : "unknown error"})`);
  }
}

function ownValue(value: object, key: PropertyKey, path: string): Result<unknown> {
  const descriptor = readDescriptor(value, key, path);
  if (!descriptor.ok) {
    return descriptor;
  }
  return ok(descriptor.value.value as unknown);
}

function hasOwnKey(value: object, key: string): boolean {
  return hasOwn.call(value, key);
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key === "") {
    return false;
  }
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric >= 0 && numeric < length && String(numeric) === key;
}

function snapshotArray(value: readonly unknown[], seen: WeakSet<object>, depth: number, path: string): Result<readonly JsonValue[]> {
  const lengthValue = ownValue(value, "length", path);
  if (!lengthValue.ok) {
    return lengthValue;
  }
  if (!Number.isInteger(lengthValue.value) || typeof lengthValue.value !== "number" || lengthValue.value < 0) {
    return err(`${path}: invalid array length`);
  }
  if (lengthValue.value > maxArrayLength) {
    return err(`${path}: array is too large`);
  }

  const length = lengthValue.value;
  const keys = readOwnKeys(value, path);
  if (!keys.ok) {
    return keys;
  }
  for (let index = 0; index < keys.value.length; index += 1) {
    const key = keys.value[index];
    if (key === undefined) {
      return err(`${path}: key enumeration changed while inspecting array`);
    }
    if (typeof key !== "string") {
      return err(`${path}: symbol keys are rejected`);
    }
    if (key !== "length" && !isCanonicalArrayIndex(key, length)) {
      return err(`${path}: unexpected array property ${key}`);
    }
  }

  const output: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!hasOwnKey(value, key)) {
      return err(`${path}: sparse arrays are rejected`);
    }
    const item = ownValue(value, key, `${path}[${index}]`);
    if (!item.ok) {
      return item;
    }
    const cloned = safeSnapshotJson(item.value, seen, depth + 1, `${path}[${index}]`);
    if (!cloned.ok) {
      return cloned;
    }
    output.push(cloned.value);
  }
  return ok(output);
}

function snapshotObject(value: object, seen: WeakSet<object>, depth: number, path: string): Result<JsonObject> {
  const prototype = readPrototype(value, path);
  if (!prototype.ok) {
    return prototype;
  }
  if (prototype.value !== objectPrototype && prototype.value !== null) {
    return err(`${path}: expected a plain object`);
  }

  const keys = readOwnKeys(value, path);
  if (!keys.ok) {
    return keys;
  }

  const output = Object.create(null) as { [key: string]: JsonValue };
  for (let index = 0; index < keys.value.length; index += 1) {
    const key = keys.value[index];
    if (key === undefined) {
      return err(`${path}: key enumeration changed while inspecting object`);
    }
    if (typeof key !== "string") {
      return err(`${path}: symbol keys are rejected`);
    }
    const item = ownValue(value, key, `${path}.${key}`);
    if (!item.ok) {
      return item;
    }
    const cloned = safeSnapshotJson(item.value, seen, depth + 1, `${path}.${key}`);
    if (!cloned.ok) {
      return cloned;
    }
    Object.defineProperty(output, key, {
      value: cloned.value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return ok(output);
}

export function safeSnapshotJson(value: unknown, seen = new WeakSet<object>(), depth = 0, path = "$"): Result<JsonValue> {
  if (depth > maxDepth) {
    return err(`${path}: value is too deeply nested`);
  }
  if (isJsonPrimitive(value)) {
    if (typeof value === "number" && !isFiniteJsonNumber(value)) {
      return err(`${path}: non-finite numbers are rejected`);
    }
    return ok(value);
  }
  if (!isObjectLike(value)) {
    return err(`${path}: unsupported JSON value`);
  }
  if (seen.has(value)) {
    return err(`${path}: cyclic objects are rejected`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return snapshotArray(value as readonly unknown[], seen, depth, path);
  }
  return snapshotObject(value, seen, depth, path);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasJsonKey(value: JsonObject, key: string): boolean {
  return hasOwn.call(value, key);
}

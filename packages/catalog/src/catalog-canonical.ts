import { TextEncoder } from "node:util";

import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

const TEXT_ENCODER = new TextEncoder();

export function canonicalizeCatalog(value: unknown): string {
  const normalized = safeNormalize(value, { maxDepth: 128, maxNodes: 100_000 });

  if (!normalized.ok) {
    throw new TypeError(`Catalog value could not be canonicalized: ${normalized.reason}`);
  }

  return serializeCanonicalJson(normalized.value);
}

export function canonicalizeCatalogBytes(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(canonicalizeCatalog(value));
}

function serializeCanonicalJson(value: PlainJson): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Catalog canonicalization requires finite numbers.");
    }

    return JSON.stringify(value);
  }

  if (plainJsonArray(value)) {
    return serializeArray(value);
  }

  return serializeObject(value);
}

function serializeArray(value: readonly PlainJson[]): string {
  let output = "[";

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined) {
      throw new TypeError("Catalog canonicalization rejects sparse arrays.");
    }

    if (index > 0) {
      output += ",";
    }

    output += serializeCanonicalJson(item);
  }

  return `${output}]`;
}

function plainJsonArray(value: PlainJson): value is readonly PlainJson[] {
  return Array.isArray(value);
}

function serializeObject(value: PlainJsonObject): string {
  const keys = Object.keys(value).sort(compareStrings);
  let output = "{";

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      throw new TypeError("Catalog canonicalization could not inspect object key.");
    }

    if (index > 0) {
      output += ",";
    }

    const item = value[key];

    if (item === undefined) {
      throw new TypeError("Catalog canonicalization rejects undefined object values.");
    }

    output += `${JSON.stringify(key)}:${serializeCanonicalJson(item)}`;
  }

  return `${output}}`;
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

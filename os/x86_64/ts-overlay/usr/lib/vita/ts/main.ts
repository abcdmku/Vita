// Vita on-device TypeScript entrypoint (P1-033).
//
// Runs under the pinned, vendored Deno runtime as the vita-ts.service oneshot at boot.
// It keeps the original VITA-TS proof marker, then exercises the real deterministic
// config -> TransactionPlan evaluator vendored under ./vita/.
//
// Determinism / supply chain:
//   - NO remote imports. Every import is a relative path to a vendored file under this overlay.
//   - NO filesystem or network access. The evaluator is pure control-plane logic.
//   - The representative configs below are fixed literals, so the emitted plan hash is stable.

import { evaluateNodeConfig } from "./vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const TS_MARKER = "VITA-TS";
const EVAL_MARKER = "VITA-EVAL";
const REJECT_MARKER = "VITA-EVAL-REJECT";

const CAPABILITY_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);

const VALID_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "normal",
      remoteAccess: "disabled",
    }),
  }),
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze(["Pool.NTP.Org", "2001:0db8::1"]),
    }),
  }),
});

const INVALID_CONFIG = Object.freeze({
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze([]),
    }),
  }),
});

function emit(line: string): void {
  console.log(line);
}

function main(): number {
  emit(`${TS_MARKER}: hello from Deno ${Deno.version.deno} status=OK`);

  const valid = evaluateNodeConfig(VALID_CONFIG, CAPABILITY_REGISTRY);

  if (!valid.ok) {
    const first = valid.rejections[0];
    const code = first?.code ?? "NO_REJECTION";
    emit(`${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ops=0 planHash=0 status=FAIL code=${code}`);
    return 1;
  }

  const canonicalPlan = stableStringify(valid.plan);
  emit(
    `${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ` +
      `ops=${valid.plan.operations.length} ` +
      `planHash=${fnv1a64Hex(canonicalPlan)} ` +
      "status=OK",
  );

  const invalid = evaluateNodeConfig(INVALID_CONFIG, CAPABILITY_REGISTRY);

  if (invalid.ok) {
    emit(`${REJECT_MARKER}: code=NOT_REJECTED status=FAIL`);
    return 1;
  }

  const firstRejection = invalid.rejections[0];
  const rejectionCode = firstRejection?.code ?? "NO_REJECTION";
  emit(`${REJECT_MARKER}: code=${rejectionCode} status=OK`);

  return firstRejection === undefined ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        items.push(stableStringify(item));
      }
    }

    return `[${items.join(",")}]`;
  }

  if (!isJsonObject(value)) {
    return JSON.stringify(null);
  }

  const keys = Object.keys(value).sort(compareStrings);
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) {
      entries.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
    }
  }

  return `{${entries.join(",")}}`;
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;

  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index);

    if (codePoint === undefined) {
      continue;
    }

    if (codePoint > 0xffff) {
      index += 1;
    }

    hash = writeUtf8Byte(hash, codePoint);
  }

  return hash.toString(16).padStart(16, "0");
}

function writeUtf8Byte(hash: bigint, codePoint: number): bigint {
  if (codePoint <= 0x7f) {
    return fnvStep(hash, codePoint);
  }

  if (codePoint <= 0x7ff) {
    return fnvStep(fnvStep(hash, 0xc0 | (codePoint >> 6)), 0x80 | (codePoint & 0x3f));
  }

  if (codePoint <= 0xffff) {
    return fnvStep(
      fnvStep(fnvStep(hash, 0xe0 | (codePoint >> 12)), 0x80 | ((codePoint >> 6) & 0x3f)),
      0x80 | (codePoint & 0x3f),
    );
  }

  return fnvStep(
    fnvStep(
      fnvStep(fnvStep(hash, 0xf0 | (codePoint >> 18)), 0x80 | ((codePoint >> 12) & 0x3f)),
      0x80 | ((codePoint >> 6) & 0x3f),
    ),
    0x80 | (codePoint & 0x3f),
  );
}

function fnvStep(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
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

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

Deno.exit(main());

import { createHash } from "node:crypto";

import { isCanonicalPlan } from "./plan.ts";
import type { CanonicalJsonValue, CanonicalPlan } from "./plan.ts";

export const PLAN_ENVELOPE_SCHEMA_VERSION = 1;

export interface PlanEnvelope {
  readonly schemaVersion: number;
  /**
   * Legacy field name for the envelope digest. This is an unkeyed SHA-256
   * corruption check over schemaVersion, createdAtRef, and plan; it is not a
   * signature or authenticity boundary.
   */
  readonly planHash: string;
  readonly plan: CanonicalPlan;
  readonly createdAtRef: string;
}

export interface PlanEnvelopeMeta {
  readonly createdAtRef: string;
}

/**
 * Adds an unkeyed recomputable digest for deterministic corruption detection.
 * Authenticity/signing belongs to the trusted Go agent, not this SDK helper.
 */
export function sealEnvelope(plan: CanonicalPlan, meta: PlanEnvelopeMeta): PlanEnvelope {
  const schemaVersion = PLAN_ENVELOPE_SCHEMA_VERSION;
  const createdAtRef = meta.createdAtRef;

  return {
    schemaVersion,
    planHash: envelopeHash(schemaVersion, createdAtRef, plan),
    plan,
    createdAtRef,
  };
}

/**
 * Checks the unkeyed envelope digest and canonical plan structure.
 * A true result detects accidental corruption only; it is not tamper-proof.
 */
export function verifyEnvelope(env: unknown): boolean {
  try {
    if (!isRecord(env) || !hasOnlyFields(env, ENVELOPE_FIELDS)) {
      return false;
    }

    const { schemaVersion, planHash, plan, createdAtRef } = env;

    if (
      schemaVersion !== PLAN_ENVELOPE_SCHEMA_VERSION ||
      typeof planHash !== "string" ||
      typeof createdAtRef !== "string" ||
      !isCanonicalPlan(plan)
    ) {
      return false;
    }

    return (
      planHash === envelopeHash(schemaVersion, createdAtRef, plan)
    );
  } catch {
    return false;
  }
}

export function encodeEnvelope(env: PlanEnvelope): string {
  return canonicalJson(env);
}

function envelopeHash(
  schemaVersion: number,
  createdAtRef: string,
  plan: CanonicalPlan,
): string {
  return createHash("sha256")
    .update(canonicalJson({ createdAtRef, plan, schemaVersion }), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);

  if (canonical === undefined) {
    throw new TypeError("Canonical envelope values cannot be undefined.");
  }

  return JSON.stringify(canonical);
}

function canonicalize(value: unknown): CanonicalJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Envelope numbers must be finite.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    const items: CanonicalJsonValue[] = [];

    for (const item of value) {
      const canonicalItem = canonicalize(item);

      if (canonicalItem !== undefined) {
        items.push(canonicalItem);
      }
    }

    return items;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, CanonicalJsonValue> = {};

    for (const key of Object.keys(record).sort()) {
      const canonicalValue = canonicalize(record[key]);

      if (canonicalValue !== undefined) {
        output[key] = canonicalValue;
      }
    }

    return output;
  }

  throw new TypeError(`Unsupported envelope value type: ${typeof value}.`);
}

type JsonRecord = Readonly<Record<string, unknown>>;

const ENVELOPE_FIELDS = new Set(["createdAtRef", "plan", "planHash", "schemaVersion"]);

function hasOnlyFields(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

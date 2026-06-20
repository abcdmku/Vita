import { planHash } from "./plan.ts";
import type { CanonicalJsonValue, CanonicalPlan } from "./plan.ts";

export const PLAN_ENVELOPE_SCHEMA_VERSION = 1;

export interface PlanEnvelope {
  readonly schemaVersion: number;
  readonly planHash: string;
  readonly plan: CanonicalPlan;
  readonly createdAtRef: string;
}

export interface PlanEnvelopeMeta {
  readonly createdAtRef: string;
}

export function sealEnvelope(plan: CanonicalPlan, meta: PlanEnvelopeMeta): PlanEnvelope {
  return {
    schemaVersion: PLAN_ENVELOPE_SCHEMA_VERSION,
    planHash: planHash(plan),
    plan,
    createdAtRef: meta.createdAtRef,
  };
}

export function verifyEnvelope(env: PlanEnvelope): boolean {
  try {
    return (
      env.schemaVersion === PLAN_ENVELOPE_SCHEMA_VERSION &&
      typeof env.planHash === "string" &&
      typeof env.createdAtRef === "string" &&
      env.planHash === planHash(env.plan)
    );
  } catch {
    return false;
  }
}

export function encodeEnvelope(env: PlanEnvelope): string {
  return canonicalJson(env);
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

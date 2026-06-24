// Vendored from sdk/typescript/src/drift.ts
import {
  diffTransactionPlans,
  TransactionPlanDiffError,
} from "./transaction-plan-diff.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type {
  PlanOperation,
  TransactionPlanChange,
  TransactionPlan,
} from "./transaction-plan-diff.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "./safe-normalize.ts";

export interface ObservedState {
  readonly [capability: string]: PlainJsonObject;
}

export interface DriftResult {
  readonly drifted: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface ObservedStateProjection {
  readonly capability: string;
  readonly project: (state: PlainJsonObject) => PlanOperation["request"];
}

export class DriftError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DriftError";
  }
}

export const DRIFT_OBSERVED_PROJECTIONS = Object.freeze([
  Object.freeze({
    capability: "hostname.set",
    project: projectHostnameSet,
  }),
]) satisfies readonly ObservedStateProjection[];

export const DRIFT_OBSERVED_CAPABILITIES = Object.freeze(
  DRIFT_OBSERVED_PROJECTIONS
    .map((projection) => projection.capability)
    .sort(compareStrings),
);

const PROJECTION_BY_CAPABILITY = buildProjectionMap(DRIFT_OBSERVED_PROJECTIONS);

export function computeDrift(
  declared: TransactionPlan,
  observed: ObservedState,
): DriftResult {
  const observedPlan = projectObservedStateToPlan(observed);

  let change: TransactionPlanChange;
  try {
    change = diffTransactionPlans(declared, observedPlan);
  } catch (cause) {
    if (cause instanceof TransactionPlanDiffError) {
      throw new DriftError(`Unable to diff drift plans: ${cause.message}`);
    }

    throw cause;
  }

  return Object.freeze({
    drifted: change.added.length + change.removed.length + change.changed.length > 0,
    added: change.added,
    removed: change.removed,
    changed: change.changed,
  });
}

function projectObservedStateToPlan(observed: ObservedState): TransactionPlan {
  const normalizedObserved = normalizeObservedState(observed);
  const capabilityNames = Object.keys(normalizedObserved).sort(compareStrings);
  const operations: PlanOperation[] = [];

  for (let index = 0; index < capabilityNames.length; index += 1) {
    const capability = capabilityNames[index];

    if (capability === undefined) {
      continue;
    }

    const state = normalizedObserved[capability];

    if (!isPlainJsonObject(state)) {
      throw new DriftError(`Observed state for ${capability} must be an object.`);
    }

    const projection = PROJECTION_BY_CAPABILITY[capability];

    if (projection === undefined) {
      continue;
    }

    operations.push(Object.freeze({
      capability,
      request: projection.project(state),
    }));
  }

  return Object.freeze({
    operations: Object.freeze(operations),
  });
}

function normalizeObservedState(observed: ObservedState): PlainJsonObject {
  const normalized = safeNormalize(observed);

  if (!normalized.ok) {
    throw new DriftError(`Observed state is malformed: ${normalized.reason}`);
  }

  if (!isPlainJsonObject(normalized.value)) {
    throw new DriftError("Observed state must be an object.");
  }

  return normalized.value;
}

function projectHostnameSet(state: PlainJsonObject): PlanOperation["request"] {
  const current = Object.hasOwn(state, "current") ? state["current"] : undefined;

  if (typeof current !== "string" || current.length === 0) {
    throw new DriftError("hostname.set observed state is missing current.");
  }

  return Object.freeze({
    desired: current,
  });
}

type ProjectionMap = Record<string, ObservedStateProjection>;

function buildProjectionMap(
  projections: readonly ObservedStateProjection[],
): ProjectionMap {
  const map: ProjectionMap = Object.create(null) as ProjectionMap;

  for (let index = 0; index < projections.length; index += 1) {
    const projection = projections[index];

    if (projection === undefined) {
      continue;
    }

    Object.defineProperty(map, projection.capability, {
      configurable: true,
      enumerable: true,
      value: projection,
      writable: false,
    });
  }

  return Object.freeze(map);
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
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

import type { CanonicalJsonValue, CanonicalPlan } from "./plan.ts";

export type PlanDiffValue = CanonicalJsonValue;

export interface AddedPlanDiffChange {
  readonly kind: "added";
  readonly path: string;
  readonly after: PlanDiffValue;
}

export interface RemovedPlanDiffChange {
  readonly kind: "removed";
  readonly path: string;
  readonly before: PlanDiffValue;
}

export interface ChangedPlanDiffChange {
  readonly kind: "changed";
  readonly path: string;
  readonly before: PlanDiffValue;
  readonly after: PlanDiffValue;
}

export type PlanDiffChange =
  | AddedPlanDiffChange
  | RemovedPlanDiffChange
  | ChangedPlanDiffChange;

export interface PlanDiff {
  readonly changes: readonly PlanDiffChange[];
}

type Path = readonly string[];
type JsonRecord = Readonly<Record<string, unknown>>;

export function diffPlans(before: CanonicalPlan, after: CanonicalPlan): PlanDiff {
  const changes: PlanDiffChange[] = [];

  diffValue([], before, after, changes);

  return {
    changes: [...changes].sort(compareChanges),
  };
}

export function renderPlanDiff(diff: PlanDiff): string {
  return [...diff.changes].sort(compareChanges).map(renderChange).join("\n");
}

function diffValue(
  path: Path,
  before: unknown,
  after: unknown,
  changes: PlanDiffChange[],
): void {
  if (Object.is(before, after)) {
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(path, before, after, changes);
    return;
  }

  if (isJsonRecord(before) && isJsonRecord(after)) {
    diffObject(path, before, after, changes);
    return;
  }

  changes.push({
    kind: "changed",
    path: formatPath(path),
    before: asPlanDiffValue(before),
    after: asPlanDiffValue(after),
  });
}

function diffObject(
  path: Path,
  before: JsonRecord,
  after: JsonRecord,
  changes: PlanDiffChange[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareStrings);

  for (const key of keys) {
    const childPath = [...path, key];
    const beforeHasKey = hasOwn(before, key);
    const afterHasKey = hasOwn(after, key);

    if (!beforeHasKey && afterHasKey) {
      changes.push({
        kind: "added",
        path: formatPath(childPath),
        after: asPlanDiffValue(after[key]),
      });
      continue;
    }

    if (beforeHasKey && !afterHasKey) {
      changes.push({
        kind: "removed",
        path: formatPath(childPath),
        before: asPlanDiffValue(before[key]),
      });
      continue;
    }

    diffValue(childPath, before[key], after[key], changes);
  }
}

function diffArray(
  path: Path,
  before: readonly unknown[],
  after: readonly unknown[],
  changes: PlanDiffChange[],
): void {
  if (isTopLevelIdCollection(path) && hasUniqueStringIds(before) && hasUniqueStringIds(after)) {
    diffIdCollection(path, before, after, changes);
    return;
  }

  const length = Math.max(before.length, after.length);

  for (let index = 0; index < length; index += 1) {
    const childPath = [...path, String(index)];
    const beforeHasIndex = index < before.length;
    const afterHasIndex = index < after.length;

    if (!beforeHasIndex && afterHasIndex) {
      changes.push({
        kind: "added",
        path: formatPath(childPath),
        after: asPlanDiffValue(after[index]),
      });
      continue;
    }

    if (beforeHasIndex && !afterHasIndex) {
      changes.push({
        kind: "removed",
        path: formatPath(childPath),
        before: asPlanDiffValue(before[index]),
      });
      continue;
    }

    diffValue(childPath, before[index], after[index], changes);
  }
}

function diffIdCollection(
  path: Path,
  before: readonly IdentifiedRecord[],
  after: readonly IdentifiedRecord[],
  changes: PlanDiffChange[],
): void {
  const beforeById = new Map(before.map((item) => [item.id, item] as const));
  const afterById = new Map(after.map((item) => [item.id, item] as const));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort(compareStrings);

  for (const id of ids) {
    const childPath = [...path, id];
    const beforeItem = beforeById.get(id);
    const afterItem = afterById.get(id);

    if (beforeItem === undefined && afterItem !== undefined) {
      changes.push({
        kind: "added",
        path: formatPath(childPath),
        after: asPlanDiffValue(afterItem),
      });
      continue;
    }

    if (beforeItem !== undefined && afterItem === undefined) {
      changes.push({
        kind: "removed",
        path: formatPath(childPath),
        before: asPlanDiffValue(beforeItem),
      });
      continue;
    }

    diffValue(childPath, beforeItem, afterItem, changes);
  }
}

interface IdentifiedRecord extends JsonRecord {
  readonly id: string;
}

function hasUniqueStringIds(values: readonly unknown[]): values is readonly IdentifiedRecord[] {
  const ids = new Set<string>();

  for (const value of values) {
    if (!isJsonRecord(value) || typeof value.id !== "string") {
      return false;
    }

    if (ids.has(value.id)) {
      return false;
    }

    ids.add(value.id);
  }

  return true;
}

function isTopLevelIdCollection(path: Path): boolean {
  return path.length === 1 && (path[0] === "apps" || path[0] === "backups");
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asPlanDiffValue(value: unknown): PlanDiffValue {
  return value as PlanDiffValue;
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function renderChange(change: PlanDiffChange): string {
  const path = change.path === "" ? "(root)" : change.path;

  switch (change.kind) {
    case "added":
      return `+ ${path}`;
    case "removed":
      return `- ${path}`;
    case "changed":
      return `~ ${path}: ${formatValue(change.before)} -> ${formatValue(change.after)}`;
  }
}

function formatValue(value: PlanDiffValue): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value) ?? "";
}

function compareChanges(left: PlanDiffChange, right: PlanDiffChange): number {
  return compareStrings(left.path, right.path) || compareStrings(left.kind, right.kind);
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

import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type SlotId = "a" | "b";

export interface SlotState {
  readonly id: SlotId;
  readonly active: boolean;
  readonly bootable: boolean;
  readonly version: string;
}

export interface UpdateBundleRef {
  readonly ref: string;
  readonly integrity: string;
  readonly version: string;
}

export interface UpdatePolicy {
  readonly automaticRollback: boolean;
  readonly maxFailedBoots: number;
}

export interface UpdateConfig {
  readonly slots: readonly SlotState[];
  readonly policy: UpdatePolicy;
}

export interface UpdatePlan {
  readonly targetSlot: SlotId;
  readonly bundle: UpdateBundleRef;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: UpdateConfig; readonly value: UpdateConfig }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type PlanResult =
  | { readonly ok: true; readonly plan: UpdatePlan; readonly value: UpdatePlan }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const CONFIG_FIELDS = new Set(["policy", "slots"]);
const SLOT_FIELDS = new Set(["active", "bootable", "id", "version"]);
const POLICY_FIELDS = new Set(["automaticRollback", "maxFailedBoots"]);
const BUNDLE_FIELDS = new Set(["integrity", "ref", "version"]);
const PLAN_FIELDS = new Set(["bundle", "targetSlot"]);

const SLOT_IDS = new Set<SlotId>(["a", "b"]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SRI_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]{20,}={0,2}$/u;
const MAX_FAILED_BOOTS = 10;

export function validateUpdateConfig(input: unknown): ConfigResult {
  try {
    const normalized = safeNormalize(input);
    if (!normalized.ok) {
      return rejectConfig([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }
    const errors: ValidationError[] = [];
    const config = parseUpdateConfig(normalized.value, [], errors);
    if (config === undefined || errors.length > 0) return rejectConfig(errors);
    return { ok: true, config, value: config };
  } catch {
    return rejectConfig([{ path: "", message: "Update config validation failed." }]);
  }
}

export function validateUpdatePlan(input: unknown): PlanResult {
  try {
    const normalized = safeNormalize(input);
    if (!normalized.ok) {
      return rejectPlan([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }
    const errors: ValidationError[] = [];
    const plan = parseUpdatePlan(normalized.value, [], errors);
    if (plan === undefined || errors.length > 0) return rejectPlan(errors);
    return { ok: true, plan, value: plan };
  } catch {
    return rejectPlan([{ path: "", message: "Update plan validation failed." }]);
  }
}

function parseUpdateConfig(value: PlainJson, path: Path, errors: ValidationError[]): UpdateConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected update config object.");
    return undefined;
  }
  const errorStart = errors.length;
  rejectUnknownFields(value, CONFIG_FIELDS, path, errors);

  const slots = parseSlots(value, [...path, "slots"], errors);
  const policy = parsePolicy(value, [...path, "policy"], errors);

  if (errors.length > errorStart || slots === undefined || policy === undefined) return undefined;
  return Object.freeze({ slots, policy });
}

function parseSlots(value: JsonRecord, path: Path, errors: ValidationError[]): readonly SlotState[] | undefined {
  const child = readRequiredProperty(value, "slots", path, errors);
  if (child === undefined) return undefined;
  if (!Array.isArray(child)) {
    addError(errors, path, "Expected slots array.");
    return undefined;
  }

  const errorStart = errors.length;
  const slots: SlotState[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < child.length; index += 1) {
    const slot = parseSlot(child[index], [...path, String(index)], errors);
    if (slot === undefined) continue;
    if (ids.has(slot.id)) {
      addError(errors, [...path, String(index), "id"], "Duplicate slot id.");
      continue;
    }
    ids.add(slot.id);
    slots.push(slot);
  }
  if (errors.length > errorStart) return undefined;

  // A/B invariants: exactly the two slots {a,b}, exactly one active.
  if (slots.length !== 2 || !ids.has("a") || !ids.has("b")) {
    addError(errors, path, "Expected exactly two slots with ids a and b.");
    return undefined;
  }
  const active = slots.filter((slot) => slot.active);
  if (active.length !== 1) {
    addError(errors, path, "Exactly one slot must be active.");
    return undefined;
  }
  return Object.freeze(slots);
}

function parseSlot(value: PlainJson | undefined, path: Path, errors: ValidationError[]): SlotState | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected slot object.");
    return undefined;
  }
  const errorStart = errors.length;
  rejectUnknownFields(value, SLOT_FIELDS, path, errors);

  const id = readString(value, "id", [...path, "id"], errors);
  if (id !== undefined && !SLOT_IDS.has(id as SlotId)) {
    addError(errors, [...path, "id"], "Expected slot id a or b.");
  }
  const active = readBoolean(value, "active", [...path, "active"], errors);
  const bootable = readBoolean(value, "bootable", [...path, "bootable"], errors);
  const version = readString(value, "version", [...path, "version"], errors);
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    addError(errors, [...path, "version"], "Expected a valid version string.");
  }

  if (
    errors.length > errorStart ||
    id === undefined ||
    !SLOT_IDS.has(id as SlotId) ||
    active === undefined ||
    bootable === undefined ||
    version === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ id: id as SlotId, active, bootable, version });
}

function parsePolicy(value: JsonRecord, path: Path, errors: ValidationError[]): UpdatePolicy | undefined {
  const child = readRequiredProperty(value, "policy", path, errors);
  if (child === undefined) return undefined;
  if (!isRecord(child)) {
    addError(errors, path, "Expected policy object.");
    return undefined;
  }
  const errorStart = errors.length;
  rejectUnknownFields(child, POLICY_FIELDS, path, errors);

  const automaticRollback = readBoolean(child, "automaticRollback", [...path, "automaticRollback"], errors);
  const maxFailedBoots = readNumber(child, "maxFailedBoots", [...path, "maxFailedBoots"], errors);
  if (
    maxFailedBoots !== undefined &&
    (!Number.isInteger(maxFailedBoots) || maxFailedBoots < 1 || maxFailedBoots > MAX_FAILED_BOOTS)
  ) {
    addError(errors, [...path, "maxFailedBoots"], "Expected maxFailedBoots 1-10.");
  }

  if (errors.length > errorStart || automaticRollback === undefined || maxFailedBoots === undefined) {
    return undefined;
  }
  return Object.freeze({ automaticRollback, maxFailedBoots });
}

function parseUpdatePlan(value: PlainJson, path: Path, errors: ValidationError[]): UpdatePlan | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected update plan object.");
    return undefined;
  }
  const errorStart = errors.length;
  rejectUnknownFields(value, PLAN_FIELDS, path, errors);

  const targetSlot = readString(value, "targetSlot", [...path, "targetSlot"], errors);
  if (targetSlot !== undefined && !SLOT_IDS.has(targetSlot as SlotId)) {
    addError(errors, [...path, "targetSlot"], "Expected target slot a or b.");
  }
  const bundle = parseBundle(value, [...path, "bundle"], errors);

  if (
    errors.length > errorStart ||
    targetSlot === undefined ||
    !SLOT_IDS.has(targetSlot as SlotId) ||
    bundle === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ targetSlot: targetSlot as SlotId, bundle });
}

function parseBundle(value: JsonRecord, path: Path, errors: ValidationError[]): UpdateBundleRef | undefined {
  const child = readRequiredProperty(value, "bundle", path, errors);
  if (child === undefined) return undefined;
  if (!isRecord(child)) {
    addError(errors, path, "Expected bundle object.");
    return undefined;
  }
  const errorStart = errors.length;
  rejectUnknownFields(child, BUNDLE_FIELDS, path, errors);

  const ref = readString(child, "ref", [...path, "ref"], errors);
  if (ref !== undefined && !REF_PATTERN.test(ref)) {
    addError(errors, [...path, "ref"], "Expected a valid bundle reference.");
  }
  const integrity = readString(child, "integrity", [...path, "integrity"], errors);
  if (integrity !== undefined && !SRI_PATTERN.test(integrity)) {
    addError(errors, [...path, "integrity"], "Expected a real SRI integrity (sha256/384/512).");
  }
  const version = readString(child, "version", [...path, "version"], errors);
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    addError(errors, [...path, "version"], "Expected a valid version string.");
  }

  if (
    errors.length > errorStart ||
    ref === undefined ||
    integrity === undefined ||
    version === undefined ||
    !REF_PATTERN.test(ref) ||
    !SRI_PATTERN.test(integrity)
  ) {
    return undefined;
  }
  return Object.freeze({ ref, integrity, version });
}

/**
 * A/B safety: an update plan must target the INACTIVE slot (never overwrite the running slot).
 * Validates the plan against a validated config; returns the surviving errors.
 */
export function validatePlanAgainstConfig(config: UpdateConfig, plan: UpdatePlan): readonly ValidationError[] {
  const activeSlot = config.slots.find((slot) => slot.active);
  if (activeSlot !== undefined && plan.targetSlot === activeSlot.id) {
    return [{ path: "targetSlot", message: "Update plan must target the inactive slot, not the active one." }];
  }
  return [];
}

function readRequiredProperty(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): PlainJson | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }
  return value[key];
}

function readString(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);
  if (child === undefined) return undefined;
  if (typeof child !== "string") {
    addError(errors, path, "Expected string.");
    return undefined;
  }
  return child;
}

function readNumber(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);
  if (child === undefined) return undefined;
  if (typeof child !== "number" || !Number.isFinite(child)) {
    addError(errors, path, "Expected number.");
    return undefined;
  }
  return child;
}

function readBoolean(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): boolean | undefined {
  const child = readRequiredProperty(value, key, path, errors);
  if (child === undefined) return undefined;
  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }
  return child;
}

function rejectUnknownFields(value: JsonRecord, allowed: ReadonlySet<string>, path: Path, errors: ValidationError[]): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key)) addError(errors, [...path, key], "Unknown field.");
  }
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({ message, path: formatPath(path) });
}

function rejectConfig(errors: readonly ValidationError[]): Extract<ConfigResult, { readonly ok: false }> {
  return { ok: false, errors };
}

function rejectPlan(errors: readonly ValidationError[]): Extract<PlanResult, { readonly ok: false }> {
  return { ok: false, errors };
}

function formatPath(path: Path): string {
  return path.map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

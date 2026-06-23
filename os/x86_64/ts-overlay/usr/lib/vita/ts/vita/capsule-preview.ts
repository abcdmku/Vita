// Vendored from controller/capsule/src/capsule-preview.ts, with on-device read
// and marker helpers for the vita-ts boot overlay.
import { createAgentClient } from "./agent-client.ts";
import { validateCapsuleRegistry } from "./capsule-registry-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import { createDenoUnixSocketAgentTransport } from "./unix-socket-transport.ts";
import type { AgentClient } from "./agent-client.ts";
import type {
  CapsuleEntry,
  CapsuleEntryState,
  CapsuleId,
  CapsuleIntegrity,
  CapsuleRegistry,
  CapsuleRegistryValidationError,
} from "./capsule-registry-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type CapsuleChangeRejectionCode =
  | "INVALID_CURRENT_REGISTRY"
  | "INVALID_DESIRED_REGISTRY"
  | "PREVIEW_FAILED";

export type CapsuleChangeRejectionSource = "current" | "desired" | "preview";

export interface CapsuleChangeRejection {
  readonly code: CapsuleChangeRejectionCode;
  readonly source: CapsuleChangeRejectionSource;
  readonly path: string;
  readonly message: string;
}

export interface CapsuleEntryPreview {
  readonly id: CapsuleId;
  readonly integrity: CapsuleIntegrity;
  readonly state: CapsuleEntryState;
  readonly version: string;
}

export interface InstalledCapsuleChange {
  readonly kind: "installed";
  readonly id: CapsuleId;
  readonly after: CapsuleEntryPreview;
}

export interface RemovedCapsuleChange {
  readonly kind: "removed";
  readonly id: CapsuleId;
  readonly before: CapsuleEntryPreview;
}

export interface CapsuleVersionChange {
  readonly kind: "upgraded" | "downgraded";
  readonly id: CapsuleId;
  readonly oldVersion: string;
  readonly newVersion: string;
}

export interface CapsuleStateChange {
  readonly kind: "stateChanged";
  readonly id: CapsuleId;
  readonly oldState: CapsuleEntryState;
  readonly newState: CapsuleEntryState;
}

export interface CapsuleChangeDiff {
  readonly installed: Readonly<Record<CapsuleId, InstalledCapsuleChange>>;
  readonly removed: Readonly<Record<CapsuleId, RemovedCapsuleChange>>;
  readonly upgraded: Readonly<Record<CapsuleId, CapsuleVersionChange>>;
  readonly downgraded: Readonly<Record<CapsuleId, CapsuleVersionChange>>;
  readonly stateChanged: Readonly<Record<CapsuleId, CapsuleStateChange>>;
}

export type CapsuleChangePreview =
  | {
      readonly valid: true;
      readonly diff: CapsuleChangeDiff;
      readonly integrityChanged: boolean;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: null;
      readonly integrityChanged: false;
      readonly rejections: readonly CapsuleChangeRejection[];
    };

export interface CapsulePreviewCounts {
  readonly installed: number;
  readonly removed: number;
  readonly upgraded: number;
}

export type CapsuleRegistryReadResult =
  | {
      readonly ok: true;
      readonly registry: CapsuleRegistry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type CapsuleRegistryPreviewResult =
  | {
      readonly ok: true;
      readonly counts: CapsulePreviewCounts;
      readonly preview: CapsuleChangePreview;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface CapsuleAgentdReadOptions {
  readonly socketPath: string;
  readonly baseUrl?: string | URL;
  readonly desired?: unknown;
}

const CAPSULE_REGISTRY_CAPABILITY = "capsule.registry";
const DEFAULT_AGENTD_BASE_URL = "http://agentd";
const READ_RESPONSE_REQUIRED_FIELDS = Object.freeze(["exists"]);
const READ_RESPONSE_OPTIONAL_FIELDS = Object.freeze(["registry", "raw"]);
const REGISTRY_RESPONSE_FIELDS = Object.freeze(["capsules"]);
const EMPTY_CAPSULE_REGISTRY = Object.freeze([]) satisfies CapsuleRegistry;
const NO_REJECTIONS: readonly [] = Object.freeze([]);

export const ON_DEVICE_CAPSULE_ENTRY = Object.freeze({
  id: "local.test.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;

export const ON_DEVICE_CAPSULE_REGISTRY = Object.freeze([
  ON_DEVICE_CAPSULE_ENTRY,
]) satisfies CapsuleRegistry;

export async function readCapsuleRegistryPreview(
  client: Pick<AgentClient, "getState">,
  desired: unknown = ON_DEVICE_CAPSULE_REGISTRY,
): Promise<CapsuleRegistryPreviewResult> {
  try {
    const current = parseCapsuleRegistryReadResponse(
      await client.getState(CAPSULE_REGISTRY_CAPABILITY),
    );

    if (!current.ok) {
      return rejectRegistryPreview(current.reason);
    }

    const preview = previewCapsuleChange(current.registry, desired);

    if (!preview.valid) {
      return rejectRegistryPreview("Capsule registry preview validation failed.");
    }

    return {
      counts: countCapsuleDiff(preview.diff),
      ok: true,
      preview,
    };
  } catch (cause) {
    return rejectRegistryPreview(describeError(cause));
  }
}

export function readCapsuleRegistryPreviewFromAgentd(
  options: CapsuleAgentdReadOptions,
): Promise<CapsuleRegistryPreviewResult> {
  const client = createAgentClient({
    baseUrl: options.baseUrl ?? DEFAULT_AGENTD_BASE_URL,
    transport: createDenoUnixSocketAgentTransport({
      socketPath: options.socketPath,
    }),
  });

  return readCapsuleRegistryPreview(client, options.desired ?? ON_DEVICE_CAPSULE_REGISTRY);
}

export function parseCapsuleRegistryReadResponse(response: unknown): CapsuleRegistryReadResult {
  try {
    const normalized = safeNormalize(response);

    if (!normalized.ok) {
      return rejectRegistryRead(normalized.reason);
    }
    if (!isPlainObject(normalized.value)) {
      return rejectRegistryRead("Capsule registry read response must be an object.");
    }

    const fields = expectFields(
      normalized.value,
      READ_RESPONSE_REQUIRED_FIELDS,
      READ_RESPONSE_OPTIONAL_FIELDS,
    );
    if (!fields.ok) {
      return fields;
    }

    const raw = optionalField(normalized.value, "raw");
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return rejectRegistryRead("Capsule registry read raw must be a string or null.");
    }

    const exists = field(normalized.value, "exists");
    if (typeof exists !== "boolean") {
      return rejectRegistryRead("Capsule registry read exists must be a boolean.");
    }

    if (!exists) {
      return {
        ok: true,
        registry: EMPTY_CAPSULE_REGISTRY,
      };
    }

    const registryValue = field(normalized.value, "registry");
    if (!isPlainObject(registryValue)) {
      return rejectRegistryRead("Capsule registry read registry must be an object.");
    }

    const registryFields = expectFields(registryValue, REGISTRY_RESPONSE_FIELDS);
    if (!registryFields.ok) {
      return registryFields;
    }

    const capsules = field(registryValue, "capsules");
    const registry = validateCapsuleRegistry(capsules);

    if (!registry.ok) {
      return rejectRegistryRead("Capsule registry read registry failed validation.");
    }

    return {
      ok: true,
      registry: registry.registry,
    };
  } catch {
    return rejectRegistryRead("Capsule registry read response validation failed.");
  }
}

export function formatCapsuleRegistryPreviewMarker(
  result: CapsuleRegistryPreviewResult,
): string {
  if (!result.ok) {
    return "VITA-CAPSULE-PREVIEW-ERROR: status=FAILSAFE";
  }

  return (
    "VITA-CAPSULE-PREVIEW: " +
    `installed=${result.counts.installed} ` +
    `removed=${result.counts.removed} ` +
    `upgraded=${result.counts.upgraded} ` +
    "status=OK"
  );
}

export function previewCapsuleChange(current: unknown, desired: unknown): CapsuleChangePreview {
  try {
    const currentResult = validateCapsuleRegistry(current);
    const desiredResult = validateCapsuleRegistry(desired);
    const rejections: CapsuleChangeRejection[] = [];

    let currentRegistry: CapsuleRegistry | undefined;
    let desiredRegistry: CapsuleRegistry | undefined;

    if (currentResult.ok) {
      currentRegistry = currentResult.registry;
    } else {
      appendValidationRejections(
        rejections,
        "INVALID_CURRENT_REGISTRY",
        "current",
        currentResult.errors,
      );
    }

    if (desiredResult.ok) {
      desiredRegistry = desiredResult.registry;
    } else {
      appendValidationRejections(
        rejections,
        "INVALID_DESIRED_REGISTRY",
        "desired",
        desiredResult.errors,
      );
    }

    if (
      currentRegistry === undefined ||
      desiredRegistry === undefined ||
      rejections.length > 0
    ) {
      return rejectedPreview(rejections);
    }

    const diffResult = diffCapsuleRegistries(currentRegistry, desiredRegistry);

    return Object.freeze({
      diff: diffResult.diff,
      integrityChanged: diffResult.integrityChanged,
      rejections: NO_REJECTIONS,
      valid: true,
    });
  } catch {
    return rejectedPreview([
      {
        code: "PREVIEW_FAILED",
        message: "Capsule change preview failed.",
        path: "",
        source: "preview",
      },
    ]);
  }
}

function diffCapsuleRegistries(
  current: CapsuleRegistry,
  desired: CapsuleRegistry,
): {
  readonly diff: CapsuleChangeDiff;
  readonly integrityChanged: boolean;
} {
  const installed = createCapsuleRecord<InstalledCapsuleChange>();
  const removed = createCapsuleRecord<RemovedCapsuleChange>();
  const upgraded = createCapsuleRecord<CapsuleVersionChange>();
  const downgraded = createCapsuleRecord<CapsuleVersionChange>();
  const stateChanged = createCapsuleRecord<CapsuleStateChange>();
  const currentById = indexRegistry(current);
  const desiredById = indexRegistry(desired);
  const ids = sortedUniqueKeys(currentById, desiredById);
  let integrityChanged = false;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];

    if (id === undefined) {
      continue;
    }

    const before = currentById.get(id);
    const after = desiredById.get(id);

    if (before === undefined && after !== undefined) {
      defineCapsuleRecordValue(installed, id, Object.freeze({
        after: snapshotCapsuleEntry(after),
        id,
        kind: "installed",
      }));
      continue;
    }

    if (before !== undefined && after === undefined) {
      defineCapsuleRecordValue(removed, id, Object.freeze({
        before: snapshotCapsuleEntry(before),
        id,
        kind: "removed",
      }));
      continue;
    }

    if (before === undefined || after === undefined) {
      continue;
    }

    if (before.version !== after.version) {
      const versionChange = Object.freeze({
        id,
        kind: versionChangeKind(before.version, after.version),
        newVersion: after.version,
        oldVersion: before.version,
      });

      if (versionChange.kind === "upgraded") {
        defineCapsuleRecordValue(upgraded, id, versionChange);
      } else {
        defineCapsuleRecordValue(downgraded, id, versionChange);
      }
    } else if (before.integrity !== after.integrity) {
      integrityChanged = true;
    }

    if (before.state !== after.state) {
      defineCapsuleRecordValue(stateChanged, id, Object.freeze({
        id,
        kind: "stateChanged",
        newState: after.state,
        oldState: before.state,
      }));
    }
  }

  return Object.freeze({
    diff: Object.freeze({
      downgraded: Object.freeze(downgraded),
      installed: Object.freeze(installed),
      removed: Object.freeze(removed),
      stateChanged: Object.freeze(stateChanged),
      upgraded: Object.freeze(upgraded),
    }),
    integrityChanged,
  });
}

function indexRegistry(registry: CapsuleRegistry): ReadonlyMap<CapsuleId, CapsuleEntry> {
  const byId = new Map<CapsuleId, CapsuleEntry>();

  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];

    if (entry !== undefined) {
      byId.set(entry.id, entry);
    }
  }

  return byId;
}

function snapshotCapsuleEntry(entry: CapsuleEntry): CapsuleEntryPreview {
  return Object.freeze({
    id: entry.id,
    integrity: entry.integrity,
    state: entry.state,
    version: entry.version,
  });
}

function sortedUniqueKeys(
  current: ReadonlyMap<CapsuleId, CapsuleEntry>,
  desired: ReadonlyMap<CapsuleId, CapsuleEntry>,
): readonly CapsuleId[] {
  const ids = new Set<CapsuleId>();

  for (const id of current.keys()) {
    ids.add(id);
  }

  for (const id of desired.keys()) {
    ids.add(id);
  }

  return Object.freeze([...ids].sort(compareStrings));
}

function versionChangeKind(
  oldVersion: string,
  newVersion: string,
): CapsuleVersionChange["kind"] {
  return compareNaturalStrings(oldVersion, newVersion) < 0 ? "upgraded" : "downgraded";
}

// Version ordering is a deterministic natural-string comparison, not semver.
// Callers must not rely on prerelease/build metadata semantics here.
function compareNaturalStrings(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCode = left.charCodeAt(leftIndex);
    const rightCode = right.charCodeAt(rightIndex);

    if (isAsciiDigit(leftCode) && isAsciiDigit(rightCode)) {
      const leftRunStart = leftIndex;
      const rightRunStart = rightIndex;

      while (leftIndex < left.length && isAsciiDigit(left.charCodeAt(leftIndex))) {
        leftIndex += 1;
      }
      while (rightIndex < right.length && isAsciiDigit(right.charCodeAt(rightIndex))) {
        rightIndex += 1;
      }

      const digitCompare = compareDigitRuns(
        left,
        leftRunStart,
        leftIndex,
        right,
        rightRunStart,
        rightIndex,
      );

      if (digitCompare !== 0) {
        return digitCompare;
      }

      continue;
    }

    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }

    leftIndex += 1;
    rightIndex += 1;
  }

  if (left.length === right.length) {
    return 0;
  }

  return left.length < right.length ? -1 : 1;
}

function compareDigitRuns(
  left: string,
  leftStart: number,
  leftEnd: number,
  right: string,
  rightStart: number,
  rightEnd: number,
): number {
  const leftSignificantStart = skipLeadingZeros(left, leftStart, leftEnd);
  const rightSignificantStart = skipLeadingZeros(right, rightStart, rightEnd);
  const leftSignificantLength = leftEnd - leftSignificantStart;
  const rightSignificantLength = rightEnd - rightSignificantStart;

  if (leftSignificantLength !== rightSignificantLength) {
    return leftSignificantLength < rightSignificantLength ? -1 : 1;
  }

  for (let offset = 0; offset < leftSignificantLength; offset += 1) {
    const leftCode = left.charCodeAt(leftSignificantStart + offset);
    const rightCode = right.charCodeAt(rightSignificantStart + offset);

    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }
  }

  const leftRunLength = leftEnd - leftStart;
  const rightRunLength = rightEnd - rightStart;

  if (leftRunLength === rightRunLength) {
    return 0;
  }

  return leftRunLength < rightRunLength ? -1 : 1;
}

function skipLeadingZeros(value: string, start: number, end: number): number {
  let index = start;

  while (index < end - 1 && value.charCodeAt(index) === 48) {
    index += 1;
  }

  return index;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function appendValidationRejections(
  rejections: CapsuleChangeRejection[],
  code: Exclude<CapsuleChangeRejectionCode, "PREVIEW_FAILED">,
  source: Exclude<CapsuleChangeRejectionSource, "preview">,
  errors: readonly CapsuleRegistryValidationError[],
): void {
  const startLength = rejections.length;

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) {
      rejections[rejections.length] = {
        code,
        message: error.message,
        path: error.path,
        source,
      };
    }
  }

  if (rejections.length === startLength) {
    rejections[rejections.length] = {
      code,
      message: "Capsule registry validation failed.",
      path: "",
      source,
    };
  }
}

function rejectedPreview(rejections: readonly CapsuleChangeRejection[]): CapsuleChangePreview {
  return Object.freeze({
    diff: null,
    integrityChanged: false,
    rejections: Object.freeze([...rejections]),
    valid: false,
  });
}

function countCapsuleDiff(diff: CapsuleChangeDiff): CapsulePreviewCounts {
  return Object.freeze({
    installed: Object.keys(diff.installed).length,
    removed: Object.keys(diff.removed).length,
    upgraded: Object.keys(diff.upgraded).length,
  });
}

function createCapsuleRecord<T>(): Record<CapsuleId, T> {
  return Object.create(null) as Record<CapsuleId, T>;
}

function defineCapsuleRecordValue<T>(
  record: Record<CapsuleId, T>,
  key: CapsuleId,
  value: T,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function expectFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): CapsuleRegistryReadResult | { readonly ok: true } {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return rejectRegistryRead("Capsule registry read response contains an unexpected field.");
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return rejectRegistryRead("Capsule registry read response is missing a required field.");
    }
  }

  return { ok: true };
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }

  return value[key];
}

function optionalField(value: PlainJsonObject, key: string): PlainJson | undefined {
  return field(value, key);
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function describeError(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "capsule registry preview failed.";
}

function rejectRegistryRead(reason: string): Extract<CapsuleRegistryReadResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}

function rejectRegistryPreview(reason: string): Extract<CapsuleRegistryPreviewResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
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

import { validateCapsuleRegistry } from "../../../sdk/typescript/src/capsule-registry-model.ts";
import type {
  CapsuleEntry,
  CapsuleEntryState,
  CapsuleId,
  CapsuleIntegrity,
  CapsuleRegistry,
  CapsuleRegistryValidationError,
} from "../../../sdk/typescript/src/capsule-registry-model.ts";

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

const NO_REJECTIONS: readonly [] = Object.freeze([]);

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
  const installed: Record<CapsuleId, InstalledCapsuleChange> = {};
  const removed: Record<CapsuleId, RemovedCapsuleChange> = {};
  const upgraded: Record<CapsuleId, CapsuleVersionChange> = {};
  const downgraded: Record<CapsuleId, CapsuleVersionChange> = {};
  const stateChanged: Record<CapsuleId, CapsuleStateChange> = {};
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
      installed[id] = Object.freeze({
        after: snapshotCapsuleEntry(after),
        id,
        kind: "installed",
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      removed[id] = Object.freeze({
        before: snapshotCapsuleEntry(before),
        id,
        kind: "removed",
      });
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
        upgraded[id] = versionChange;
      } else {
        downgraded[id] = versionChange;
      }
    } else if (before.integrity !== after.integrity) {
      integrityChanged = true;
    }

    if (before.state !== after.state) {
      stateChanged[id] = Object.freeze({
        id,
        kind: "stateChanged",
        newState: after.state,
        oldState: before.state,
      });
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

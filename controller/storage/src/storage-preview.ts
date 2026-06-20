import { validateStorageLayout } from "../../../sdk/typescript/src/storage-model.ts";
import type {
  StorageAreaRole,
  StorageLayout,
  Subvolume,
  ValidationError,
} from "../../../sdk/typescript/src/storage-model.ts";

export type StorageChangeRejectionCode =
  | "INVALID_CURRENT_LAYOUT"
  | "INVALID_DESIRED_LAYOUT"
  | "DUPLICATE_SUBVOLUME_KEY"
  | "PREVIEW_FAILED";

export type StorageChangeRejectionSource = "current" | "desired" | "diff" | "preview";

export interface StorageChangeRejection {
  readonly code: StorageChangeRejectionCode;
  readonly source: StorageChangeRejectionSource;
  readonly path: string;
  readonly message: string;
}

export interface StorageSubvolumePreview {
  readonly id: string;
  readonly role: StorageAreaRole;
  readonly path: string;
  readonly appId?: string;
  readonly quotaGiB?: number;
}

export type StorageSubvolumeField = "role" | "path" | "appId" | "quotaGiB";
export type StorageSubvolumeFieldValue = string | number | null;

export interface StorageSubvolumeFieldChange {
  readonly field: StorageSubvolumeField;
  readonly before: StorageSubvolumeFieldValue;
  readonly after: StorageSubvolumeFieldValue;
}

export interface AddedStorageSubvolumeChange {
  readonly kind: "added";
  readonly key: string;
  readonly after: StorageSubvolumePreview;
}

export interface RemovedStorageSubvolumeChange {
  readonly kind: "removed";
  readonly key: string;
  readonly before: StorageSubvolumePreview;
}

export interface ModifiedStorageSubvolumeChange {
  readonly kind: "modified";
  readonly key: string;
  readonly beforeKey: string;
  readonly afterKey: string;
  readonly before: StorageSubvolumePreview;
  readonly after: StorageSubvolumePreview;
  readonly changes: readonly StorageSubvolumeFieldChange[];
}

export interface StorageChangeDiff {
  readonly added: Readonly<Record<string, AddedStorageSubvolumeChange>>;
  readonly removed: Readonly<Record<string, RemovedStorageSubvolumeChange>>;
  readonly modified: Readonly<Record<string, ModifiedStorageSubvolumeChange>>;
}

export type StorageChangePreview =
  | {
      readonly valid: true;
      readonly diff: StorageChangeDiff;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: null;
      readonly rejections: readonly StorageChangeRejection[];
    };

interface IndexedLayout {
  readonly byId: ReadonlyMap<string, Subvolume>;
  readonly keyRejections: readonly StorageChangeRejection[];
}

const NO_REJECTIONS: readonly [] = Object.freeze([]);
const COMPARED_FIELDS: readonly StorageSubvolumeField[] = Object.freeze([
  "role",
  "path",
  "appId",
  "quotaGiB",
]);

export function previewStorageChange(current: unknown, desired: unknown): StorageChangePreview {
  try {
    const currentResult = validateStorageLayout(current);
    const desiredResult = validateStorageLayout(desired);
    const rejections: StorageChangeRejection[] = [];

    let currentLayout: StorageLayout | undefined;
    let desiredLayout: StorageLayout | undefined;

    if (currentResult.ok) {
      currentLayout = currentResult.layout;
    } else {
      appendValidationRejections(
        rejections,
        "INVALID_CURRENT_LAYOUT",
        "current",
        currentResult.errors,
      );
    }

    if (desiredResult.ok) {
      desiredLayout = desiredResult.layout;
    } else {
      appendValidationRejections(
        rejections,
        "INVALID_DESIRED_LAYOUT",
        "desired",
        desiredResult.errors,
      );
    }

    if (currentLayout === undefined || desiredLayout === undefined || rejections.length > 0) {
      return rejectedPreview(rejections);
    }

    const currentIndex = indexLayout(currentLayout, "current");
    const desiredIndex = indexLayout(desiredLayout, "desired");

    appendRejections(rejections, currentIndex.keyRejections);
    appendRejections(rejections, desiredIndex.keyRejections);

    if (rejections.length > 0) {
      return rejectedPreview(rejections);
    }

    return Object.freeze({
      diff: diffIndexedLayouts(currentIndex, desiredIndex),
      rejections: NO_REJECTIONS,
      valid: true,
    });
  } catch {
    return rejectedPreview([
      {
        code: "PREVIEW_FAILED",
        message: "Storage change preview failed.",
        path: "",
        source: "preview",
      },
    ]);
  }
}

function diffIndexedLayouts(current: IndexedLayout, desired: IndexedLayout): StorageChangeDiff {
  const added: Record<string, AddedStorageSubvolumeChange> = {};
  const removed: Record<string, RemovedStorageSubvolumeChange> = {};
  const modified: Record<string, ModifiedStorageSubvolumeChange> = {};
  const ids = sortedUniqueKeys(current.byId, desired.byId);

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];

    if (id === undefined) {
      continue;
    }

    const before = current.byId.get(id);
    const after = desired.byId.get(id);

    if (before === undefined && after !== undefined) {
      const key = subvolumeKey(after);
      added[key] = Object.freeze({
        after: snapshotSubvolume(after),
        key,
        kind: "added",
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      const key = subvolumeKey(before);
      removed[key] = Object.freeze({
        before: snapshotSubvolume(before),
        key,
        kind: "removed",
      });
      continue;
    }

    if (before !== undefined && after !== undefined) {
      const changes = fieldChanges(before, after);

      if (changes.length > 0) {
        const beforeKey = subvolumeKey(before);
        const afterKey = subvolumeKey(after);
        modified[beforeKey] = Object.freeze({
          after: snapshotSubvolume(after),
          afterKey,
          before: snapshotSubvolume(before),
          beforeKey,
          changes: Object.freeze(changes),
          key: beforeKey,
          kind: "modified",
        });
      }
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    removed: Object.freeze(removed),
  });
}

function indexLayout(layout: StorageLayout, source: "current" | "desired"): IndexedLayout {
  const byId = new Map<string, Subvolume>();
  const seenKeys = new Map<string, number>();
  const keyRejections: StorageChangeRejection[] = [];

  for (let index = 0; index < layout.subvolumes.length; index += 1) {
    const subvolume = layout.subvolumes[index];

    if (subvolume === undefined) {
      continue;
    }

    byId.set(subvolume.id, subvolume);

    const key = subvolumeKey(subvolume);
    const previousIndex = seenKeys.get(key);

    if (previousIndex === undefined) {
      seenKeys.set(key, index);
    } else {
      keyRejections[keyRejections.length] = {
        code: "DUPLICATE_SUBVOLUME_KEY",
        message: `Duplicate subvolume role/path key also appears at subvolumes/${previousIndex}.`,
        path: `subvolumes/${index}`,
        source: "diff",
      };
    }
  }

  return Object.freeze({
    byId,
    keyRejections: Object.freeze(keyRejections),
  });
}

function fieldChanges(
  before: Subvolume,
  after: Subvolume,
): readonly StorageSubvolumeFieldChange[] {
  const changes: StorageSubvolumeFieldChange[] = [];

  for (let index = 0; index < COMPARED_FIELDS.length; index += 1) {
    const field = COMPARED_FIELDS[index];

    if (field === undefined) {
      continue;
    }

    const beforeValue = fieldValue(before, field);
    const afterValue = fieldValue(after, field);

    if (!Object.is(beforeValue, afterValue)) {
      changes[changes.length] = Object.freeze({
        after: afterValue,
        before: beforeValue,
        field,
      });
    }
  }

  return changes;
}

function snapshotSubvolume(subvolume: Subvolume): StorageSubvolumePreview {
  let snapshot: StorageSubvolumePreview = Object.freeze({
    id: subvolume.id,
    path: subvolume.path,
    role: subvolume.role,
  });

  if (subvolume.appId !== undefined) {
    snapshot = Object.freeze({
      ...snapshot,
      appId: subvolume.appId,
    });
  }

  if (subvolume.quotaGiB !== undefined) {
    snapshot = Object.freeze({
      ...snapshot,
      quotaGiB: subvolume.quotaGiB,
    });
  }

  return snapshot;
}

function fieldValue(
  subvolume: Subvolume,
  field: StorageSubvolumeField,
): StorageSubvolumeFieldValue {
  switch (field) {
    case "role":
      return subvolume.role;
    case "path":
      return subvolume.path;
    case "appId":
      return subvolume.appId ?? null;
    case "quotaGiB":
      return subvolume.quotaGiB ?? null;
  }
}

function sortedUniqueKeys(
  current: ReadonlyMap<string, Subvolume>,
  desired: ReadonlyMap<string, Subvolume>,
): readonly string[] {
  const ids = new Set<string>();

  for (const id of current.keys()) {
    ids.add(id);
  }

  for (const id of desired.keys()) {
    ids.add(id);
  }

  return Object.freeze([...ids].sort(compareStrings));
}

function appendValidationRejections(
  rejections: StorageChangeRejection[],
  code: StorageChangeRejectionCode,
  source: "current" | "desired",
  errors: readonly ValidationError[],
): void {
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      code,
      message: error.message,
      path: error.path,
      source,
    };
  }
}

function appendRejections(
  rejections: StorageChangeRejection[],
  nextRejections: readonly StorageChangeRejection[],
): void {
  for (let index = 0; index < nextRejections.length; index += 1) {
    const rejection = nextRejections[index];

    if (rejection !== undefined) {
      rejections[rejections.length] = rejection;
    }
  }
}

function rejectedPreview(rejections: readonly StorageChangeRejection[]): StorageChangePreview {
  return Object.freeze({
    diff: null,
    rejections: Object.freeze([...rejections]),
    valid: false,
  });
}

function subvolumeKey(subvolume: Subvolume): string {
  return `${subvolume.role}:${subvolume.path}`;
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

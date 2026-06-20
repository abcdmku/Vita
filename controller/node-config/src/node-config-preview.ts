import { previewBackupChange } from "../../backup/src/backup-preview.ts";
import type {
  BackupChangeDiff,
  BackupPreviewRejection,
  BackupTargetDiff,
} from "../../backup/src/backup-preview.ts";
import { previewNetworkChange } from "../../network/src/network-preview.ts";
import type {
  NetworkChangeDiff,
  NetworkPreviewRejection,
} from "../../network/src/network-preview.ts";
import { previewStorageChange } from "../../storage/src/storage-preview.ts";
import type {
  AddedStorageSubvolumeChange,
  RemovedStorageSubvolumeChange,
  StorageChangeDiff,
  StorageChangeRejection,
  StorageSubvolumePreview,
} from "../../storage/src/storage-preview.ts";
import type {
  BackupPolicy,
  BackupSchedule,
} from "../../../sdk/typescript/src/backup-model.ts";
import type { IdentityConfig } from "../../../sdk/typescript/src/identity-model.ts";
import type {
  InboundRule,
  NetworkConfig,
  NetworkInterface,
} from "../../../sdk/typescript/src/network-model.ts";
import { validateNodeConfig } from "../../../sdk/typescript/src/node-config-model.ts";
import type {
  NodeConfig,
  ValidationError as NodeConfigValidationError,
} from "../../../sdk/typescript/src/node-config-model.ts";
import type {
  StorageLayout,
  Subvolume,
} from "../../../sdk/typescript/src/storage-model.ts";

export type NodeConfigSectionName = "storage" | "network" | "backup" | "identity";
export type NodeConfigSectionChangeKind = "added" | "removed" | "changed";

export type NodeConfigChangeRejectionCode =
  | "INVALID_CURRENT_CONFIG"
  | "INVALID_DESIRED_CONFIG"
  | "INVALID_CURRENT_SECTION"
  | "INVALID_DESIRED_SECTION"
  | "INVALID_SECTION_PREVIEW"
  | "PREVIEW_FAILED";

export type NodeConfigChangeRejectionSource =
  | "current"
  | "desired"
  | "section"
  | "preview";

export interface NodeConfigChangeRejection {
  readonly code: NodeConfigChangeRejectionCode;
  readonly source: NodeConfigChangeRejectionSource;
  readonly path: string;
  readonly message: string;
  readonly section?: NodeConfigSectionName;
}

export interface NodeConfigStorageSectionPreview {
  readonly kind: NodeConfigSectionChangeKind;
  readonly diff: StorageChangeDiff;
}

export interface NodeConfigNetworkSectionPreview {
  readonly kind: NodeConfigSectionChangeKind;
  readonly diff: NetworkChangeDiff;
  readonly wideningInbound: boolean;
}

export type NodeConfigBackupScheduleDiff =
  | BackupChangeDiff["schedule"]
  | {
      readonly kind: "added";
      readonly after: BackupSchedule;
    }
  | {
      readonly kind: "removed";
      readonly before: BackupSchedule;
    };

export type NodeConfigBackupRetentionDiff =
  | BackupChangeDiff["retention"]
  | {
      readonly kind: "added";
      readonly after: number;
    }
  | {
      readonly kind: "removed";
      readonly before: number;
    };

export interface NodeConfigBackupDiff {
  readonly schedule: NodeConfigBackupScheduleDiff;
  readonly retention: NodeConfigBackupRetentionDiff;
  readonly targets: BackupTargetDiff;
}

export interface NodeConfigBackupSectionPreview {
  readonly kind: NodeConfigSectionChangeKind;
  readonly diff: NodeConfigBackupDiff;
  readonly weakensRetention: boolean;
}

export type NodeConfigIdentityDiff =
  | {
      readonly kind: "added";
      readonly after: IdentityConfig;
    }
  | {
      readonly kind: "removed";
      readonly before: IdentityConfig;
    }
  | {
      readonly kind: "modified";
      readonly before: IdentityConfig;
      readonly after: IdentityConfig;
    };

export interface NodeConfigIdentitySectionPreview {
  readonly kind: NodeConfigSectionChangeKind;
  readonly diff: NodeConfigIdentityDiff | null;
}

export interface NodeConfigChangeSections {
  readonly storage?: NodeConfigStorageSectionPreview;
  readonly network?: NodeConfigNetworkSectionPreview;
  readonly backup?: NodeConfigBackupSectionPreview;
  readonly identity?: NodeConfigIdentitySectionPreview;
}

export interface NodeConfigChangeSummary {
  readonly added: readonly NodeConfigSectionName[];
  readonly removed: readonly NodeConfigSectionName[];
  readonly changed: readonly NodeConfigSectionName[];
  readonly wideningInbound: boolean;
  readonly weakensRetention: boolean;
}

export type NodeConfigChangePreview =
  | {
      readonly ok: true;
      readonly sections: NodeConfigChangeSections;
      readonly summary: NodeConfigChangeSummary;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly NodeConfigChangeRejection[];
    };

type SectionPreviewResult<T> =
  | {
      readonly ok: true;
      readonly section: T | undefined;
      readonly hasChanges: boolean;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly NodeConfigChangeRejection[];
    };

interface MutableNodeConfigChangeSections {
  storage?: NodeConfigStorageSectionPreview;
  network?: NodeConfigNetworkSectionPreview;
  backup?: NodeConfigBackupSectionPreview;
  identity?: NodeConfigIdentitySectionPreview;
}

const NO_REJECTIONS: readonly [] = Object.freeze([]);

export function previewNodeConfigChange(
  current: unknown,
  desired: unknown,
): NodeConfigChangePreview {
  try {
    const currentResult = validateNodeConfig(current);
    const desiredResult = validateNodeConfig(desired);
    const rejections: NodeConfigChangeRejection[] = [];

    let currentConfig: NodeConfig | undefined;
    let desiredConfig: NodeConfig | undefined;

    if (currentResult.ok) {
      currentConfig = currentResult.config;
    } else {
      appendNodeValidationRejections(
        rejections,
        "INVALID_CURRENT_CONFIG",
        "current",
        currentResult.errors,
      );
    }

    if (desiredResult.ok) {
      desiredConfig = desiredResult.config;
    } else {
      appendNodeValidationRejections(
        rejections,
        "INVALID_DESIRED_CONFIG",
        "desired",
        desiredResult.errors,
      );
    }

    if (currentConfig === undefined || desiredConfig === undefined || rejections.length > 0) {
      return rejectedPreview(rejections);
    }

    const sections: MutableNodeConfigChangeSections = {};
    const summaryAdded: NodeConfigSectionName[] = [];
    const summaryRemoved: NodeConfigSectionName[] = [];
    const summaryChanged: NodeConfigSectionName[] = [];
    let wideningInbound = false;
    let weakensRetention = false;

    const storage = previewStorageSection(currentConfig.storage, desiredConfig.storage);
    if (!storage.ok) {
      appendRejections(rejections, storage.rejections);
    } else if (storage.section !== undefined) {
      sections.storage = storage.section;
      appendSummarySection(storage.section.kind, storage.hasChanges, "storage", summaryAdded, summaryRemoved, summaryChanged);
    }

    const network = previewNetworkSection(currentConfig.network, desiredConfig.network);
    if (!network.ok) {
      appendRejections(rejections, network.rejections);
    } else if (network.section !== undefined) {
      sections.network = network.section;
      wideningInbound = network.section.wideningInbound;
      appendSummarySection(network.section.kind, network.hasChanges, "network", summaryAdded, summaryRemoved, summaryChanged);
    }

    const backup = previewBackupSection(currentConfig.backup, desiredConfig.backup);
    if (!backup.ok) {
      appendRejections(rejections, backup.rejections);
    } else if (backup.section !== undefined) {
      sections.backup = backup.section;
      weakensRetention = backup.section.weakensRetention;
      appendSummarySection(backup.section.kind, backup.hasChanges, "backup", summaryAdded, summaryRemoved, summaryChanged);
    }

    const identity = previewIdentitySection(currentConfig.identity, desiredConfig.identity);
    if (!identity.ok) {
      appendRejections(rejections, identity.rejections);
    } else if (identity.section !== undefined) {
      sections.identity = identity.section;
      appendSummarySection(identity.section.kind, identity.hasChanges, "identity", summaryAdded, summaryRemoved, summaryChanged);
    }

    if (rejections.length > 0) {
      return rejectedPreview(rejections);
    }

    return Object.freeze({
      ok: true,
      sections: Object.freeze(sections),
      summary: Object.freeze({
        added: Object.freeze(summaryAdded),
        changed: Object.freeze(summaryChanged),
        removed: Object.freeze(summaryRemoved),
        weakensRetention,
        wideningInbound,
      }),
    });
  } catch {
    return rejectedPreview([
      {
        code: "PREVIEW_FAILED",
        message: "Node config change preview failed.",
        path: "",
        source: "preview",
      },
    ]);
  }
}

function previewStorageSection(
  current: StorageLayout | undefined,
  desired: StorageLayout | undefined,
): SectionPreviewResult<NodeConfigStorageSectionPreview> {
  if (current !== undefined && desired !== undefined) {
    const preview = previewStorageChange(current, desired);

    if (!preview.valid) {
      return rejectSection(mapStorageRejections(preview.rejections, undefined));
    }

    return acceptSection(
      Object.freeze({
        diff: preview.diff,
        kind: "changed",
      }),
      hasStorageDiff(preview.diff),
    );
  }

  if (desired !== undefined) {
    const rejections = validatePresentStorageSection(desired, "desired");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: storageAddedDiff(desired),
        kind: "added",
      }),
      true,
    );
  }

  if (current !== undefined) {
    const rejections = validatePresentStorageSection(current, "current");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: storageRemovedDiff(current),
        kind: "removed",
      }),
      true,
    );
  }

  return acceptSection(undefined, false);
}

function previewNetworkSection(
  current: NetworkConfig | undefined,
  desired: NetworkConfig | undefined,
): SectionPreviewResult<NodeConfigNetworkSectionPreview> {
  if (current !== undefined && desired !== undefined) {
    const preview = previewNetworkChange(current, desired);

    if (!preview.valid) {
      return rejectSection(mapNetworkRejections(preview.rejections));
    }

    return acceptSection(
      Object.freeze({
        diff: preview.diff,
        kind: "changed",
        wideningInbound: preview.wideningInbound,
      }),
      hasNetworkDiff(preview.diff),
    );
  }

  if (desired !== undefined) {
    const rejections = validatePresentNetworkSection(desired, "desired");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: networkAddedDiff(desired),
        kind: "added",
        wideningInbound: desired.firewall.allow.length > 0,
      }),
      true,
    );
  }

  if (current !== undefined) {
    const rejections = validatePresentNetworkSection(current, "current");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: networkRemovedDiff(current),
        kind: "removed",
        wideningInbound: false,
      }),
      true,
    );
  }

  return acceptSection(undefined, false);
}

function previewBackupSection(
  current: BackupPolicy | undefined,
  desired: BackupPolicy | undefined,
): SectionPreviewResult<NodeConfigBackupSectionPreview> {
  if (current !== undefined && desired !== undefined) {
    const preview = previewBackupChange(current, desired);

    if (!preview.valid) {
      return rejectSection(mapBackupRejections(preview.rejections));
    }

    return acceptSection(
      Object.freeze({
        diff: preview.diff,
        kind: "changed",
        weakensRetention: preview.weakensRetention,
      }),
      hasBackupDiff(preview.diff),
    );
  }

  if (desired !== undefined) {
    const rejections = validatePresentBackupSection(desired, "desired");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: backupAddedDiff(desired),
        kind: "added",
        weakensRetention: false,
      }),
      true,
    );
  }

  if (current !== undefined) {
    const rejections = validatePresentBackupSection(current, "current");

    if (rejections.length > 0) {
      return rejectSection(rejections);
    }

    return acceptSection(
      Object.freeze({
        diff: backupRemovedDiff(current),
        kind: "removed",
        weakensRetention: true,
      }),
      true,
    );
  }

  return acceptSection(undefined, false);
}

function previewIdentitySection(
  current: IdentityConfig | undefined,
  desired: IdentityConfig | undefined,
): SectionPreviewResult<NodeConfigIdentitySectionPreview> {
  if (current !== undefined && desired !== undefined) {
    const diff = identityConfigsEqual(current, desired)
      ? null
      : Object.freeze({
          after: desired,
          before: current,
          kind: "modified" as const,
        });

    return acceptSection(
      Object.freeze({
        diff,
        kind: "changed",
      }),
      diff !== null,
    );
  }

  if (desired !== undefined) {
    return acceptSection(
      Object.freeze({
        diff: Object.freeze({
          after: desired,
          kind: "added",
        }),
        kind: "added",
      }),
      true,
    );
  }

  if (current !== undefined) {
    return acceptSection(
      Object.freeze({
        diff: Object.freeze({
          before: current,
          kind: "removed",
        }),
        kind: "removed",
      }),
      true,
    );
  }

  return acceptSection(undefined, false);
}

function validatePresentStorageSection(
  value: StorageLayout,
  side: "current" | "desired",
): readonly NodeConfigChangeRejection[] {
  const preview = previewStorageChange(value, value);

  if (preview.valid) {
    return NO_REJECTIONS;
  }

  return mapStorageRejections(preview.rejections, side);
}

function validatePresentNetworkSection(
  value: NetworkConfig,
  side: "current" | "desired",
): readonly NodeConfigChangeRejection[] {
  const preview = previewNetworkChange(value, value);

  if (preview.valid) {
    return NO_REJECTIONS;
  }

  return mapNetworkRejectionsToSide(preview.rejections, side);
}

function validatePresentBackupSection(
  value: BackupPolicy,
  side: "current" | "desired",
): readonly NodeConfigChangeRejection[] {
  const preview = previewBackupChange(value, value);

  if (preview.valid) {
    return NO_REJECTIONS;
  }

  return mapBackupRejectionsToSide(preview.rejections, side);
}

function storageAddedDiff(layout: StorageLayout): StorageChangeDiff {
  const added: Record<string, AddedStorageSubvolumeChange> = {};

  for (let index = 0; index < layout.subvolumes.length; index += 1) {
    const subvolume = layout.subvolumes[index];

    if (subvolume === undefined) {
      continue;
    }

    const key = subvolumeKey(subvolume);
    added[key] = Object.freeze({
      after: snapshotSubvolume(subvolume),
      key,
      kind: "added",
    });
  }

  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze({}),
    removed: Object.freeze({}),
  });
}

function storageRemovedDiff(layout: StorageLayout): StorageChangeDiff {
  const removed: Record<string, RemovedStorageSubvolumeChange> = {};

  for (let index = 0; index < layout.subvolumes.length; index += 1) {
    const subvolume = layout.subvolumes[index];

    if (subvolume === undefined) {
      continue;
    }

    const key = subvolumeKey(subvolume);
    removed[key] = Object.freeze({
      before: snapshotSubvolume(subvolume),
      key,
      kind: "removed",
    });
  }

  return Object.freeze({
    added: Object.freeze({}),
    modified: Object.freeze({}),
    removed: Object.freeze(removed),
  });
}

function networkAddedDiff(config: NetworkConfig): NetworkChangeDiff {
  return Object.freeze({
    firewall: Object.freeze({
      added: freezeSortedRules(copyRules(config.firewall.allow)),
      removed: Object.freeze([]),
    }),
    interfaces: Object.freeze({
      added: freezeSortedInterfaces(copyInterfaces(config.interfaces)),
      modified: Object.freeze([]),
      removed: Object.freeze([]),
    }),
  });
}

function networkRemovedDiff(config: NetworkConfig): NetworkChangeDiff {
  return Object.freeze({
    firewall: Object.freeze({
      added: Object.freeze([]),
      removed: freezeSortedRules(copyRules(config.firewall.allow)),
    }),
    interfaces: Object.freeze({
      added: Object.freeze([]),
      modified: Object.freeze([]),
      removed: freezeSortedInterfaces(copyInterfaces(config.interfaces)),
    }),
  });
}

function backupAddedDiff(policy: BackupPolicy): NodeConfigBackupDiff {
  return Object.freeze({
    retention: Object.freeze({
      after: policy.retentionDays,
      kind: "added",
    }),
    schedule: Object.freeze({
      after: policy.schedule,
      kind: "added",
    }),
    targets: Object.freeze({
      added: Object.freeze([policy.target]),
      removed: Object.freeze([]),
    }),
  });
}

function backupRemovedDiff(policy: BackupPolicy): NodeConfigBackupDiff {
  return Object.freeze({
    retention: Object.freeze({
      before: policy.retentionDays,
      kind: "removed",
    }),
    schedule: Object.freeze({
      before: policy.schedule,
      kind: "removed",
    }),
    targets: Object.freeze({
      added: Object.freeze([]),
      removed: Object.freeze([policy.target]),
    }),
  });
}

function hasStorageDiff(diff: StorageChangeDiff): boolean {
  return (
    Object.keys(diff.added).length > 0 ||
    Object.keys(diff.removed).length > 0 ||
    Object.keys(diff.modified).length > 0
  );
}

function hasNetworkDiff(diff: NetworkChangeDiff): boolean {
  return (
    diff.interfaces.added.length > 0 ||
    diff.interfaces.removed.length > 0 ||
    diff.interfaces.modified.length > 0 ||
    diff.firewall.added.length > 0 ||
    diff.firewall.removed.length > 0
  );
}

function hasBackupDiff(diff: BackupChangeDiff): boolean {
  return (
    diff.schedule !== null ||
    diff.retention.maxAgeDays !== null ||
    diff.targets.added.length > 0 ||
    diff.targets.removed.length > 0
  );
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

function copyInterfaces(values: readonly NetworkInterface[]): NetworkInterface[] {
  const output: NetworkInterface[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== undefined) {
      output[output.length] = value;
    }
  }

  return output;
}

function copyRules(values: readonly InboundRule[]): InboundRule[] {
  const output: InboundRule[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== undefined) {
      output[output.length] = value;
    }
  }

  return output;
}

function freezeSortedInterfaces(values: NetworkInterface[]): readonly NetworkInterface[] {
  values.sort(compareInterfaces);
  return Object.freeze(values);
}

function freezeSortedRules(values: InboundRule[]): readonly InboundRule[] {
  values.sort(compareRules);
  return Object.freeze(values);
}

function identityConfigsEqual(current: IdentityConfig, desired: IdentityConfig): boolean {
  if (
    current.did !== desired.did ||
    current.handle !== desired.handle ||
    current.pds.endpoint !== desired.pds.endpoint ||
    current.signingKeyRef.id !== desired.signingKeyRef.id ||
    current.signingKeyRef.handle !== desired.signingKeyRef.handle ||
    current.rotationKeyRefs.length !== desired.rotationKeyRefs.length
  ) {
    return false;
  }

  for (let index = 0; index < current.rotationKeyRefs.length; index += 1) {
    const currentKey = current.rotationKeyRefs[index];
    const desiredKey = desired.rotationKeyRefs[index];

    if (
      currentKey === undefined ||
      desiredKey === undefined ||
      currentKey.id !== desiredKey.id ||
      currentKey.handle !== desiredKey.handle
    ) {
      return false;
    }
  }

  return true;
}

function mapStorageRejections(
  rejections: readonly StorageChangeRejection[],
  forcedSide: "current" | "desired" | undefined,
): readonly NodeConfigChangeRejection[] {
  const output: NodeConfigChangeRejection[] = [];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection === undefined) {
      continue;
    }

    output[output.length] = sectionRejection(
      "storage",
      storageRejectionCode(rejection, forcedSide),
      forcedSide ?? sourceFromStorageRejection(rejection),
      rejection.path,
      rejection.message,
    );
  }

  return Object.freeze(output);
}

function mapNetworkRejections(
  rejections: readonly NetworkPreviewRejection[],
): readonly NodeConfigChangeRejection[] {
  const output: NodeConfigChangeRejection[] = [];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection !== undefined) {
      output[output.length] = sectionRejection(
        "network",
        sideCode(rejection.side),
        rejection.side,
        rejection.path,
        rejection.message,
      );
    }
  }

  return Object.freeze(output);
}

function mapNetworkRejectionsToSide(
  rejections: readonly NetworkPreviewRejection[],
  side: "current" | "desired",
): readonly NodeConfigChangeRejection[] {
  const output: NodeConfigChangeRejection[] = [];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection !== undefined) {
      output[output.length] = sectionRejection(
        "network",
        sideCode(side),
        side,
        rejection.path,
        rejection.message,
      );
    }
  }

  return Object.freeze(output);
}

function mapBackupRejections(
  rejections: readonly BackupPreviewRejection[],
): readonly NodeConfigChangeRejection[] {
  const output: NodeConfigChangeRejection[] = [];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection !== undefined) {
      output[output.length] = sectionRejection(
        "backup",
        sideCode(rejection.side),
        rejection.side,
        rejection.path,
        rejection.message,
      );
    }
  }

  return Object.freeze(output);
}

function mapBackupRejectionsToSide(
  rejections: readonly BackupPreviewRejection[],
  side: "current" | "desired",
): readonly NodeConfigChangeRejection[] {
  const output: NodeConfigChangeRejection[] = [];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection !== undefined) {
      output[output.length] = sectionRejection(
        "backup",
        sideCode(side),
        side,
        rejection.path,
        rejection.message,
      );
    }
  }

  return Object.freeze(output);
}

function sideFromStorageRejection(
  rejection: StorageChangeRejection,
): "current" | "desired" | undefined {
  if (rejection.source === "current" || rejection.source === "desired") {
    return rejection.source;
  }

  return undefined;
}

function storageRejectionCode(
  rejection: StorageChangeRejection,
  forcedSide: "current" | "desired" | undefined,
): NodeConfigChangeRejectionCode {
  if (forcedSide !== undefined) {
    return sideCode(forcedSide);
  }

  if (rejection.source === "preview") {
    return "PREVIEW_FAILED";
  }

  return sideCode(sideFromStorageRejection(rejection));
}

function sourceFromStorageRejection(
  rejection: StorageChangeRejection,
): NodeConfigChangeRejectionSource {
  if (rejection.source === "current" || rejection.source === "desired") {
    return rejection.source;
  }

  if (rejection.source === "preview") {
    return "preview";
  }

  return "section";
}

function sideCode(
  side: "current" | "desired" | "preview" | undefined,
): NodeConfigChangeRejectionCode {
  if (side === "current") {
    return "INVALID_CURRENT_SECTION";
  }

  if (side === "desired") {
    return "INVALID_DESIRED_SECTION";
  }

  if (side === "preview") {
    return "PREVIEW_FAILED";
  }

  return "INVALID_SECTION_PREVIEW";
}

function sectionRejection(
  section: NodeConfigSectionName,
  code: NodeConfigChangeRejectionCode,
  source: NodeConfigChangeRejectionSource,
  path: string,
  message: string,
): NodeConfigChangeRejection {
  return Object.freeze({
    code,
    message,
    path: prefixSectionPath(section, path),
    section,
    source,
  });
}

function appendNodeValidationRejections(
  rejections: NodeConfigChangeRejection[],
  code: "INVALID_CURRENT_CONFIG" | "INVALID_DESIRED_CONFIG",
  source: "current" | "desired",
  errors: readonly NodeConfigValidationError[],
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
      message: "Node config validation failed.",
      path: "",
      source,
    };
  }
}

function appendRejections(
  target: NodeConfigChangeRejection[],
  source: readonly NodeConfigChangeRejection[],
): void {
  for (let index = 0; index < source.length; index += 1) {
    const rejection = source[index];

    if (rejection !== undefined) {
      target[target.length] = rejection;
    }
  }
}

function appendSummarySection(
  kind: NodeConfigSectionChangeKind,
  hasChanges: boolean,
  section: NodeConfigSectionName,
  added: NodeConfigSectionName[],
  removed: NodeConfigSectionName[],
  changed: NodeConfigSectionName[],
): void {
  switch (kind) {
    case "added":
      added[added.length] = section;
      return;
    case "removed":
      removed[removed.length] = section;
      return;
    case "changed":
      if (hasChanges) {
        changed[changed.length] = section;
      }
      return;
  }
}

function acceptSection<T>(
  section: T | undefined,
  hasChanges: boolean,
): SectionPreviewResult<T> {
  return {
    hasChanges,
    ok: true,
    section,
  };
}

function rejectSection<T>(
  rejections: readonly NodeConfigChangeRejection[],
): SectionPreviewResult<T> {
  return {
    ok: false,
    rejections,
  };
}

function rejectedPreview(rejections: readonly NodeConfigChangeRejection[]): NodeConfigChangePreview {
  return Object.freeze({
    ok: false,
    rejections: Object.freeze([...rejections]),
  });
}

function prefixSectionPath(section: NodeConfigSectionName, path: string): string {
  if (path === "") {
    return section;
  }

  return `${section}/${path}`;
}

function subvolumeKey(subvolume: Subvolume): string {
  return `${subvolume.role}:${subvolume.path}`;
}

function compareInterfaces(left: NetworkInterface, right: NetworkInterface): number {
  return compareStrings(left.name, right.name);
}

function compareRules(left: InboundRule, right: InboundRule): number {
  return compareStrings(ruleKey(left), ruleKey(right));
}

function ruleKey(rule: InboundRule): string {
  return `${rule.protocol}:${rule.port}:${rule.sourceCidr}`;
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

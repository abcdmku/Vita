import { previewAccountsChange } from "../../accounts/src/accounts-preview.ts";
import type {
  AccountsChangeDiff,
  AccountsChangePreview,
  AccountsGroupChanges,
  AccountsPreviewRejection,
} from "../../accounts/src/accounts-preview.ts";
import { previewCapsuleChange } from "../../capsule/src/capsule-preview.ts";
import type {
  CapsuleChangeDiff,
  CapsuleChangeRejection,
} from "../../capsule/src/capsule-preview.ts";
import { previewNodeConfigChange } from "../../node-config/src/node-config-preview.ts";
import type {
  NodeConfigChangePreview,
  NodeConfigChangeRejection,
  NodeConfigChangeSections,
  NodeConfigChangeSummary,
} from "../../node-config/src/node-config-preview.ts";
import { previewServicesChange } from "../../services/src/services-preview.ts";
import type {
  ServicesChangeDiff,
  ServicesPreviewRejection,
} from "../../services/src/services-preview.ts";
import { validateNodeChangeSet } from "../../../sdk/typescript/src/node-changeset-model.ts";
import type { AccountsConfig } from "../../../sdk/typescript/src/accounts-model.ts";
import type { CapsuleRegistry } from "../../../sdk/typescript/src/capsule-registry-model.ts";
import type {
  NodeChangeSet,
  NodeChangeSetRejections,
  NodeChangeSetSection,
} from "../../../sdk/typescript/src/node-changeset-model.ts";
import type { NodeConfig } from "../../../sdk/typescript/src/node-config-model.ts";
import type { ServicesConfig } from "../../../sdk/typescript/src/services-model.ts";

export type NodeChangeSetSubsystemKind =
  | "added"
  | "changed"
  | "removed"
  | "unchanged";

export interface NodeConfigChangedSubsystemPreview {
  readonly kind: "changed" | "unchanged";
  readonly sections: NodeConfigChangeSections;
  readonly summary: NodeConfigChangeSummary;
  readonly weakensRetention: boolean;
  readonly wideningInbound: boolean;
}

export interface AddedNodeConfigSubsystemPreview {
  readonly kind: "added";
  readonly after: NodeConfig;
  readonly weakensRetention: false;
  readonly wideningInbound: boolean;
}

export interface RemovedNodeConfigSubsystemPreview {
  readonly kind: "removed";
  readonly before: NodeConfig;
  readonly weakensRetention: boolean;
  readonly wideningInbound: false;
}

export type NodeConfigSubsystemPreview =
  | AddedNodeConfigSubsystemPreview
  | NodeConfigChangedSubsystemPreview
  | RemovedNodeConfigSubsystemPreview;

export interface ServicesSubsystemPreview {
  readonly kind: NodeChangeSetSubsystemKind;
  readonly diff: ServicesChangeDiff;
  readonly newlyEnabledCount: number;
}

export interface AccountsSubsystemPreview {
  readonly kind: NodeChangeSetSubsystemKind;
  readonly diff: AccountsChangeDiff;
  readonly newlyEnabledCount: number;
  readonly groupChanges: AccountsGroupChanges;
}

export interface CapsulesSubsystemPreview {
  readonly kind: NodeChangeSetSubsystemKind;
  readonly diff: CapsuleChangeDiff;
  readonly integrityChanged: boolean;
}

export interface NodeChangeSetSubsystems {
  readonly nodeConfig?: NodeConfigSubsystemPreview;
  readonly services?: ServicesSubsystemPreview;
  readonly accounts?: AccountsSubsystemPreview;
  readonly capsules?: CapsulesSubsystemPreview;
}

export interface NodeChangeSetPreviewSummary {
  readonly wideningInbound: boolean;
  readonly weakensRetention: boolean;
  readonly newlyEnabledServices: number;
  readonly newlyEnabledAccounts: number;
  readonly accountGroupChanges: AccountsGroupChanges;
}

export interface NodeChangeSetPreviewInternalRejection {
  readonly code: "PREVIEW_FAILED" | "VALIDATED_SECTION_MISSING";
  readonly section?: NodeChangeSetSection;
  readonly side?: "current" | "desired";
  readonly message: string;
}

export interface NodeChangeSetPreviewRejections {
  readonly current?: NodeChangeSetRejections;
  readonly desired?: NodeChangeSetRejections;
  readonly nodeConfig?: readonly NodeConfigChangeRejection[];
  readonly services?: readonly ServicesPreviewRejection[];
  readonly accounts?: readonly AccountsPreviewRejection[];
  readonly capsules?: readonly CapsuleChangeRejection[];
  readonly preview?: readonly NodeChangeSetPreviewInternalRejection[];
}

export type NodeChangeSetPreview =
  | {
      readonly ok: true;
      readonly subsystems: NodeChangeSetSubsystems;
      readonly summary: NodeChangeSetPreviewSummary;
    }
  | {
      readonly ok: false;
      readonly rejections: NodeChangeSetPreviewRejections;
    };

interface MutableNodeChangeSetSubsystems {
  nodeConfig?: NodeConfigSubsystemPreview;
  services?: ServicesSubsystemPreview;
  accounts?: AccountsSubsystemPreview;
  capsules?: CapsulesSubsystemPreview;
}

interface MutableNodeChangeSetPreviewSummary {
  wideningInbound: boolean;
  weakensRetention: boolean;
  newlyEnabledServices: number;
  newlyEnabledAccounts: number;
  accountGroupChanges: AccountsGroupChanges;
}

interface MutableNodeChangeSetPreviewRejections {
  current?: NodeChangeSetRejections;
  desired?: NodeChangeSetRejections;
  nodeConfig?: readonly NodeConfigChangeRejection[];
  services?: readonly ServicesPreviewRejection[];
  accounts?: readonly AccountsPreviewRejection[];
  capsules?: readonly CapsuleChangeRejection[];
  preview?: NodeChangeSetPreviewInternalRejection[];
}

const EMPTY_SERVICES_CONFIG: ServicesConfig = Object.freeze({
  services: Object.freeze([]),
});
const EMPTY_ACCOUNTS_CONFIG: AccountsConfig = Object.freeze({
  accounts: Object.freeze([]),
});
const EMPTY_CAPSULE_REGISTRY: CapsuleRegistry = Object.freeze([]);
const EMPTY_ACCOUNT_GROUP_CHANGES: AccountsGroupChanges = Object.freeze({});

export function previewNodeChangeSet(
  current: unknown,
  desired: unknown,
): NodeChangeSetPreview {
  try {
    const currentValidation = validateNodeChangeSet(current);
    const desiredValidation = validateNodeChangeSet(desired);
    const rejections: MutableNodeChangeSetPreviewRejections = {};

    if (!currentValidation.ok) {
      rejections.current = currentValidation.rejections;
    }

    if (!desiredValidation.ok) {
      rejections.desired = desiredValidation.rejections;
    }

    if (!currentValidation.ok || !desiredValidation.ok) {
      return rejectedPreview(rejections);
    }

    const subsystems: MutableNodeChangeSetSubsystems = {};
    const summary: MutableNodeChangeSetPreviewSummary = {
      accountGroupChanges: EMPTY_ACCOUNT_GROUP_CHANGES,
      newlyEnabledAccounts: 0,
      newlyEnabledServices: 0,
      weakensRetention: false,
      wideningInbound: false,
    };

    composeNodeConfigSubsystem(
      currentValidation.changeSet,
      desiredValidation.changeSet,
      subsystems,
      summary,
      rejections,
    );
    composeServicesSubsystem(
      currentValidation.changeSet,
      desiredValidation.changeSet,
      subsystems,
      summary,
      rejections,
    );
    composeAccountsSubsystem(
      currentValidation.changeSet,
      desiredValidation.changeSet,
      subsystems,
      summary,
      rejections,
    );
    composeCapsulesSubsystem(
      currentValidation.changeSet,
      desiredValidation.changeSet,
      subsystems,
      rejections,
    );

    if (hasPreviewRejections(rejections)) {
      return rejectedPreview(rejections);
    }

    return Object.freeze({
      ok: true,
      subsystems: Object.freeze(subsystems),
      summary: Object.freeze({
        accountGroupChanges: summary.accountGroupChanges,
        newlyEnabledAccounts: summary.newlyEnabledAccounts,
        newlyEnabledServices: summary.newlyEnabledServices,
        weakensRetention: summary.weakensRetention,
        wideningInbound: summary.wideningInbound,
      }),
    });
  } catch {
    return rejectedPreview({
      preview: [
        {
          code: "PREVIEW_FAILED",
          message: "Node change-set preview failed.",
        },
      ],
    });
  }
}

function composeNodeConfigSubsystem(
  current: NodeChangeSet,
  desired: NodeChangeSet,
  subsystems: MutableNodeChangeSetSubsystems,
  summary: MutableNodeChangeSetPreviewSummary,
  rejections: MutableNodeChangeSetPreviewRejections,
): void {
  const currentPresent = hasSection(current, "nodeConfig");
  const desiredPresent = hasSection(desired, "nodeConfig");

  if (!currentPresent && !desiredPresent) {
    return;
  }

  const currentConfig = current.nodeConfig;
  const desiredConfig = desired.nodeConfig;

  if (currentPresent && desiredPresent) {
    if (currentConfig === undefined || desiredConfig === undefined) {
      appendMissingValidatedSectionRejection(
        rejections,
        "nodeConfig",
        currentConfig === undefined ? "current" : "desired",
      );
      return;
    }

    const preview = previewNodeConfigChange(currentConfig, desiredConfig);

    if (!preview.ok) {
      rejections.nodeConfig = preview.rejections;
      return;
    }

    const subsystem = nodeConfigChangedSubsystem(preview);
    subsystems.nodeConfig = subsystem;
    summary.wideningInbound = subsystem.wideningInbound;
    summary.weakensRetention = subsystem.weakensRetention;
    return;
  }

  if (desiredPresent) {
    if (desiredConfig === undefined) {
      appendMissingValidatedSectionRejection(rejections, "nodeConfig", "desired");
      return;
    }

    const subsystem: AddedNodeConfigSubsystemPreview = Object.freeze({
      after: desiredConfig,
      kind: "added",
      weakensRetention: false,
      wideningInbound: addedNodeConfigWidensInbound(desiredConfig),
    });

    subsystems.nodeConfig = subsystem;
    summary.wideningInbound = subsystem.wideningInbound;
    return;
  }

  if (currentConfig === undefined) {
    appendMissingValidatedSectionRejection(rejections, "nodeConfig", "current");
    return;
  }

  const subsystem: RemovedNodeConfigSubsystemPreview = Object.freeze({
    before: currentConfig,
    kind: "removed",
    weakensRetention: removedNodeConfigWeakensRetention(currentConfig),
    wideningInbound: false,
  });

  subsystems.nodeConfig = subsystem;
  summary.weakensRetention = subsystem.weakensRetention;
}

function composeServicesSubsystem(
  current: NodeChangeSet,
  desired: NodeChangeSet,
  subsystems: MutableNodeChangeSetSubsystems,
  summary: MutableNodeChangeSetPreviewSummary,
  rejections: MutableNodeChangeSetPreviewRejections,
): void {
  const currentPresent = hasSection(current, "services");
  const desiredPresent = hasSection(desired, "services");

  if (!currentPresent && !desiredPresent) {
    return;
  }

  const currentConfig = currentPresent ? current.services : EMPTY_SERVICES_CONFIG;
  const desiredConfig = desiredPresent ? desired.services : EMPTY_SERVICES_CONFIG;

  if (currentConfig === undefined || desiredConfig === undefined) {
    appendMissingValidatedSectionRejection(
      rejections,
      "services",
      currentConfig === undefined ? "current" : "desired",
    );
    return;
  }

  const preview = previewServicesChange(currentConfig, desiredConfig);

  if (!preview.valid) {
    rejections.services = preview.rejections;
    return;
  }

  const subsystem: ServicesSubsystemPreview = Object.freeze({
    diff: preview.diff,
    kind: subsystemKind(currentPresent, desiredPresent, hasServicesDiff(preview.diff)),
    newlyEnabledCount: preview.newlyEnabledCount,
  });

  subsystems.services = subsystem;
  summary.newlyEnabledServices = subsystem.newlyEnabledCount;
}

function composeAccountsSubsystem(
  current: NodeChangeSet,
  desired: NodeChangeSet,
  subsystems: MutableNodeChangeSetSubsystems,
  summary: MutableNodeChangeSetPreviewSummary,
  rejections: MutableNodeChangeSetPreviewRejections,
): void {
  const currentPresent = hasSection(current, "accounts");
  const desiredPresent = hasSection(desired, "accounts");

  if (!currentPresent && !desiredPresent) {
    return;
  }

  const currentConfig = currentPresent ? current.accounts : EMPTY_ACCOUNTS_CONFIG;
  const desiredConfig = desiredPresent ? desired.accounts : EMPTY_ACCOUNTS_CONFIG;

  if (currentConfig === undefined || desiredConfig === undefined) {
    appendMissingValidatedSectionRejection(
      rejections,
      "accounts",
      currentConfig === undefined ? "current" : "desired",
    );
    return;
  }

  const preview = previewAccountsChange(currentConfig, desiredConfig);

  if (!preview.valid) {
    rejections.accounts = preview.rejections;
    return;
  }

  const subsystem: AccountsSubsystemPreview = Object.freeze({
    diff: preview.diff,
    groupChanges: preview.groupChanges,
    kind: subsystemKind(currentPresent, desiredPresent, hasAccountsDiff(preview)),
    newlyEnabledCount: preview.newlyEnabledCount,
  });

  subsystems.accounts = subsystem;
  summary.accountGroupChanges = subsystem.groupChanges;
  summary.newlyEnabledAccounts = subsystem.newlyEnabledCount;
}

function composeCapsulesSubsystem(
  current: NodeChangeSet,
  desired: NodeChangeSet,
  subsystems: MutableNodeChangeSetSubsystems,
  rejections: MutableNodeChangeSetPreviewRejections,
): void {
  const currentPresent = hasSection(current, "capsules");
  const desiredPresent = hasSection(desired, "capsules");

  if (!currentPresent && !desiredPresent) {
    return;
  }

  const currentRegistry = currentPresent ? current.capsules : EMPTY_CAPSULE_REGISTRY;
  const desiredRegistry = desiredPresent ? desired.capsules : EMPTY_CAPSULE_REGISTRY;

  if (currentRegistry === undefined || desiredRegistry === undefined) {
    appendMissingValidatedSectionRejection(
      rejections,
      "capsules",
      currentRegistry === undefined ? "current" : "desired",
    );
    return;
  }

  const preview = previewCapsuleChange(currentRegistry, desiredRegistry);

  if (!preview.valid) {
    rejections.capsules = preview.rejections;
    return;
  }

  subsystems.capsules = Object.freeze({
    diff: preview.diff,
    integrityChanged: preview.integrityChanged,
    kind: subsystemKind(
      currentPresent,
      desiredPresent,
      hasCapsuleDiff(preview.diff) || preview.integrityChanged,
    ),
  });
}

function nodeConfigChangedSubsystem(
  preview: Extract<NodeConfigChangePreview, { readonly ok: true }>,
): NodeConfigChangedSubsystemPreview {
  return Object.freeze({
    kind: hasNodeConfigSummaryChanges(preview.summary) ? "changed" : "unchanged",
    sections: preview.sections,
    summary: preview.summary,
    weakensRetention: preview.summary.weakensRetention,
    wideningInbound: preview.summary.wideningInbound,
  });
}

function addedNodeConfigWidensInbound(config: NodeConfig): boolean {
  if (!Object.hasOwn(config, "network")) {
    return false;
  }

  const network = config.network;

  return network !== undefined && network.firewall.allow.length > 0;
}

function removedNodeConfigWeakensRetention(config: NodeConfig): boolean {
  return Object.hasOwn(config, "backup") && config.backup !== undefined;
}

function subsystemKind(
  currentPresent: boolean,
  desiredPresent: boolean,
  changed: boolean,
): NodeChangeSetSubsystemKind {
  if (currentPresent && desiredPresent) {
    return changed ? "changed" : "unchanged";
  }

  if (desiredPresent) {
    return "added";
  }

  return "removed";
}

function hasNodeConfigSummaryChanges(summary: NodeConfigChangeSummary): boolean {
  return (
    summary.added.length > 0 ||
    summary.removed.length > 0 ||
    summary.changed.length > 0
  );
}

function hasServicesDiff(diff: ServicesChangeDiff): boolean {
  return (
    hasRecordEntries(diff.added) ||
    hasRecordEntries(diff.removed) ||
    hasRecordEntries(diff.enabled) ||
    hasRecordEntries(diff.disabled)
  );
}

function hasAccountsDiff(
  preview: Extract<AccountsChangePreview, { readonly valid: true }>,
): boolean {
  return (
    hasRecordEntries(preview.diff.added) ||
    hasRecordEntries(preview.diff.removed) ||
    hasRecordEntries(preview.diff.modified)
  );
}

function hasCapsuleDiff(diff: CapsuleChangeDiff): boolean {
  return (
    hasRecordEntries(diff.installed) ||
    hasRecordEntries(diff.removed) ||
    hasRecordEntries(diff.upgraded) ||
    hasRecordEntries(diff.downgraded) ||
    hasRecordEntries(diff.stateChanged)
  );
}

function hasRecordEntries<T>(record: Readonly<Record<string, T>>): boolean {
  return Object.keys(record).length > 0;
}

function hasSection(changeSet: NodeChangeSet, section: NodeChangeSetSection): boolean {
  return Object.hasOwn(changeSet, section);
}

function appendMissingValidatedSectionRejection(
  rejections: MutableNodeChangeSetPreviewRejections,
  section: NodeChangeSetSection,
  side: "current" | "desired",
): void {
  if (rejections.preview === undefined) {
    rejections.preview = [];
  }

  rejections.preview[rejections.preview.length] = {
    code: "VALIDATED_SECTION_MISSING",
    message: `Validated ${side} change-set is missing ${section}.`,
    section,
    side,
  };
}

function hasPreviewRejections(rejections: MutableNodeChangeSetPreviewRejections): boolean {
  return (
    rejections.current !== undefined ||
    rejections.desired !== undefined ||
    rejections.nodeConfig !== undefined ||
    rejections.services !== undefined ||
    rejections.accounts !== undefined ||
    rejections.capsules !== undefined ||
    rejections.preview !== undefined
  );
}

function rejectedPreview(
  rejections: MutableNodeChangeSetPreviewRejections,
): Extract<NodeChangeSetPreview, { readonly ok: false }> {
  const output: MutableNodeChangeSetPreviewRejections = {};

  if (rejections.current !== undefined) {
    output.current = rejections.current;
  }
  if (rejections.desired !== undefined) {
    output.desired = rejections.desired;
  }
  if (rejections.nodeConfig !== undefined) {
    output.nodeConfig = Object.freeze([...rejections.nodeConfig]);
  }
  if (rejections.services !== undefined) {
    output.services = Object.freeze([...rejections.services]);
  }
  if (rejections.accounts !== undefined) {
    output.accounts = Object.freeze([...rejections.accounts]);
  }
  if (rejections.capsules !== undefined) {
    output.capsules = Object.freeze([...rejections.capsules]);
  }
  if (rejections.preview !== undefined) {
    output.preview = [...rejections.preview];
  }

  return Object.freeze({
    ok: false,
    rejections: Object.freeze(output),
  });
}

import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type SnapshotTierStatus = "active" | "configured-inactive" | "absent";
export type MirrorTierStatus = "active" | "absent";
export type LocalBackupTierStatus = "verified" | "configured" | "absent";
export type OffSiteBackupTierStatus = "configured" | "absent";
export type CapsuleExposure = "exposed-ingress" | "egress-only" | "network-mute";
export type DashboardProtocol = "tcp" | "udp";
export type BackupTargetKind =
  | "local-snapshot"
  | "attached-disk"
  | "peer-node"
  | "remote-object"
  | "sftp"
  | "vendor-managed";

export interface DashboardValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SnapshotTierEvidence {
  readonly snapshotAreaPresent: boolean;
  readonly cadence?: SnapshotCadence;
  readonly retentionCount?: number;
  readonly readOnlySnapshots?: boolean;
  readonly measuredSnapshotCount?: number;
}

export interface MirrorTierEvidence {
  readonly mirrorDevices?: number;
  readonly diskHealthStatus?: DiskHealthStatus;
}

export interface BackupTierEvidence {
  readonly targetKinds: readonly BackupTargetKind[];
}

export interface LocalBackupTierEvidence extends BackupTierEvidence {
  readonly archiveVerified: boolean;
}

export interface SnapshotTierSummary {
  readonly status: SnapshotTierStatus;
  readonly evidence: SnapshotTierEvidence;
}

export interface MirrorTierSummary {
  readonly status: MirrorTierStatus;
  readonly evidence: MirrorTierEvidence;
}

export interface LocalBackupTierSummary {
  readonly status: LocalBackupTierStatus;
  readonly evidence: LocalBackupTierEvidence;
}

export interface OffSiteBackupTierSummary {
  readonly status: OffSiteBackupTierStatus;
  readonly evidence: BackupTierEvidence;
}

export interface ProtectionOverallSummary {
  readonly protectedTiers: number;
}

export interface ProtectionSummary {
  readonly snapshots: SnapshotTierSummary;
  readonly mirror: MirrorTierSummary;
  readonly localBackup: LocalBackupTierSummary;
  readonly offSite: OffSiteBackupTierSummary;
  readonly overall: ProtectionOverallSummary;
}

export interface HostIngressPort {
  readonly proto: DashboardProtocol;
  readonly port: number;
}

export interface HostIngressRuleSummary {
  readonly proto: DashboardProtocol;
  readonly port: number;
  readonly sourceCidr: string;
  readonly wideOpen: boolean;
}

export interface HostExposureSummary {
  readonly openIngressPorts: readonly HostIngressPort[];
  readonly wideOpen: boolean;
  readonly rules: readonly HostIngressRuleSummary[];
}

export interface CapsuleExposureSummary {
  readonly capsuleId: string;
  readonly exposure: CapsuleExposure;
  readonly egressGrants: number;
  readonly ingressGrants: number;
}

export interface CapsuleExposureCounts {
  readonly exposedIngress: number;
  readonly egressOnly: number;
  readonly networkMute: number;
}

export interface ExposureSummary {
  readonly host: HostExposureSummary;
  readonly capsules: readonly CapsuleExposureSummary[];
  readonly counts: CapsuleExposureCounts;
}

export interface ProtectionDashboardSummary {
  readonly protection: ProtectionSummary;
  readonly exposure: ExposureSummary;
}

export type ProtectionSummaryResult =
  | {
      readonly ok: true;
      readonly protection: ProtectionSummary;
      readonly value: ProtectionSummary;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DashboardValidationError[];
    };

export type ExposureSummaryResult =
  | {
      readonly ok: true;
      readonly exposure: ExposureSummary;
      readonly value: ExposureSummary;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DashboardValidationError[];
    };

export type ProtectionDashboardResult =
  | {
      readonly ok: true;
      readonly dashboard: ProtectionDashboardSummary;
      readonly value: ProtectionDashboardSummary;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DashboardValidationError[];
    };

type SnapshotCadence = "disabled" | "hourly" | "daily" | "weekly";
type StorageAreaRole =
  | "system-state"
  | "user-data"
  | "app-state"
  | "snapshots"
  | "local-backup-cache";
type DiskHealthStatus = "healthy" | "degraded" | "critical" | "unknown";
type SmartHealthStatus = "passed" | "warning" | "failed" | "unknown";
type BackupCadence = "hourly" | "daily" | "weekly" | "monthly";
type CapsuleEntryState = "installed" | "disabled";
type Path = readonly string[];
type JsonRecord = PlainJsonObject;

interface ProtectionInput {
  readonly storageLayout?: StorageLayoutProjection;
  readonly backupPolicy?: BackupPolicyProjection;
  readonly backupArchive?: BackupArchiveProjection;
  readonly mirrorDevices?: number;
  readonly measuredSnapshotCount?: number;
}

interface ExposureInput {
  readonly networkPolicy?: NetworkPolicyProjection;
  readonly capsuleRegistry: readonly CapsuleRegistryEntry[];
  readonly capsuleNetworkGrants: readonly CapsuleNetworkGrant[];
}

interface StorageLayoutProjection {
  readonly snapshotAreaPresent: boolean;
  readonly cadence: SnapshotCadence;
  readonly retentionCount: number;
  readonly readOnlySnapshots: boolean;
  readonly diskHealthStatus: DiskHealthStatus;
}

interface BackupPolicyProjection {
  readonly targetKind: BackupTargetKind;
}

interface BackupArchiveProjection {
  readonly verified: boolean;
}

interface NetworkPolicyProjection {
  readonly rules: readonly HostIngressRuleSummary[];
}

interface CapsuleRegistryEntry {
  readonly id: string;
  readonly state: CapsuleEntryState;
  readonly version: string;
}

interface CapsuleNetworkGrant {
  readonly capsuleId: string;
  readonly egressGrants: number;
  readonly ingressGrants: number;
}

const PROTECTION_INPUT_FIELDS = new Set([
  "backupArchive",
  "backupPolicy",
  "measuredSnapshotCount",
  "mirrorDevices",
  "storageLayout",
]);
const EXPOSURE_INPUT_FIELDS = new Set([
  "capsuleNetworkGrants",
  "capsuleRegistry",
  "networkPolicy",
]);
const DASHBOARD_INPUT_FIELDS = new Set([
  ...PROTECTION_INPUT_FIELDS,
  ...EXPOSURE_INPUT_FIELDS,
]);

const STORAGE_LAYOUT_FIELDS = new Set([
  "dataVolume",
  "diskHealth",
  "snapshotPolicy",
  "subvolumes",
  "version",
]);
const DATA_VOLUME_FIELDS = new Set([
  "encryption",
  "filesystem",
  "recoveryKeyRequired",
  "tpmUnlock",
]);
const SUBVOLUME_FIELDS = new Set([
  "appId",
  "id",
  "path",
  "quotaGiB",
  "readOnly",
  "role",
]);
const SNAPSHOT_POLICY_FIELDS = new Set([
  "cadence",
  "minFreeBytes",
  "readOnlySnapshots",
  "retentionCount",
]);
const DISK_HEALTH_FIELDS = new Set([
  "checksumErrors",
  "freeBytes",
  "smart",
  "status",
  "totalBytes",
  "usedBytes",
]);
const SMART_HEALTH_FIELDS = new Set([
  "powerOnHours",
  "reallocatedSectors",
  "status",
  "temperatureC",
]);
const BACKUP_POLICY_FIELDS = new Set([
  "createdAt",
  "enabled",
  "id",
  "recoveryKeyRef",
  "retentionDays",
  "schedule",
  "target",
]);
const BACKUP_SCHEDULE_FIELDS = new Set(["cadence", "interval", "startAt"]);
const RECOVERY_KEY_REF_FIELDS = new Set(["handle", "id", "keyStoreRef"]);
const BACKUP_ARCHIVE_FIELDS = new Set(["last"]);
const BACKUP_ARCHIVE_LAST_FIELDS = new Set([
  "backupId",
  "created",
  "failure",
  "files",
  "op",
  "restored",
  "status",
  "verified",
]);
const BACKUP_ARCHIVE_FAILURE_FIELDS = new Set(["entry", "reason"]);
const AGENT_NETWORK_POLICY_FIELDS = new Set(["allow"]);
const AGENT_NETWORK_RULE_FIELDS = new Set([
  "interface",
  "port",
  "proto",
  "sourceCidr",
  "unsafeWideOpen",
]);
const NETWORK_CONFIG_FIELDS = new Set(["firewall", "interfaces"]);
const NETWORK_INTERFACE_FIELDS = new Set(["kind", "name"]);
const NETWORK_FIREWALL_FIELDS = new Set(["allow", "unsafeWideOpen"]);
const NETWORK_CONFIG_RULE_FIELDS = new Set(["port", "protocol", "sourceCidr"]);
const CAPSULE_ENTRY_FIELDS = new Set(["id", "integrity", "state", "version"]);
const CAPSULE_GRANT_FIELDS = new Set(["capsuleId", "egressGrants", "ingressGrants"]);

const STORAGE_AREA_ROLES = ["system-state", "user-data", "app-state", "snapshots", "local-backup-cache"] as const;
const REQUIRED_STORAGE_AREA_ROLES: readonly StorageAreaRole[] = [
  "system-state",
  "user-data",
  "app-state",
  "local-backup-cache",
];
const SINGLETON_STORAGE_AREA_ROLES = new Set<StorageAreaRole>([
  "system-state",
  "user-data",
  "snapshots",
  "local-backup-cache",
]);
const SNAPSHOT_CADENCES = ["disabled", "hourly", "daily", "weekly"] as const;
const DISK_HEALTH_STATUSES = ["healthy", "degraded", "critical", "unknown"] as const;
const SMART_HEALTH_STATUSES = ["passed", "warning", "failed", "unknown"] as const;
const BACKUP_CADENCES = ["hourly", "daily", "weekly", "monthly"] as const;
const BACKUP_TARGET_KINDS = [
  "local-snapshot",
  "attached-disk",
  "peer-node",
  "remote-object",
  "sftp",
  "vendor-managed",
] as const;
const LOCAL_BACKUP_TARGET_KINDS = new Set<BackupTargetKind>(["attached-disk", "local-snapshot"]);
const OFF_SITE_BACKUP_TARGET_KINDS = new Set<BackupTargetKind>([
  "peer-node",
  "remote-object",
  "sftp",
  "vendor-managed",
]);
const ARCHIVE_OPS = ["create", "restore", "verify"] as const;
const ARCHIVE_STATUSES = ["FAIL", "OK"] as const;
const PROTOCOLS = ["tcp", "udp"] as const;
const INTERFACE_KINDS = ["bridge", "ethernet", "loopback", "wifi"] as const;
const CAPSULE_STATES = ["disabled", "installed"] as const;
const WIDE_OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

const MAX_SNAPSHOT_RETENTION = 10_000;
const MAX_QUOTA_GIB = 1_000_000;
const MAX_REF_LENGTH = 2048;
const MAX_RETENTION_DAYS = 3650;
const MAX_BACKUP_INTERVAL = 31;
const MAX_MIRROR_DEVICES = 1024;
const MAX_CAPSULE_GRANTS = 1_000_000;
const MAX_ARCHIVE_FILES = Number.MAX_SAFE_INTEGER;

export function summarizeProtection(input: unknown): ProtectionSummaryResult {
  try {
    const normalized = normalizeInputObject(input);

    if (!normalized.ok) {
      return rejectProtection(normalized.errors);
    }

    const errors: DashboardValidationError[] = [];
    rejectUnknownFields(normalized.value, PROTECTION_INPUT_FIELDS, [], errors);
    const protectionInput = parseProtectionInput(normalized.value, errors);

    if (errors.length > 0 || protectionInput === undefined) {
      return rejectProtection(errors);
    }

    const protection = buildProtectionSummary(protectionInput);

    return Object.freeze({
      ok: true,
      protection,
      value: protection,
    });
  } catch {
    return rejectProtection([
      {
        message: "Protection dashboard summary failed.",
        path: "",
      },
    ]);
  }
}

export function summarizeExposure(input: unknown): ExposureSummaryResult {
  try {
    const normalized = normalizeInputObject(input);

    if (!normalized.ok) {
      return rejectExposure(normalized.errors);
    }

    const errors: DashboardValidationError[] = [];
    rejectUnknownFields(normalized.value, EXPOSURE_INPUT_FIELDS, [], errors);
    const exposureInput = parseExposureInput(normalized.value, errors);

    if (errors.length > 0 || exposureInput === undefined) {
      return rejectExposure(errors);
    }

    const exposure = buildExposureSummary(exposureInput);

    return Object.freeze({
      exposure,
      ok: true,
      value: exposure,
    });
  } catch {
    return rejectExposure([
      {
        message: "Exposure dashboard summary failed.",
        path: "",
      },
    ]);
  }
}

export function summarizeDashboard(input: unknown): ProtectionDashboardResult {
  try {
    const normalized = normalizeInputObject(input);

    if (!normalized.ok) {
      return rejectDashboard(normalized.errors);
    }

    const errors: DashboardValidationError[] = [];
    rejectUnknownFields(normalized.value, DASHBOARD_INPUT_FIELDS, [], errors);
    const protectionInput = parseProtectionInput(normalized.value, errors);
    const exposureInput = parseExposureInput(normalized.value, errors);

    if (
      errors.length > 0 ||
      protectionInput === undefined ||
      exposureInput === undefined
    ) {
      return rejectDashboard(errors);
    }

    const dashboard = Object.freeze({
      exposure: buildExposureSummary(exposureInput),
      protection: buildProtectionSummary(protectionInput),
    });

    return Object.freeze({
      dashboard,
      ok: true,
      value: dashboard,
    });
  } catch {
    return rejectDashboard([
      {
        message: "Protection dashboard summary failed.",
        path: "",
      },
    ]);
  }
}

function parseProtectionInput(
  value: JsonRecord,
  errors: DashboardValidationError[],
): ProtectionInput | undefined {
  const errorStart = errors.length;
  const storageLayout = hasOwn(value, "storageLayout")
    ? parseStorageLayout(value["storageLayout"], ["storageLayout"], errors)
    : undefined;
  const backupPolicy = hasOwn(value, "backupPolicy")
    ? parseBackupPolicy(value["backupPolicy"], ["backupPolicy"], errors)
    : undefined;
  const backupArchive = hasOwn(value, "backupArchive")
    ? parseBackupArchive(value["backupArchive"], ["backupArchive"], errors)
    : undefined;
  const mirrorDevices = hasOwn(value, "mirrorDevices")
    ? readIntegerValue(value["mirrorDevices"], 1, MAX_MIRROR_DEVICES, ["mirrorDevices"], errors)
    : undefined;
  const measuredSnapshotCount = hasOwn(value, "measuredSnapshotCount")
    ? readIntegerValue(
        value["measuredSnapshotCount"],
        0,
        Number.MAX_SAFE_INTEGER,
        ["measuredSnapshotCount"],
        errors,
      )
    : undefined;

  if (errors.length > errorStart) {
    return undefined;
  }

  const result: {
    storageLayout?: StorageLayoutProjection;
    backupPolicy?: BackupPolicyProjection;
    backupArchive?: BackupArchiveProjection;
    mirrorDevices?: number;
    measuredSnapshotCount?: number;
  } = {};

  if (storageLayout !== undefined) result.storageLayout = storageLayout;
  if (backupPolicy !== undefined) result.backupPolicy = backupPolicy;
  if (backupArchive !== undefined) result.backupArchive = backupArchive;
  if (mirrorDevices !== undefined) result.mirrorDevices = mirrorDevices;
  if (measuredSnapshotCount !== undefined) {
    result.measuredSnapshotCount = measuredSnapshotCount;
  }

  return Object.freeze(result);
}

function parseExposureInput(
  value: JsonRecord,
  errors: DashboardValidationError[],
): ExposureInput | undefined {
  const errorStart = errors.length;
  const networkPolicy = hasOwn(value, "networkPolicy")
    ? parseNetworkPolicy(value["networkPolicy"], ["networkPolicy"], errors)
    : undefined;
  const capsuleRegistry = hasOwn(value, "capsuleRegistry")
    ? parseCapsuleRegistry(value["capsuleRegistry"], ["capsuleRegistry"], errors)
    : Object.freeze([]) satisfies readonly CapsuleRegistryEntry[];
  const capsuleNetworkGrants = hasOwn(value, "capsuleNetworkGrants")
    ? parseCapsuleNetworkGrants(
        value["capsuleNetworkGrants"],
        ["capsuleNetworkGrants"],
        capsuleRegistry,
        errors,
      )
    : Object.freeze([]) satisfies readonly CapsuleNetworkGrant[];

  if (
    errors.length > errorStart ||
    capsuleRegistry === undefined ||
    capsuleNetworkGrants === undefined
  ) {
    return undefined;
  }

  const result: {
    networkPolicy?: NetworkPolicyProjection;
    capsuleRegistry: readonly CapsuleRegistryEntry[];
    capsuleNetworkGrants: readonly CapsuleNetworkGrant[];
  } = {
    capsuleNetworkGrants,
    capsuleRegistry,
  };

  if (networkPolicy !== undefined) {
    result.networkPolicy = networkPolicy;
  }

  return Object.freeze(result);
}

function buildProtectionSummary(input: ProtectionInput): ProtectionSummary {
  const targetKinds = input.backupPolicy === undefined
    ? Object.freeze([]) satisfies readonly BackupTargetKind[]
    : Object.freeze([input.backupPolicy.targetKind]) satisfies readonly BackupTargetKind[];
  const localTargetKinds = filterTargetKinds(targetKinds, LOCAL_BACKUP_TARGET_KINDS);
  const offSiteTargetKinds = filterTargetKinds(targetKinds, OFF_SITE_BACKUP_TARGET_KINDS);
  const archiveVerified = input.backupArchive?.verified === true;
  const snapshots = buildSnapshotTier(input);
  const mirror = buildMirrorTier(input);
  const localBackup = Object.freeze({
    evidence: Object.freeze({
      archiveVerified,
      targetKinds: localTargetKinds,
    }),
    status: localTargetKinds.length === 0
      ? "absent"
      : archiveVerified
        ? "verified"
        : "configured",
  }) satisfies LocalBackupTierSummary;
  const offSite = Object.freeze({
    evidence: Object.freeze({
      targetKinds: offSiteTargetKinds,
    }),
    status: offSiteTargetKinds.length === 0 ? "absent" : "configured",
  }) satisfies OffSiteBackupTierSummary;

  return Object.freeze({
    snapshots,
    mirror,
    localBackup,
    offSite,
    overall: Object.freeze({
      protectedTiers: countProtectedTiers([
        snapshots.status,
        mirror.status,
        localBackup.status,
        offSite.status,
      ]),
    }),
  });
}

function buildSnapshotTier(input: ProtectionInput): SnapshotTierSummary {
  const storage = input.storageLayout;

  if (storage === undefined || !storage.snapshotAreaPresent) {
    const evidence: {
      snapshotAreaPresent: boolean;
      measuredSnapshotCount?: number;
    } = {
      snapshotAreaPresent: false,
    };

    if (input.measuredSnapshotCount !== undefined) {
      evidence.measuredSnapshotCount = input.measuredSnapshotCount;
    }

    return Object.freeze({
      evidence: Object.freeze(evidence),
      status: "absent",
    });
  }

  const evidence: {
    snapshotAreaPresent: boolean;
    cadence: SnapshotCadence;
    retentionCount: number;
    readOnlySnapshots: boolean;
    measuredSnapshotCount?: number;
  } = {
    cadence: storage.cadence,
    readOnlySnapshots: storage.readOnlySnapshots,
    retentionCount: storage.retentionCount,
    snapshotAreaPresent: true,
  };

  if (input.measuredSnapshotCount !== undefined) {
    evidence.measuredSnapshotCount = input.measuredSnapshotCount;
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    status: storage.cadence !== "disabled" && storage.retentionCount >= 1
      ? "active"
      : "configured-inactive",
  });
}

function buildMirrorTier(input: ProtectionInput): MirrorTierSummary {
  const evidence: {
    mirrorDevices?: number;
    diskHealthStatus?: DiskHealthStatus;
  } = {};

  if (input.mirrorDevices !== undefined) {
    evidence.mirrorDevices = input.mirrorDevices;
  }
  if (input.storageLayout !== undefined) {
    evidence.diskHealthStatus = input.storageLayout.diskHealthStatus;
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    status: input.mirrorDevices !== undefined && input.mirrorDevices >= 2 ? "active" : "absent",
  });
}

function buildExposureSummary(input: ExposureInput): ExposureSummary {
  const rules = input.networkPolicy?.rules ?? Object.freeze([]) satisfies readonly HostIngressRuleSummary[];
  const sortedRules = Object.freeze([...rules].sort(compareRules));
  const capsules = buildCapsuleExposureSummaries(input.capsuleRegistry, input.capsuleNetworkGrants);
  const counts = countCapsuleExposure(capsules);

  return Object.freeze({
    host: Object.freeze({
      openIngressPorts: buildOpenIngressPorts(sortedRules),
      rules: sortedRules,
      wideOpen: sortedRules.some((rule) => rule.wideOpen),
    }),
    capsules,
    counts,
  });
}

function buildCapsuleExposureSummaries(
  registry: readonly CapsuleRegistryEntry[],
  grants: readonly CapsuleNetworkGrant[],
): readonly CapsuleExposureSummary[] {
  const grantsByCapsule = new Map<string, CapsuleNetworkGrant>();

  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];

    if (grant !== undefined) {
      grantsByCapsule.set(grant.capsuleId, grant);
    }
  }

  const capsules: CapsuleExposureSummary[] = [];
  const sortedRegistry = [...registry].sort((left, right) => compareStrings(left.id, right.id));

  for (let index = 0; index < sortedRegistry.length; index += 1) {
    const entry = sortedRegistry[index];

    if (entry === undefined) {
      continue;
    }

    const grant = grantsByCapsule.get(entry.id);
    const egressGrants = grant?.egressGrants ?? 0;
    const ingressGrants = grant?.ingressGrants ?? 0;

    capsules.push(Object.freeze({
      capsuleId: entry.id,
      egressGrants,
      exposure: classifyCapsuleExposure(egressGrants, ingressGrants),
      ingressGrants,
    }));
  }

  return Object.freeze(capsules);
}

function buildOpenIngressPorts(
  rules: readonly HostIngressRuleSummary[],
): readonly HostIngressPort[] {
  const seen = new Set<string>();
  const ports: HostIngressPort[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule === undefined) {
      continue;
    }

    const key = `${rule.proto}:${rule.port}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    ports.push(Object.freeze({
      port: rule.port,
      proto: rule.proto,
    }));
  }

  return Object.freeze(ports.sort(compareIngressPorts));
}

function countCapsuleExposure(
  capsules: readonly CapsuleExposureSummary[],
): CapsuleExposureCounts {
  let exposedIngress = 0;
  let egressOnly = 0;
  let networkMute = 0;

  for (let index = 0; index < capsules.length; index += 1) {
    const capsule = capsules[index];

    if (capsule === undefined) {
      continue;
    }

    switch (capsule.exposure) {
      case "exposed-ingress":
        exposedIngress += 1;
        break;
      case "egress-only":
        egressOnly += 1;
        break;
      case "network-mute":
        networkMute += 1;
        break;
    }
  }

  return Object.freeze({
    egressOnly,
    exposedIngress,
    networkMute,
  });
}

function classifyCapsuleExposure(egressGrants: number, ingressGrants: number): CapsuleExposure {
  if (ingressGrants >= 1) {
    return "exposed-ingress";
  }

  if (egressGrants >= 1) {
    return "egress-only";
  }

  return "network-mute";
}

function parseStorageLayout(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): StorageLayoutProjection | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected storage layout object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, STORAGE_LAYOUT_FIELDS, path, errors);
  readRequiredLiteral(value, "version", 1, [...path, "version"], errors);
  parseDataVolume(value["dataVolume"], [...path, "dataVolume"], errors);
  const subvolumes = parseSubvolumes(value["subvolumes"], [...path, "subvolumes"], errors);
  const snapshotPolicy = parseSnapshotPolicy(
    value["snapshotPolicy"],
    [...path, "snapshotPolicy"],
    errors,
  );
  const diskHealthStatus = parseDiskHealth(value["diskHealth"], [...path, "diskHealth"], errors);

  if (
    errors.length > errorStart ||
    subvolumes === undefined ||
    snapshotPolicy === undefined ||
    diskHealthStatus === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cadence: snapshotPolicy.cadence,
    diskHealthStatus,
    readOnlySnapshots: snapshotPolicy.readOnlySnapshots,
    retentionCount: snapshotPolicy.retentionCount,
    snapshotAreaPresent: subvolumes.snapshotAreaPresent,
  });
}

function parseDataVolume(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected data volume object.");
    return;
  }

  rejectUnknownFields(value, DATA_VOLUME_FIELDS, path, errors);
  readRequiredLiteral(value, "encryption", "luks2", [...path, "encryption"], errors);
  readRequiredLiteral(value, "filesystem", "btrfs", [...path, "filesystem"], errors);
  readRequiredBoolean(value, "tpmUnlock", [...path, "tpmUnlock"], errors);
  readRequiredLiteral(
    value,
    "recoveryKeyRequired",
    true,
    [...path, "recoveryKeyRequired"],
    errors,
  );
}

function parseSubvolumes(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): { readonly snapshotAreaPresent: boolean } | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected subvolumes array.");
    return undefined;
  }

  if (value.length === 0) {
    addError(errors, path, "Expected at least one subvolume.");
    return undefined;
  }

  let snapshotAreaPresent = false;
  const seenIds = new Set<string>();
  const seenRoles = new Map<StorageAreaRole, number>();
  const seenAppIds = new Map<string, number>();
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    const subvolume = parseSubvolume(value[index], [...path, String(index)], errors);

    if (subvolume === undefined) {
      continue;
    }

    if (seenIds.has(subvolume.id)) {
      addError(errors, [...path, String(index), "id"], "Duplicate subvolume id.");
    } else {
      seenIds.add(subvolume.id);
    }

    const previousRoleIndex = seenRoles.get(subvolume.role);
    if (previousRoleIndex !== undefined && SINGLETON_STORAGE_AREA_ROLES.has(subvolume.role)) {
      addError(
        errors,
        [...path, String(index), "role"],
        `Duplicate ${subvolume.role} area also appears at subvolumes/${previousRoleIndex}/role.`,
      );
    } else if (previousRoleIndex === undefined) {
      seenRoles.set(subvolume.role, index);
    }

    if (subvolume.role === "app-state" && subvolume.appId !== undefined) {
      const previousAppIndex = seenAppIds.get(subvolume.appId);

      if (previousAppIndex !== undefined) {
        addError(
          errors,
          [...path, String(index), "appId"],
          `Duplicate app-state appId also appears at subvolumes/${previousAppIndex}/appId.`,
        );
      } else {
        seenAppIds.set(subvolume.appId, index);
      }
    }

    if (subvolume.role === "snapshots") {
      snapshotAreaPresent = true;
    }
  }

  for (let index = 0; index < REQUIRED_STORAGE_AREA_ROLES.length; index += 1) {
    const role = REQUIRED_STORAGE_AREA_ROLES[index];

    if (role !== undefined && !seenRoles.has(role)) {
      addError(errors, path, `Missing required ${role} storage area.`);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze({
    snapshotAreaPresent,
  });
}

function parseSubvolume(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): { readonly id: string; readonly role: StorageAreaRole; readonly appId?: string } | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected subvolume object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, SUBVOLUME_FIELDS, path, errors);
  const id = readRequiredNonEmptyString(value, "id", [...path, "id"], errors);
  const role = readRequiredEnum(value, "role", STORAGE_AREA_ROLES, [...path, "role"], errors);
  const subvolumePath = readRequiredNonEmptyString(value, "path", [...path, "path"], errors);
  if (subvolumePath !== undefined && !isCanonicalAbsolutePath(subvolumePath)) {
    addError(errors, [...path, "path"], "Expected canonical absolute path.");
  }
  readOptionalInteger(value, "quotaGiB", 1, MAX_QUOTA_GIB, [...path, "quotaGiB"], errors);
  readOptionalBoolean(value, "readOnly", [...path, "readOnly"], errors);
  const appId = readOptionalNonEmptyString(value, "appId", [...path, "appId"], errors);

  if (role === "app-state" && appId === undefined) {
    addError(errors, [...path, "appId"], "app-state subvolumes require appId.");
  } else if (role !== undefined && role !== "app-state" && appId !== undefined) {
    addError(errors, [...path, "appId"], "appId is only allowed for app-state subvolumes.");
  }

  if (errors.length > errorStart || id === undefined || role === undefined) {
    return undefined;
  }

  if (appId !== undefined) {
    return Object.freeze({
      appId,
      id,
      role,
    });
  }

  return Object.freeze({
    id,
    role,
  });
}

function parseSnapshotPolicy(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): {
  readonly cadence: SnapshotCadence;
  readonly retentionCount: number;
  readonly readOnlySnapshots: true;
} | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected snapshot policy object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, SNAPSHOT_POLICY_FIELDS, path, errors);
  const cadence = readRequiredEnum(value, "cadence", SNAPSHOT_CADENCES, [...path, "cadence"], errors);
  const retentionCount = readRequiredInteger(
    value,
    "retentionCount",
    0,
    MAX_SNAPSHOT_RETENTION,
    [...path, "retentionCount"],
    errors,
  );
  const readOnlySnapshots = readRequiredLiteral(
    value,
    "readOnlySnapshots",
    true,
    [...path, "readOnlySnapshots"],
    errors,
  );
  readOptionalInteger(
    value,
    "minFreeBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "minFreeBytes"],
    errors,
  );

  if (
    errors.length > errorStart ||
    cadence === undefined ||
    retentionCount === undefined ||
    readOnlySnapshots === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cadence,
    readOnlySnapshots,
    retentionCount,
  });
}

function parseDiskHealth(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): DiskHealthStatus | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected disk health object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, DISK_HEALTH_FIELDS, path, errors);
  const status = readRequiredEnum(value, "status", DISK_HEALTH_STATUSES, [...path, "status"], errors);
  const totalBytes = readRequiredInteger(
    value,
    "totalBytes",
    1,
    Number.MAX_SAFE_INTEGER,
    [...path, "totalBytes"],
    errors,
  );
  const usedBytes = readRequiredInteger(
    value,
    "usedBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "usedBytes"],
    errors,
  );
  const freeBytes = readRequiredInteger(
    value,
    "freeBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "freeBytes"],
    errors,
  );
  readRequiredInteger(
    value,
    "checksumErrors",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "checksumErrors"],
    errors,
  );
  parseSmartHealth(value["smart"], [...path, "smart"], errors);

  if (totalBytes !== undefined && usedBytes !== undefined && usedBytes > totalBytes) {
    addError(errors, [...path, "usedBytes"], "Expected value less than or equal to totalBytes.");
  }
  if (totalBytes !== undefined && freeBytes !== undefined && freeBytes > totalBytes) {
    addError(errors, [...path, "freeBytes"], "Expected value less than or equal to totalBytes.");
  }
  if (
    totalBytes !== undefined &&
    usedBytes !== undefined &&
    freeBytes !== undefined &&
    usedBytes + freeBytes > totalBytes
  ) {
    addError(errors, [...path, "freeBytes"], "Expected usedBytes + freeBytes to fit totalBytes.");
  }

  if (errors.length > errorStart || status === undefined) {
    return undefined;
  }

  return status;
}

function parseSmartHealth(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected SMART health object.");
    return;
  }

  rejectUnknownFields(value, SMART_HEALTH_FIELDS, path, errors);
  readRequiredEnum(value, "status", SMART_HEALTH_STATUSES, [...path, "status"], errors);
  readRequiredInteger(
    value,
    "reallocatedSectors",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "reallocatedSectors"],
    errors,
  );
  readOptionalFiniteNumber(value, "temperatureC", -40, 125, [...path, "temperatureC"], errors);
  readOptionalInteger(
    value,
    "powerOnHours",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "powerOnHours"],
    errors,
  );
}

function parseBackupPolicy(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): BackupPolicyProjection | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup policy object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, BACKUP_POLICY_FIELDS, path, errors);
  readRequiredOpaqueRef(value, "id", [...path, "id"], errors);
  const targetKind = parseBackupTarget(value["target"], [...path, "target"], errors);
  parseBackupSchedule(value["schedule"], [...path, "schedule"], errors);
  readRequiredInteger(value, "retentionDays", 1, MAX_RETENTION_DAYS, [...path, "retentionDays"], errors);
  readRequiredNonEmptyString(value, "createdAt", [...path, "createdAt"], errors);
  readOptionalBoolean(value, "enabled", [...path, "enabled"], errors);
  if (hasOwn(value, "recoveryKeyRef")) {
    parseRecoveryKeyRef(value["recoveryKeyRef"], [...path, "recoveryKeyRef"], errors);
  }

  if (errors.length > errorStart || targetKind === undefined) {
    return undefined;
  }

  return Object.freeze({
    targetKind,
  });
}

function parseBackupTarget(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): BackupTargetKind | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup target object.");
    return undefined;
  }

  const kind = readRequiredEnum(value, "kind", BACKUP_TARGET_KINDS, [...path, "kind"], errors);

  if (kind === undefined) {
    return undefined;
  }

  switch (kind) {
    case "local-snapshot":
      rejectUnknownFields(value, new Set(["kind"]), path, errors);
      return errors.some((error) => error.path === formatPath([...path, "kind"])) ? undefined : kind;
    case "attached-disk":
      rejectUnknownFields(value, new Set(["deviceRef", "kind"]), path, errors);
      readRequiredOpaqueRef(value, "deviceRef", [...path, "deviceRef"], errors);
      return kind;
    case "peer-node":
      rejectUnknownFields(value, new Set(["kind", "nodeRef"]), path, errors);
      readRequiredOpaqueRef(value, "nodeRef", [...path, "nodeRef"], errors);
      return kind;
    case "remote-object":
      rejectUnknownFields(value, new Set(["bucketRef", "credentialRef", "kind"]), path, errors);
      readRequiredOpaqueRef(value, "bucketRef", [...path, "bucketRef"], errors);
      readRequiredOpaqueRef(value, "credentialRef", [...path, "credentialRef"], errors);
      return kind;
    case "sftp":
      rejectUnknownFields(value, new Set(["credentialRef", "endpointRef", "kind"]), path, errors);
      readRequiredOpaqueRef(value, "credentialRef", [...path, "credentialRef"], errors);
      readRequiredOpaqueRef(value, "endpointRef", [...path, "endpointRef"], errors);
      return kind;
    case "vendor-managed":
      rejectUnknownFields(value, new Set(["accountRef", "kind", "serviceRef"]), path, errors);
      readRequiredOpaqueRef(value, "accountRef", [...path, "accountRef"], errors);
      readRequiredOpaqueRef(value, "serviceRef", [...path, "serviceRef"], errors);
      return kind;
  }
}

function parseBackupSchedule(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup schedule object.");
    return;
  }

  rejectUnknownFields(value, BACKUP_SCHEDULE_FIELDS, path, errors);
  readRequiredEnum(value, "cadence", BACKUP_CADENCES, [...path, "cadence"], errors);
  readRequiredInteger(value, "interval", 1, MAX_BACKUP_INTERVAL, [...path, "interval"], errors);
  readRequiredNonEmptyString(value, "startAt", [...path, "startAt"], errors);
}

function parseRecoveryKeyRef(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery key reference object.");
    return;
  }

  rejectUnknownFields(value, RECOVERY_KEY_REF_FIELDS, path, errors);
  readRequiredOpaqueRef(value, "handle", [...path, "handle"], errors);
  readRequiredOpaqueRef(value, "id", [...path, "id"], errors);
  readOptionalOpaqueRef(value, "keyStoreRef", [...path, "keyStoreRef"], errors);
}

function parseBackupArchive(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): BackupArchiveProjection | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup archive state object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, BACKUP_ARCHIVE_FIELDS, path, errors);

  if (!hasOwn(value, "last")) {
    return Object.freeze({
      verified: false,
    });
  }

  const last = parseBackupArchiveLast(value["last"], [...path, "last"], errors);

  if (errors.length > errorStart || last === undefined) {
    return undefined;
  }

  return Object.freeze({
    verified: last.verified,
  });
}

function parseBackupArchiveLast(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): BackupArchiveProjection | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup archive last-result object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, BACKUP_ARCHIVE_LAST_FIELDS, path, errors);
  readRequiredEnum(value, "op", ARCHIVE_OPS, [...path, "op"], errors);
  readOptionalNonEmptyString(value, "backupId", [...path, "backupId"], errors);
  readRequiredInteger(value, "files", 0, MAX_ARCHIVE_FILES, [...path, "files"], errors);
  readRequiredBoolean(value, "created", [...path, "created"], errors);
  const verified = readRequiredBoolean(value, "verified", [...path, "verified"], errors);
  readRequiredBoolean(value, "restored", [...path, "restored"], errors);
  const status = readRequiredEnum(value, "status", ARCHIVE_STATUSES, [...path, "status"], errors);
  if (hasOwn(value, "failure")) {
    parseArchiveFailure(value["failure"], [...path, "failure"], errors);
  }

  if (errors.length > errorStart || verified === undefined || status === undefined) {
    return undefined;
  }

  return Object.freeze({
    verified: status === "OK" && verified,
  });
}

function parseArchiveFailure(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup archive failure object.");
    return;
  }

  rejectUnknownFields(value, BACKUP_ARCHIVE_FAILURE_FIELDS, path, errors);
  readRequiredNonEmptyString(value, "entry", [...path, "entry"], errors);
  readRequiredNonEmptyString(value, "reason", [...path, "reason"], errors);
}

function parseNetworkPolicy(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): NetworkPolicyProjection | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected network policy object.");
    return undefined;
  }

  if (hasOwn(value, "allow")) {
    return parseAgentNetworkPolicy(value, path, errors);
  }

  return parseNetworkConfig(value, path, errors);
}

function parseAgentNetworkPolicy(
  value: JsonRecord,
  path: Path,
  errors: DashboardValidationError[],
): NetworkPolicyProjection | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, AGENT_NETWORK_POLICY_FIELDS, path, errors);
  const allow = readRequiredArray(value, "allow", [...path, "allow"], errors);
  const rules: HostIngressRuleSummary[] = [];

  if (allow !== undefined) {
    for (let index = 0; index < allow.length; index += 1) {
      const rule = parseAgentNetworkRule(allow[index], [...path, "allow", String(index)], errors);

      if (rule !== undefined) {
        rules.push(rule);
      }
    }
  }

  if (errors.length > errorStart || allow === undefined) {
    return undefined;
  }

  return Object.freeze({
    rules: Object.freeze([...rules].sort(compareRules)),
  });
}

function parseAgentNetworkRule(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): HostIngressRuleSummary | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected network allow rule object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, AGENT_NETWORK_RULE_FIELDS, path, errors);
  const proto = readRequiredEnum(value, "proto", PROTOCOLS, [...path, "proto"], errors);
  const port = readPort(value["port"], [...path, "port"], errors);
  const sourceCidr = readRequiredNonEmptyString(value, "sourceCidr", [...path, "sourceCidr"], errors);
  const unsafeWideOpen = readOptionalBoolean(value, "unsafeWideOpen", [...path, "unsafeWideOpen"], errors) ?? false;
  readOptionalNonEmptyString(value, "interface", [...path, "interface"], errors);

  if (sourceCidr !== undefined && !isValidCidr(sourceCidr)) {
    addError(errors, [...path, "sourceCidr"], "Expected a valid CIDR.");
  }

  if (errors.length > errorStart || proto === undefined || port === undefined || sourceCidr === undefined) {
    return undefined;
  }

  return Object.freeze({
    port,
    proto,
    sourceCidr,
    wideOpen: unsafeWideOpen || WIDE_OPEN_CIDRS.has(sourceCidr),
  });
}

function parseNetworkConfig(
  value: JsonRecord,
  path: Path,
  errors: DashboardValidationError[],
): NetworkPolicyProjection | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, NETWORK_CONFIG_FIELDS, path, errors);
  parseNetworkInterfaces(value["interfaces"], [...path, "interfaces"], errors);
  const rules = parseNetworkFirewall(value["firewall"], [...path, "firewall"], errors);

  if (errors.length > errorStart || rules === undefined) {
    return undefined;
  }

  return Object.freeze({
    rules: Object.freeze([...rules].sort(compareRules)),
  });
}

function parseNetworkInterfaces(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): void {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected interfaces array.");
    return;
  }

  if (value.length === 0) {
    addError(errors, path, "Expected at least one interface.");
    return;
  }

  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      addError(errors, [...path, String(index)], "Expected interface object.");
      continue;
    }

    rejectUnknownFields(item, NETWORK_INTERFACE_FIELDS, [...path, String(index)], errors);
    const name = readRequiredNonEmptyString(item, "name", [...path, String(index), "name"], errors);
    readRequiredEnum(item, "kind", INTERFACE_KINDS, [...path, String(index), "kind"], errors);

    if (name !== undefined) {
      if (seen.has(name)) {
        addError(errors, [...path, String(index), "name"], "Duplicate interface name.");
      } else {
        seen.add(name);
      }
    }
  }
}

function parseNetworkFirewall(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): readonly HostIngressRuleSummary[] | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected firewall object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, NETWORK_FIREWALL_FIELDS, path, errors);
  const unsafeWideOpen = readOptionalBoolean(value, "unsafeWideOpen", [...path, "unsafeWideOpen"], errors) ?? false;
  const allow = readRequiredArray(value, "allow", [...path, "allow"], errors);
  const rules: HostIngressRuleSummary[] = [];

  if (allow !== undefined) {
    for (let index = 0; index < allow.length; index += 1) {
      const rule = parseNetworkConfigRule(
        allow[index],
        [...path, "allow", String(index)],
        unsafeWideOpen,
        errors,
      );

      if (rule !== undefined) {
        rules.push(rule);
      }
    }
  }

  if (errors.length > errorStart || allow === undefined) {
    return undefined;
  }

  return Object.freeze(rules);
}

function parseNetworkConfigRule(
  value: PlainJson | undefined,
  path: Path,
  unsafeWideOpen: boolean,
  errors: DashboardValidationError[],
): HostIngressRuleSummary | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected network allow rule object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, NETWORK_CONFIG_RULE_FIELDS, path, errors);
  const proto = readRequiredEnum(value, "protocol", PROTOCOLS, [...path, "protocol"], errors);
  const port = readPort(value["port"], [...path, "port"], errors);
  const sourceCidr = readRequiredNonEmptyString(value, "sourceCidr", [...path, "sourceCidr"], errors);

  if (sourceCidr !== undefined && !isValidCidr(sourceCidr)) {
    addError(errors, [...path, "sourceCidr"], "Expected a valid CIDR.");
  }

  if (errors.length > errorStart || proto === undefined || port === undefined || sourceCidr === undefined) {
    return undefined;
  }

  return Object.freeze({
    port,
    proto,
    sourceCidr,
    wideOpen: unsafeWideOpen || WIDE_OPEN_CIDRS.has(sourceCidr),
  });
}

function parseCapsuleRegistry(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): readonly CapsuleRegistryEntry[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected capsule registry array.");
    return undefined;
  }

  const entries: CapsuleRegistryEntry[] = [];
  const seenIds = new Set<string>();
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    const entry = parseCapsuleEntry(value[index], [...path, String(index)], errors);

    if (entry === undefined) {
      continue;
    }

    if (seenIds.has(entry.id)) {
      addError(errors, [...path, String(index), "id"], "Duplicate capsule id.");
      continue;
    }

    seenIds.add(entry.id);
    entries.push(entry);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(entries.sort((left, right) => compareStrings(left.id, right.id)));
}

function parseCapsuleEntry(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): CapsuleRegistryEntry | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capsule entry object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, CAPSULE_ENTRY_FIELDS, path, errors);
  const id = readRequiredNonEmptyString(value, "id", [...path, "id"], errors);
  const version = readRequiredNonEmptyString(value, "version", [...path, "version"], errors);
  const state = readRequiredEnum(value, "state", CAPSULE_STATES, [...path, "state"], errors);
  readOptionalNonEmptyString(value, "integrity", [...path, "integrity"], errors);

  if (errors.length > errorStart || id === undefined || version === undefined || state === undefined) {
    return undefined;
  }

  return Object.freeze({
    id,
    state,
    version,
  });
}

function parseCapsuleNetworkGrants(
  value: PlainJson | undefined,
  path: Path,
  registry: readonly CapsuleRegistryEntry[] | undefined,
  errors: DashboardValidationError[],
): readonly CapsuleNetworkGrant[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected capsule network grants array.");
    return undefined;
  }

  const registryIds = new Set<string>();
  if (registry !== undefined) {
    for (let index = 0; index < registry.length; index += 1) {
      const entry = registry[index];
      if (entry !== undefined) {
        registryIds.add(entry.id);
      }
    }
  }

  const grants: CapsuleNetworkGrant[] = [];
  const seenIds = new Set<string>();
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    const grant = parseCapsuleNetworkGrant(value[index], [...path, String(index)], errors);

    if (grant === undefined) {
      continue;
    }

    if (!registryIds.has(grant.capsuleId)) {
      addError(errors, [...path, String(index), "capsuleId"], "Capsule grant has no registry entry.");
      continue;
    }

    if (seenIds.has(grant.capsuleId)) {
      addError(errors, [...path, String(index), "capsuleId"], "Duplicate capsule network grant.");
      continue;
    }

    seenIds.add(grant.capsuleId);
    grants.push(grant);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(grants.sort((left, right) => compareStrings(left.capsuleId, right.capsuleId)));
}

function parseCapsuleNetworkGrant(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): CapsuleNetworkGrant | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capsule network grant object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, CAPSULE_GRANT_FIELDS, path, errors);
  const capsuleId = readRequiredNonEmptyString(value, "capsuleId", [...path, "capsuleId"], errors);
  const egressGrants = readRequiredInteger(
    value,
    "egressGrants",
    0,
    MAX_CAPSULE_GRANTS,
    [...path, "egressGrants"],
    errors,
  );
  const ingressGrants = readRequiredInteger(
    value,
    "ingressGrants",
    0,
    MAX_CAPSULE_GRANTS,
    [...path, "ingressGrants"],
    errors,
  );

  if (
    errors.length > errorStart ||
    capsuleId === undefined ||
    egressGrants === undefined ||
    ingressGrants === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    capsuleId,
    egressGrants,
    ingressGrants,
  });
}

function normalizeInputObject(input: unknown):
  | {
      readonly ok: true;
      readonly value: JsonRecord;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DashboardValidationError[];
    } {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return rejectNormalized(`Invalid untrusted input: ${normalized.reason}`);
  }

  if (!isRecord(normalized.value)) {
    return rejectNormalized("Expected dashboard input object.");
  }

  return {
    ok: true,
    value: normalized.value,
  };
}

function rejectNormalized(
  message: string,
): { readonly ok: false; readonly errors: readonly DashboardValidationError[] } {
  return {
    errors: Object.freeze([
      Object.freeze({
        message,
        path: "",
      }),
    ]),
    ok: false,
  };
}

function filterTargetKinds(
  targetKinds: readonly BackupTargetKind[],
  allowed: ReadonlySet<BackupTargetKind>,
): readonly BackupTargetKind[] {
  const filtered: BackupTargetKind[] = [];

  for (let index = 0; index < targetKinds.length; index += 1) {
    const kind = targetKinds[index];

    if (kind !== undefined && allowed.has(kind)) {
      filtered.push(kind);
    }
  }

  return Object.freeze(filtered.sort(compareStrings));
}

function countProtectedTiers(statuses: readonly string[]): number {
  let count = 0;

  for (let index = 0; index < statuses.length; index += 1) {
    if (statuses[index] !== "absent") {
      count += 1;
    }
  }

  return count;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): PlainJson | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return value[key];
}

function readRequiredLiteral<T extends string | number | boolean>(
  value: JsonRecord,
  key: string,
  expected: T,
  path: Path,
  errors: DashboardValidationError[],
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child !== expected) {
    addError(errors, path, `Expected ${String(expected)}.`);
    return undefined;
  }

  return expected;
}

function readRequiredEnum<T extends string>(
  value: JsonRecord,
  key: string,
  allowed: readonly T[],
  path: Path,
  errors: DashboardValidationError[],
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isStringMember(child, allowed)) {
    addError(errors, path, `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }

  return child;
}

function readRequiredNonEmptyString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || child.length === 0) {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readOptionalNonEmptyString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child.length === 0) {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): boolean | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): boolean | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readRequiredInteger(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: DashboardValidationError[],
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return readIntegerValue(child, min, max, path, errors);
}

function readOptionalInteger(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: DashboardValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return readIntegerValue(value[key], min, max, path, errors);
}

function readIntegerValue(
  value: PlainJson | undefined,
  min: number,
  max: number,
  path: Path,
  errors: DashboardValidationError[],
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    addError(errors, path, `Expected integer from ${min} through ${max}.`);
    return undefined;
  }

  return value;
}

function readOptionalFiniteNumber(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: DashboardValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "number" || !Number.isFinite(child) || child < min || child > max) {
    addError(errors, path, `Expected finite number from ${min} through ${max}.`);
    return undefined;
  }

  return child;
}

function readRequiredOpaqueRef(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): string | undefined {
  const ref = readRequiredNonEmptyString(value, key, path, errors);

  if (ref === undefined) {
    return undefined;
  }

  if (!isOpaqueRef(ref)) {
    addError(errors, path, "Expected opaque reference syntax.");
    return undefined;
  }

  return ref;
}

function readOptionalOpaqueRef(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): string | undefined {
  const ref = readOptionalNonEmptyString(value, key, path, errors);

  if (ref === undefined) {
    return undefined;
  }

  if (!isOpaqueRef(ref)) {
    addError(errors, path, "Expected opaque reference syntax.");
    return undefined;
  }

  return ref;
}

function readRequiredArray(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: DashboardValidationError[],
): readonly PlainJson[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }

  return child;
}

function readPort(
  value: PlainJson | undefined,
  path: Path,
  errors: DashboardValidationError[],
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value === 0 ||
    value < -1 ||
    value > 65535
  ) {
    addError(errors, path, "Expected port -1 or 1-65535.");
    return undefined;
  }

  return value;
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: DashboardValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringMember<T extends string>(value: PlainJson, allowed: readonly T[]): value is T {
  if (typeof value !== "string") {
    return false;
  }

  for (let index = 0; index < allowed.length; index += 1) {
    if (allowed[index] === value) {
      return true;
    }
  }

  return false;
}

function isOpaqueRef(value: string): boolean {
  return value.length <= MAX_REF_LENGTH && value === value.trim() && !/[\s<>{}`"']/u.test(value);
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value === "/" || value.endsWith("/")) {
    return false;
  }

  const segments = value.split("/");

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (
      segment === undefined ||
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\0")
    ) {
      return false;
    }
  }

  return true;
}

function isValidCidr(value: string): boolean {
  if (value !== value.trim()) {
    return false;
  }

  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return false;
  }

  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^[0-9]{1,3}$/u.test(prefixText)) {
    return false;
  }

  const prefix = Number(prefixText);

  if (address.includes(":")) {
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128 && isIpv6(address);
  }

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const octets = address.split(".");
  if (octets.length !== 4) {
    return false;
  }

  for (let index = 0; index < octets.length; index += 1) {
    const octet = octets[index];

    if (octet === undefined || !/^[0-9]{1,3}$/u.test(octet)) {
      return false;
    }

    const numberValue = Number(octet);
    if (numberValue < 0 || numberValue > 255) {
      return false;
    }

    if (octet.length > 1 && octet.startsWith("0")) {
      return false;
    }
  }

  return true;
}

function isIpv6(value: string): boolean {
  if (value.length === 0 || /[^0-9a-f:]/u.test(value)) {
    return false;
  }

  const doubleColon = value.split("::");
  if (doubleColon.length > 2) {
    return false;
  }

  const groups = value.replace("::", ":").split(":").filter((group) => group.length > 0);
  if (groups.length > 8) {
    return false;
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group === undefined || group.length > 4) {
      return false;
    }
  }

  return doubleColon.length === 2 || groups.length === 8;
}

function compareRules(left: HostIngressRuleSummary, right: HostIngressRuleSummary): number {
  const proto = compareStrings(left.proto, right.proto);
  if (proto !== 0) return proto;

  const port = left.port - right.port;
  if (port !== 0) return port;

  return compareStrings(left.sourceCidr, right.sourceCidr);
}

function compareIngressPorts(left: HostIngressPort, right: HostIngressPort): number {
  const proto = compareStrings(left.proto, right.proto);
  if (proto !== 0) return proto;

  return left.port - right.port;
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

function addError(
  errors: DashboardValidationError[],
  path: Path,
  message: string,
): void {
  errors.push(Object.freeze({
    message,
    path: formatPath(path),
  }));
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function rejectProtection(errors: readonly DashboardValidationError[]): Extract<ProtectionSummaryResult, { readonly ok: false }> {
  return Object.freeze({
    errors: Object.freeze([...errors]),
    ok: false,
  });
}

function rejectExposure(errors: readonly DashboardValidationError[]): Extract<ExposureSummaryResult, { readonly ok: false }> {
  return Object.freeze({
    errors: Object.freeze([...errors]),
    ok: false,
  });
}

function rejectDashboard(errors: readonly DashboardValidationError[]): Extract<ProtectionDashboardResult, { readonly ok: false }> {
  return Object.freeze({
    errors: Object.freeze([...errors]),
    ok: false,
  });
}

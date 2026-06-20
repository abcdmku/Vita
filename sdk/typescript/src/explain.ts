import type {
  CanonicalApp,
  CanonicalBackup,
  CanonicalJsonObject,
  CanonicalJsonValue,
  CanonicalPlan,
} from "./plan.ts";

export function explainPlan(plan: CanonicalPlan): string {
  return [
    `Canonical plan v${plan.version}`,
    "",
    "Identity",
    ...explainIdentity(plan),
    "",
    "Storage",
    ...explainStorage(plan),
    "",
    `Apps (${plan.apps.length})`,
    ...explainApps(plan.apps),
    "",
    `Backups (${plan.backups.length})`,
    ...explainBackups(plan.backups),
  ].join("\n");
}

function explainIdentity(plan: CanonicalPlan): readonly string[] {
  const { owner, passkeysRequired } = plan.identity;
  const ownerLine =
    owner === undefined
      ? "  Owner: not declared"
      : `  Owner: ${formatOwner(owner.id, owner.displayName)}`;

  return [ownerLine, `  Passkeys required: ${formatOptionalBoolean(passkeysRequired)}`];
}

function explainStorage(plan: CanonicalPlan): readonly string[] {
  const dataVolume = plan.storage.dataVolume;

  if (dataVolume === undefined) {
    return ["  Data volume: not declared"];
  }

  return [
    "  Data volume:",
    `    Encryption: ${dataVolume.encryption ?? "not specified"}`,
    `    Snapshots: ${dataVolume.snapshots ?? "not specified"}`,
    `    Quota: ${dataVolume.quotaGiB === undefined ? "not specified" : `${dataVolume.quotaGiB} GiB`}`,
  ];
}

function explainApps(apps: readonly CanonicalApp[]): readonly string[] {
  if (apps.length === 0) {
    return ["  None"];
  }

  return sortedApps(apps).flatMap((app) => [
    `  - ${app.id}`,
    `    Enabled: ${formatOptionalBoolean(app.enabled)}`,
    `    Version: ${app.version ?? "not specified"}`,
    ...explainConfig(app.config, "    "),
  ]);
}

function explainBackups(backups: readonly CanonicalBackup[]): readonly string[] {
  if (backups.length === 0) {
    return ["  None"];
  }

  return sortedBackups(backups).flatMap((backup) => [
    `  - ${backup.id}`,
    `    Enabled: ${formatOptionalBoolean(backup.enabled)}`,
    `    Target: ${backup.target}`,
    `    Schedule: ${backup.schedule}`,
    `    Retention: ${
      backup.retentionDays === undefined ? "not specified" : `${backup.retentionDays} days`
    }`,
  ]);
}

function explainConfig(config: CanonicalJsonObject | undefined, indent: string): readonly string[] {
  if (config === undefined) {
    return [`${indent}Config: not specified`];
  }

  const keys = Object.keys(config).sort(compareStrings);

  if (keys.length === 0) {
    return [`${indent}Config: {}`];
  }

  return [`${indent}Config:`, ...formatObjectEntries(config, `${indent}  `)];
}

function formatObjectEntries(object: CanonicalJsonObject, indent: string): readonly string[] {
  return Object.keys(object)
    .sort(compareStrings)
    .flatMap((key) => formatNamedValue(key, objectValue(object, key), indent));
}

function formatNamedValue(
  key: string,
  value: CanonicalJsonValue,
  indent: string,
): readonly string[] {
  if (isCanonicalJsonObject(value)) {
    const keys = Object.keys(value).sort(compareStrings);

    if (keys.length === 0) {
      return [`${indent}${key}: {}`];
    }

    return [`${indent}${key}:`, ...formatObjectEntries(value, `${indent}  `)];
  }

  if (isCanonicalJsonArray(value)) {
    if (value.length === 0) {
      return [`${indent}${key}: []`];
    }

    return [`${indent}${key}:`, ...formatArrayItems(value, `${indent}  `)];
  }

  return [`${indent}${key}: ${formatScalar(value)}`];
}

function formatArrayItems(values: readonly CanonicalJsonValue[], indent: string): readonly string[] {
  return values.flatMap((value) => {
    if (isCanonicalJsonObject(value)) {
      const keys = Object.keys(value).sort(compareStrings);

      if (keys.length === 0) {
        return [`${indent}- {}`];
      }

      const firstKey = firstString(keys);

      return [
        ...formatArrayObjectFirstEntry(firstKey, objectValue(value, firstKey), indent),
        ...keys
          .slice(1)
          .flatMap((key) => formatNamedValue(key, objectValue(value, key), `${indent}  `)),
      ];
    }

    if (isCanonicalJsonArray(value)) {
      if (value.length === 0) {
        return [`${indent}- []`];
      }

      return [`${indent}-`, ...formatArrayItems(value, `${indent}  `)];
    }

    return [`${indent}- ${formatScalar(value)}`];
  });
}

function formatArrayObjectFirstEntry(
  key: string,
  value: CanonicalJsonValue,
  indent: string,
): readonly string[] {
  const lines = formatNamedValue(key, value, `${indent}- `);
  const firstLine = lines[0] ?? "";
  const remainingLines = lines.slice(1);

  return [firstLine, ...remainingLines.map((line) => `${indent}  ${line.slice(indent.length + 2)}`)];
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }

  return String(value);
}

function formatOptionalBoolean(value: boolean | undefined): string {
  if (value === undefined) {
    return "not specified";
  }

  return value ? "yes" : "no";
}

function formatOwner(id: string, displayName: string | undefined): string {
  if (displayName === undefined) {
    return id;
  }

  return `${displayName} (${id})`;
}

function objectValue(object: CanonicalJsonObject, key: string): CanonicalJsonValue {
  return object[key] ?? null;
}

function firstString(values: readonly string[]): string {
  const value = values[0];

  if (value === undefined) {
    throw new TypeError("Expected at least one value.");
  }

  return value;
}

function sortedApps(apps: readonly CanonicalApp[]): readonly CanonicalApp[] {
  return [...apps].sort(
    (left, right) => compareStrings(left.id, right.id) || compareJson(left, right),
  );
}

function sortedBackups(backups: readonly CanonicalBackup[]): readonly CanonicalBackup[] {
  return [...backups].sort(
    (left, right) => compareStrings(left.id, right.id) || compareJson(left, right),
  );
}

function compareJson(left: unknown, right: unknown): number {
  return compareStrings(JSON.stringify(left) ?? "", JSON.stringify(right) ?? "");
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

function isCanonicalJsonObject(value: CanonicalJsonValue): value is CanonicalJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalJsonArray(
  value: CanonicalJsonValue,
): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value);
}

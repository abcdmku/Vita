import { validateBackupPolicy } from "./backup-model.ts";
import { validateIdentityConfig } from "./identity-model.ts";
import { validateNetworkConfig } from "./network-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import { validateStorageLayout } from "./storage-model.ts";
import type { BackupPolicy } from "./backup-model.ts";
import type { IdentityConfig } from "./identity-model.ts";
import type { NetworkConfig } from "./network-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";
import type { StorageLayout } from "./storage-model.ts";

export interface NodeConfig {
  readonly storage?: StorageLayout;
  readonly network?: NetworkConfig;
  readonly backup?: BackupPolicy;
  readonly identity?: IdentityConfig;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | {
      readonly ok: true;
      readonly config: NodeConfig;
      readonly value: NodeConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];
type SectionName = keyof NodeConfig;

const NODE_CONFIG_FIELDS = new Set<SectionName>([
  "backup",
  "identity",
  "network",
  "storage",
]);

export function validateNodeConfig(input: unknown): Result {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([
        {
          path: "",
          message: `Invalid untrusted input: ${normalized.reason}`,
        },
      ]);
    }

    const errors: ValidationError[] = [];
    const config = parseNodeConfig(normalized.value, errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      config,
      value: config,
    };
  } catch {
    return reject([{ path: "", message: "Node config validation failed." }]);
  }
}

function parseNodeConfig(value: PlainJson, errors: ValidationError[]): NodeConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, [], "Expected node config object.");
    return undefined;
  }

  const errorStart = errors.length;
  const topLevelKeys = Object.keys(value);

  rejectUnknownFields(value, NODE_CONFIG_FIELDS, [], errors);

  if (topLevelKeys.length === 0) {
    addError(errors, [], "Expected at least one config section.");
  }

  const storage = hasOwn(value, "storage")
    ? validateStorageSection(value.storage, errors)
    : undefined;
  const network = hasOwn(value, "network")
    ? validateNetworkSection(value.network, errors)
    : undefined;
  const backup = hasOwn(value, "backup")
    ? validateBackupSection(value.backup, errors)
    : undefined;
  const identity = hasOwn(value, "identity")
    ? validateIdentitySection(value.identity, errors)
    : undefined;

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze({
    ...(storage === undefined ? {} : { storage }),
    ...(network === undefined ? {} : { network }),
    ...(backup === undefined ? {} : { backup }),
    ...(identity === undefined ? {} : { identity }),
  });
}

function validateStorageSection(
  value: PlainJson | undefined,
  errors: ValidationError[],
): StorageLayout | undefined {
  const result = validateStorageLayout(value);

  if (!result.ok) {
    appendSectionErrors(errors, "storage", result.errors);
    return undefined;
  }

  return result.layout;
}

function validateNetworkSection(
  value: PlainJson | undefined,
  errors: ValidationError[],
): NetworkConfig | undefined {
  const result = validateNetworkConfig(value);

  if (!result.ok) {
    appendSectionErrors(errors, "network", result.errors);
    return undefined;
  }

  return result.config;
}

function validateBackupSection(
  value: PlainJson | undefined,
  errors: ValidationError[],
): BackupPolicy | undefined {
  const result = validateBackupPolicy(value);

  if (!result.ok) {
    appendSectionErrors(errors, "backup", result.errors);
    return undefined;
  }

  return result.policy;
}

function validateIdentitySection(
  value: PlainJson | undefined,
  errors: ValidationError[],
): IdentityConfig | undefined {
  const result = validateIdentityConfig(value);

  if (!result.ok) {
    appendSectionErrors(errors, "identity", result.errors);
    return undefined;
  }

  return result.config;
}

function appendSectionErrors(
  errors: ValidationError[],
  section: SectionName,
  sectionErrors: readonly ValidationError[],
): void {
  for (let index = 0; index < sectionErrors.length; index += 1) {
    const error = sectionErrors[index];

    if (error === undefined) {
      continue;
    }

    errors.push({
      message: error.message,
      path: prefixPath(section, error.path),
    });
  }
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isRecord(value: PlainJson): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({
    message,
    path: formatPath(path),
  });
}

function reject(errors: readonly ValidationError[]): Extract<Result, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
}

function prefixPath(section: SectionName, path: string): string {
  if (path === "") {
    return section;
  }

  return `${section}/${path}`;
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
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

import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface Account {
  readonly name: string;
  readonly uid: number;
  readonly primaryGroup: string;
  readonly groups: readonly string[];
  readonly shell: string;
  readonly enabled: boolean;
}

export interface AccountsConfig {
  readonly accounts: readonly Account[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type AccountsConfigValidationResult =
  | {
      readonly ok: true;
      readonly config: AccountsConfig;
      readonly value: AccountsConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

export type Result = AccountsConfigValidationResult;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const ACCOUNTS_CONFIG_FIELDS = new Set(["accounts"]);
const ACCOUNT_FIELDS = new Set([
  "enabled",
  "groups",
  "name",
  "primaryGroup",
  "shell",
  "uid",
]);

const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const GROUP_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const MIN_MANAGED_UID = 1000;
const MAX_MANAGED_UID = 60000;
const PRIVILEGED_GROUPS = new Set(["admin", "root", "sudo", "wheel"]);
const ALLOWED_SHELLS = new Set([
  "/bin/bash",
  "/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
  "/usr/sbin/nologin",
  "/bin/false",
]);

const DATA_URL_PATTERN = /\bdata:/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

export function validateAccountsConfig(input: unknown): AccountsConfigValidationResult {
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
    const config = parseAccountsConfig(normalized.value, [], errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      config,
      value: config,
    };
  } catch {
    return reject([{ path: "", message: "Accounts config validation failed." }]);
  }
}

function parseAccountsConfig(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): AccountsConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected accounts config object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, ACCOUNTS_CONFIG_FIELDS, path, errors);

  const accounts = readAccounts(value, [...path, "accounts"], errors);

  if (errors.length > errorStart || accounts === undefined) {
    return undefined;
  }

  return Object.freeze({
    accounts,
  });
}

function readAccounts(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly Account[] | undefined {
  const child = readRequiredProperty(value, "accounts", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected accounts array.");
    return undefined;
  }

  const accounts: Account[] = [];
  const seenNames = new Map<string, number>();
  const seenUids = new Map<number, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const itemPath = [...path, String(index)];
    const account = parseAccount(child[index], itemPath, errors);

    if (account === undefined) {
      continue;
    }

    const previousNameIndex = seenNames.get(account.name);

    if (previousNameIndex !== undefined) {
      addError(
        errors,
        [...itemPath, "name"],
        `Duplicate account name also appears at ${formatPath([
          ...path,
          String(previousNameIndex),
          "name",
        ])}.`,
      );
    } else {
      seenNames.set(account.name, index);
    }

    const previousUidIndex = seenUids.get(account.uid);

    if (previousUidIndex !== undefined) {
      addError(
        errors,
        [...itemPath, "uid"],
        `Duplicate account uid also appears at ${formatPath([
          ...path,
          String(previousUidIndex),
          "uid",
        ])}.`,
      );
    } else {
      seenUids.set(account.uid, index);
    }

    accounts.push(account);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(accounts);
}

function parseAccount(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): Account | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected account object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, ACCOUNT_FIELDS, path, errors);

  const name = readRequiredAccountName(value, "name", [...path, "name"], errors);
  const uid = readRequiredUid(value, "uid", [...path, "uid"], errors);
  const primaryGroup = readRequiredGroupName(value, "primaryGroup", [...path, "primaryGroup"], errors);
  const groups = readRequiredGroups(value, [...path, "groups"], errors);
  const shell = readRequiredShell(value, "shell", [...path, "shell"], errors);
  const enabled = readRequiredBoolean(value, "enabled", [...path, "enabled"], errors);

  if (
    errors.length > errorStart ||
    name === undefined ||
    uid === undefined ||
    primaryGroup === undefined ||
    groups === undefined ||
    shell === undefined ||
    enabled === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    name,
    uid,
    primaryGroup,
    groups,
    shell,
    enabled,
  });
}

function readRequiredAccountName(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isAccountName(child)) {
    addError(errors, path, "Expected valid POSIX account name.");
    return undefined;
  }

  return child;
}

function readRequiredGroupName(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isGroupName(child)) {
    addError(errors, path, "Expected valid POSIX group name.");
    return undefined;
  }

  if (PRIVILEGED_GROUPS.has(child)) {
    addError(errors, path, "Privileged group membership is not allowed.");
    return undefined;
  }

  return child;
}

function readRequiredGroups(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly string[] | undefined {
  const child = readRequiredProperty(value, "groups", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected groups array.");
    return undefined;
  }

  const groups: string[] = [];
  const seen = new Set<string>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const groupPath = [...path, String(index)];
    const group = child[index];

    if (typeof group !== "string" || !isGroupName(group)) {
      addError(errors, groupPath, "Expected valid POSIX group name.");
      continue;
    }

    if (PRIVILEGED_GROUPS.has(group)) {
      addError(errors, groupPath, "Privileged group membership is not allowed.");
      continue;
    }

    if (!seen.has(group)) {
      seen.add(group);
      groups.push(group);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(groups);
}

function readRequiredShell(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isAllowedShell(child)) {
    addError(errors, path, "Expected allowlisted absolute shell path.");
    return undefined;
  }

  return child;
}

function readRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
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

function readRequiredUid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (
    typeof child !== "number" ||
    !Number.isSafeInteger(child) ||
    child < MIN_MANAGED_UID ||
    child > MAX_MANAGED_UID
  ) {
    addError(errors, path, `Expected integer from ${MIN_MANAGED_UID} through ${MAX_MANAGED_UID}.`);
    return undefined;
  }

  return child;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PlainJson | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return value[key];
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

function isAccountName(value: string): boolean {
  return ACCOUNT_NAME_PATTERN.test(value) && !containsInlineKeyMaterial(value);
}

function isGroupName(value: string): boolean {
  return GROUP_NAME_PATTERN.test(value) && !containsInlineKeyMaterial(value);
}

function isAllowedShell(value: string): boolean {
  return ALLOWED_SHELLS.has(value) && !containsInlineKeyMaterial(value);
}

function containsInlineKeyMaterial(value: string): boolean {
  return DATA_URL_PATTERN.test(value) || PEM_BLOCK_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
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

function reject(
  errors: readonly ValidationError[],
): Extract<AccountsConfigValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
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

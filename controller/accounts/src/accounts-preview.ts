import { validateAccountsConfig } from "../../../sdk/typescript/src/accounts-model.ts";
import type {
  Account,
  AccountsConfig,
  ValidationError,
} from "../../../sdk/typescript/src/accounts-model.ts";

export type AccountsPreviewSide = "current" | "desired";

export interface AccountsPreviewRejection {
  readonly side: AccountsPreviewSide;
  readonly path: string;
  readonly message: string;
}

export type AccountChangedField =
  | "uid"
  | "primaryGroup"
  | "groups"
  | "shell"
  | "enabled";

export type AccountGroupChangedField = "primaryGroup" | "groups";

export interface ModifiedAccountChange {
  readonly name: string;
  readonly current: Account;
  readonly desired: Account;
  readonly fields: readonly AccountChangedField[];
}

export interface AccountGroupSnapshot {
  readonly primaryGroup: string;
  readonly groups: readonly string[];
}

export interface AccountGroupChange {
  readonly name: string;
  readonly current: AccountGroupSnapshot;
  readonly desired: AccountGroupSnapshot;
  readonly fields: readonly AccountGroupChangedField[];
}

export interface AccountsChangeDiff {
  readonly added: Readonly<Record<string, Account>>;
  readonly removed: Readonly<Record<string, Account>>;
  readonly modified: Readonly<Record<string, ModifiedAccountChange>>;
}

export type AccountsGroupChanges = Readonly<Record<string, AccountGroupChange>>;

export type AccountsChangePreview =
  | {
      readonly valid: true;
      readonly diff: AccountsChangeDiff;
      readonly newlyEnabledCount: number;
      readonly groupChanges: AccountsGroupChanges;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: undefined;
      readonly newlyEnabledCount: 0;
      readonly groupChanges: AccountsGroupChanges;
      readonly rejections: readonly AccountsPreviewRejection[];
    };

type SideValidation =
  | {
      readonly ok: true;
      readonly config: AccountsConfig;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly AccountsPreviewRejection[];
    };

const NO_REJECTIONS: readonly [] = Object.freeze([]);
const VALIDATION_FAILED = "Accounts config validation failed.";

export function previewAccountsChange(current: unknown, desired: unknown): AccountsChangePreview {
  const currentValidation = validateSide("current", current);
  const desiredValidation = validateSide("desired", desired);

  if (!currentValidation.ok || !desiredValidation.ok) {
    return Object.freeze({
      diff: undefined,
      groupChanges: emptyNameRecord<AccountGroupChange>(),
      newlyEnabledCount: 0,
      rejections: collectRejections(currentValidation, desiredValidation),
      valid: false,
    });
  }

  const preview = diffAccountsConfigs(currentValidation.config, desiredValidation.config);

  return Object.freeze({
    diff: preview.diff,
    groupChanges: preview.groupChanges,
    newlyEnabledCount: preview.newlyEnabledCount,
    rejections: NO_REJECTIONS,
    valid: true,
  });
}

function validateSide(side: AccountsPreviewSide, input: unknown): SideValidation {
  try {
    const result = validateAccountsConfig(input);

    if (result.ok) {
      return {
        config: result.config,
        ok: true,
      };
    }

    return {
      ok: false,
      rejections: validationErrorsToRejections(side, result.errors),
    };
  } catch {
    return {
      ok: false,
      rejections: Object.freeze([
        {
          message: VALIDATION_FAILED,
          path: "",
          side,
        },
      ]),
    };
  }
}

function validationErrorsToRejections(
  side: AccountsPreviewSide,
  errors: readonly ValidationError[],
): readonly AccountsPreviewRejection[] {
  const rejections: AccountsPreviewRejection[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      rejections[rejections.length] = {
        message: VALIDATION_FAILED,
        path: "",
        side,
      };
    } else {
      rejections[rejections.length] = {
        message: error.message,
        path: error.path,
        side,
      };
    }
  }

  if (rejections.length === 0) {
    rejections[0] = {
      message: VALIDATION_FAILED,
      path: "",
      side,
    };
  }

  return Object.freeze(rejections);
}

function collectRejections(
  currentValidation: SideValidation,
  desiredValidation: SideValidation,
): readonly AccountsPreviewRejection[] {
  const rejections: AccountsPreviewRejection[] = [];

  if (!currentValidation.ok) {
    appendRejections(rejections, currentValidation.rejections);
  }
  if (!desiredValidation.ok) {
    appendRejections(rejections, desiredValidation.rejections);
  }

  return Object.freeze(rejections);
}

function appendRejections(
  target: AccountsPreviewRejection[],
  source: readonly AccountsPreviewRejection[],
): void {
  for (let index = 0; index < source.length; index += 1) {
    const rejection = source[index];

    if (rejection !== undefined) {
      target[target.length] = rejection;
    }
  }
}

function diffAccountsConfigs(
  current: AccountsConfig,
  desired: AccountsConfig,
): {
  readonly diff: AccountsChangeDiff;
  readonly newlyEnabledCount: number;
  readonly groupChanges: AccountsGroupChanges;
} {
  const currentByName = indexAccounts(current.accounts);
  const desiredByName = indexAccounts(desired.accounts);
  const added = createNameRecord<Account>();
  const removed = createNameRecord<Account>();
  const modified = createNameRecord<ModifiedAccountChange>();
  const groupChanges = createNameRecord<AccountGroupChange>();
  let newlyEnabledCount = 0;
  const names = sortedUniqueNames(currentByName, desiredByName);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];

    if (name === undefined) {
      continue;
    }

    const currentAccount = currentByName.get(name);
    const desiredAccount = desiredByName.get(name);

    if (currentAccount === undefined && desiredAccount !== undefined) {
      defineNameRecordValue(added, name, desiredAccount);

      if (desiredAccount.enabled) {
        newlyEnabledCount += 1;
      }
      continue;
    }

    if (currentAccount !== undefined && desiredAccount === undefined) {
      defineNameRecordValue(removed, name, currentAccount);
      continue;
    }

    if (currentAccount !== undefined && desiredAccount !== undefined) {
      if (!currentAccount.enabled && desiredAccount.enabled) {
        newlyEnabledCount += 1;
      }

      const changedFields = changedAccountFields(currentAccount, desiredAccount);

      if (changedFields.length > 0) {
        defineNameRecordValue(
          modified,
          name,
          Object.freeze({
            current: currentAccount,
            desired: desiredAccount,
            fields: Object.freeze(changedFields),
            name,
          }),
        );
      }

      const changedGroupFields = changedAccountGroupFields(currentAccount, desiredAccount);

      if (changedGroupFields.length > 0) {
        defineNameRecordValue(
          groupChanges,
          name,
          Object.freeze({
            current: groupSnapshot(currentAccount),
            desired: groupSnapshot(desiredAccount),
            fields: Object.freeze(changedGroupFields),
            name,
          }),
        );
      }
    }
  }

  return Object.freeze({
    diff: Object.freeze({
      added: Object.freeze(added),
      modified: Object.freeze(modified),
      removed: Object.freeze(removed),
    }),
    groupChanges: Object.freeze(groupChanges),
    newlyEnabledCount,
  });
}

function indexAccounts(accounts: readonly Account[]): ReadonlyMap<string, Account> {
  const byName = new Map<string, Account>();

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];

    if (account !== undefined) {
      byName.set(account.name, account);
    }
  }

  return byName;
}

function sortedUniqueNames(
  current: ReadonlyMap<string, Account>,
  desired: ReadonlyMap<string, Account>,
): readonly string[] {
  const names = new Set<string>();

  for (const name of current.keys()) {
    names.add(name);
  }

  for (const name of desired.keys()) {
    names.add(name);
  }

  return Object.freeze([...names].sort(compareStrings));
}

function changedAccountFields(
  current: Account,
  desired: Account,
): AccountChangedField[] {
  const fields: AccountChangedField[] = [];

  if (current.uid !== desired.uid) {
    fields[fields.length] = "uid";
  }
  if (current.primaryGroup !== desired.primaryGroup) {
    fields[fields.length] = "primaryGroup";
  }
  if (!stringArraysEqual(current.groups, desired.groups)) {
    fields[fields.length] = "groups";
  }
  if (current.shell !== desired.shell) {
    fields[fields.length] = "shell";
  }
  if (current.enabled !== desired.enabled) {
    fields[fields.length] = "enabled";
  }

  return fields;
}

function changedAccountGroupFields(
  current: Account,
  desired: Account,
): AccountGroupChangedField[] {
  const fields: AccountGroupChangedField[] = [];

  if (current.primaryGroup !== desired.primaryGroup) {
    fields[fields.length] = "primaryGroup";
  }
  if (!stringArraysEqual(current.groups, desired.groups)) {
    fields[fields.length] = "groups";
  }

  return fields;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function groupSnapshot(account: Account): AccountGroupSnapshot {
  return Object.freeze({
    groups: account.groups,
    primaryGroup: account.primaryGroup,
  });
}

function createNameRecord<T>(): Record<string, T> {
  return {};
}

function emptyNameRecord<T>(): Readonly<Record<string, T>> {
  return Object.freeze(createNameRecord<T>());
}

function defineNameRecordValue<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
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

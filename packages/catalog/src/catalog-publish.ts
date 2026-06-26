import { canonicalizeCatalogBytes } from "./catalog-canonical.ts";
import { validateCatalogEntry } from "./catalog-entry.ts";
import type { CatalogEntryValidationError } from "./catalog-entry.ts";
import type {
  CatalogApp,
  CatalogAppVersion,
  CatalogPayload,
  CatalogSignature,
  SignedCatalogManifest,
} from "./catalog-manifest.ts";

export interface CatalogSigner {
  readonly keyId: string;
  sign(bytes: Uint8Array): Uint8Array;
}

export interface PublishCatalogParams {
  readonly entries: readonly unknown[];
  readonly apps: readonly CatalogApp[];
  readonly schemaVersion: string;
  readonly catalogVersion: string;
  readonly generatedAt: string;
  readonly signer: CatalogSigner;
}

export type CatalogPublishParams = PublishCatalogParams;

export interface CatalogPublishError extends CatalogEntryValidationError {}

export type CatalogPublishResult =
  | (SignedCatalogManifest & { readonly ok?: true })
  | {
      readonly ok: false;
      readonly errors: readonly CatalogPublishError[];
    };

export function publishCatalog(params: PublishCatalogParams): CatalogPublishResult {
  try {
    return publishCatalogChecked(params);
  } catch {
    return reject([
      {
        message: "Catalog publish failed closed.",
        path: "",
      },
    ]);
  }
}

function publishCatalogChecked(params: PublishCatalogParams): CatalogPublishResult {
  const entryErrors = validateCatalogEntries(params.entries);

  if (entryErrors.length > 0) {
    return reject(entryErrors);
  }

  const payloadResult = assembleCatalogPayload(params);

  if (!payloadResult.ok) {
    return reject(payloadResult.errors);
  }

  try {
    return {
      catalog: payloadResult.catalog,
      signature: signCatalogPayload(payloadResult.catalog, params.signer),
    };
  } catch {
    return reject([
      {
        message: "Catalog signing failed.",
        path: "signature",
      },
    ]);
  }
}

type CatalogPayloadResult =
  | {
      readonly ok: true;
      readonly catalog: CatalogPayload;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CatalogPublishError[];
    };

function validateCatalogEntries(entries: readonly unknown[]): CatalogPublishError[] {
  const errors: CatalogPublishError[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const result = validateCatalogEntry(entry);

    if (result.ok) {
      continue;
    }

    for (let errorIndex = 0; errorIndex < result.errors.length; errorIndex += 1) {
      const error = result.errors[errorIndex];

      if (error !== undefined) {
        errors[errors.length] = {
          message: error.message,
          path: prefixEntryPath(index, error.path),
        };
      }
    }
  }

  return errors;
}

function assembleCatalogPayload(params: PublishCatalogParams): CatalogPayloadResult {
  const errors: CatalogPublishError[] = [];
  const apps = sortedCatalogApps(params.apps, errors);

  if (errors.length > 0) {
    return {
      errors,
      ok: false,
    };
  }

  return {
    catalog: {
      apps,
      catalogVersion: params.catalogVersion,
      generatedAt: params.generatedAt,
      schemaVersion: params.schemaVersion,
    },
    ok: true,
  };
}

function sortedCatalogApps(
  apps: readonly CatalogApp[],
  errors: CatalogPublishError[],
): readonly CatalogApp[] {
  const copied: CatalogApp[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app === undefined) {
      errors[errors.length] = {
        message: "Expected app object.",
        path: `apps/${index}`,
      };
      continue;
    }

    if (typeof app.id !== "string" || app.id === "") {
      errors[errors.length] = {
        message: "Expected non-empty app id string.",
        path: `apps/${index}/id`,
      };
      continue;
    }

    if (!Array.isArray(app.versions)) {
      errors[errors.length] = {
        message: "Expected versions array.",
        path: `apps/${index}/versions`,
      };
      continue;
    }

    copied[copied.length] = {
      id: app.id,
      versions: copyVersions(app.versions, index, errors),
    };
  }

  copied.sort(compareApps);
  return copied;
}

function copyVersions(
  versions: readonly CatalogAppVersion[],
  appIndex: number,
  errors: CatalogPublishError[],
): readonly CatalogAppVersion[] {
  const copied: CatalogAppVersion[] = [];

  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    const path = `apps/${appIndex}/versions/${index}`;

    if (version === undefined) {
      errors[errors.length] = {
        message: "Expected app version object.",
        path,
      };
      continue;
    }

    const grantsSummary = sortedUniqueStrings(version.grantsSummary, `${path}/grantsSummary`, errors);

    copied[copied.length] = {
      grantsSummary,
      integrity: version.integrity,
      packageRef: version.packageRef,
      riskSummary: version.riskSummary,
      version: version.version,
    };
  }

  return copied;
}

function sortedUniqueStrings(
  values: readonly string[],
  path: string,
  errors: CatalogPublishError[],
): readonly string[] {
  if (!Array.isArray(values)) {
    errors[errors.length] = {
      message: "Expected grants summary array.",
      path,
    };

    return [];
  }

  const sorted: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (typeof value !== "string" || value === "") {
      errors[errors.length] = {
        message: "Expected non-empty grant id string.",
        path: `${path}/${index}`,
      };
      continue;
    }

    sorted[sorted.length] = value;
  }

  sorted.sort(compareStrings);

  const unique: string[] = [];
  let previous: string | undefined;

  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index];

    if (value !== undefined && value !== previous) {
      unique[unique.length] = value;
      previous = value;
    }
  }

  return unique;
}

function signCatalogPayload(catalog: CatalogPayload, signer: CatalogSigner): CatalogSignature {
  const signature = signer.sign(canonicalizeCatalogBytes(catalog));

  return {
    algorithm: "ed25519",
    keyId: signer.keyId,
    value: Buffer.from(signature).toString("base64"),
  };
}

function prefixEntryPath(index: number, path: string): string {
  const prefix = `entries/${index}`;

  return path === "" ? prefix : `${prefix}/${path}`;
}

function reject(errors: readonly CatalogPublishError[]): Extract<CatalogPublishResult, { readonly ok: false }> {
  return {
    errors,
    ok: false,
  };
}

function compareApps(left: CatalogApp, right: CatalogApp): number {
  return compareStrings(left.id, right.id);
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

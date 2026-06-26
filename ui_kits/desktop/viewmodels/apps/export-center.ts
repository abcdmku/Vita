import type {
  AppError,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  EXPORT_BUNDLE_FORMAT_VERSION,
} from "../../../../sdk/typescript/src/export-bundle.ts";
import type {
  ExportBundleBlob,
  ExportBundleEntry,
  ExportBundleRejectReason,
  ExportEntryKind,
  ExportManifest,
} from "../../../../sdk/typescript/src/export-bundle.ts";

export const EXPORT_CENTER_APP_ID = "vita.app.export-center";
export const EXPORT_CENTER_DOMAIN_ORDER = Object.freeze(["file", "config", "pds"] as const);

export type ExportCenterStatus =
  | "idle"
  | "enumerating"
  | "ready"
  | "forbidden"
  | "exporting"
  | "done"
  | "failed";
export type ExportCenterAction = "listDomains" | "select" | "previewManifest" | "export" | "reset";
export type ExportCenterBundleHandle = string;

export interface ExportCenterDomain {
  readonly kind: ExportEntryKind;
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
}

export interface ExportCenterState {
  readonly status: ExportCenterStatus;
  readonly domains: readonly ExportCenterDomain[];
  readonly selectedKinds: readonly ExportEntryKind[];
  readonly manifest: ExportManifest | null;
  readonly bundleHandle: ExportCenterBundleHandle | null;
  readonly error?: AppError;
}

export type ExportCenterActionResult =
  | {
      readonly ok: true;
      readonly action: ExportCenterAction;
      readonly state: ExportCenterState;
    }
  | {
      readonly ok: false;
      readonly action: ExportCenterAction;
      readonly error: AppError;
      readonly state: ExportCenterState;
    };

export interface ExportCenterListDomainsRequest {
  readonly appId: typeof EXPORT_CENTER_APP_ID;
  readonly kinds: readonly ExportEntryKind[];
}

export interface ExportCenterPreviewManifestRequest {
  readonly appId: typeof EXPORT_CENTER_APP_ID;
  readonly domains: readonly ExportEntryKind[];
}

export interface ExportCenterExportRequest {
  readonly appId: typeof EXPORT_CENTER_APP_ID;
  readonly domains: readonly ExportEntryKind[];
  readonly grant: string;
  readonly manifest?: ExportManifest;
}

export type ExportCenterPortResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    };

export interface ExportCenterListedDomains {
  readonly domains: readonly ExportEntryKind[];
}

export interface ExportCenterManifestPreview {
  readonly manifest: ExportManifest;
}

export type ExportCenterDomainExportStatus =
  | {
      readonly ok: true;
      readonly kind: ExportEntryKind;
    }
  | {
      readonly ok: false;
      readonly kind: ExportEntryKind;
      readonly error?: AppError;
      readonly reason?: ExportBundleRejectReason;
    };

export interface ExportCenterBundle {
  readonly bundleHandle: ExportCenterBundleHandle;
  readonly manifest: ExportManifest;
  readonly blobs: readonly ExportBundleBlob[];
  readonly domains?: readonly ExportCenterDomainExportStatus[];
}

export interface ExportCenterPort {
  readonly listDomains?: (
    request: ExportCenterListDomainsRequest,
  ) => ExportCenterMaybePromise<ExportCenterPortResult<ExportCenterListedDomains>>;
  readonly previewManifest: (
    request: ExportCenterPreviewManifestRequest,
  ) => ExportCenterMaybePromise<ExportCenterPortResult<ExportCenterManifestPreview>>;
  readonly exportBundle: (
    request: ExportCenterExportRequest,
  ) => ExportCenterMaybePromise<ExportCenterPortResult<ExportCenterBundle>>;
}

export interface ExportCenterViewModelInput {
  readonly exportPort?: ExportCenterPort;
  readonly grant?: string;
}

export interface ExportCenterViewModel {
  readonly state: ExportCenterState;
  snapshot(): ExportCenterState;
  listDomains(): Promise<ExportCenterActionResult>;
  select(domain: unknown, selected?: unknown): ExportCenterActionResult;
  previewManifest(): Promise<ExportCenterActionResult>;
  export(): Promise<ExportCenterActionResult>;
  reset(): ExportCenterActionResult;
}

type ExportCenterMaybePromise<T> = T | Promise<T>;

const DOMAIN_LABELS = Object.freeze({
  config: Object.freeze({
    description: "Device state and local configuration.",
    label: "Device state",
  }),
  file: Object.freeze({
    description: "User-owned files.",
    label: "Files",
  }),
  pds: Object.freeze({
    description: "PDS sync state.",
    label: "PDS sync state",
  }),
}) satisfies Record<ExportEntryKind, { readonly description: string; readonly label: string }>;

const EMPTY_SELECTED_KINDS = Object.freeze([]) satisfies readonly ExportEntryKind[];

export function createExportCenterViewModel(
  input: ExportCenterViewModelInput = Object.freeze({}),
): ExportCenterViewModel {
  return new ExportCenterModel(input);
}

class ExportCenterModel implements ExportCenterViewModel {
  readonly #exportPort: ExportCenterPort | undefined;
  readonly #grant: string | undefined;
  #state: ExportCenterState;

  constructor(input: ExportCenterViewModelInput) {
    this.#exportPort = input.exportPort;
    this.#grant = input.grant;
    this.#state = freezeState({
      bundleHandle: null,
      domains: freezeDomains(EXPORT_CENTER_DOMAIN_ORDER, new Set(EXPORT_CENTER_DOMAIN_ORDER)),
      manifest: null,
      status: "idle",
    });
  }

  get state(): ExportCenterState {
    return this.#state;
  }

  snapshot(): ExportCenterState {
    return this.#state;
  }

  async listDomains(): Promise<ExportCenterActionResult> {
    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      manifest: null,
      status: "enumerating",
    });

    const listDomains = this.#exportPort?.listDomains;
    let listedKinds: readonly ExportEntryKind[] = EXPORT_CENTER_DOMAIN_ORDER;

    if (listDomains !== undefined) {
      let rawResult: ExportCenterPortResult<ExportCenterListedDomains>;

      try {
        rawResult = await listDomains(Object.freeze({
          appId: EXPORT_CENTER_APP_ID,
          kinds: EXPORT_CENTER_DOMAIN_ORDER,
        }));
      } catch {
        return this.#fail("listDomains", failedError(
          "ExportListFailed",
          "Export Center domain listing failed closed.",
          "/export/listDomains",
        ));
      }

      const result = normalizePortResult(rawResult, normalizeListedDomains, "/export/listDomains");

      if (!result.ok) return this.#fail("listDomains", result.error);

      listedKinds = result.value.domains;
    }

    if (!hasAllDomains(listedKinds)) {
      return this.#fail("listDomains", failedError(
        "ExportDomainsIncomplete",
        "Export Center requires every first-party data domain to be enumerable.",
        "/domains",
      ));
    }

    this.#state = freezeState({
      bundleHandle: null,
      domains: freezeDomains(EXPORT_CENTER_DOMAIN_ORDER, selectedSet(this.#state.domains)),
      manifest: null,
      status: "ready",
    });

    return acceptAction("listDomains", this.#state);
  }

  select(domain: unknown, selected: unknown = true): ExportCenterActionResult {
    const kind = normalizeDomainKind(domain);

    if (kind === undefined) {
      return rejectAction("select", failedError(
        "ExportDomainUnsupported",
        "Export Center domain is not supported.",
        "/select/domain",
      ), this.#state);
    }
    if (typeof selected !== "boolean") {
      return rejectAction("select", failedError(
        "ExportSelectionInvalid",
        "Export Center selection must be a boolean.",
        "/select/selected",
      ), this.#state);
    }

    const selectedKinds = selectedSet(this.#state.domains);
    if (selected) {
      selectedKinds.add(kind);
    } else {
      selectedKinds.delete(kind);
    }

    this.#state = freezeState({
      bundleHandle: null,
      domains: freezeDomains(EXPORT_CENTER_DOMAIN_ORDER, selectedKinds),
      manifest: null,
      status: this.#state.status,
    });

    return acceptAction("select", this.#state);
  }

  async previewManifest(): Promise<ExportCenterActionResult> {
    const selectedKinds = this.#state.selectedKinds;

    if (selectedKinds.length === 0) {
      return this.#fail("previewManifest", failedError(
        "ExportSelectionEmpty",
        "Export Center requires at least one selected domain.",
        "/previewManifest/domains",
      ));
    }

    const exportPort = this.#exportPort;
    if (exportPort === undefined) {
      return this.#fail("previewManifest", failedError(
        "ExportPortUnavailable",
        "Export Center requires an injected export port.",
        "/exportPort",
      ));
    }

    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      manifest: null,
      status: "enumerating",
    });

    let rawResult: ExportCenterPortResult<ExportCenterManifestPreview>;
    try {
      rawResult = await exportPort.previewManifest(Object.freeze({
        appId: EXPORT_CENTER_APP_ID,
        domains: selectedKinds,
      }));
    } catch {
      return this.#fail("previewManifest", failedError(
        "ExportPreviewFailed",
        "Export Center manifest preview failed closed.",
        "/export/previewManifest",
      ));
    }

    const result = normalizePortResult(rawResult, normalizeManifestPreview, "/export/previewManifest");

    if (!result.ok) return this.#fail("previewManifest", result.error);
    if (!manifestMatchesSelection(result.value.manifest, selectedKinds)) {
      return this.#fail("previewManifest", failedError(
        "ExportManifestIncomplete",
        "Export Center manifest preview does not match the selected domains.",
        "/manifest/entries",
      ));
    }

    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      manifest: result.value.manifest,
      status: "ready",
    });

    return acceptAction("previewManifest", this.#state);
  }

  async export(): Promise<ExportCenterActionResult> {
    const grant = this.#grant;

    if (grant === undefined || grant.length === 0) {
      return this.#forbidden("export", error(
        "MissingExportGrant",
        "Export Center requires an injected export grant.",
        "/grant",
      ));
    }

    const selectedKinds = this.#state.selectedKinds;
    if (selectedKinds.length === 0) {
      return this.#fail("export", failedError(
        "ExportSelectionEmpty",
        "Export Center requires at least one selected domain.",
        "/export/domains",
      ));
    }

    const exportPort = this.#exportPort;
    if (exportPort === undefined) {
      return this.#fail("export", failedError(
        "ExportPortUnavailable",
        "Export Center requires an injected export port.",
        "/exportPort",
      ));
    }

    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      manifest: this.#state.manifest,
      status: "exporting",
    });

    const requestInput: {
      appId: typeof EXPORT_CENTER_APP_ID;
      domains: readonly ExportEntryKind[];
      grant: string;
      manifest?: ExportManifest;
    } = {
      appId: EXPORT_CENTER_APP_ID,
      domains: selectedKinds,
      grant,
    };

    if (this.#state.manifest !== null) requestInput.manifest = this.#state.manifest;

    let rawResult: ExportCenterPortResult<ExportCenterBundle>;
    try {
      rawResult = await exportPort.exportBundle(Object.freeze(requestInput));
    } catch {
      return this.#fail("export", failedError(
        "ExportRunFailed",
        "Export Center run failed closed.",
        "/export",
      ));
    }

    const result = normalizePortResult(rawResult, normalizeBundle, "/export");

    if (!result.ok) return this.#fail("export", result.error);

    const bundle = result.value;
    const bundleFailure = validateCompleteBundle(bundle, selectedKinds);

    if (bundleFailure !== undefined) return this.#fail("export", bundleFailure);

    this.#state = freezeState({
      bundleHandle: bundle.bundleHandle,
      domains: this.#state.domains,
      manifest: bundle.manifest,
      status: "done",
    });

    return acceptAction("export", this.#state);
  }

  reset(): ExportCenterActionResult {
    this.#state = freezeState({
      bundleHandle: null,
      domains: freezeDomains(EXPORT_CENTER_DOMAIN_ORDER, new Set(EXPORT_CENTER_DOMAIN_ORDER)),
      manifest: null,
      status: "idle",
    });

    return acceptAction("reset", this.#state);
  }

  #fail(action: ExportCenterAction, errorValue: AppError): ExportCenterActionResult {
    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      error: errorValue,
      manifest: null,
      status: "failed",
    });

    return rejectAction(action, errorValue, this.#state);
  }

  #forbidden(action: ExportCenterAction, errorValue: AppError): ExportCenterActionResult {
    this.#state = freezeState({
      bundleHandle: null,
      domains: this.#state.domains,
      error: errorValue,
      manifest: null,
      status: "forbidden",
    });

    return rejectAction(action, errorValue, this.#state);
  }
}

function freezeState(input: {
  readonly status: ExportCenterStatus;
  readonly domains: readonly ExportCenterDomain[];
  readonly manifest: ExportManifest | null;
  readonly bundleHandle: ExportCenterBundleHandle | null;
  readonly error?: AppError;
}): ExportCenterState {
  const output: {
    status: ExportCenterStatus;
    domains: readonly ExportCenterDomain[];
    selectedKinds: readonly ExportEntryKind[];
    manifest: ExportManifest | null;
    bundleHandle: ExportCenterBundleHandle | null;
    error?: AppError;
  } = {
    bundleHandle: input.bundleHandle,
    domains: freezeDomainEntries(input.domains),
    manifest: input.manifest === null ? null : freezeManifest(input.manifest),
    selectedKinds: selectedKinds(input.domains),
    status: input.status,
  };

  if (input.error !== undefined) output.error = freezeError(input.error);

  return Object.freeze(output);
}

function freezeDomains(
  kinds: readonly ExportEntryKind[],
  selected: ReadonlySet<ExportEntryKind>,
): readonly ExportCenterDomain[] {
  const domains: ExportCenterDomain[] = [];

  for (let index = 0; index < EXPORT_CENTER_DOMAIN_ORDER.length; index += 1) {
    const kind = EXPORT_CENTER_DOMAIN_ORDER[index];
    if (kind === undefined || !containsKind(kinds, kind)) continue;
    const labels = DOMAIN_LABELS[kind];

    domains.push(Object.freeze({
      description: labels.description,
      kind,
      label: labels.label,
      selected: selected.has(kind),
    }));
  }

  return Object.freeze(domains);
}

function freezeDomainEntries(domains: readonly ExportCenterDomain[]): readonly ExportCenterDomain[] {
  const output: ExportCenterDomain[] = [];

  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    if (domain === undefined) continue;
    const kind = normalizeDomainKind(domain.kind);
    if (kind === undefined) continue;
    const labels = DOMAIN_LABELS[kind];

    output.push(Object.freeze({
      description: labels.description,
      kind,
      label: labels.label,
      selected: domain.selected === true,
    }));
  }

  output.sort(compareDomains);

  return Object.freeze(output);
}

function selectedSet(domains: readonly ExportCenterDomain[]): Set<ExportEntryKind> {
  const output = new Set<ExportEntryKind>();

  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    if (domain !== undefined && domain.selected) output.add(domain.kind);
  }

  return output;
}

function selectedKinds(domains: readonly ExportCenterDomain[]): readonly ExportEntryKind[] {
  const selected = selectedSet(domains);
  const output: ExportEntryKind[] = [];

  for (let index = 0; index < EXPORT_CENTER_DOMAIN_ORDER.length; index += 1) {
    const kind = EXPORT_CENTER_DOMAIN_ORDER[index];
    if (kind !== undefined && selected.has(kind)) output.push(kind);
  }

  if (output.length === 0) return EMPTY_SELECTED_KINDS;

  return Object.freeze(output);
}

function normalizePortResult<T>(
  input: ExportCenterPortResult<T>,
  normalizeValue: (value: T) => ExportCenterNormalizeResult<T>,
  path: string,
): ExportCenterNormalizeResult<T> {
  try {
    if (input.ok) return normalizeValue(input.value);

    if ("error" in input) return rejectNormalize(freezeError(input.error));

    return rejectNormalize(failedError(
      "ExportBundleRejected",
      `Export bundle rejected: ${input.reason}.`,
      `${path}/reason`,
    ));
  } catch {
    return rejectNormalize(failedError(
      "ExportPortMalformed",
      "Export Center port returned malformed data.",
      path,
    ));
  }
}

type ExportCenterNormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
    };

function normalizeListedDomains(
  value: ExportCenterListedDomains,
): ExportCenterNormalizeResult<ExportCenterListedDomains> {
  const output: ExportEntryKind[] = [];

  for (let index = 0; index < value.domains.length; index += 1) {
    const kind = normalizeDomainKind(value.domains[index]);
    if (kind === undefined || containsKind(output, kind)) {
      return rejectNormalize(failedError(
        "ExportDomainsMalformed",
        "Export Center domain listing is malformed.",
        "/export/listDomains/domains",
      ));
    }
    output.push(kind);
  }

  return acceptNormalize(Object.freeze({
    domains: Object.freeze(output),
  }));
}

function normalizeManifestPreview(
  value: ExportCenterManifestPreview,
): ExportCenterNormalizeResult<ExportCenterManifestPreview> {
  const manifest = normalizeManifest(value.manifest);

  if (!manifest.ok) return manifest;

  return acceptNormalize(Object.freeze({
    manifest: manifest.value,
  }));
}

function normalizeBundle(value: ExportCenterBundle): ExportCenterNormalizeResult<ExportCenterBundle> {
  if (typeof value.bundleHandle !== "string" || value.bundleHandle.length === 0) {
    return rejectNormalize(failedError(
      "ExportBundleMalformed",
      "Export Center bundle handle is malformed.",
      "/export/bundleHandle",
    ));
  }

  const manifest = normalizeManifest(value.manifest);
  if (!manifest.ok) return manifest;

  const blobs = normalizeBlobs(value.blobs);
  if (!blobs.ok) return blobs;

  const output: {
    bundleHandle: ExportCenterBundleHandle;
    manifest: ExportManifest;
    blobs: readonly ExportBundleBlob[];
    domains?: readonly ExportCenterDomainExportStatus[];
  } = {
    blobs: blobs.value,
    bundleHandle: value.bundleHandle,
    manifest: manifest.value,
  };

  if (value.domains !== undefined) {
    const domains = normalizeDomainExportStatuses(value.domains);
    if (!domains.ok) return domains;
    output.domains = domains.value;
  }

  return acceptNormalize(Object.freeze(output));
}

function normalizeManifest(manifest: ExportManifest): ExportCenterNormalizeResult<ExportManifest> {
  if (manifest.formatVersion !== EXPORT_BUNDLE_FORMAT_VERSION) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest formatVersion is not supported.",
      "/manifest/formatVersion",
    ));
  }
  if (!Array.isArray(manifest.entries)) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest entries are malformed.",
      "/manifest/entries",
    ));
  }
  if (typeof manifest.rootDigest !== "string" || !isSha256Integrity(manifest.rootDigest)) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest rootDigest is malformed.",
      "/manifest/rootDigest",
    ));
  }

  const entries: ExportBundleEntry[] = [];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = normalizeManifestEntry(manifest.entries[index], `/manifest/entries/${index}`);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }

  const output: {
    entries: readonly ExportBundleEntry[];
    formatVersion: typeof EXPORT_BUNDLE_FORMAT_VERSION;
    rootDigest: `sha256-${string}`;
    createdMarker?: string;
  } = {
    entries: Object.freeze(entries),
    formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
    rootDigest: manifest.rootDigest,
  };

  if (manifest.createdMarker !== undefined) {
    if (typeof manifest.createdMarker !== "string" || manifest.createdMarker.length === 0) {
      return rejectNormalize(failedError(
        "ExportManifestInvalid",
        "Export Center manifest createdMarker is malformed.",
        "/manifest/createdMarker",
      ));
    }
    output.createdMarker = manifest.createdMarker;
  }

  return acceptNormalize(Object.freeze(output));
}

function normalizeManifestEntry(
  entry: ExportBundleEntry | undefined,
  path: string,
): ExportCenterNormalizeResult<ExportBundleEntry> {
  if (entry === undefined || typeof entry.path !== "string" || entry.path.length === 0) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest entry path is malformed.",
      `${path}/path`,
    ));
  }
  const kind = normalizeDomainKind(entry.kind);
  if (kind === undefined) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest entry kind is unsupported.",
      `${path}/kind`,
    ));
  }
  if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest entry byte count is malformed.",
      `${path}/bytes`,
    ));
  }
  if (typeof entry.integrity !== "string" || !isSha256Integrity(entry.integrity)) {
    return rejectNormalize(failedError(
      "ExportManifestInvalid",
      "Export Center manifest entry integrity is malformed.",
      `${path}/integrity`,
    ));
  }

  return acceptNormalize(Object.freeze({
    bytes: entry.bytes,
    integrity: entry.integrity,
    kind,
    path: entry.path,
  }));
}

function normalizeBlobs(input: readonly ExportBundleBlob[]): ExportCenterNormalizeResult<readonly ExportBundleBlob[]> {
  if (!Array.isArray(input)) {
    return rejectNormalize(failedError(
      "ExportBundleMalformed",
      "Export Center bundle blobs are malformed.",
      "/export/blobs",
    ));
  }

  const blobs: ExportBundleBlob[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const blob = input[index];
    if (blob === undefined || typeof blob.path !== "string" || blob.path.length === 0) {
      return rejectNormalize(failedError(
        "ExportBundleMalformed",
        "Export Center bundle blob path is malformed.",
        `/export/blobs/${index}/path`,
      ));
    }
    const kind = normalizeDomainKind(blob.kind);
    if (kind === undefined || !(blob.data instanceof Uint8Array)) {
      return rejectNormalize(failedError(
        "ExportBundleMalformed",
        "Export Center bundle blob is malformed.",
        `/export/blobs/${index}`,
      ));
    }
    blobs.push(Object.freeze({
      data: cloneBytes(blob.data),
      kind,
      path: blob.path,
    }));
  }

  return acceptNormalize(Object.freeze(blobs));
}

function normalizeDomainExportStatuses(
  input: readonly ExportCenterDomainExportStatus[],
): ExportCenterNormalizeResult<readonly ExportCenterDomainExportStatus[]> {
  if (!Array.isArray(input)) {
    return rejectNormalize(failedError(
      "ExportBundleMalformed",
      "Export Center domain export statuses are malformed.",
      "/export/domains",
    ));
  }

  const output: ExportCenterDomainExportStatus[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const kind = normalizeDomainKind(item?.kind);
    if (item === undefined || kind === undefined || typeof item.ok !== "boolean") {
      return rejectNormalize(failedError(
        "ExportBundleMalformed",
        "Export Center domain export status is malformed.",
        `/export/domains/${index}`,
      ));
    }
    if (item.ok) {
      output.push(Object.freeze({
        kind,
        ok: true,
      }));
      continue;
    }

    const rejected: {
      kind: ExportEntryKind;
      ok: false;
      error?: AppError;
      reason?: ExportBundleRejectReason;
    } = {
      kind,
      ok: false,
    };

    if (item.error !== undefined) rejected.error = freezeError(item.error);
    if (item.reason !== undefined) rejected.reason = item.reason;
    output.push(Object.freeze(rejected));
  }

  return acceptNormalize(Object.freeze(output));
}

function validateCompleteBundle(
  bundle: ExportCenterBundle,
  selected: readonly ExportEntryKind[],
): AppError | undefined {
  if (!manifestMatchesSelection(bundle.manifest, selected)) {
    return failedError(
      "ExportManifestIncomplete",
      "Export Center completed manifest does not match the selected domains.",
      "/export/manifest/entries",
    );
  }

  if (bundle.domains !== undefined) {
    for (let index = 0; index < bundle.domains.length; index += 1) {
      const domain = bundle.domains[index];
      if (domain !== undefined && !domain.ok) {
        return domain.error ?? failedError(
          "ExportDomainFailed",
          domain.reason === undefined
            ? "Export Center domain export failed closed."
            : `Export Center domain export rejected: ${domain.reason}.`,
          `/export/domains/${index}`,
        );
      }
    }
  }

  for (let index = 0; index < bundle.manifest.entries.length; index += 1) {
    const entry = bundle.manifest.entries[index];
    if (entry !== undefined && !hasBlobForEntry(bundle.blobs, entry)) {
      return failedError(
        "ExportBundleIncomplete",
        "Export Center bundle is missing a manifest entry blob.",
        `/export/blobs/${entry.path}`,
      );
    }
  }

  for (let index = 0; index < selected.length; index += 1) {
    const kind = selected[index];
    if (kind !== undefined && !hasBlobKind(bundle.blobs, kind)) {
      return failedError(
        "ExportBundleIncomplete",
        "Export Center bundle is missing a selected domain blob.",
        `/export/blobs/${kind}`,
      );
    }
  }

  return undefined;
}

function manifestMatchesSelection(manifest: ExportManifest, selected: readonly ExportEntryKind[]): boolean {
  const selectedSetValue = new Set<ExportEntryKind>();
  const manifestKinds = new Set<ExportEntryKind>();

  for (let index = 0; index < selected.length; index += 1) {
    const kind = selected[index];
    if (kind !== undefined) selectedSetValue.add(kind);
  }
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    if (entry === undefined || !selectedSetValue.has(entry.kind)) return false;
    manifestKinds.add(entry.kind);
  }
  for (let index = 0; index < selected.length; index += 1) {
    const kind = selected[index];
    if (kind !== undefined && !manifestKinds.has(kind)) return false;
  }

  return true;
}

function hasAllDomains(kinds: readonly ExportEntryKind[]): boolean {
  for (let index = 0; index < EXPORT_CENTER_DOMAIN_ORDER.length; index += 1) {
    const kind = EXPORT_CENTER_DOMAIN_ORDER[index];
    if (kind !== undefined && !containsKind(kinds, kind)) return false;
  }

  return true;
}

function hasBlobForEntry(blobs: readonly ExportBundleBlob[], entry: ExportBundleEntry): boolean {
  for (let index = 0; index < blobs.length; index += 1) {
    const blob = blobs[index];
    if (blob !== undefined && blob.path === entry.path && blob.kind === entry.kind) return true;
  }

  return false;
}

function hasBlobKind(blobs: readonly ExportBundleBlob[], kind: ExportEntryKind): boolean {
  for (let index = 0; index < blobs.length; index += 1) {
    if (blobs[index]?.kind === kind) return true;
  }

  return false;
}

function freezeManifest(manifest: ExportManifest): ExportManifest {
  const entries: ExportBundleEntry[] = [];

  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    if (entry === undefined) continue;
    entries.push(Object.freeze({
      bytes: entry.bytes,
      integrity: entry.integrity,
      kind: entry.kind,
      path: entry.path,
    }));
  }

  const output: {
    entries: readonly ExportBundleEntry[];
    formatVersion: typeof EXPORT_BUNDLE_FORMAT_VERSION;
    rootDigest: `sha256-${string}`;
    createdMarker?: string;
  } = {
    entries: Object.freeze(entries),
    formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
    rootDigest: manifest.rootDigest,
  };

  if (manifest.createdMarker !== undefined) output.createdMarker = manifest.createdMarker;

  return Object.freeze(output);
}

function cloneBytes(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.byteLength);
  output.set(input);
  return output;
}

function normalizeDomainKind(input: unknown): ExportEntryKind | undefined {
  if (input === "file" || input === "config" || input === "pds") return input;

  return undefined;
}

function containsKind(kinds: readonly ExportEntryKind[], kind: ExportEntryKind): boolean {
  for (let index = 0; index < kinds.length; index += 1) {
    if (kinds[index] === kind) return true;
  }

  return false;
}

function compareDomains(left: ExportCenterDomain, right: ExportCenterDomain): number {
  return domainOrder(left.kind) - domainOrder(right.kind);
}

function domainOrder(kind: ExportEntryKind): number {
  for (let index = 0; index < EXPORT_CENTER_DOMAIN_ORDER.length; index += 1) {
    if (EXPORT_CENTER_DOMAIN_ORDER[index] === kind) return index;
  }

  return EXPORT_CENTER_DOMAIN_ORDER.length;
}

function isSha256Integrity(value: string): value is `sha256-${string}` {
  if (!value.startsWith("sha256-")) return false;

  const token = value.slice("sha256-".length);
  return token.length > 0;
}

function acceptAction(action: ExportCenterAction, state: ExportCenterState): ExportCenterActionResult {
  return Object.freeze({
    action,
    ok: true,
    state,
  });
}

function rejectAction(
  action: ExportCenterAction,
  errorValue: AppError,
  state: ExportCenterState,
): ExportCenterActionResult {
  return Object.freeze({
    action,
    error: freezeError(errorValue),
    ok: false,
    state,
  });
}

function acceptNormalize<T>(value: T): ExportCenterNormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectNormalize<T>(errorValue: AppError): ExportCenterNormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function failedError(code: string, message: string, path: string): AppError {
  return error(code, message, path);
}

function freezeError(errorValue: AppError): AppError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): AppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

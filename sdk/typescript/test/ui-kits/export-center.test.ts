import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPORT_CENTER_APP_ID,
  EXPORT_CENTER_DOMAIN_ORDER,
  createExportCenterViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/export-center.ts";
import type {
  ExportCenterActionResult,
  ExportCenterExportRequest,
  ExportCenterListDomainsRequest,
  ExportCenterPort,
  ExportCenterPortResult,
  ExportCenterPreviewManifestRequest,
  ExportCenterState,
} from "../../../../ui_kits/desktop/viewmodels/apps/export-center.ts";
import {
  buildExportBundle,
} from "../../src/export-bundle.ts";
import type {
  BuildExportBundleResult,
  ExportBundleBlob,
  ExportEntryKind,
  ExportManifest,
} from "../../src/export-bundle.ts";

test("Export Center lists every first-party domain without an export grant", async () => {
  const calls: ExportCenterListDomainsRequest[] = [];
  const model = createExportCenterViewModel({
    exportPort: fakeExportPort({
      listDomains(request) {
        calls.push(request);
        assert.equal(Object.hasOwn(request, "grant"), false);

        return ok({
          domains: ["pds", "file", "config"],
        });
      },
    }),
  });

  const state = expectOk(await model.listDomains());

  assert.deepEqual(calls, [
    {
      appId: EXPORT_CENTER_APP_ID,
      kinds: EXPORT_CENTER_DOMAIN_ORDER,
    },
  ]);
  assert.equal(state.status, "ready");
  assert.deepEqual(state.domains.map((domain) => domain.kind), ["file", "config", "pds"]);
  assert.deepEqual(state.selectedKinds, ["file", "config", "pds"]);
  assert.equal(state.bundleHandle, null);
  assert.equal(state.manifest, null);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.domains), true);
  assert.equal(Object.isFrozen(state.domains[0]), true);
});

test("Export Center previews a documented manifest for the selected domains", async () => {
  const previewRequests: ExportCenterPreviewManifestRequest[] = [];
  const selectedBundle = await bundleFor(["file", "pds"]);
  const model = createExportCenterViewModel({
    exportPort: fakeExportPort({
      previewManifest(request) {
        previewRequests.push(request);
        assert.equal(Object.hasOwn(request, "grant"), false);

        return ok({
          manifest: selectedBundle.manifest,
        });
      },
    }),
  });

  expectOk(await model.listDomains());
  expectOk(model.select("config", false));

  const state = expectOk(await model.previewManifest());

  assert.deepEqual(previewRequests, [
    {
      appId: EXPORT_CENTER_APP_ID,
      domains: ["file", "pds"],
    },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(state.manifest?.formatVersion, 1);
  assert.deepEqual(kindsIn(state.manifest), ["file", "pds"]);
  assert.deepEqual(state.manifest?.entries.map((entry) => ({
    integrity: entry.integrity.startsWith("sha256-"),
    kind: entry.kind,
    path: entry.path,
  })), [
    {
      integrity: true,
      kind: "pds",
      path: "pds-sync-state.json",
    },
    {
      integrity: true,
      kind: "config",
      path: "state.json",
    },
    {
      integrity: true,
      kind: "file",
      path: "user-notes.txt",
    },
  ].filter((entry) => entry.kind !== "config").sort((left, right) => compareStrings(left.path, right.path)));
  assert.equal(state.bundleHandle, null);
});

test("Export Center exports a complete bundle without subscription and with vendor domains blocked", async () => {
  const bundle = await bundleFor(["file", "config", "pds"]);
  const environment = Object.freeze({
    subscriptionActive: false,
    vendorDomainsBlocked: true,
  });
  const exportRequests: ExportCenterExportRequest[] = [];
  const model = createExportCenterViewModel({
    exportPort: fakeExportPort({
      async previewManifest(_request) {
        assert.equal(environment.subscriptionActive, false);
        assert.equal(environment.vendorDomainsBlocked, true);

        return ok({
          manifest: bundle.manifest,
        });
      },
      exportBundle(request) {
        exportRequests.push(request);
        assert.equal(environment.subscriptionActive, false);
        assert.equal(environment.vendorDomainsBlocked, true);

        return ok({
          blobs: bundle.blobs,
          bundleHandle: "export://bundle/all-first-party-data",
          domains: [
            { kind: "file", ok: true },
            { kind: "config", ok: true },
            { kind: "pds", ok: true },
          ],
          manifest: bundle.manifest,
        });
      },
    }),
    grant: "export-grant",
  });

  expectOk(await model.listDomains());
  expectOk(await model.previewManifest());
  const state = expectOk(await model.export());

  assert.deepEqual(exportRequests, [
    {
      appId: EXPORT_CENTER_APP_ID,
      domains: ["file", "config", "pds"],
      grant: "export-grant",
      manifest: bundle.manifest,
    },
  ]);
  assert.equal(state.status, "done");
  assert.equal(state.bundleHandle, "export://bundle/all-first-party-data");
  assert.equal(state.error, undefined);
  assert.deepEqual(kindsIn(state.manifest), ["pds", "config", "file"].sort(compareStrings));
});

test("Export Center fails closed with forbidden status when the export grant is missing", async () => {
  const model = createExportCenterViewModel({
    exportPort: fakeExportPort({
      exportBundle(_request) {
        throw new Error("export port must not be called without a grant");
      },
    }),
  });

  expectOk(await model.listDomains());
  const result = await model.export();

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected missing export grant failure");
  assert.equal(result.error.code, "MissingExportGrant");
  assertFailClosedState(result.state, "forbidden", "MissingExportGrant");
});

test("Export Center fails closed on rejected, partial, or per-domain failed export results", async () => {
  const complete = await bundleFor(["file", "config", "pds"]);
  const rejected = createExportCenterViewModel({
    exportPort: fakeExportPort({
      exportBundle(_request) {
        return {
          ok: false,
          reason: "integrity_mismatch",
        };
      },
    }),
    grant: "export-grant",
  });

  expectOk(await rejected.listDomains());
  const rejectedResult = await rejected.export();

  assert.equal(rejectedResult.ok, false);
  if (rejectedResult.ok) assert.fail("expected rejected export failure");
  assertFailClosedState(rejectedResult.state, "failed", "ExportBundleRejected");

  const missingPdsBlob = createExportCenterViewModel({
    exportPort: fakeExportPort({
      exportBundle(_request) {
        return ok({
          blobs: complete.blobs.filter((blob) => blob.kind !== "pds"),
          bundleHandle: "export://bundle/missing-pds",
          manifest: complete.manifest,
        });
      },
    }),
    grant: "export-grant",
  });

  expectOk(await missingPdsBlob.listDomains());
  const partialResult = await missingPdsBlob.export();

  assert.equal(partialResult.ok, false);
  if (partialResult.ok) assert.fail("expected missing blob failure");
  assertFailClosedState(partialResult.state, "failed", "ExportBundleIncomplete");

  const domainFailure = createExportCenterViewModel({
    exportPort: fakeExportPort({
      exportBundle(_request) {
        return ok({
          blobs: complete.blobs,
          bundleHandle: "export://bundle/domain-failure",
          domains: [
            { kind: "file", ok: true },
            { kind: "config", ok: false, reason: "invalid_input" },
            { kind: "pds", ok: true },
          ],
          manifest: complete.manifest,
        });
      },
    }),
    grant: "export-grant",
  });

  expectOk(await domainFailure.listDomains());
  const domainFailureResult = await domainFailure.export();

  assert.equal(domainFailureResult.ok, false);
  if (domainFailureResult.ok) assert.fail("expected per-domain failure");
  assertFailClosedState(domainFailureResult.state, "failed", "ExportDomainFailed");
});

function fakeExportPort(overrides: Partial<ExportCenterPort>): ExportCenterPort {
  return Object.freeze({
    exportBundle(request: ExportCenterExportRequest) {
      if (overrides.exportBundle !== undefined) return overrides.exportBundle(request);

      throw new Error("unexpected export request");
    },
    listDomains(request: ExportCenterListDomainsRequest) {
      if (overrides.listDomains !== undefined) return overrides.listDomains(request);

      return ok({
        domains: EXPORT_CENTER_DOMAIN_ORDER,
      });
    },
    previewManifest(request: ExportCenterPreviewManifestRequest) {
      if (overrides.previewManifest !== undefined) return overrides.previewManifest(request);

      return bundleFor(request.domains).then((bundle) => ok({
        manifest: bundle.manifest,
      }));
    },
  });
}

function ok<T>(value: T): ExportCenterPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

async function bundleFor(kinds: readonly ExportEntryKind[]): Promise<{
  readonly manifest: ExportManifest;
  readonly blobs: readonly ExportBundleBlob[];
}> {
  const files = contains(kinds, "file")
    ? Object.freeze([
        Object.freeze({
          data: bytes("user notes\n"),
          relPath: "user-notes.txt",
        }),
      ])
    : undefined;
  const stateSnapshot = contains(kinds, "config")
    ? Object.freeze({
        device: "vita-desktop",
        version: 1,
      })
    : undefined;
  const pdsSyncState = contains(kinds, "pds")
    ? Object.freeze({
        cursor: "sync-001",
        service: "pds",
      })
    : undefined;

  const input = {
    ...(files === undefined ? {} : { files }),
    ...(pdsSyncState === undefined ? {} : { pdsSyncState }),
    ...(stateSnapshot === undefined ? {} : { stateSnapshot }),
  };

  const built = await buildExportBundle(input);

  assertBundleBuilt(built);

  return {
    blobs: built.blobs,
    manifest: built.manifest,
  };
}

function assertBundleBuilt(
  built: BuildExportBundleResult,
): asserts built is Extract<BuildExportBundleResult, { readonly ok: true }> {
  if (!built.ok) {
    assert.fail(`expected test bundle to build, got ${built.reason}`);
  }
}

function expectOk(result: ExportCenterActionResult): ExportCenterState {
  if (!result.ok) {
    assert.fail(`expected ok result, got ${result.error.code}`);
  }

  return result.state;
}

function kindsIn(manifest: ExportManifest | null): readonly ExportEntryKind[] {
  if (manifest === null) return Object.freeze([]);

  const output: ExportEntryKind[] = [];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const kind = manifest.entries[index]?.kind;
    if (kind !== undefined && !contains(output, kind)) output.push(kind);
  }

  return Object.freeze(output.sort(compareStrings));
}

function contains(values: readonly ExportEntryKind[], kind: ExportEntryKind): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === kind) return true;
  }

  return false;
}

function assertFailClosedState(
  state: ExportCenterState,
  status: "forbidden" | "failed",
  code: string,
): void {
  assert.equal(state.status, status);
  assert.equal(state.bundleHandle, null);
  assert.equal(state.manifest, null);
  assert.equal(state.error?.code, code);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

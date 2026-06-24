import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildExportBundle,
  EXPORT_CONFIG_PATH,
  EXPORT_FILES_PREFIX,
  EXPORT_PDS_PATH,
  parseExportManifest,
  verifyExportBundle,
} from "./export-bundle.ts";
import type { BuildExportBundleInput, BuildExportBundleResult } from "./export-bundle.ts";

const ENCODER = new TextEncoder();
const EMPTY_SHA256_SRI = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

test("export bundle builder is deterministic and sorts entries by path", async () => {
  const input = fixtureInput();

  const first = await mustBuild(input);
  const second = await mustBuild(input);

  assert.deepEqual(first.manifestBytes, second.manifestBytes);
  assert.deepEqual(
    first.manifest.entries.map((entry) => entry.path),
    [
      `${EXPORT_FILES_PREFIX}a.txt`,
      EXPORT_PDS_PATH,
      EXPORT_CONFIG_PATH,
      `${EXPORT_FILES_PREFIX}z.txt`,
    ],
  );
});

test("export bundle entries carry sha256 SRI content digests", async () => {
  const result = await mustBuild({
    files: [
      {
        data: bytes("hello"),
        relPath: "hello.txt",
      },
    ],
  });

  assert.equal(result.manifest.entries.length, 1);
  const entry = result.manifest.entries[0];
  assert.notEqual(entry, undefined);
  assert.equal(entry?.integrity, sha256SRI(bytes("hello")));
  assert.deepEqual(await verifyExportBundle(result.manifestBytes, (path) => blob(result, path)), {
    entries: 1,
    ok: true,
    rootDigest: result.manifest.rootDigest,
    totalBytes: 5,
  });
});

test("export rootDigest changes when content or path changes", async () => {
  const base = await mustBuild({
    files: [{ data: bytes("one"), relPath: "note.txt" }],
  });
  const changedContent = await mustBuild({
    files: [{ data: bytes("two"), relPath: "note.txt" }],
  });
  const changedPath = await mustBuild({
    files: [{ data: bytes("one"), relPath: "renamed.txt" }],
  });
  const stable = await mustBuild({
    files: [{ data: bytes("one"), relPath: "note.txt" }],
  });

  assert.notEqual(base.manifest.rootDigest, changedContent.manifest.rootDigest);
  assert.notEqual(base.manifest.rootDigest, changedPath.manifest.rootDigest);
  assert.equal(base.manifest.rootDigest, stable.manifest.rootDigest);
});

test("export builder rejects inline secret metadata without emitting manifest", async () => {
  const pathSecret = await buildExportBundle({
    files: [{ data: bytes("metadata only"), relPath: "private-key.txt" }],
  });
  assert.deepEqual(pathSecret, { ok: false, reason: "inline_secret_metadata" });

  const markerSecret = await buildExportBundle({
    createdMarker: "api_key=test-only-not-a-real-secret",
  });
  assert.deepEqual(markerSecret, { ok: false, reason: "inline_secret_metadata" });
});

test("empty export yields a deterministic well-formed manifest", async () => {
  const result = await mustBuild({});
  assert.deepEqual(result.blobs, []);
  assert.deepEqual(result.manifest.entries, []);
  assert.match(result.manifest.rootDigest, /^sha256-[A-Za-z0-9+/]+={0,2}$/u);

  const parsed = await parseExportManifest(result.manifestBytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(await verifyExportBundle(result.manifestBytes, () => bytes("unused")), {
    entries: 0,
    ok: true,
    rootDigest: result.manifest.rootDigest,
    totalBytes: 0,
  });
});

test("empty content digest uses the proven sha256 SRI vector", async () => {
  const result = await mustBuild({
    files: [{ data: new Uint8Array(), relPath: "empty.bin" }],
  });

  assert.equal(result.manifest.entries[0]?.integrity, EMPTY_SHA256_SRI);
});

test("export verifier rejects tampered content", async () => {
  const result = await mustBuild({
    files: [{ data: bytes("untampered"), relPath: "note.txt" }],
  });

  const verified = await verifyExportBundle(result.manifestBytes, () => bytes("tampered"));

  assert.deepEqual(verified, { ok: false, reason: "integrity_mismatch" });
});

function fixtureInput(): BuildExportBundleInput {
  return {
    files: [
      { data: bytes("zed"), relPath: "z.txt" },
      { data: bytes("alpha"), relPath: "a.txt" },
    ],
    pdsSyncState: {
      cursor: 42,
      repo: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
      repoHead: "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy",
    },
    stateSnapshot: {
      capabilities: {
        "hostname.set": {
          current: "vita-node-7",
        },
      },
    },
  };
}

async function mustBuild(input: BuildExportBundleInput): Promise<Extract<BuildExportBundleResult, { readonly ok: true }>> {
  const result = await buildExportBundle(input);
  if (!result.ok) {
    assert.fail(`build failed: ${result.reason}`);
  }
  return result;
}

function blob(result: Extract<BuildExportBundleResult, { readonly ok: true }>, path: string): Uint8Array {
  for (let index = 0; index < result.blobs.length; index += 1) {
    const item = result.blobs[index];
    if (item?.path === path) return item.data;
  }
  throw new Error(`missing blob ${path}`);
}

function bytes(value: string): Uint8Array {
  return ENCODER.encode(value);
}

function sha256SRI(value: Uint8Array): string {
  return `sha256-${createHash("sha256").update(value).digest("base64")}`;
}

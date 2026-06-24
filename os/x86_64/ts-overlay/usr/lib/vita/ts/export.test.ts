import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatExportMarker,
  formatExportRejectMarker,
  rejectInlineSecretExportMetadata,
  rejectTamperedExportBundle,
  runExportRoundTrip,
} from "./vita/export-client.ts";
import {
  EXPORT_MANIFEST_PATH,
  parseExportManifest,
  verifyExportBundle,
} from "./vita/export-bundle.ts";
import type {
  AgentCapabilityState,
  AgentTransport,
  AgentTransportResponse,
} from "./vita/agent-client.ts";
import type {
  FilesClient,
  FilesEntry,
  FilesReadResult,
  FilesStatResult,
  FilesWriteResult,
} from "./vita/files-client.ts";

const ENCODER = new TextEncoder();
const SOURCE_GRANT = "runtime-files";
const EXPORT_GRANT = "export";
const SOURCE_PATH = "roundtrip.txt";
const VALID_REPO = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const VALID_HEAD = "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy";

test("export client builds, writes, agent-verifies, and locally re-verifies a bundle", async () => {
  const files = new MemoryFilesClient([
    {
      data: bytes("owner file\n"),
      grant: SOURCE_GRANT,
      path: SOURCE_PATH,
    },
  ]);
  const result = await runExportRoundTrip({
    agentClient: mockAgentClient(),
    baseUrl: "http://agentd",
    exportGrant: EXPORT_GRANT,
    filesClient: files,
    sourceGrant: SOURCE_GRANT,
    sourcePath: SOURCE_PATH,
    stateTransport: stateTransport(),
    verifyTransport: exportVerifyTransport(files),
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("export roundtrip unexpectedly failed");
  assert.equal(result.entries, 3);
  assert.match(
    formatExportMarker(result),
    /^VITA-EXPORT: entries=3 bytes=[1-9][0-9]* root=sha256-[A-Za-z0-9+/]{12} verify=OK status=OK$/u,
  );

  assert.deepEqual(files.writesForGrant(EXPORT_GRANT).map((write) => write.path).sort(), [
    EXPORT_MANIFEST_PATH,
    "pds-sync-state.json",
    SOURCE_PATH,
    "state.json",
  ]);

  const manifest = await files.read(EXPORT_GRANT, EXPORT_MANIFEST_PATH);
  const parsed = await parseExportManifest(manifest.data);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) assert.fail("manifest parse unexpectedly failed");
  assert.equal(parsed.manifest.rootDigest, result.rootDigest);
  assert.deepEqual(
    parsed.manifest.entries.map((entry) => entry.path),
    ["pds-sync-state.json", SOURCE_PATH, "state.json"],
  );

  const local = await verifyExportBundle(manifest.data, async (path) => {
    const read = await files.read(EXPORT_GRANT, path);
    return read.data;
  });
  assert.deepEqual(local, {
    entries: result.entries,
    ok: true,
    rootDigest: result.rootDigest,
    totalBytes: result.bytes,
  });
});

test("export client proves tampered and inline-secret manifests are rejected", async () => {
  const files = new MemoryFilesClient();
  const verifyTransport = exportVerifyTransport(files);

  const tampered = await rejectTamperedExportBundle({
    baseUrl: "http://agentd",
    exportGrant: EXPORT_GRANT,
    filesClient: files,
    verifyTransport,
  });
  assert.deepEqual(tampered, { ok: true, reason: "integrity_mismatch" });
  assert.equal(
    formatExportRejectMarker(tampered),
    "VITA-EXPORT-REJECT: reason=integrity_mismatch status=OK",
  );

  const secret = await rejectInlineSecretExportMetadata({
    baseUrl: "http://agentd",
    exportGrant: EXPORT_GRANT,
    filesClient: files,
    verifyTransport,
  });
  assert.deepEqual(secret, { ok: true, reason: "inline_secret_metadata" });
  assert.equal(
    formatExportRejectMarker(secret),
    "VITA-EXPORT-REJECT: reason=inline_secret_metadata status=OK",
  );
});

test("export client fails closed on malformed state without writing", async () => {
  const files = new MemoryFilesClient([
    {
      data: bytes("owner file\n"),
      grant: SOURCE_GRANT,
      path: SOURCE_PATH,
    },
  ]);

  const result = await runExportRoundTrip({
    agentClient: mockAgentClient(),
    baseUrl: "http://agentd",
    exportGrant: EXPORT_GRANT,
    filesClient: files,
    sourceGrant: SOURCE_GRANT,
    sourcePath: SOURCE_PATH,
    stateTransport: jsonTransport(200, JSON.stringify(["not", "state"])),
    verifyTransport: exportVerifyTransport(files),
  });

  assert.deepEqual(result, { ok: false, reason: "malformed_state" });
  assert.deepEqual(files.writesForGrant(EXPORT_GRANT), []);
  assert.equal(formatExportMarker(result), "VITA-EXPORT-ERROR: status=FAILSAFE");
});

function mockAgentClient(): {
  readonly getOperations: () => Promise<readonly string[]>;
  readonly getState: (capability: string) => Promise<AgentCapabilityState>;
} {
  return {
    getOperations: async () => ["hostname.set", "pds.sync-state"],
    getState: async (capability) => {
      if (capability === "hostname.set") {
        return {
          current: "vita-node-7",
        };
      }
      if (capability === "pds.sync-state") {
        return {
          exists: true,
          raw: "canonical-pds-sync-state",
          state: {
            cursor: 42,
            repo: VALID_REPO,
            repoHead: VALID_HEAD,
          },
        };
      }
      return {};
    },
  };
}

function stateTransport(): AgentTransport {
  return jsonTransport(
    200,
    JSON.stringify({
      capabilities: {
        "hostname.set": {
          current: "vita-node-7",
        },
      },
      capsuleWorkloads: [],
    }),
  );
}

function exportVerifyTransport(files: MemoryFilesClient): AgentTransport {
  return async (url, init) => {
    if (new URL(url).pathname !== "/export" || init.method !== "POST") {
      return jsonResponse(404, JSON.stringify({ error: { code: "not_found", message: "not found" } }));
    }

    const request: unknown = JSON.parse(init.body ?? "{}");
    if (!isRecord(request)) {
      return jsonResponse(400, JSON.stringify({ error: { code: "invalid_request", message: "invalid request" } }));
    }
    const grant = request["grant"];
    const manifestPath = request["manifestPath"];
    if (typeof grant !== "string" || typeof manifestPath !== "string") {
      return jsonResponse(400, JSON.stringify({ error: { code: "invalid_request", message: "invalid request" } }));
    }

    try {
      const manifest = await files.read(grant, manifestPath);
      const verified = await verifyExportBundle(manifest.data, async (path) => {
        const read = await files.read(grant, path);
        return read.data;
      });
      if (!verified.ok) {
        return jsonResponse(
          400,
          JSON.stringify({ error: { code: verified.reason, message: verified.reason } }),
        );
      }
      return jsonResponse(
        200,
        JSON.stringify({
          bytes: verified.totalBytes,
          entries: verified.entries,
          rootDigest: verified.rootDigest,
          verified: true,
        }),
      );
    } catch {
      return jsonResponse(404, JSON.stringify({ error: { code: "not_found", message: "not found" } }));
    }
  };
}

function jsonTransport(status: number, body: string): AgentTransport {
  return async () => jsonResponse(status, body);
}

function jsonResponse(status: number, body: string): AgentTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

interface InitialFile {
  readonly grant: string;
  readonly path: string;
  readonly data: Uint8Array;
}

interface RecordedWrite {
  readonly grant: string;
  readonly path: string;
  readonly data: Uint8Array;
}

class MemoryFilesClient implements FilesClient {
  readonly #files = new Map<string, Uint8Array>();
  readonly #writes: RecordedWrite[] = [];

  constructor(initial: readonly InitialFile[] = []) {
    for (let index = 0; index < initial.length; index += 1) {
      const file = initial[index];
      if (file !== undefined) {
        this.#files.set(fileKey(file.grant, file.path), cloneBytes(file.data));
      }
    }
  }

  async write(grant: string, path: string, data: Uint8Array): Promise<FilesWriteResult> {
    const copied = cloneBytes(data);
    this.#files.set(fileKey(grant, path), copied);
    this.#writes[this.#writes.length] = {
      data: cloneBytes(copied),
      grant,
      path,
    };
    return { size: copied.byteLength };
  }

  async read(grant: string, path: string): Promise<FilesReadResult> {
    const data = this.#files.get(fileKey(grant, path));
    if (data === undefined) throw Object.assign(new Error("missing file"), { reason: "not_found" });
    const copied = cloneBytes(data);
    return {
      data: copied,
      mtime: "2026-06-24T00:00:00Z",
      size: copied.byteLength,
    };
  }

  async list(grant: string, path: string): Promise<readonly FilesEntry[]> {
    const exact = this.#files.get(fileKey(grant, path));
    if (exact !== undefined) {
      const entry: FilesEntry = {
        kind: "file",
        mtime: "2026-06-24T00:00:00Z",
        name: basename(path),
        size: exact.byteLength,
      };
      return Object.freeze([entry]);
    }

    const prefix = path === "" || path === "." ? `${grant}:` : `${grant}:${path}/`;
    const entries: FilesEntry[] = [];
    for (const [key, data] of this.#files.entries()) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name.includes("/")) continue;
      entries[entries.length] = {
        kind: "file",
        mtime: "2026-06-24T00:00:00Z",
        name,
        size: data.byteLength,
      };
    }
    return Object.freeze(entries.sort(compareEntriesByName));
  }

  async stat(grant: string, path: string): Promise<FilesStatResult> {
    const data = this.#files.get(fileKey(grant, path));
    if (data === undefined) throw Object.assign(new Error("missing file"), { reason: "not_found" });
    return {
      kind: "file",
      mtime: "2026-06-24T00:00:00Z",
      size: data.byteLength,
    };
  }

  writesForGrant(grant: string): readonly RecordedWrite[] {
    const writes: RecordedWrite[] = [];
    for (let index = 0; index < this.#writes.length; index += 1) {
      const write = this.#writes[index];
      if (write !== undefined && write.grant === grant) {
        writes[writes.length] = {
          data: cloneBytes(write.data),
          grant: write.grant,
          path: write.path,
        };
      }
    }
    return Object.freeze(writes);
  }
}

function fileKey(grant: string, path: string): string {
  return `${grant}:${path}`;
}

function basename(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

function compareEntriesByName(left: FilesEntry, right: FilesEntry): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneBytes(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(value.byteLength);
  out.set(value);
  return out;
}

function bytes(value: string): Uint8Array {
  return ENCODER.encode(value);
}

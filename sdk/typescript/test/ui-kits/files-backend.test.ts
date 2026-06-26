import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILES_MAX_FILE_BYTES,
  createRequestFilePort,
} from "../../src/desktop-sdk/host-bridge/index.ts";
import { isFilesResponse } from "../../src/files-grant.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

const MTIME = "2026-06-25T12:00:00Z";
const FILE_GRANT = "workspace";

test("requestFile maps list/read/write/stat through the agentd files responder", async () => {
  const backend = new FakeAgentdFiles();
  const calls: FilesRequest[] = [];
  const requestFile = createRequestFilePort({
    package: packageManifest(
      grant("files.read", FILE_GRANT),
      grant("files.write", FILE_GRANT),
    ),
    transport: {
      request(request) {
        calls.push(request);
        return backend.request(request);
      },
    },
  });

  const listed = await requestFile({
    grant: FILE_GRANT,
    op: "list",
    path: "/docs",
  });
  assertFilesSuccess(listed);
  assert.deepEqual(listed.entries, [
    entry("draft.txt", "file", 5, MTIME),
    entry("nested", "dir", 0, MTIME),
    entry("old-link", "symlink-skipped", 0, MTIME),
  ]);

  const read = await requestFile({
    grant: FILE_GRANT,
    op: "read",
    path: "/docs/draft.txt",
  });
  assertFilesSuccess(read);
  assert.deepEqual(read, {
    data: "aGVsbG8=",
    mtime: MTIME,
    size: 5,
  });

  const written = await requestFile({
    data: "dXBkYXRlZA==",
    grant: FILE_GRANT,
    op: "write",
    path: "/docs/draft.txt",
  });
  assertFilesSuccess(written);
  assert.deepEqual(written, {
    kind: "file",
    size: 7,
  });

  const reread = await requestFile({
    grant: FILE_GRANT,
    op: "read",
    path: "/docs/draft.txt",
  });
  assertFilesSuccess(reread);
  assert.deepEqual(reread, {
    data: "dXBkYXRlZA==",
    mtime: MTIME,
    size: 7,
  });

  const stat = await requestFile({
    grant: FILE_GRANT,
    op: "stat",
    path: "/docs/nested",
  });
  assertFilesSuccess(stat);
  assert.deepEqual(stat, {
    kind: "dir",
    mtime: MTIME,
    size: 0,
  });

  assert.deepEqual(calls, [
    { grant: FILE_GRANT, op: "list", path: "/docs" },
    { grant: FILE_GRANT, op: "read", path: "/docs/draft.txt" },
    { data: "dXBkYXRlZA==", grant: FILE_GRANT, op: "write", path: "/docs/draft.txt" },
    { grant: FILE_GRANT, op: "read", path: "/docs/draft.txt" },
    { grant: FILE_GRANT, op: "stat", path: "/docs/nested" },
  ]);
});

test("requestFile returns FilesErrorResponse for oversize and agentd denials", async () => {
  const backend = new FakeAgentdFiles();
  const calls: FilesRequest[] = [];
  const requestFile = createRequestFilePort({
    package: packageManifest(
      grant("files.read"),
      grant("files.write", FILE_GRANT),
    ),
    transport(request) {
      calls.push(request);
      return backend.request(request);
    },
  });

  const oversizeRead = await requestFile({
    grant: "oversize",
    op: "read",
    path: "/huge.bin",
  });
  assertFilesError(oversizeRead, "file_too_large");

  const oversizeWrite = await requestFile({
    data: "A".repeat(base64EncodedLength(FILES_MAX_FILE_BYTES + 1)),
    grant: FILE_GRANT,
    op: "write",
    path: "/docs/draft.txt",
  });
  assertFilesError(oversizeWrite, "file_too_large");

  const deniedRole = await requestFile({
    grant: "denied",
    op: "list",
    path: "/",
  });
  assertFilesError(deniedRole, "role_forbidden");

  const unknownGrant = await requestFile({
    grant: "unknown",
    op: "list",
    path: "/",
  });
  assertFilesError(unknownGrant, "unknown_grant");

  const notFound = await requestFile({
    grant: FILE_GRANT,
    op: "read",
    path: "/docs/missing.txt",
  });
  assertFilesError(notFound, "not_found");

  assert.deepEqual(calls.map((request) => [request.grant, request.op, request.path]), [
    ["oversize", "read", "/huge.bin"],
    ["denied", "list", "/"],
    ["unknown", "list", "/"],
    [FILE_GRANT, "read", "/docs/missing.txt"],
  ]);
});

test("requestFile enforces bridge grants fail-closed before agentd transport", async () => {
  const calls: FilesRequest[] = [];
  const readOnly = createRequestFilePort({
    package: packageManifest(grant("files.read", FILE_GRANT)),
    transport(request) {
      calls.push(request);
      return new FakeAgentdFiles().request(request);
    },
  });
  const noGrant = createRequestFilePort({
    package: packageManifest(),
    transport(request) {
      calls.push(request);
      return new FakeAgentdFiles().request(request);
    },
  });

  const writeDenied = await readOnly({
    data: "b2s=",
    grant: FILE_GRANT,
    op: "write",
    path: "/docs/draft.txt",
  });
  assertFilesError(writeDenied, "MISSING_CAPABILITY");

  const readDenied = await noGrant({
    grant: FILE_GRANT,
    op: "read",
    path: "/docs/draft.txt",
  });
  assertFilesError(readDenied, "MISSING_CAPABILITY");

  assert.deepEqual(calls, []);
});

class FakeAgentdFiles {
  readonly #files = new Map<string, string>([
    ["/docs/draft.txt", "aGVsbG8="],
  ]);

  request(request: FilesRequest): FilesResponse | FilesErrorResponse {
    if (request.grant === "denied") return requestError("role_forbidden", "files role is not allowed for this grant");
    if (request.grant === "unknown") return requestError("unknown_grant", "unknown files grant");
    if (request.grant === "oversize" && request.op === "read") {
      return {
        data: "A".repeat(base64EncodedLength(FILES_MAX_FILE_BYTES + 1)),
        mtime: MTIME,
        size: FILES_MAX_FILE_BYTES + 1,
      };
    }

    switch (request.op) {
      case "list":
        return this.#list(request.path);
      case "read":
        return this.#read(request.path);
      case "write":
        return this.#write(request.path, request.data);
      case "stat":
        return this.#stat(request.path);
    }
  }

  #list(path: string): FilesResponse | FilesErrorResponse {
    if (path !== "/docs") return requestError("not_found", "stat files path failed");

    return {
      entries: [
        entry("draft.txt", "file", 5, MTIME),
        entry("nested", "dir", 0, MTIME),
        entry("old-link", "symlink-skipped", 0, MTIME),
      ],
    };
  }

  #read(path: string): FilesResponse | FilesErrorResponse {
    const data = this.#files.get(path);

    if (data === undefined) return requestError("not_found", "read files path failed");

    return {
      data,
      mtime: MTIME,
      size: decodedLength(data),
    };
  }

  #write(path: string, data: string | undefined): FilesResponse | FilesErrorResponse {
    if (data === undefined) return requestError("invalid_request", "data is required for write");

    this.#files.set(path, data);

    return {
      kind: "file",
      size: decodedLength(data),
    };
  }

  #stat(path: string): FilesResponse | FilesErrorResponse {
    if (path === "/docs/nested") {
      return {
        kind: "dir",
        mtime: MTIME,
        size: 0,
      };
    }

    const data = this.#files.get(path);

    if (data === undefined) return requestError("not_found", "stat files path failed");

    return {
      kind: "file",
      mtime: MTIME,
      size: decodedLength(data),
    };
  }
}

function packageManifest(...capabilityGrants: readonly DesktopCapabilityGrant[]): { readonly capabilityGrants: readonly DesktopCapabilityGrant[] } {
  return Object.freeze({
    capabilityGrants: Object.freeze([...capabilityGrants]),
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = { capability };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

function entry(
  name: string,
  kind: FilesEntry["kind"],
  size: number,
  mtime: string,
): FilesEntry {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

function assertFilesSuccess(response: FilesResponse | FilesErrorResponse): asserts response is FilesResponse {
  assert.equal(isFilesResponse(response), true);
}

function assertFilesError(
  response: FilesResponse | FilesErrorResponse,
  code: string,
): asserts response is FilesErrorResponse {
  assert.equal(isFilesResponse(response), false);
  assert.equal(isFilesErrorResponse(response), true);
  if (!isFilesErrorResponse(response)) assert.fail("expected files error response");

  assert.deepEqual(Object.keys(response), ["error"]);
  assert.equal(response.error.code, code);
  assert.equal(typeof response.error.message, "string");
}

function isFilesErrorResponse(response: FilesResponse | FilesErrorResponse): response is FilesErrorResponse {
  return "error" in response &&
    typeof response.error.code === "string" &&
    typeof response.error.message === "string";
}

function requestError(code: string, message: string): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
    }),
  });
}

function decodedLength(base64: string): number {
  let padding = 0;

  if (base64.endsWith("=")) padding += 1;
  if (base64.endsWith("==")) padding += 1;

  return (base64.length / 4) * 3 - padding;
}

function base64EncodedLength(byteLength: number): number {
  return Math.floor((byteLength + 2) / 3) * 4;
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFilesOpsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/files-ops.ts";
import type {
  FilesOpsCapabilityPort,
  FilesOpsRequest,
  FilesOpsResponse,
  FilesOpsTarget,
} from "../../../../ui_kits/desktop/viewmodels/files-ops.ts";
import type {
  FilesEntry,
  FilesErrorResponse,
} from "../../src/desktop-sdk/index.ts";

test("files ops rename, duplicate, and newFolder append deterministic collision suffixes", async () => {
  const calls: FilesOpsRequest[] = [];
  const model = createFilesOpsViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "list" && request.path === "/workspace") {
        return entries([
          "report.txt",
          "report (1).txt",
          "Archive",
          "Photos",
          "Photos (1)",
        ]);
      }

      return {};
    }),
    grant: "workspace",
  });

  const renamed = await model.rename(target("/workspace/report.txt"), "Archive");
  const duplicated = await model.duplicate(target("/workspace/report.txt"));
  const folder = await model.newFolder("/workspace", "Photos");

  assert.equal(renamed.status, "ready");
  assert.equal(duplicated.status, "ready");
  assert.equal(folder.status, "ready");
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace",
    },
    {
      grant: "workspace",
      newPath: "/workspace/Archive (1)",
      op: "rename",
      path: "/workspace/report.txt",
    },
    {
      grant: "workspace",
      op: "list",
      path: "/workspace",
    },
    {
      grant: "workspace",
      newPath: "/workspace/report (2).txt",
      op: "copy",
      path: "/workspace/report.txt",
    },
    {
      grant: "workspace",
      op: "list",
      path: "/workspace",
    },
    {
      grant: "workspace",
      op: "mkdir",
      path: "/workspace/Photos (2)",
    },
  ]);
  assert.deepEqual(model.state.pendingOps, []);
  assert.deepEqual(model.state.trash, []);
});

test("files ops clipboard copy/cut stores target set and paste copies or moves through the files port", async () => {
  const calls: FilesOpsRequest[] = [];
  const model = createFilesOpsViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "list" && request.path === "/workspace/dest") {
        return entries(["note.txt"]);
      }

      return {};
    }),
    grant: "workspace",
  });

  const copied = model.copy([
    target("/workspace/src/note.txt"),
    target("/workspace/src/note.txt"),
    target("/workspace/src/image.png"),
  ]);

  assert.equal(copied.clipboard.mode, "copy");
  assert.deepEqual(copied.clipboard.targets.map((entry) => entry.path), [
    "/workspace/src/note.txt",
    "/workspace/src/image.png",
  ]);

  const pastedCopy = await model.paste("/workspace/dest");

  assert.equal(pastedCopy.status, "ready");
  assert.equal(pastedCopy.clipboard.mode, "copy");

  const cut = model.cut([target("/workspace/src/note.txt")]);

  assert.equal(cut.clipboard.mode, "cut");

  const pastedCut = await model.paste("/workspace/dest");

  assert.equal(pastedCut.status, "ready");
  assert.equal(pastedCut.clipboard.mode, null);
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/dest",
    },
    {
      grant: "workspace",
      newPath: "/workspace/dest/note (1).txt",
      op: "copy",
      path: "/workspace/src/note.txt",
    },
    {
      grant: "workspace",
      newPath: "/workspace/dest/image.png",
      op: "copy",
      path: "/workspace/src/image.png",
    },
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/dest",
    },
    {
      grant: "workspace",
      newPath: "/workspace/dest/note (1).txt",
      op: "move",
      path: "/workspace/src/note.txt",
    },
  ]);
});

test("files ops trash records restorable items and restore removes them after port acceptance", async () => {
  const calls: FilesOpsRequest[] = [];
  const model = createFilesOpsViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "list" && request.path === "/workspace/.trash") {
        return entries(["report.txt"]);
      }
      if (request.op === "list" && request.path === "/workspace/docs") {
        return entries(["report.txt"]);
      }

      return {};
    }),
    grant: "workspace",
    trashPath: "/workspace/.trash",
  });

  const trashed = await model.trash([
    target("/workspace/docs/report.txt", "file"),
  ]);

  assert.equal(trashed.status, "ready");
  assert.deepEqual(trashed.trash, [
    {
      id: "trash:1",
      kind: "file",
      name: "report.txt",
      originalPath: "/workspace/docs/report.txt",
      trashPath: "/workspace/.trash/report (1).txt",
    },
  ]);

  const restored = await model.restoreFromTrash(["trash:1"]);

  assert.equal(restored.status, "ready");
  assert.deepEqual(restored.trash, []);
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/.trash",
    },
    {
      grant: "workspace",
      newPath: "/workspace/.trash/report (1).txt",
      op: "trash",
      path: "/workspace/docs/report.txt",
    },
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/docs",
    },
    {
      grant: "workspace",
      newPath: "/workspace/docs/report (1).txt",
      op: "restore",
      path: "/workspace/.trash/report (1).txt",
    },
  ]);
});

test("files ops expose a pending queue while an async files operation is in flight", async () => {
  const calls: FilesOpsRequest[] = [];
  const listed = deferred<FilesOpsResponse>();
  const model = createFilesOpsViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "list") return listed.promise;

      return {};
    }),
    grant: "workspace",
  });

  const operation = model.rename(target("/workspace/report.txt"), "summary.txt");

  assert.equal(model.state.status, "busy");
  assert.deepEqual(model.state.pendingOps, [
    {
      id: "pending:1",
      kind: "rename",
      name: "summary.txt",
      sources: ["/workspace/report.txt"],
    },
  ]);

  listed.resolve(entries([]));
  const finalState = await operation;

  assert.equal(finalState.status, "ready");
  assert.deepEqual(finalState.pendingOps, []);
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace",
    },
    {
      grant: "workspace",
      newPath: "/workspace/summary.txt",
      op: "rename",
      path: "/workspace/report.txt",
    },
  ]);
});

test("files ops fail closed without a files grant before calling the port", async () => {
  const calls: FilesOpsRequest[] = [];
  const model = createFilesOpsViewModel({
    files: fakeFilesPort(calls, () => {
      throw new Error("must not call files port without grant");
    }),
  });

  const state = await model.rename(target("/workspace/report.txt"), "summary.txt");

  assert.deepEqual(calls, []);
  assert.equal(state.status, "forbidden");
  assert.equal(state.error?.code, "MissingFilesGrant");
  assert.deepEqual(state.clipboard.targets, []);
  assert.deepEqual(state.pendingOps, []);
});

function fakeFilesPort(
  calls: FilesOpsRequest[],
  handler: (request: FilesOpsRequest) =>
    | FilesOpsResponse
    | FilesErrorResponse
    | Promise<FilesOpsResponse | FilesErrorResponse>,
): FilesOpsCapabilityPort {
  return {
    request(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

function entries(names: readonly string[]): FilesOpsResponse {
  const output: FilesEntry[] = [];

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];

    if (name === undefined) continue;
    output.push(Object.freeze({
      kind: "file",
      mtime: "2026-06-25T00:00:00Z",
      name,
      size: 1,
    }));
  }

  return Object.freeze({
    entries: Object.freeze(output),
  });
}

function target(path: string, kind?: FilesEntry["kind"]): FilesOpsTarget {
  const output: {
    path: string;
    kind?: FilesEntry["kind"];
  } = {
    path,
  };

  if (kind !== undefined) output.kind = kind;

  return Object.freeze(output);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      if (resolveValue === undefined) {
        assert.fail("deferred resolver was not initialized");
      }

      resolveValue(value);
    },
  };
}

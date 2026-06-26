import assert from "node:assert/strict";
import { test } from "node:test";

import {
  textEditorAppPackage,
} from "../../../../apps/editor/manifest.ts";
import {
  createEditorAppViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/editor-app.ts";
import type {
  EditorAppSnapshot,
} from "../../../../ui_kits/desktop/viewmodels/apps/editor-app.ts";
import {
  SDK_VERSION,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  AppPackageManifest,
  DesktopCapability,
  DesktopCapabilityGrant,
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

test("Text Editor manifest is a valid first-party web app package with minimal files grants", () => {
  const app = defineAppPackage(textEditorAppPackage);

  assert.equal(app.manifest.id, "vita.app.editor");
  assert.equal(app.manifest.version, "1.0.0");
  assert.equal(app.manifest.sdkVersion, SDK_VERSION);
  assert.equal(app.manifest.entry, "index.html");
  assert.equal(app.descriptor.id, app.manifest.id);
  assert.equal(app.descriptor.title, "Text Editor");
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, "vita-app-editor");
  assert.deepEqual(app.manifest.capabilityGrants.map((entry) => entry.capability), [
    "files.read",
    "files.write",
  ]);
  assert.equal(app.manifest.capabilityGrants.length, 2);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read", "workspace"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.write", "workspace"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.read"), false);
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest), true);
  assert.equal(Object.isFrozen(app.descriptor), true);
});

test("editor view-model opens, edits, undoes, redoes, saves, and snapshots deterministically", async () => {
  const calls: FilesRequest[] = [];
  const model = createEditorAppViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "read" && request.path === "/workspace/notes.md") {
        return Object.freeze({
          data: "hello\nworld",
        });
      }
      if (request.op === "write" && request.path === "/workspace/notes.md") {
        assert.equal(request.data, "updated\ntext");

        return Object.freeze({});
      }

      return forbidden();
    }),
    grant: "workspace",
    package: manifest([
      grant("files.read", "workspace"),
      grant("files.write", "workspace"),
    ]),
  });

  const initial = model.snapshot();

  assert.equal(initial.document, undefined);
  assert.equal(initial.dirty, false);
  assert.deepEqual(initial.cursor, {
    column: 1,
    line: 1,
  });
  assert.equal(Object.isFrozen(initial), true);

  const opened = await model.open("/workspace/notes.md");

  assert.equal(opened.ok, true);
  if (!opened.ok) assert.fail("expected open to succeed");
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "read",
      path: "/workspace/notes.md",
    },
  ]);
  assert.deepEqual(opened.value, {
    content: "hello\nworld",
    language: "markdown",
    path: "/workspace/notes.md",
  });
  assert.equal(opened.state.dirty, false);
  assert.deepEqual(opened.state.undoStack, []);

  const moved = model.moveCursor({
    anchor: {
      column: 2,
      line: 1,
    },
    focus: {
      column: 4,
      line: 2,
    },
  });

  assert.equal(moved.ok, true);
  if (!moved.ok) assert.fail("expected cursor move to succeed");
  assert.deepEqual(moved.value, {
    anchor: {
      column: 2,
      line: 1,
    },
    focus: {
      column: 4,
      line: 2,
    },
  });
  assert.deepEqual(model.snapshot().cursor, {
    column: 4,
    line: 2,
  });

  const edited = model.edit("updated\ntext");

  assert.equal(edited.ok, true);
  if (!edited.ok) assert.fail("expected edit to succeed");
  assert.equal(edited.value.content, "updated\ntext");
  assert.equal(edited.state.dirty, true);
  assert.deepEqual(edited.state.cursor, {
    column: 5,
    line: 2,
  });
  assert.deepEqual(edited.state.undoStack, [
    {
      content: "hello\nworld",
      cursor: {
        column: 4,
        line: 2,
      },
      selection: {
        anchor: {
          column: 2,
          line: 1,
        },
        focus: {
          column: 4,
          line: 2,
        },
      },
    },
  ]);

  const undone = model.undo();

  assert.equal(undone.ok, true);
  if (!undone.ok) assert.fail("expected undo to succeed");
  assert.equal(undone.value.content, "hello\nworld");
  assert.equal(undone.state.dirty, false);
  assert.deepEqual(undone.state.redoStack.map((entry) => entry.content), ["updated\ntext"]);

  const redone = model.redo();

  assert.equal(redone.ok, true);
  if (!redone.ok) assert.fail("expected redo to succeed");
  assert.equal(redone.value.content, "updated\ntext");
  assert.equal(redone.state.dirty, true);

  const saved = await model.save();

  assert.equal(saved.ok, true);
  if (!saved.ok) assert.fail("expected save to succeed");
  assert.equal(saved.state.dirty, false);
  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "read",
      path: "/workspace/notes.md",
    },
    {
      data: "updated\ntext",
      grant: "workspace",
      op: "write",
      path: "/workspace/notes.md",
    },
  ]);

  assertFrozenSnapshot(saved.state);
  assert.deepEqual(model.snapshot(), model.snapshot());
});

test("editor view-model fails closed before open or save when files capabilities are missing", async () => {
  const openCalls: FilesRequest[] = [];
  const readDenied = createEditorAppViewModel({
    files: fakeFilesPort(openCalls, () => {
      throw new Error("must not read without files.read");
    }),
    grant: "workspace",
    package: manifest([
      grant("files.write", "workspace"),
    ]),
  });
  const beforeOpen = readDenied.snapshot();
  const opened = await readDenied.open("/workspace/notes.txt");

  assert.equal(opened.ok, false);
  if (opened.ok) assert.fail("expected missing read capability to fail");
  assert.equal(opened.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(openCalls, []);
  assert.deepEqual(opened.state, beforeOpen);

  const saveCalls: FilesRequest[] = [];
  const writeDenied = createEditorAppViewModel({
    files: fakeFilesPort(saveCalls, (request) => {
      if (request.op === "read") return Object.freeze({ data: "draft" });

      throw new Error("must not write without files.write");
    }),
    grant: "workspace",
    package: manifest([
      grant("files.read", "workspace"),
    ]),
  });

  assert.equal((await writeDenied.open("/workspace/draft.txt")).ok, true);
  assert.equal(writeDenied.edit("draft updated").ok, true);
  saveCalls.length = 0;

  const saved = await writeDenied.save();

  assert.equal(saved.ok, false);
  if (saved.ok) assert.fail("expected missing write capability to fail");
  assert.equal(saved.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(saveCalls, []);
  assert.equal(saved.state.dirty, true);
  assert.equal(saved.state.document?.content, "draft updated");
});

test("editor view-model preserves state when files port denies open or save", async () => {
  const readCalls: FilesRequest[] = [];
  const readDenied = createEditorAppViewModel({
    files: fakeFilesPort(readCalls, () => forbidden()),
    grant: "workspace",
    package: manifest([
      grant("files.read", "workspace"),
      grant("files.write", "workspace"),
    ]),
  });
  const beforeRead = readDenied.snapshot();
  const opened = await readDenied.open("/private/notes.txt");

  assert.equal(opened.ok, false);
  if (opened.ok) assert.fail("expected read denial to fail");
  assert.equal(opened.error.code, "AccessForbidden");
  assert.deepEqual(opened.state, beforeRead);
  assert.deepEqual(readCalls, [
    {
      grant: "workspace",
      op: "read",
      path: "/private/notes.txt",
    },
  ]);

  const writeCalls: FilesRequest[] = [];
  const writeDenied = createEditorAppViewModel({
    files: fakeFilesPort(writeCalls, (request) => {
      if (request.op === "read") return Object.freeze({ data: "draft" });

      return forbidden();
    }),
    grant: "workspace",
    package: manifest([
      grant("files.read", "workspace"),
      grant("files.write", "workspace"),
    ]),
  });

  assert.equal((await writeDenied.open("/workspace/draft.txt")).ok, true);
  assert.equal(writeDenied.edit("draft updated").ok, true);

  const beforeSave = writeDenied.snapshot();
  const saved = await writeDenied.save();

  assert.equal(saved.ok, false);
  if (saved.ok) assert.fail("expected write denial to fail");
  assert.equal(saved.error.code, "AccessForbidden");
  assert.equal(saved.state.dirty, true);
  assert.deepEqual(saved.state, beforeSave);
  assert.deepEqual(writeCalls, [
    {
      grant: "workspace",
      op: "read",
      path: "/workspace/draft.txt",
    },
    {
      data: "draft updated",
      grant: "workspace",
      op: "write",
      path: "/workspace/draft.txt",
    },
  ]);
});

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) =>
    | FilesResponse
    | FilesErrorResponse
    | Promise<FilesResponse | FilesErrorResponse>,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest) {
      calls.push(request);
      return handler(request);
    },
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): AppPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "index.html",
    id: "vita.app.editor.test",
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  });
}

function grant(
  capability: DesktopCapability,
  resourceId?: string,
): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

function forbidden(): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path is outside the grant",
    }),
  });
}

function assertFrozenSnapshot(snapshot: EditorAppSnapshot): void {
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.cursor), true);
  assert.equal(Object.isFrozen(snapshot.selection), true);
  assert.equal(Object.isFrozen(snapshot.selection.anchor), true);
  assert.equal(Object.isFrozen(snapshot.selection.focus), true);
  assert.equal(Object.isFrozen(snapshot.undoStack), true);
  assert.equal(Object.isFrozen(snapshot.redoStack), true);
  if (snapshot.document !== undefined) assert.equal(Object.isFrozen(snapshot.document), true);
}

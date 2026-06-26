import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  launchEditorApp,
} from "../../../../apps/editor/editor-launch.ts";
import type {
  EditorBindId,
  EditorLaunchViewModel,
} from "../../../../apps/editor/editor-launch.ts";
import type {
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

const EDITOR_HTML = new URL("../../../../apps/editor/index.html", import.meta.url);

test("editor HTML uses the desktop binder attributes, not ignored placeholders", () => {
  const source = readFileSync(EDITOR_HTML, "utf8");

  assert.equal(source.includes("data-view-model"), false);
  assert.doesNotMatch(source, /\sdata-bind=/u);
  assert.doesNotMatch(source, /\sdata-action=/u);
  assert.match(source, /data-vita-bind-text="editor\.path"/u);
  assert.match(source, /data-vita-bind-text="editor\.title"/u);
  assert.match(source, /data-vita-action="editor\.save"/u);
});

test("editor launch hydrates live fields from the injected files port", async () => {
  const calls: FilesRequest[] = [];
  const content = "export const hydrated = true;\n";
  const launched = await launchEditorApp({
    files: fakeFilesPort(calls, (request) => {
      assert.equal(request.op, "read");
      assert.equal(request.grant, "workspace");
      assert.equal(request.path, "/workspace/hydrated.ts");

      return Object.freeze({
        data: content,
      });
    }),
    grant: "workspace",
    path: "/workspace/hydrated.ts",
  });

  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "read",
      path: "/workspace/hydrated.ts",
    },
  ]);
  assert.equal(launched.editor.path, "/workspace/hydrated.ts");
  assert.equal(launched.editor.title, "hydrated.ts");
  assert.equal(launched.editor.content, content);
  assert.notEqual(launched.editor.path, "No file open");
  assert.notEqual(launched.editor.title, "Untitled");
  assert.equal(bindText(launched, "editor.path"), "/workspace/hydrated.ts");
  assert.equal(bindText(launched, "editor.title"), "hydrated.ts");
  assert.equal(bindText(launched, "editor.content"), content);
  assert.deepEqual(launched.snapshot().editor, {
    content,
    cursor: "Ln 1, Col 1",
    dirty: "Saved",
    error: undefined,
    language: "TypeScript",
    lineNumbers: "1\n2",
    path: "/workspace/hydrated.ts",
    title: "hydrated.ts",
  });
});

test("editor launch and actions fail closed when grant or port access is denied", async () => {
  const missingGrantCalls: FilesRequest[] = [];
  const missingGrant = await launchEditorApp({
    files: fakeFilesPort(missingGrantCalls, () => {
      throw new Error("files port must not be called without an editor grant");
    }),
    path: "/workspace/private.md",
  });

  assert.deepEqual(missingGrantCalls, []);
  assert.equal(missingGrant.editor.error?.code, "MISSING_FILES_GRANT");
  assert.equal(missingGrant.editor.error?.path, "/grant");

  const openedWithoutGrant = await missingGrant.editor.open("/workspace/private.md");

  assert.equal(openedWithoutGrant.ok, false);
  if (openedWithoutGrant.ok) assert.fail("expected open without grant to fail closed");
  assert.equal(openedWithoutGrant.error.code, "MISSING_FILES_GRANT");
  assert.equal(openedWithoutGrant.error.path, "/grant");

  const writeDeniedCalls: FilesRequest[] = [];
  const writeDenied = await launchEditorApp({
    files: fakeFilesPort(writeDeniedCalls, (request) => {
      if (request.op === "read") {
        return Object.freeze({
          data: "draft",
        });
      }

      return forbidden();
    }),
    grant: "workspace",
    path: "/workspace/draft.md",
  });

  assert.equal(writeDenied.editor.edit("updated draft").ok, true);

  const saved = await writeDenied.editor.save();

  assert.equal(saved.ok, false);
  if (saved.ok) assert.fail("expected denied save to fail closed");
  assert.deepEqual(writeDeniedCalls, [
    {
      grant: "workspace",
      op: "read",
      path: "/workspace/draft.md",
    },
    {
      data: "updated draft",
      grant: "workspace",
      op: "write",
      path: "/workspace/draft.md",
    },
  ]);
  assert.equal(saved.error.code, "AccessForbidden");
  assert.equal(saved.error.path, "/files/write/error");
  assert.equal(writeDenied.editor.error?.code, "AccessForbidden");
  assert.equal(writeDenied.editor.dirty, "Unsaved");
});

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest): FilesResponse | FilesErrorResponse {
      calls.push(request);
      return handler(request);
    },
  });
}

function forbidden(): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path is outside the grant",
    }),
  });
}

function bindText(viewModel: EditorLaunchViewModel, bindId: EditorBindId): string {
  const resolver = viewModel.binds.get(bindId);

  if (resolver === undefined) assert.fail(`missing bind resolver ${bindId}`);

  return resolver();
}

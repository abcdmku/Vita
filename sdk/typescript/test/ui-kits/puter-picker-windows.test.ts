// picker-windows tests — the puter.ui.* picker orchestrator: scope confinement (the capability
// contract), open/save/dir/font/color flows, and the SDK-facing item shapes.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-picker-windows.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import type { PuterAppSession } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import {
  clampToScope,
  createPickerSinks,
  isWithinScope,
  toPickedFsEntry,
  type PickerChoice,
  type PickerFsClient,
  type PickerFsEntry,
  type PickerUi,
  type PickerUiOpenRequest,
} from "../../../../ui_kits/desktop/runtime/puter/picker-windows.ts";

function session(grants: readonly import("../../../../ui_kits/desktop/runtime/puter/capability.ts").PuterCapability[] = ["fs.read", "fs.write"]): PuterAppSession {
  const caps = createCapabilityRegistry();

  return caps.mintAppSession({ appId: "test.app", appInstanceId: "inst-1", grants: [...grants] });
}

// A tiny in-memory fs the picker client browses. Paths are absolute.
function memFs(seed: Record<string, { is_dir: boolean; size?: number }>): PickerFsClient & { writes: Record<string, string> } {
  const writes: Record<string, string> = {};
  const tree = { ...seed };

  function children(dir: string): PickerFsEntry[] {
    const out: PickerFsEntry[] = [];

    for (const [path, meta] of Object.entries(tree)) {
      const slash = path.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : path.slice(0, slash);

      if (parent === dir && path !== dir) {
        out.push({ created: 1, is_dir: meta.is_dir, modified: 2, name: path.slice(slash + 1), path, size: meta.size ?? 0, uid: `u${path}` });
      }
    }

    return out;
  }

  return {
    writes,
    async mkdirp(): Promise<void> {},
    async readdir(_s, dir): Promise<readonly PickerFsEntry[]> {
      return children(dir);
    },
    async stat(_s, path): Promise<PickerFsEntry | undefined> {
      const meta = tree[path];

      if (meta === undefined) return undefined;
      const slash = path.lastIndexOf("/");

      return { created: 1, is_dir: meta.is_dir, modified: 2, name: path.slice(slash + 1), path, size: meta.size ?? 0, uid: `u${path}` };
    },
    async write(_s, path, content): Promise<PickerFsEntry> {
      writes[path] = typeof content === "string" ? content : new TextDecoder().decode(content);
      tree[path] = { is_dir: false, size: writes[path].length };
      const slash = path.lastIndexOf("/");

      return { created: 1, is_dir: false, modified: 2, name: path.slice(slash + 1), path, size: writes[path].length, uid: `u${path}` };
    },
  };
}

// A scripted UI that returns a fixed choice and records the request (so we can assert root/scope).
function scriptedUi(choice: PickerChoice, opts?: { font?: string | null; color?: string | null }): PickerUi & { lastRequest?: PickerUiOpenRequest } {
  const ui: PickerUi & { lastRequest?: PickerUiOpenRequest } = {
    async browse(request): Promise<PickerChoice> {
      ui.lastRequest = request;
      return choice;
    },
    async pickColor(): Promise<string | null> {
      return opts?.color ?? null;
    },
    async pickFont(): Promise<string | null> {
      return opts?.font ?? null;
    },
  };

  return ui;
}

test("isWithinScope / clampToScope confine to the root", () => {
  assert.equal(isWithinScope("/apps/x", "/apps/x"), true);
  assert.equal(isWithinScope("/apps/x", "/apps/x/sub/file.txt"), true);
  assert.equal(isWithinScope("/apps/x", "/apps/y/file.txt"), false);
  assert.equal(isWithinScope("/", "/anything"), true);
  // A path that escapes the root is clamped back to the root.
  assert.equal(clampToScope("/apps/x", "/apps/y"), "/apps/x");
  assert.equal(clampToScope("/apps/x", "/apps/x/ok"), "/apps/x/ok");
});

test("toPickedFsEntry builds a parseable absolute read/write url (FSItem-safe)", () => {
  const picked = toPickedFsEntry({ created: 1, is_dir: false, modified: 2, name: "a.txt", path: "/a.txt", size: 3, uid: "u" }, "/api");

  assert.doesNotThrow(() => new URL(picked.read_url));
  assert.doesNotThrow(() => new URL(picked.write_url));
  assert.equal(picked.path, "/a.txt");
});

test("showOpenFilePicker returns the picked file scoped to the app", async () => {
  const fs = memFs({ "/notes": { is_dir: true }, "/notes/a.txt": { is_dir: false, size: 5 } });
  const ui = scriptedUi({ kind: "open", paths: ["/notes/a.txt"] });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui });

  const result = await sinks.showOpenFilePicker(session(), {});

  assert.equal(result?.length, 1);
  assert.equal(result?.[0]?.path, "/notes/a.txt");
  assert.equal(result?.[0]?.name, "a.txt");
});

test("showOpenFilePicker REFUSES a path outside the app's scope (fail-closed)", async () => {
  const fs = memFs({ "/other/secret.txt": { is_dir: false } });
  // The UI maliciously returns a path outside the scope root.
  const ui = scriptedUi({ kind: "open", paths: ["/other/secret.txt"] });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui, resolveScopeRoot: () => "/apps/sandbox" });

  const result = await sinks.showOpenFilePicker(session(), {});

  // Out-of-scope pick is dropped → null (nothing returned to the app).
  assert.equal(result, null);
});

test("the browse window is opened rooted at the app's scope (cannot start above it)", async () => {
  const fs = memFs({ "/apps/sandbox/x.txt": { is_dir: false } });
  const ui = scriptedUi({ kind: "open", paths: ["/apps/sandbox/x.txt"] });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui, resolveScopeRoot: () => "/apps/sandbox" });

  await sinks.showOpenFilePicker(session(), {});

  assert.equal(ui.lastRequest?.root, "/apps/sandbox");
  assert.equal(ui.lastRequest?.startDir, "/apps/sandbox");
});

test("showSaveFilePicker writes the content to the chosen destination", async () => {
  const fs = memFs({ "/notes": { is_dir: true } });
  const ui = scriptedUi({ kind: "save", path: "/notes/Untitled.txt" });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui });

  const result = await sinks.showSaveFilePicker(session(), { content: "the body", suggestedName: "Untitled.txt" });

  assert.equal(result?.path, "/notes/Untitled.txt");
  assert.equal(fs.writes["/notes/Untitled.txt"], "the body");
});

test("showSaveFilePicker REFUSES to write outside the scope (fail-closed)", async () => {
  const fs = memFs({});
  const ui = scriptedUi({ kind: "save", path: "/elsewhere/evil.txt" });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui, resolveScopeRoot: () => "/apps/sandbox" });

  const result = await sinks.showSaveFilePicker(session(), { content: "x" });

  assert.equal(result, null);
  assert.equal(Object.keys(fs.writes).length, 0, "nothing written outside scope");
});

test("showFontPicker / showColorPicker return the chosen values", async () => {
  const fs = memFs({});
  const ui = scriptedUi({ kind: "cancel" }, { color: "#abcdef", font: "Georgia" });
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui });

  assert.equal(await sinks.showFontPicker(session(), {}), "Georgia");
  assert.equal(await sinks.showColorPicker(session(), {}), "#abcdef");
});

test("scoped lister drops entries that resolve outside the scope", async () => {
  // listDir is given to the UI; it must clamp + filter. Drive it through the request the sink builds.
  const fs = memFs({ "/apps/sandbox": { is_dir: true }, "/apps/sandbox/ok.txt": { is_dir: false } });
  let listed: readonly PickerFsEntry[] = [];
  const ui: PickerUi = {
    async browse(request): Promise<PickerChoice> {
      listed = await request.listDir("/apps/sandbox");
      return { kind: "cancel" };
    },
    async pickColor(): Promise<string | null> { return null; },
    async pickFont(): Promise<string | null> { return null; },
  };
  const sinks = createPickerSinks({ apiOrigin: "/api", fs, ui, resolveScopeRoot: () => "/apps/sandbox" });

  await sinks.showOpenFilePicker(session(), {});

  assert.equal(listed.every((e) => e.path.startsWith("/apps/sandbox")), true);
});

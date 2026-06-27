// ui-broker tests — the puter.ui.* postMessage parent. Exercises READY attach (no INIT reply),
// original_msg_id correlation, sink mapping, and validation (bad env / unknown instance / source spoof).
//
// Run: node --experimental-strip-types --test ui_kits/desktop/runtime/puter/test/ui-broker.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BrokerMessageEvent,
  type BrokerMessageListener,
  type BrokerSinks,
  type BrokerWindow,
  type PickedFsEntry,
  createUiBroker,
} from "../../../../ui_kits/desktop/runtime/puter/ui-broker.ts";
import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import type { PuterAppSession } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";

const INSTANCE = "ui-instance";
const APP_ID = "ui.app";

// A fake parent window that lets the test dispatch inbound messages.
function fakeWindow(): { win: BrokerWindow; dispatch: (event: BrokerMessageEvent) => void } {
  let listener: BrokerMessageListener | null = null;

  return {
    dispatch(event: BrokerMessageEvent): void {
      listener?.(event);
    },
    win: {
      addEventListener(_type, l): void {
        listener = l;
      },
      removeEventListener(): void {
        listener = null;
      },
    },
  };
}

// A fake app window (the iframe contentWindow) capturing replies posted to it.
function fakeAppSource(): { source: object; replies: unknown[] } {
  const replies: unknown[] = [];
  const source = {
    postMessage(message: unknown): void {
      replies.push(message);
    },
  };

  return { replies, source };
}

// Scripted picker results a test can set before dispatching, so we can assert the broker maps the
// sink result into the exact SDK reply shape.
interface PickerScript {
  open: readonly PickedFsEntry[] | null;
  save: PickedFsEntry | null;
  directory: readonly PickedFsEntry[] | null;
  font: string | null;
  color: string | null;
}

function entry(path: string, name: string): PickedFsEntry {
  return Object.freeze({
    created: 1000,
    is_dir: false,
    modified: 2000,
    name,
    path,
    read_url: `http://127.0.0.1/api/read?file=${encodeURIComponent(path)}&signature=x&expires=0`,
    size: 7,
    uid: `uid-${path}`,
    write_url: `http://127.0.0.1/api/batch?path=${encodeURIComponent(path)}&signature=x&expires=0`,
  });
}

function recordingSinks(script?: Partial<PickerScript>): {
  sinks: BrokerSinks;
  calls: { type: string; args: unknown[] }[];
} {
  const calls: { type: string; args: unknown[] }[] = [];
  const s: PickerScript = {
    color: script?.color ?? null,
    directory: script?.directory ?? null,
    font: script?.font ?? null,
    open: script?.open ?? null,
    save: script?.save ?? null,
  };

  return {
    calls,
    sinks: {
      async alert(instance, message, buttons): Promise<string> {
        calls.push({ args: [instance, message, buttons], type: "alert" });
        return "OK";
      },
      createWindow(instance, options): string {
        calls.push({ args: [instance, options], type: "createWindow" });
        return "win-1";
      },
      launchApp(instance, appName, args): void {
        calls.push({ args: [instance, appName, args], type: "launchApp" });
      },
      async prompt(instance, message): Promise<string | null> {
        calls.push({ args: [instance, message], type: "prompt" });
        return "typed";
      },
      setWindowTitle(instance, title): void {
        calls.push({ args: [instance, title], type: "setWindowTitle" });
      },
      async showColorPicker(session: PuterAppSession, options): Promise<string | null> {
        calls.push({ args: [session.appInstanceId, options], type: "showColorPicker" });
        return s.color;
      },
      async showDirectoryPicker(session: PuterAppSession, options): Promise<readonly PickedFsEntry[] | null> {
        calls.push({ args: [session.appInstanceId, options], type: "showDirectoryPicker" });
        return s.directory;
      },
      async showFontPicker(session: PuterAppSession, options): Promise<string | null> {
        calls.push({ args: [session.appInstanceId, options], type: "showFontPicker" });
        return s.font;
      },
      showNotification(instance, input): void {
        calls.push({ args: [instance, input], type: "showNotification" });
      },
      async showOpenFilePicker(session: PuterAppSession, options): Promise<readonly PickedFsEntry[] | null> {
        calls.push({ args: [session.appInstanceId, options], type: "showOpenFilePicker" });
        return s.open;
      },
      async showSaveFilePicker(session: PuterAppSession, input): Promise<PickedFsEntry | null> {
        calls.push({ args: [session.appInstanceId, input], type: "showSaveFilePicker" });
        return s.save;
      },
    },
  };
}

function setup(
  grants: readonly import("../../../../ui_kits/desktop/runtime/puter/capability.ts").PuterCapability[] = ["ui"],
  script?: Partial<PickerScript>,
): {
  dispatch: (e: BrokerMessageEvent) => void;
  broker: ReturnType<typeof createUiBroker>;
  calls: { type: string; args: unknown[] }[];
  appSource: { source: object; replies: unknown[] };
  caps: ReturnType<typeof createCapabilityRegistry>;
} {
  const { win, dispatch } = fakeWindow();
  const { sinks, calls } = recordingSinks(script);
  const appSource = fakeAppSource();
  const caps = createCapabilityRegistry();

  caps.mintAppSession({ appId: APP_ID, appInstanceId: INSTANCE, grants });
  const broker = createUiBroker({ capabilities: caps, sinks, window: win });

  broker.start();
  broker.registerTarget({ appInstanceId: INSTANCE, post: (m) => appSource.replies.push(m) });
  return { appSource, broker, calls, caps, dispatch };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("READY handshake attaches the app and sends NO reply", async () => {
  const { broker, dispatch, appSource } = setup();

  assert.equal(broker.isAttached(INSTANCE), false);
  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  await tick();

  assert.equal(broker.isAttached(INSTANCE), true);
  assert.equal(appSource.replies.length, 0, "READY must not get an INIT reply");
});

test("setWindowTitle maps to the sink and replies with original_msg_id", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "setWindowTitle", title: "Hello", uuid: "u-123" }, source: appSource.source });
  await tick();

  assert.deepEqual(calls.find((c) => c.type === "setWindowTitle")?.args, [INSTANCE, "Hello"]);
  const reply = appSource.replies.at(-1) as { original_msg_id?: string; msg?: string };

  assert.equal(reply?.original_msg_id, "u-123");
  assert.equal(reply?.msg, "setWindowTitle");
});

test("alert maps to the sink and replies with the chosen value correlated to uuid", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", message: "Are you sure?", msg: "alert", uuid: "u-9" }, source: appSource.source });
  await tick();

  assert.equal(calls.find((c) => c.type === "alert")?.args[1], "Are you sure?");
  const reply = appSource.replies.at(-1) as { original_msg_id?: string; value?: string };

  assert.equal(reply?.original_msg_id, "u-9");
  assert.equal(reply?.value, "OK");
});

test("setWindowTitle reads the SDK's `new_title` key", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  // The genuine SDK sends { msg:'setWindowTitle', new_title:'…', window_id:… }.
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "setWindowTitle", new_title: "Vita Spike OK", uuid: "nt-1", window_id: null }, source: appSource.source });
  await tick();

  assert.deepEqual(calls.find((c) => c.type === "setWindowTitle")?.args, [INSTANCE, "Vita Spike OK"]);
});

test("showNotification maps to the sink", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", message: "hi", msg: "showNotification", title: "t", uuid: "n1" }, source: appSource.source });
  await tick();

  const call = calls.find((c) => c.type === "showNotification");

  assert.deepEqual(call?.args[1], { message: "hi", title: "t" });
});

test("validation: env !== 'app' is rejected with an error reply", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "web", message: "x", msg: "alert", uuid: "bad-env" }, source: appSource.source });
  await tick();

  assert.equal(calls.some((c) => c.type === "alert"), false, "no sink call for a bad-env message");
  const reply = appSource.replies.at(-1) as { original_msg_id?: string; error?: { code: string } };

  assert.equal(reply?.original_msg_id, "bad-env");
  assert.equal(reply?.error?.code, "bad_env");
});

test("validation: unknown appInstanceID is rejected", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: "ghost", env: "app", message: "x", msg: "alert", uuid: "g1" }, source: appSource.source });
  await tick();

  assert.equal(calls.length, 0);
  const reply = appSource.replies.at(-1) as { error?: { code: string } } | undefined;

  assert.equal(reply?.error?.code, "UNKNOWN_INSTANCE");
});

test("validation: a different source window cannot spoof an attached instance", async () => {
  const { dispatch, calls, appSource } = setup();
  const attacker = fakeAppSource();

  // Legit app completes READY from its window.
  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  // Attacker sends with the SAME instance id from a DIFFERENT window.
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", message: "x", msg: "alert", uuid: "spoof" }, source: attacker.source });
  await tick();

  assert.equal(calls.some((c) => c.type === "alert"), false, "spoofed message must not reach the sink");
});

test("ui capability required: an app without 'ui' grant is denied", async () => {
  const { dispatch, calls, appSource } = setup(["fs.read"]); // no ui grant

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", message: "x", msg: "alert", uuid: "no-ui" }, source: appSource.source });
  await tick();

  assert.equal(calls.some((c) => c.type === "alert"), false);
  const reply = appSource.replies.at(-1) as { error?: { code: string } };

  assert.equal(reply?.error?.code, "CAP_DENIED");
});

test("launchApp maps to the sink", async () => {
  const { dispatch, calls, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { app_name: "editor", appInstanceID: INSTANCE, env: "app", msg: "launchApp", uuid: "l1" }, source: appSource.source });
  await tick();

  assert.equal(calls.find((c) => c.type === "launchApp")?.args[1], "editor");
});

test("unknown ui message is acked benignly (never hangs the app)", async () => {
  const { dispatch, appSource } = setup();

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "someFutureMessage", uuid: "fut" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { original_msg_id?: string; unhandled?: boolean };

  assert.equal(reply?.original_msg_id, "fut");
  assert.equal(reply?.unhandled, true);
});

test("non-envelope postMessages are ignored", async () => {
  const { dispatch, appSource } = setup();

  dispatch({ data: "just a string", source: appSource.source });
  dispatch({ data: { foo: "bar" }, source: appSource.source });
  await tick();

  assert.equal(appSource.replies.length, 0);
});

// ----- PICKERS -----

test("showOpenFilePicker replies with fileOpenPicked + the SDK FSItem item shape", async () => {
  const picked = entry("/notes/hello.txt", "hello.txt");
  const { dispatch, calls, appSource } = setup(["ui", "fs.read"], { open: [picked] });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showOpenFilePicker", options: {}, uuid: "of-1" }, source: appSource.source });
  await tick();

  assert.equal(calls.find((c) => c.type === "showOpenFilePicker") !== undefined, true);
  const reply = appSource.replies.at(-1) as { msg?: string; original_msg_id?: string; items?: { path?: string; name?: string; read_url?: string }[] };

  assert.equal(reply?.msg, "fileOpenPicked");
  assert.equal(reply?.original_msg_id, "of-1");
  assert.equal(reply?.items?.[0]?.path, "/notes/hello.txt");
  assert.equal(reply?.items?.[0]?.name, "hello.txt");
  // The item carries a parseable read_url so the SDK's FSItem constructor does not throw.
  assert.doesNotThrow(() => new URL(reply!.items![0]!.read_url!));
});

test("showOpenFilePicker reply item survives the genuine FSItem constructor's URL parse", async () => {
  const picked = entry("/a b/with space.txt", "with space.txt");
  const { dispatch, appSource } = setup(["ui", "fs.read"], { open: [picked] });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showOpenFilePicker", options: {}, uuid: "of-2" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { items?: Record<string, unknown>[] };
  const item = reply?.items?.[0] as Record<string, unknown>;

  // Mimic the SDK's FSItem constructor's signature/expires read: it never throws given our item.
  assert.doesNotThrow(() => {
    const u = new URL(String(item["write_url"] ?? item["read_url"]));
    u.searchParams.get("signature");
  });
});

test("showOpenFilePicker on cancel replies fileOpenCancelled", async () => {
  const { dispatch, appSource } = setup(["ui", "fs.read"], { open: null });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showOpenFilePicker", options: {}, uuid: "of-3" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { msg?: string; original_msg_id?: string };

  assert.equal(reply?.msg, "fileOpenCancelled");
  assert.equal(reply?.original_msg_id, "of-3");
});

test("showOpenFilePicker is DENIED for an app without fs.read (capability gating)", async () => {
  const { dispatch, calls, appSource } = setup(["ui"], { open: [entry("/x.txt", "x.txt")] }); // no fs.read

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showOpenFilePicker", options: {}, uuid: "of-deny" }, source: appSource.source });
  await tick();

  assert.equal(calls.some((c) => c.type === "showOpenFilePicker"), false, "picker sink must not run without fs.read");
  const reply = appSource.replies.at(-1) as { error?: { code?: string }; original_msg_id?: string };

  assert.equal(reply?.error?.code, "CAP_DENIED");
  assert.equal(reply?.original_msg_id, "of-deny");
});

test("showSaveFilePicker writes via the sink and replies fileSaved with saved_file", async () => {
  const saved = entry("/notes/Untitled.txt", "Untitled.txt");
  const { dispatch, calls, appSource } = setup(["ui", "fs.write"], { save: saved });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, content: "hello world", env: "app", msg: "showSaveFilePicker", suggestedName: "Untitled.txt", uuid: "sv-1" }, source: appSource.source });
  await tick();

  const call = calls.find((c) => c.type === "showSaveFilePicker");

  assert.equal(call !== undefined, true);
  assert.deepEqual((call?.args[1] as { content?: unknown; suggestedName?: string }).content, "hello world");
  const reply = appSource.replies.at(-1) as { msg?: string; original_msg_id?: string; saved_file?: { path?: string } };

  assert.equal(reply?.msg, "fileSaved");
  assert.equal(reply?.original_msg_id, "sv-1");
  assert.equal(reply?.saved_file?.path, "/notes/Untitled.txt");
});

test("showSaveFilePicker is DENIED without fs.write", async () => {
  const { dispatch, appSource } = setup(["ui", "fs.read"], { save: entry("/x.txt", "x.txt") }); // no fs.write

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, content: "x", env: "app", msg: "showSaveFilePicker", uuid: "sv-deny" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { error?: { code?: string } };

  assert.equal(reply?.error?.code, "CAP_DENIED");
});

test("showFontPicker replies fontPicked with the chosen font", async () => {
  const { dispatch, appSource } = setup(["ui"], { font: "Georgia" });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showFontPicker", options: {}, uuid: "ft-1" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { msg?: string; font?: { fontFamily?: string }; original_msg_id?: string };

  assert.equal(reply?.msg, "fontPicked");
  // The genuine SDK contract: apps read `new_font.fontFamily` (e.g. Notepad), so font is an object.
  assert.equal(reply?.font?.fontFamily, "Georgia");
  assert.equal(reply?.original_msg_id, "ft-1");
});

test("showColorPicker replies colorPicked with the chosen color", async () => {
  const { dispatch, appSource } = setup(["ui"], { color: "#ff8800" });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showColorPicker", options: {}, uuid: "cl-1" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { msg?: string; color?: string; original_msg_id?: string };

  assert.equal(reply?.msg, "colorPicked");
  assert.equal(reply?.color, "#ff8800");
  assert.equal(reply?.original_msg_id, "cl-1");
});

test("showDirectoryPicker replies directoryPicked with snake_case fsentry items", async () => {
  const dir = { ...entry("/projects", "projects"), is_dir: true };
  const { dispatch, appSource } = setup(["ui", "fs.read"], { directory: [dir] });

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  dispatch({ data: { appInstanceID: INSTANCE, env: "app", msg: "showDirectoryPicker", options: {}, uuid: "dp-1" }, source: appSource.source });
  await tick();

  const reply = appSource.replies.at(-1) as { msg?: string; items?: { path?: string; fsentry_name?: string; read_url?: string }[] };

  assert.equal(reply?.msg, "directoryPicked");
  assert.equal(reply?.items?.[0]?.path, "/projects");
  assert.equal(reply?.items?.[0]?.fsentry_name, "projects");
});

test("pushLaunchItems posts itemsOpened with the item list (onLaunchedWithItems live path)", async () => {
  const { broker, dispatch, appSource } = setup(["ui", "fs.read"]);

  dispatch({ data: { appInstanceID: INSTANCE, msg: "READY" }, source: appSource.source });
  broker.pushLaunchItems(INSTANCE, [entry("/inbox/launch.txt", "launch.txt")]);
  await tick();

  const msg = appSource.replies.at(-1) as { msg?: string; items?: { path?: string }[] };

  assert.equal(msg?.msg, "itemsOpened");
  assert.equal(msg?.items?.[0]?.path, "/inbox/launch.txt");
});

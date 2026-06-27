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
  createUiBroker,
} from "../../../../ui_kits/desktop/runtime/puter/ui-broker.ts";
import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";

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

function recordingSinks(): { sinks: BrokerSinks; calls: { type: string; args: unknown[] }[] } {
  const calls: { type: string; args: unknown[] }[] = [];

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
      showNotification(instance, input): void {
        calls.push({ args: [instance, input], type: "showNotification" });
      },
    },
  };
}

function setup(grants: readonly import("../../../../ui_kits/desktop/runtime/puter/capability.ts").PuterCapability[] = ["ui"]): {
  dispatch: (e: BrokerMessageEvent) => void;
  broker: ReturnType<typeof createUiBroker>;
  calls: { type: string; args: unknown[] }[];
  appSource: { source: object; replies: unknown[] };
  caps: ReturnType<typeof createCapabilityRegistry>;
} {
  const { win, dispatch } = fakeWindow();
  const { sinks, calls } = recordingSinks();
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

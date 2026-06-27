// store + native binding + launch-url + web-app window-host tests — the P2 shared-store proof and the
// pure helpers (path normalization, launch-url round-trip), plus the web-app window host mounting an
// iframe into a fake WM window.
//
// Run: node --experimental-strip-types --test ui_kits/desktop/runtime/puter/test/store-native.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryStore, PuterStoreError, basename, dirname, normalizePath } from "../../../../ui_kits/desktop/runtime/puter/store.ts";
import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { NativeCapabilityError, createVitaPuter } from "../../../../ui_kits/desktop/runtime/puter/native.ts";
import { buildLaunchSearch, buildLaunchUrl, parseLaunchParams } from "../../../../ui_kits/desktop/runtime/puter/launch-url.ts";
import { createWebAppWindowHost } from "../../../../ui_kits/desktop/runtime/puter/web-app-window.ts";
import { createUiBroker } from "../../../../ui_kits/desktop/runtime/puter/ui-broker.ts";
import type { BrokerSinks, BrokerWindow } from "../../../../ui_kits/desktop/runtime/puter/ui-broker.ts";
import type {
  WindowContent,
  WindowHandle,
  WindowManager,
  WmDocument,
  WmElement,
} from "../../../../ui_kits/desktop/runtime/window-manager.ts";

// ---- store: path helpers (pure) ----

test("normalizePath collapses, strips ~, and rejects traversal", () => {
  assert.equal(normalizePath("a/b"), "/a/b");
  assert.equal(normalizePath("/a//b/./c"), "/a/b/c");
  assert.equal(normalizePath("~/docs"), "/docs");
  assert.equal(normalizePath(""), "/");
  assert.throws(() => normalizePath("/a/../../etc"), (e) => e instanceof PuterStoreError && e.code === "forbidden");
});

test("basename / dirname", () => {
  assert.equal(basename("/a/b/c.txt"), "c.txt");
  assert.equal(dirname("/a/b/c.txt"), "/a/b");
  assert.equal(dirname("/x"), "/");
  assert.equal(basename("/"), "/");
});

// ---- store: in-memory fs + kv ----

test("memory store fs write/read/readdir/delete", () => {
  const store = createMemoryStore();

  store.fs.write("/a.txt", new TextEncoder().encode("hello"));
  assert.equal(new TextDecoder().decode(store.fs.read("/a.txt")?.bytes), "hello");

  store.fs.mkdir("/sub");
  store.fs.write("/sub/b.txt", new TextEncoder().encode("x"));
  const names = store.fs.readdir("/").map((e) => e.name).sort();

  assert.deepEqual(names, ["a.txt", "sub"]);

  store.fs.delete("/a.txt");
  assert.equal(store.fs.read("/a.txt"), undefined);
});

test("memory store write overwrite:false on existing throws", () => {
  const store = createMemoryStore();

  store.fs.write("/x.txt", new TextEncoder().encode("1"));
  assert.throws(
    () => store.fs.write("/x.txt", new TextEncoder().encode("2"), { overwrite: false }),
    (e) => e instanceof PuterStoreError && e.code === "item_with_same_name_exists",
  );
});

test("memory store kv set/get/del/list", () => {
  const store = createMemoryStore();

  store.kv.set("k", "v");
  assert.equal(store.kv.get("k"), "v");
  assert.deepEqual(store.kv.list(), [{ key: "k", value: "v" }]);
  store.kv.del("k");
  assert.equal(store.kv.get("k"), null);
});

// ---- native binding (P2) ----

function nativeSetup(grants: readonly import("../../../../ui_kits/desktop/runtime/puter/capability.ts").PuterCapability[]): { puter: ReturnType<typeof createVitaPuter>; store: ReturnType<typeof createMemoryStore> } {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();
  const session = caps.mintAppSession({ appId: "native.app", appInstanceId: "n1", grants });

  return { puter: createVitaPuter({ capabilities: caps, session, store }), store };
}

test("native binding fs write/read against the shared store", async () => {
  const { puter, store } = nativeSetup(["fs.read", "fs.write"]);

  await puter.fs.write("/native.txt", "from native");
  assert.equal(await puter.fs.read("/native.txt"), "from native");
  // The same store sees it raw.
  assert.equal(new TextDecoder().decode(store.fs.read("/native.txt")?.bytes), "from native");
});

test("native binding is capability-gated (no fs.write → denied)", async () => {
  const { puter } = nativeSetup(["fs.read"]);

  await assert.rejects(
    () => puter.fs.write("/x.txt", "x"),
    (e) => e instanceof NativeCapabilityError && e.code === "CAP_DENIED",
  );
});

test("native binding kv + whoami", async () => {
  const { puter } = nativeSetup(["kv.read", "kv.write", "auth"]);

  await puter.kv.set("nk", "nv");
  assert.equal(await puter.kv.get("nk"), "nv");
  assert.equal((await puter.auth.whoami()).username, "owner");
});

test("P2 shared store: native reads what an HTTP-shaped write put in the SAME store", async () => {
  // Simulate the api_origin's effect by writing through the store directly (the api-origin test proves
  // the HTTP path), then prove the native binding over the same store sees it.
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();
  const session = caps.mintAppSession({ appId: "shared.app", appInstanceId: "s1", grants: ["fs.read", "fs.write"] });

  store.fs.write("/shared.txt", new TextEncoder().encode("written by the web tier"));

  const puter = createVitaPuter({ capabilities: caps, session, store });

  assert.equal(await puter.fs.read("/shared.txt"), "written by the web tier");
});

// ---- launch-url (pure) ----

test("buildLaunchUrl carries the minimal puter.* params and round-trips", () => {
  const url = buildLaunchUrl({
    apiOrigin: "http://localhost:8137/api",
    appId: "my.app",
    appInstanceId: "inst-1",
    appUrl: "/spike/app/index.html",
    authToken: "tok-abc",
    guiOrigin: "http://localhost:8137",
    username: "owner",
  });

  const params = parseLaunchParams(url);

  assert.equal(params["puter.app_instance_id"], "inst-1");
  assert.equal(params["puter.api_origin"], "http://localhost:8137/api");
  assert.equal(params["puter.auth.token"], "tok-abc");
  assert.equal(params["puter.auth.username"], "owner");
  assert.equal(params["puter.env"], "app");
  assert.equal(params["puter.origin"], "http://localhost:8137");
});

test("buildLaunchSearch preserves an existing app query", () => {
  const url = buildLaunchUrl({
    apiOrigin: "o",
    appInstanceId: "i",
    appUrl: "/app.html?foo=bar",
    authToken: "t",
  });

  assert.ok(url.includes("foo=bar"));
  assert.ok(url.includes("puter.app_instance_id=i"));
  assert.equal(typeof buildLaunchSearch({ apiOrigin: "o", appInstanceId: "i", appUrl: "/x", authToken: "t" }), "string");
});

// ---- web-app window host (mounts an iframe into a fake WM window) ----

// A test element node carrying the attrs the host sets (sandbox/src/style) so we can assert on them.
interface TestNode extends WmElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  src?: string;
}

// A minimal WmDocument + WindowManager good enough for the host to mount an iframe. Typed against the
// real structural interfaces (no `any`) so strict TS covers the host's element interactions.
function fakeDomAndWm(): { doc: WmDocument; wm: WindowManager; created: TestNode[] } {
  const created: TestNode[] = [];

  function el(tag: string): TestNode {
    const attrs: Record<string, string> = {};
    const node: TestNode = {
      addEventListener(): void {},
      appendChild(child: WmElement): WmElement { return child; },
      attrs,
      classList: { add(): void {}, remove(): void {}, toggle(): boolean { return false; } },
      getAttribute(name: string): string | null { return attrs[name] ?? null; },
      id: "",
      innerHTML: "",
      querySelector(): WmElement | null { return null; },
      setAttribute(name: string, value: string): void { attrs[name] = value; },
      style: {
        cssText: "",
        setProperty(name: string, value: string): void { attrs[`style:${name}`] = value; },
      },
      tag,
      textContent: null,
    };

    created.push(node);
    return node;
  }

  const body = el("div");
  const element = el("div");
  const handle: WindowHandle = {
    appId: "",
    bodyElement: body,
    close(): void {},
    element,
    focus(): void {},
    id: "win-1",
    isOpen: true,
    setBody(): void {},
    setContent(): void {},
  };
  const wm: WindowManager = {
    closeAll(): void {},
    dispose(): void {},
    get(): WindowHandle { return handle; },
    launchOrFocus(_appId: string, _seed: WindowContent): WindowHandle { return handle; },
    windows: [],
  };
  const doc: WmDocument = {
    body,
    createElement: el,
    getElementById(): WmElement | null { return null; },
    querySelector(): WmElement | null { return null; },
  };

  return { created, doc, wm };
}

test("web-app window host mounts a sandboxed iframe with the launch URL + mints a session", () => {
  const { doc, wm, created } = fakeDomAndWm();
  const caps = createCapabilityRegistry();
  const broker = createUiBroker({ capabilities: caps, sinks: stubSinks(), window: stubWindow() });
  const host = createWebAppWindowHost({
    apiOrigin: "http://127.0.0.1:9/api",
    broker,
    capabilities: caps,
    doc,
    guiOrigin: "http://127.0.0.1:9",
    wm,
  });

  const handle = host.open({ appId: "spike.app", appUrl: "/spike/app/index.html", title: "Spike" });

  // A session was minted with the token baked into the launch URL.
  assert.ok(handle.token.length > 0);
  assert.ok(handle.launchUrl.includes("puter.api_origin"));
  assert.ok(handle.launchUrl.includes(`puter.auth.token=${handle.token}`));
  assert.equal(caps.sessions.length, 1);
  assert.equal(caps.sessions[0]?.appInstanceId, handle.appInstanceId);

  // An iframe element was created, sandboxed, and pointed at the launch URL.
  const iframe = created.find((n) => n.tag === "iframe");

  assert.ok(iframe, "an iframe was created");
  assert.equal(iframe?.attrs["sandbox"], "allow-scripts allow-same-origin allow-forms allow-modals");
  assert.equal(iframe?.src, handle.launchUrl);
});

function stubSinks(): BrokerSinks {
  return {
    async alert(): Promise<string> { return "OK"; },
    createWindow(): string { return "w"; },
    launchApp(): void {},
    async prompt(): Promise<string | null> { return null; },
    setWindowTitle(): void {},
    showNotification(): void {},
  };
}

function stubWindow(): BrokerWindow {
  return { addEventListener(): void {}, removeEventListener(): void {} };
}

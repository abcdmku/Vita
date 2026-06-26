import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appIdFor,
  createPackagerCatalog,
  generateApp,
  inMemoryModuleLoader,
  packagerRegistrySeed,
  registerGeneratedApp,
} from "../../../../ui_kits/desktop/runtime/packager/index.ts";
import type {
  DesktopAppSet,
  PackageJsonLike,
  PackagerCatalogEntry,
  PackagerModuleNamespace,
} from "../../../../ui_kits/desktop/runtime/packager/index.ts";
import {
  CLOCK_PACKAGE_NAME,
  ECHO_PACKAGE_NAME,
  clockCatalogEntry,
  clockPackageJson,
  echoCatalogEntry,
  echoPackageJson,
  sampleCatalog,
  sampleModuleLoader,
} from "../../../../ui_kits/desktop/runtime/packager/samples/index.ts";
import {
  defineApp,
} from "../../../../ui_kits/desktop/runtime/app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../../../../ui_kits/desktop/runtime/app-sdk.ts";
import { createAppRegistry } from "../../src/desktop-sdk/index.ts";

// A valid sample SRI for an arbitrary identity string (sha256 base64 of the string).
function sriFor(identity: string): string {
  return `sha256-${createHash("sha256").update(identity, "utf8").digest("base64")}`;
}

function entry(over: Partial<PackagerCatalogEntry> & Pick<PackagerCatalogEntry, "name">): PackagerCatalogEntry {
  return Object.freeze({
    capabilities: over.capabilities ?? Object.freeze([]),
    integrity: over.integrity ?? sriFor(`${over.name}@1.0.0`),
    kind: over.kind ?? "auto",
    name: over.name,
    version: over.version ?? "1.0.0",
    ...(over.title !== undefined ? { title: over.title } : {}),
    ...(over.icon !== undefined ? { icon: over.icon } : {}),
  });
}

function pkg(over: Partial<PackageJsonLike> & Pick<PackageJsonLike, "name">): PackageJsonLike {
  return Object.freeze({
    ...over,
    name: over.name,
    version: over.version ?? "1.0.0",
  });
}

// --- Catalog / allowlist ----------------------------------------------------

test("catalog lists allowed entries deterministically and gates by name", () => {
  const catalog = createPackagerCatalog([
    entry({ name: "@vita/echo" }),
    entry({ name: "@vita/clock" }),
  ]);

  assert.deepEqual(catalog.list().map((e) => e.name), ["@vita/clock", "@vita/echo"]);
  assert.equal(catalog.allows("@vita/clock"), true);
  assert.equal(catalog.allows("@vita/not-listed"), false);
  assert.equal(catalog.resolve("@vita/echo")?.version, "1.0.0");
  assert.equal(catalog.resolve("@vita/not-listed"), undefined);
  assert.equal(Object.isFrozen(catalog.list()), true);
  assert.equal(Object.isFrozen(catalog.list()[0]), true);
});

test("catalog drops entries with malformed SRI integrity fail-closed", () => {
  const catalog = createPackagerCatalog([
    entry({ name: "@vita/good" }),
    entry({ name: "@vita/bad", integrity: "sha256-not-base64!!" }),
    entry({ name: "@vita/empty", integrity: "" }),
  ]);

  assert.deepEqual(catalog.list().map((e) => e.name), ["@vita/good"]);
  assert.equal(catalog.allows("@vita/bad"), false);
  assert.equal(catalog.allows("@vita/empty"), false);
});

test("catalog keeps the first occurrence on duplicate names", () => {
  const catalog = createPackagerCatalog([
    entry({ name: "@vita/dup", version: "1.0.0" }),
    entry({ name: "@vita/dup", version: "9.9.9" }),
  ]);

  assert.equal(catalog.resolve("@vita/dup")?.version, "1.0.0");
});

// --- Generator: bin -> cmd --------------------------------------------------

test("generator produces a CMD app for a package with a bin", async () => {
  const e = entry({ name: "@vita/echo", kind: "auto", icon: "📣", title: "Echo" });
  const p = pkg({ name: "@vita/echo", bin: "./bin/echo.js", vita: { icon: "📣", title: "Echo" } });

  const result = await generateApp(e, p);

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "cmd");
  assert.equal(result.value.backendWired, false); // no exec backend wired in v1
  assert.equal(result.value.app.manifest.id, "vita.pkg.vita-echo");
  assert.equal(result.value.app.manifest.title, "Echo");
  assert.equal(result.value.app.manifest.icon, "📣");
});

test("explicit kind:cmd forces a cmd app even without a bin", async () => {
  const e = entry({ name: "@vita/runner", kind: "cmd" });
  const p = pkg({ name: "@vita/runner" });

  const result = await generateApp(e, p);

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "cmd");
});

test("a mounted cmd app renders a live surface and echoes args honestly with no exec backend", async () => {
  const e = entry({ name: "@vita/echo", kind: "cmd" });
  const p = pkg({ name: "@vita/echo", bin: "echo" });

  const result = await generateApp(e, p);
  assert.equal(result.ok, true);

  const mounted = mountSync(e, p, result.value.app);
  const dom = mounted.ctx.root;

  // The cmd surface rendered an input line + scrollback (the banner with the honest "no exec" note).
  assert.match(dom.innerHTML, /vita-pkg-cmd-input/);
  assert.match(mounted.html(), /no exec backend/i);

  // Type args + Enter -> a local echo line (the surface is demonstrably live).
  setInputValue(dom, "vita-pkg-cmd-input", "hello world");
  dom.fire("keydown", { key: "Enter", preventDefault() {} });

  assert.match(mounted.html(), /echo: hello world/);
  assert.match(mounted.html(), /no exec backend wired/i);

  mounted.close();
});

// --- Generator: ui -> desktop ----------------------------------------------

test("generator produces a DESKTOP app for a UI package via the mount convention", async () => {
  const e = entry({ name: "@vita/widget", kind: "auto", title: "Widget" });
  const p = pkg({ name: "@vita/widget", module: "index.js", vita: { ui: "default", title: "Widget" } });
  let painted = false;
  let cleaned = false;
  const ns: PackagerModuleNamespace = Object.freeze({
    default(root: { innerHTML: string }): () => void {
      painted = true;
      root.innerHTML = "<div data-widget>hi</div>";
      return () => {
        cleaned = true;
      };
    },
  });

  const result = await generateApp(e, p, inMemoryModuleLoader({ "@vita/widget": ns }));

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "desktop");
  assert.equal(result.value.backendWired, true);
  assert.equal(result.value.app.manifest.title, "Widget");

  // Mounting calls the package mount; close runs its cleanup.
  const mounted = mountSync(e, p, result.value.app);

  assert.equal(painted, true);
  assert.match(mounted.ctx.root.innerHTML, /data-widget/);
  mounted.close();
  assert.equal(cleaned, true);
});

test("generator registers a package's own VitaApp default export, intersecting capabilities", async () => {
  const e = entry({ name: "@vita/firstparty", kind: "desktop", capabilities: Object.freeze(["files.read"]) });
  const p = pkg({ name: "@vita/firstparty", module: "index.js" });
  // The package declares MORE than the catalog grants — the OS must intersect down to files.read.
  const packagedApp: VitaApp = defineApp({
    manifest: Object.freeze({
      capabilities: Object.freeze(["files.read", "files.write", "settings.write"] as const),
      icon: "🧩",
      id: "vita.pkg.firstparty",
      title: "First Party",
    }),
    mount() {
      return () => {};
    },
  });
  const ns: PackagerModuleNamespace = Object.freeze({ default: packagedApp });

  const result = await generateApp(e, p, inMemoryModuleLoader({ "@vita/firstparty": ns }));

  assert.equal(result.ok, true);
  assert.deepEqual([...result.value.app.manifest.capabilities], ["files.read"]); // widened grants stripped
  assert.equal(result.value.app.manifest.id, "vita.pkg.firstparty");
});

test("a UI package that loads a module but exports nothing usable fails closed", async () => {
  const e = entry({ name: "@vita/broken", kind: "desktop" });
  const p = pkg({ name: "@vita/broken", module: "index.js" });
  const ns: PackagerModuleNamespace = Object.freeze({ notMount: 42 });

  const result = await generateApp(e, p, inMemoryModuleLoader({ "@vita/broken": ns }));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected BAD_UI_EXPORT");
  assert.equal(result.error.code, "BAD_UI_EXPORT");
});

test("a plain web entry with no JS module gets the honest web fallback host", async () => {
  const e = entry({ name: "@vita/site", kind: "desktop" });
  const p = pkg({ name: "@vita/site", browser: "index.html" });

  const result = await generateApp(e, p, sampleModuleLoader()); // loader has no module for it

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "desktop");
  assert.equal(result.value.backendWired, false); // web load not wired in v1

  const mounted = mountSync(e, p, result.value.app);

  assert.match(mounted.ctx.root.innerHTML, /index\.html/);
  assert.match(mounted.ctx.root.innerHTML, /offline-install/i);
  mounted.close();
});

// --- Generator: auto-detect + fail-closed -----------------------------------

test("auto-detect picks cmd for a bin and desktop for a ui entry", async () => {
  const cmd = await generateApp(entry({ name: "@vita/a", kind: "auto" }), pkg({ name: "@vita/a", bin: "a" }));
  const ui = await generateApp(
    entry({ name: "@vita/b", kind: "auto" }),
    pkg({ name: "@vita/b", module: "i.js", vita: { web: "i.html" } }),
    sampleModuleLoader(),
  );

  assert.equal(cmd.ok && cmd.value.kind, "cmd");
  assert.equal(ui.ok && ui.value.kind, "desktop");
});

test("auto-detect with neither a bin nor a ui entry fails closed (NO_SURFACE)", async () => {
  const result = await generateApp(entry({ name: "@vita/empty", kind: "auto" }), pkg({ name: "@vita/empty" }));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected NO_SURFACE");
  assert.equal(result.error.code, "NO_SURFACE");
});

test("generator fails closed on name/version mismatch with the catalog entry", async () => {
  const e = entry({ name: "@vita/pkg", version: "2.0.0", kind: "cmd" });

  const nameMismatch = await generateApp(e, pkg({ name: "@vita/other", version: "2.0.0", bin: "x" }));
  assert.equal(nameMismatch.ok, false);
  if (nameMismatch.ok) assert.fail("expected NAME_MISMATCH");
  assert.equal(nameMismatch.error.code, "NAME_MISMATCH");

  const versionMismatch = await generateApp(e, pkg({ name: "@vita/pkg", version: "1.0.0", bin: "x" }));
  assert.equal(versionMismatch.ok, false);
  if (versionMismatch.ok) assert.fail("expected VERSION_MISMATCH");
  assert.equal(versionMismatch.error.code, "VERSION_MISMATCH");
});

test("a module loader that throws fails closed (MODULE_LOAD_FAILED)", async () => {
  const loader = {
    load(): never {
      throw new Error("boom");
    },
  };
  const result = await generateApp(entry({ name: "@vita/x", kind: "desktop" }), pkg({ name: "@vita/x", module: "i.js" }), loader);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected MODULE_LOAD_FAILED");
  assert.equal(result.error.code, "MODULE_LOAD_FAILED");
});

// --- Capability mapping + registry bridge -----------------------------------

test("a generated app produces a registry seed that verifies in createAppRegistry with mapped grants", async () => {
  const e = entry({ name: "@vita/grants", kind: "cmd", capabilities: Object.freeze(["files.read", "settings.write", "metrics.read"]) });
  const result = await generateApp(e, pkg({ name: "@vita/grants", bin: "g" }));

  assert.equal(result.ok, true);

  const seed = packagerRegistrySeed(result.value);
  const registry = createAppRegistry({ firstParty: Object.freeze([seed]) });
  const listed = registry.list();

  // The seed's SRI verifies (the app is listed), and capabilities mapped to desktop grants (metrics.read
  // has no desktop analogue and is dropped).
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.app.id, "vita.pkg.vita-grants");
  assert.deepEqual(listed[0]?.requiredGrants.map((g) => g.capability), ["files.read", "settings.write"]);
});

test("registerGeneratedApp adds to the app set and refuses id collisions", async () => {
  const e = entry({ name: "@vita/dock", kind: "cmd" });
  const result = await generateApp(e, pkg({ name: "@vita/dock", bin: "d" }));

  assert.equal(result.ok, true);

  const set: DesktopAppSet = new Map();

  assert.equal(registerGeneratedApp(set, result.value), true);
  assert.equal(set.has("vita.pkg.vita-dock"), true);
  assert.equal(registerGeneratedApp(set, result.value), false); // collision -> fail-closed
  assert.equal(set.size, 1);
});

test("appIdFor derives stable ids from scoped and unscoped names", () => {
  assert.equal(appIdFor(entry({ name: "@vita/clock" }), pkg({ name: "@vita/clock" })), "vita.pkg.vita-clock");
  assert.equal(appIdFor(entry({ name: "cowsay" }), pkg({ name: "cowsay" })), "vita.pkg.cowsay");
  assert.equal(appIdFor(entry({ name: "cowsay" }), pkg({ name: "cowsay", vita: { id: "my.app" } })), "my.app");
});

// --- The two in-repo SAMPLES generate + mount end-to-end --------------------

test("the sample catalog lists exactly the two allowed sample packages", () => {
  const catalog = sampleCatalog();

  assert.deepEqual(catalog.list().map((e) => e.name).sort(), [CLOCK_PACKAGE_NAME, ECHO_PACKAGE_NAME].sort());
  assert.equal(catalog.allows(CLOCK_PACKAGE_NAME), true);
  assert.equal(catalog.allows(ECHO_PACKAGE_NAME), true);
});

test("SAMPLE clock package generates a desktop app and mounts a live clock surface", async () => {
  const catalog = sampleCatalog();
  const e = catalog.resolve(CLOCK_PACKAGE_NAME);

  assert.notEqual(e, undefined);
  if (e === undefined) assert.fail("clock not in catalog");

  const result = await generateApp(e, clockPackageJson, sampleModuleLoader());

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "desktop");
  assert.equal(result.value.app.manifest.title, "Clock");
  assert.equal(result.value.app.manifest.icon, "🕙");

  const mounted = mountSync(e, clockPackageJson, result.value.app);

  assert.match(mounted.ctx.root.innerHTML, /data-vita-clock-face/);
  assert.match(mounted.ctx.root.innerHTML, /@vita\/clock/);
  mounted.close();
});

test("SAMPLE echo package generates a cmd app and mounts a live command surface", async () => {
  const catalog = sampleCatalog();
  const e = catalog.resolve(ECHO_PACKAGE_NAME);

  assert.notEqual(e, undefined);
  if (e === undefined) assert.fail("echo not in catalog");

  const result = await generateApp(e, echoPackageJson, sampleModuleLoader());

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "cmd");
  assert.equal(result.value.app.manifest.title, "Echo");

  const mounted = mountSync(e, echoPackageJson, result.value.app);

  assert.match(mounted.html(), /Vita packaged command: echo/);

  setInputValue(mounted.ctx.root, "vita-pkg-cmd-input", "ping");
  mounted.ctx.root.fire("keydown", { key: "Enter", preventDefault() {} });
  assert.match(mounted.html(), /echo: ping/);
  mounted.close();
});

test("both samples register into one app set + a signed registry that lists both", async () => {
  const catalog = sampleCatalog();
  const loader = sampleModuleLoader();
  const set: DesktopAppSet = new Map();
  const seeds = [];

  for (const e of catalog.list()) {
    const json = e.name === CLOCK_PACKAGE_NAME ? clockPackageJson : echoPackageJson;
    const result = await generateApp(e, json, loader);

    assert.equal(result.ok, true);
    assert.equal(registerGeneratedApp(set, result.value), true);
    seeds.push(packagerRegistrySeed(result.value));
  }

  assert.equal(set.size, 2);

  const registry = createAppRegistry({ firstParty: Object.freeze(seeds) });

  assert.deepEqual(registry.list().map((d) => d.title).sort(), ["Clock", "Echo"]);
});

// --- Mount harness (fake WmElement surface) ---------------------------------

interface FakeEl {
  id: string;
  innerHTML: string;
  textContent: string | null;
  value?: string;
  scrollTop?: number;
  scrollHeight?: number;
  readonly style: { cssText: string; setProperty(name: string, value: string): void };
  readonly classList: { add(): void; remove(): void; toggle(): boolean };
  children: FakeEl[];
  byId: Map<string, FakeEl>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: unknown): unknown;
  querySelector(selector: string): FakeEl | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  fire(type: string, event: unknown): void;
  focus(): void;
}

// A fake surface root whose querySelector("#id") resolves inputs/scrollback by scanning the rendered
// innerHTML for the known ids the generator emits (the generator only queries by `#id`).
function makeRoot(): FakeEl {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const children = new Map<string, FakeEl>();
  const el: FakeEl = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    appendChild(child) {
      return child;
    },
    byId: children,
    children: [],
    classList: { add() {}, remove() {}, toggle() { return false; } },
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    focus() {},
    getAttribute() {
      return null;
    },
    id: "",
    innerHTML: "",
    querySelector(selector) {
      if (!selector.startsWith("#")) return null;
      const id = selector.slice(1);
      // Only resolve the id if the generator actually rendered it.
      if (!el.innerHTML.includes(id)) return null;
      let child = children.get(id);
      if (child === undefined) {
        child = makeRoot();
        child.id = id;
        children.set(id, child);
      }
      return child;
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setAttribute() {},
    style: { cssText: "", setProperty() {} },
    textContent: null,
  };

  return el;
}

interface MountedHarness {
  ctx: { root: FakeEl };
  // The aggregate innerHTML of the surface root plus every child element the generator rendered into
  // (the cmd surface paints its banner/output into a `#vita-pkg-cmd-scrollback` CHILD, not the root).
  html(): string;
  close(): void;
}

// Resolve the VitaApp (generate it if not given), build a minimal AppContext over a fake surface, mount
// it, and return a harness that can fire events + close (which runs the app cleanup + close listeners).
function mountSync(e: PackagerCatalogEntry, p: PackageJsonLike, app?: VitaApp): MountedHarness {
  const root = makeRoot();
  const closeListeners = new Set<() => void>();
  const ctx = {
    config: {
      get: () => undefined,
      getAll: () => Object.freeze({}),
      onChange: () => () => {},
      schema: Object.freeze([]),
      set: () => Object.freeze({}),
      update: () => Object.freeze({}),
    },
    host: {},
    on(event: string, cb: () => void) {
      if (event === "close") closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    surface: { root },
    window: {
      id: "w",
      requestClose() {},
      requestFocus() {},
      requestMaximize() {},
      requestRestore() {},
      setBadge() {},
      setTitle() {},
    },
  } as unknown as AppContext;

  const resolved = app ?? Object.freeze({ manifest: { capabilities: [], icon: "?", id: "x", title: "x" }, mount() {} } as VitaApp);
  const cleanup = resolved.mount(ctx);

  return {
    ctx: { root },
    close() {
      if (typeof cleanup === "function") cleanup();
      for (const cb of closeListeners) cb();
    },
    html() {
      let html = root.innerHTML;

      for (const child of root.byId.values()) html += child.innerHTML;

      return html;
    },
  };
}

function setInputValue(root: FakeEl, id: string, value: string): void {
  const input = root.querySelector(`#${id}`);

  if (input !== null) input.value = value;
}

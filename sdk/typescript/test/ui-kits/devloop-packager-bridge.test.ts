// Dev-loop PACKAGER BRIDGE tests. Proves the existing npm->app packager (catalog/allowlist + generator)
// maps onto the NEW Puter platform: `add <allowed-pkg>` → offline locked install (SRI-verified on disk)
// → a SERVED APP DIRECTORY (manifest + index.html wired to the api_origin) that runs in a browser face.
//
// Uses real on-disk fixture packages (no network): a UI mount-convention package (@vita/greeter) and a
// cmd/bin package (@vita/echo-cli). Also pulls packager-bridge*.ts into the repo strict-typecheck lane.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  addPackagedApp,
  createPackagerCatalog,
  hashInstalledDir,
  verifyLockedInstall,
  type LockedInstall,
} from "../../../../ui_kits/desktop/runtime/devloop/packager-bridge.ts";
import type {
  PackagerCatalogEntry,
} from "../../../../ui_kits/desktop/runtime/packager/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../../ui_kits/desktop/runtime/devloop/fixtures/packages");

const greeterDir = resolve(FIXTURES, "greeter");
const echoDir = resolve(FIXTURES, "echo-cli");

const greeterInstall: LockedInstall = { dir: greeterDir, name: "@vita/greeter", version: "1.0.0" };
const echoInstall: LockedInstall = { dir: echoDir, name: "@vita/echo-cli", version: "2.1.0" };

// The catalog pins the content hash of the installed dir (production behavior).
function catalogFor(install: LockedInstall, kind: "auto" | "desktop" | "cmd", caps: string[] = []): PackagerCatalogEntry {
  return Object.freeze({
    capabilities: Object.freeze(caps) as never,
    integrity: hashInstalledDir(install.dir),
    kind,
    name: install.name,
    version: install.version,
  });
}

test("hashInstalledDir is deterministic + SRI-parseable", () => {
  const a = hashInstalledDir(greeterDir);
  const b = hashInstalledDir(greeterDir);

  assert.equal(a, b);
  assert.match(a, /^sha256-[A-Za-z0-9+/]+=*$/);
});

test("verifyLockedInstall accepts a matching install + rejects name/version drift", () => {
  const entry = catalogFor(greeterInstall, "auto");
  const verified = verifyLockedInstall(entry, greeterInstall);

  assert.equal(verified.pkg.name, "@vita/greeter");
  assert.equal(verified.pkg.version, "1.0.0");

  assert.throws(() => verifyLockedInstall(entry, { ...greeterInstall, version: "9.9.9" }), /version/);
  assert.throws(() => verifyLockedInstall(entry, { ...greeterInstall, name: "@vita/other" }), /name/);
});

test("add <UI package> → a served DESKTOP app hosting the mount module, wired to the api_origin", async () => {
  const catalog = createPackagerCatalog([catalogFor(greeterInstall, "auto", ["files.read"])]);
  const result = await addPackagedApp(catalog, "@vita/greeter", greeterInstall);

  assert.ok(result.ok, result.ok ? "" : result.error.message);

  const app = result.value;
  assert.equal(app.kind, "desktop");
  assert.equal(app.appId, "vita.pkg.vita-greeter");
  assert.equal(app.title, "Greeter");
  assert.equal(app.backendWired, true);
  assert.equal(app.entryPath, app.appDir + "/index.html");
  assert.deepEqual(app.source, { name: "@vita/greeter", version: "1.0.0" });

  const byLeaf = fileMap(app.files);
  // The served host page wires the SDK + loads the package module + the verbatim installed module.
  assert.match(get(byLeaf, "index.html"), /\/_vendor\/puter\/v2\.js/);
  assert.match(get(byLeaf, "index.html"), /\/session\.js/);
  assert.match(get(byLeaf, "index.html"), /host\.js/);
  assert.match(get(byLeaf, "host.js"), /import \* as mod from "\.\/package\.mjs"/);
  assert.match(get(byLeaf, "host.js"), /mount\(root, host\)/);
  // The package's OWN module source is embedded verbatim (offline-installed bytes).
  assert.match(get(byLeaf, "package.mjs"), /Hello from @vita\/greeter/);
});

test("add <cmd/bin package> → a served CMD app (honest: no exec backend wired)", async () => {
  const catalog = createPackagerCatalog([catalogFor(echoInstall, "auto")]);
  const result = await addPackagedApp(catalog, "@vita/echo-cli", echoInstall);

  assert.ok(result.ok, result.ok ? "" : result.error.message);

  const app = result.value;
  assert.equal(app.kind, "cmd");
  assert.equal(app.title, "Echo CLI");
  assert.equal(app.backendWired, false);

  const byLeaf = fileMap(app.files);
  assert.match(get(byLeaf, "index.html"), /\/_vendor\/puter\/v2\.js/);
  // The cmd surface is scoped to the bin's command name + is honest about the missing exec transport.
  assert.match(get(byLeaf, "app.js"), /COMMAND = "echo-cli"/);
  assert.match(get(byLeaf, "app.js"), /no exec backend wired/);
});

test("a package NOT on the allowlist is refused (NOT_ALLOWED)", async () => {
  const catalog = createPackagerCatalog([catalogFor(greeterInstall, "auto")]);
  const result = await addPackagedApp(catalog, "@vita/not-listed", greeterInstall);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "NOT_ALLOWED");
});

test("an install whose version drifts from the catalog pin fails closed (INSTALL_INVALID)", async () => {
  const catalog = createPackagerCatalog([catalogFor(greeterInstall, "auto")]);
  const result = await addPackagedApp(catalog, "@vita/greeter", { ...greeterInstall, version: "1.0.0-tampered" });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "INSTALL_INVALID");
});

function fileMap(files: readonly { readonly path: string; readonly content: string }[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const f of files) {
    const leaf = f.path.split("/").at(-1) ?? f.path;

    out[leaf] = f.content;
  }

  return out;
}

function get(map: Record<string, string>, leaf: string): string {
  const value = map[leaf];

  assert.ok(value !== undefined, `expected a ${leaf} in the served app files`);

  return value;
}

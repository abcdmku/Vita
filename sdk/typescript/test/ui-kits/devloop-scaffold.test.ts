// Dev-loop SCAFFOLD generator tests. The scaffold is pure (returns a file map), so these run with no
// browser/server: they assert the generated app shape is RUNNABLE — a manifest, an index.html that
// wires the puter.js SDK to the api_origin, an app.js with real puter.* calls, deterministic slugs.
//
// Also pulls scaffold.ts into the repo strict-typecheck lane (sdk/** is in tsconfig.json include).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  scaffoldApp,
  slugify,
  type ScaffoldResult,
} from "../../../../ui_kits/desktop/runtime/devloop/scaffold.ts";

test("slugify lowercases + dashes non-alphanumerics, never empty", () => {
  assert.equal(slugify("Hello Vita"), "hello-vita");
  assert.equal(slugify("  My  App!! 2 "), "my-app-2");
  assert.equal(slugify("@scope/name"), "scope-name");
  assert.equal(slugify("***"), "app");
});

test("scaffoldApp produces a runnable app file set under /home/apps/<slug>", () => {
  const result = scaffoldApp({ name: "Hello Vita" });

  assert.equal(result.slug, "hello-vita");
  assert.equal(result.appId, "vita.app.hello-vita");
  assert.equal(result.appDir, "/home/apps/hello-vita");
  assert.equal(result.entryPath, "/home/apps/hello-vita/index.html");

  const paths = result.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "/home/apps/hello-vita/README.md",
    "/home/apps/hello-vita/app.css",
    "/home/apps/hello-vita/app.js",
    "/home/apps/hello-vita/index.html",
    "/home/apps/hello-vita/manifest.json",
  ]);
});

test("the generated index.html wires the SDK to the api_origin (boot contract)", () => {
  const result = scaffoldApp({ name: "Demo" });
  const html = fileContent(result, "index.html");

  // Pins the api_origin before the SDK loads, loads the vendored SDK, loads the session bootstrap.
  assert.match(html, /window\.PUTER_API_ORIGIN\s*=\s*window\.location\.origin \+ "\/api"/);
  assert.match(html, /<script src="\/_vendor\/puter\/v2\.js">/);
  assert.match(html, /<script src="\/session\.js">/);
  assert.match(html, /<title>Demo<\/title>/);
});

test("the generated app.js makes real puter.* calls (whoami + kv persist)", () => {
  const result = scaffoldApp({ name: "Counter App" });
  const js = fileContent(result, "app.js");

  assert.match(js, /puter\.auth\.getUser\(\)/);
  assert.match(js, /puter\.kv\.get\(/);
  assert.match(js, /puter\.kv\.set\(/);
  // Sets a readiness flag the verification harness waits on.
  assert.match(js, /window\.__appReady\s*=\s*true/);
});

test("the manifest.json is valid JSON with the expected shape", () => {
  const result = scaffoldApp({ name: "Notes", description: "Take notes", icon: "📝" });
  const manifest = JSON.parse(fileContent(result, "manifest.json")) as Record<string, unknown>;

  assert.equal(manifest["id"], "vita.app.notes");
  assert.equal(manifest["title"], "Notes");
  assert.equal(manifest["description"], "Take notes");
  assert.equal(manifest["icon"], "📝");
  assert.equal(manifest["entry"], "index.html");
  assert.equal(manifest["surfaceKind"], "web");
  assert.deepEqual(manifest["capabilities"], ["files.read", "files.write"]);
});

test("scaffoldApp is deterministic (same input → byte-identical files)", () => {
  const a = scaffoldApp({ name: "Stable", appsDir: "/home/apps" });
  const b = scaffoldApp({ name: "Stable", appsDir: "/home/apps" });

  assert.deepEqual(a.files, b.files);
});

test("a custom appsDir + explicit slug are honored", () => {
  const result = scaffoldApp({ name: "My Tool", appsDir: "/home/projects", slug: "tool-x" });

  assert.equal(result.appDir, "/home/projects/tool-x");
  assert.equal(result.appId, "vita.app.tool-x");
});

test("an empty name is rejected", () => {
  assert.throws(() => scaffoldApp({ name: "  " }), /non-empty name/);
});

function fileContent(result: ScaffoldResult, leaf: string): string {
  const file = result.files.find((f) => f.path.endsWith("/" + leaf));

  assert.ok(file, `expected a ${leaf} in the scaffold`);

  return file.content;
}

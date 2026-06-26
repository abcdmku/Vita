import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { test } from "node:test";

interface MethodMapping {
  readonly method: string;
  readonly backend: string;
}

const ADR_URL = new URL("../../../../architecture/adr/0015-desktop-host-bridge.md", import.meta.url);
const EXPECTED_MAPPINGS = Object.freeze([
  Object.freeze({ backend: "compositor/shell layout engine", method: "registerComponent" }),
  Object.freeze({ backend: "compositor/shell layout engine", method: "previewShell" }),
  Object.freeze({ backend: "compositor/shell layout engine", method: "applyShell" }),
  Object.freeze({ backend: "compositor/shell layout engine", method: "rollbackShell" }),
  Object.freeze({ backend: "compositor/shell layout engine", method: "currentShell" }),
  Object.freeze({ backend: "capsule.execute", method: "launchApp" }),
  Object.freeze({ backend: "capsule.stop", method: "stopApp" }),
  Object.freeze({ backend: "shell notification/tray sink", method: "postNotification" }),
  Object.freeze({ backend: "shell notification/tray sink", method: "registerTrayItem" }),
  Object.freeze({ backend: "files capability", method: "requestFile" }),
  Object.freeze({ backend: "settings store", method: "readSetting" }),
  Object.freeze({ backend: "settings store", method: "previewSetting" }),
  Object.freeze({ backend: "settings store", method: "applySetting" }),
  Object.freeze({ backend: "launcher", method: "emitLauncherIntent" }),
  Object.freeze({ backend: "theme store", method: "readTheme" }),
]) satisfies readonly MethodMapping[];
const REQUIRED_SECTIONS = Object.freeze([
  "Context",
  "Decision",
  "Host-Side DesktopHost Owner",
  "Channel Transport",
  "Backend Port Map",
  "Capability Enforcement",
  "Slice DAG",
  "Consequences",
]);

test("ADR-0015 exists and is Proposed", () => {
  assert.equal(existsSync(ADR_URL), true);

  const adr = readAdr();

  assert.match(adr, /^## Status\r?\nProposed\.$/m);
});

test("ADR-0015 contains the required decision sections and references", () => {
  const adr = readAdr();

  for (let index = 0; index < REQUIRED_SECTIONS.length; index += 1) {
    const section = REQUIRED_SECTIONS[index];

    if (section === undefined) assert.fail(`Missing required section fixture at index ${index}`);
    assert.equal(adr.includes(`## ${section}`), true, section);
  }

  assert.equal(adr.includes("[ADR-0013](0013-desktop-hydration.md)"), true);
  assert.equal(adr.includes("[ADR-0014](0014-cef-live-render.md)"), true);
  assert.equal(adr.includes("`ui_kits/desktop/runtime/host-bridge.ts:44`"), true);
  assert.equal(adr.includes("`SurfaceHostMethod`"), true);
  assert.equal(adr.includes("`ui_kits/desktop/runtime/bootstrap.ts:67`"), true);
  assert.equal(adr.includes("`TRANSPORT_GLOBALS`"), true);
});

test("ADR-0015 records the channel and enforcement decisions", () => {
  const adr = readAdr();

  assert.equal(adr.includes("Channel transport choice: injected `window.vitaDesktopBridge`."), true);
  assert.equal(adr.includes("This binds to the first name in `bootstrap.ts:67` `TRANSPORT_GLOBALS`: `vitaDesktopBridge`."), true);
  assert.equal(adr.includes("The host proxy is the single capability-enforcement point."), true);
  assert.equal(adr.includes("`DEFAULT_PACKAGE_GRANTS` in `host-bridge.ts:110`"), true);
  assert.equal(adr.includes("No backend trusts renderer claims."), true);
});

test("ADR-0015 enumerates every SurfaceHostMethod backend mapping", () => {
  const mappings = backendMappings(readAdr());

  assert.equal(mappings.length, EXPECTED_MAPPINGS.length);
  assert.equal(new Set(mappings.map((mapping) => mapping.method)).size, EXPECTED_MAPPINGS.length);

  for (let index = 0; index < EXPECTED_MAPPINGS.length; index += 1) {
    const expected = EXPECTED_MAPPINGS[index];

    if (expected === undefined) assert.fail(`Missing expected mapping fixture at index ${index}`);
    assert.deepEqual(findMapping(mappings, expected.method), expected);
  }
});

function readAdr(): string {
  return readFileSync(ADR_URL, "utf8");
}

function backendMappings(adr: string): readonly MethodMapping[] {
  const section = sectionBody(adr, "Backend Port Map");
  const mappings: MethodMapping[] = [];
  const rowPattern = /^\| `([^`]+)` \| `([^`]+)` \|$/gm;

  for (const match of section.matchAll(rowPattern)) {
    const method = match[1];
    const backend = match[2];

    if (method === undefined || backend === undefined || method === "SurfaceHostMethod") continue;

    mappings.push(Object.freeze({
      backend,
      method,
    }));
  }

  return Object.freeze(mappings);
}

function sectionBody(adr: string, heading: string): string {
  const header = `## ${heading}`;
  const start = adr.indexOf(header);

  if (start < 0) assert.fail(`Missing section: ${heading}`);

  const bodyStart = start + header.length;
  const next = adr.indexOf("\n## ", bodyStart);

  return next < 0 ? adr.slice(bodyStart) : adr.slice(bodyStart, next);
}

function findMapping(mappings: readonly MethodMapping[], method: string): MethodMapping | undefined {
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];

    if (mapping?.method === method) return mapping;
  }

  return undefined;
}

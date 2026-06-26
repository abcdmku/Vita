import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { test } from "node:test";

interface SliceRow {
  readonly slice: string;
  readonly app: string;
  readonly dependsOn: string;
}

const ADR_URL = new URL("../../../../architecture/adr/0016-first-party-app-packages.md", import.meta.url);
const REQUIRED_SECTIONS = Object.freeze([
  "Context",
  "Decision",
  "AppPackageManifest Shape",
  "App Loader / Host / Window Lifecycle",
  "Install / List / Launch Flow",
  "Capability Enforcement",
  "Slice DAG",
  "Consequences",
]);
const EXPECTED_SLICES = Object.freeze([
  Object.freeze({ app: "App SDK foundation + registry/loader", dependsOn: "ADR-0016, ADR-0015 / PSD-340", slice: "PSD-361" }),
  Object.freeze({ app: "Files", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-362" }),
  Object.freeze({ app: "Terminal", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-363" }),
  Object.freeze({ app: "Settings", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-364" }),
  Object.freeze({ app: "Browser", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-365" }),
  Object.freeze({ app: "Mail", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-366" }),
  Object.freeze({ app: "Text-Editor", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-367" }),
  Object.freeze({ app: "Activity-Monitor", dependsOn: "PSD-361, PSD-340, PSD-304", slice: "PSD-368" }),
]) satisfies readonly SliceRow[];

test("ADR-0016 exists and is Proposed", () => {
  assert.equal(existsSync(ADR_URL), true);

  const adr = readAdr();

  assert.match(adr, /^## Status\r?\nProposed\.$/m);
});

test("ADR-0016 contains the required sections and cross-links", () => {
  const adr = readAdr();

  for (let index = 0; index < REQUIRED_SECTIONS.length; index += 1) {
    const section = REQUIRED_SECTIONS[index];

    if (section === undefined) assert.fail(`Missing required section fixture at index ${index}`);
    assert.equal(adr.includes(`## ${section}`), true, section);
  }

  assert.equal(adr.includes("[ADR-0013](0013-desktop-hydration.md)"), true);
  assert.equal(adr.includes("[ADR-0014](0014-cef-live-render.md)"), true);
  assert.equal(adr.includes("[ADR-0015](0015-desktop-host-bridge.md)"), true);
  assert.equal(adr.includes("`sdk/typescript/src/desktop-sdk/ui-package.ts`"), true);
  assert.equal(adr.includes("`DesktopUiPackageManifest`"), true);
  assert.equal(adr.includes("`DesktopCapability`"), true);
  assert.equal(adr.includes("`sdk/typescript/src/appshell/index.ts:85`"), true);
  assert.equal(adr.includes("`WebAppDescriptor`"), true);
  assert.equal(adr.includes("PSD-304"), true);
  assert.equal(adr.includes("PSD-340"), true);
});

test("ADR-0016 decides the AppPackageManifest and AppPackage SDK surface", () => {
  const section = sectionBody(readAdr(), "AppPackageManifest Shape");

  assert.equal(section.includes("`sdk/typescript/src/desktop-sdk/app-package.ts`"), true);
  assert.equal(section.includes("`sdk/typescript/src/desktop-sdk/index.ts`"), true);
  assert.equal(section.includes("export interface AppPackageManifest"), true);
  assert.equal(section.includes("readonly id: string;"), true);
  assert.equal(section.includes("readonly version: string;"), true);
  assert.equal(section.includes("readonly sdkVersion: DesktopSdkCompatibility;"), true);
  assert.equal(section.includes("readonly entry: string;"), true);
  assert.equal(section.includes("readonly capabilityGrants: readonly DesktopCapabilityGrant[];"), true);
  assert.equal(section.includes("export interface AppPackage"), true);
  assert.equal(section.includes("readonly manifest: AppPackageManifest;"), true);
  assert.equal(section.includes("descriptor(): WebAppDescriptor;"), true);
  assert.equal(section.includes("`surfaceKind: \"web\"`"), true);
  assert.equal(section.includes("`runtime.url`"), true);
  assert.equal(section.includes("`manifest.entry`"), true);
});

test("ADR-0016 records the host, web descriptor, and WM lifecycle decisions", () => {
  const section = sectionBody(readAdr(), "App Loader / Host / Window Lifecycle");

  assert.equal(section.includes("`DesktopHost.launchApp(app)`"), true);
  assert.equal(section.includes("`DesktopHost.stopApp(appId)`"), true);
  assert.equal(section.includes("`DesktopAppLaunch`"), true);
  assert.equal(section.includes("`DesktopAppStop`"), true);
  assert.equal(section.includes("`surfaceId`"), true);
  assert.equal(section.includes("`windowId`"), true);
  assert.equal(section.includes("`textureId`"), true);
  assert.equal(section.includes("`intents`"), true);
  assert.equal(section.includes("`WebAppDescriptor`"), true);
  assert.equal(section.includes("`WebviewRuntimeRef`"), true);
  assert.equal(section.includes("`surfaceKind: \"web\"`"), true);
  assert.equal(section.includes("`capsule.execute`"), true);
  assert.equal(section.includes("`capsule.stop`"), true);
  assert.equal(section.includes("`raise_surface`"), true);
  assert.equal(section.includes("`set_z`"), true);
  assert.equal(section.includes("per-surface placement"), true);
});

test("ADR-0016 records install, registry, launcher, and fail-closed enforcement decisions", () => {
  const install = sectionBody(readAdr(), "Install / List / Launch Flow");
  const enforcement = sectionBody(readAdr(), "Capability Enforcement");

  assert.equal(install.includes("`packageClass`"), true);
  assert.equal(install.includes("`capsule.fetch`"), true);
  assert.equal(install.includes("install transaction"), true);
  assert.equal(install.includes("PSD-361"), true);
  assert.equal(install.includes("app registry"), true);
  assert.equal(install.includes("`DesktopHost.emitLauncherIntent` (`ui-package.ts:138`)"), true);
  assert.equal(install.includes("`ui_kits/desktop/viewmodels/dock.ts`"), true);
  assert.equal(install.includes("Third-party apps implement the same"), true);

  assert.equal(enforcement.includes("single capability-enforcement point"), true);
  assert.equal(enforcement.includes("host proxy"), true);
  assert.equal(enforcement.includes("fail-closed"), true);
  assert.equal(enforcement.includes("`capabilityGrants`"), true);
  assert.equal(enforcement.includes("No backend trusts renderer claims."), true);
  assert.equal(enforcement.includes("offline by default"), true);
  assert.equal(enforcement.includes("`allowed_network: false`"), true);
  assert.equal(enforcement.includes("capability-gated"), true);
});

test("ADR-0016 enumerates the follow-on slice DAG", () => {
  const rows = sliceRows(readAdr());

  assert.equal(rows.length, EXPECTED_SLICES.length);
  assert.equal(new Set(rows.map((row) => row.slice)).size, EXPECTED_SLICES.length);

  for (let index = 0; index < EXPECTED_SLICES.length; index += 1) {
    const expected = EXPECTED_SLICES[index];

    if (expected === undefined) assert.fail(`Missing expected slice fixture at index ${index}`);
    assert.deepEqual(findSlice(rows, expected.slice), expected);
  }

  const dag = sectionBody(readAdr(), "Slice DAG");

  assert.equal(dag.includes("ADR-0016 and ADR-0015 / PSD-340 -> PSD-361."), true);
  assert.equal(dag.includes("PSD-361 + PSD-340 + PSD-304 -> PSD-368."), true);
});

function readAdr(): string {
  return readFileSync(ADR_URL, "utf8");
}

function sectionBody(adr: string, heading: string): string {
  const header = `## ${heading}`;
  const start = adr.indexOf(header);

  if (start < 0) assert.fail(`Missing section: ${heading}`);

  const bodyStart = start + header.length;
  const next = adr.indexOf("\n## ", bodyStart);

  return next < 0 ? adr.slice(bodyStart) : adr.slice(bodyStart, next);
}

function sliceRows(adr: string): readonly SliceRow[] {
  const section = sectionBody(adr, "Slice DAG");
  const rows: SliceRow[] = [];
  const rowPattern = /^\| (PSD-\d+) \| ([^|]+) \| [^|]+ \| ([^|]+) \|$/gm;

  for (const match of section.matchAll(rowPattern)) {
    const slice = match[1];
    const app = match[2];
    const dependsOn = match[3];

    if (slice === undefined || app === undefined || dependsOn === undefined) continue;

    rows.push(Object.freeze({
      app: app.trim(),
      dependsOn: dependsOn.trim(),
      slice,
    }));
  }

  return Object.freeze(rows);
}

function findSlice(rows: readonly SliceRow[], slice: string): SliceRow | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row?.slice === slice) return row;
  }

  return undefined;
}

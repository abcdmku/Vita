import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// feat/os-three-modes / DEPRECATED.md: the bespoke local-rendering stack (the custom Rust compositor in
// packages/compositor-core + its boot-time self-test service/wrapper/smoke-layout bridge, and the CEF/osr
// renderer) is ARCHIVED. It is no longer built into or booted by the image — the standard kiosk-browser
// model (cage + chromium --kiosk, vita-kiosk.service in local-desktop mode) renders the desktop instead.
//
// The old assertions on the compositor self-test's INTERNALS (rust-in-docker build, the
// vita-compositor-selftest.service unit, its wrapper script, and the compositor-smoke-layout.mjs command
// generator) have been removed: that subsystem's source stays in-repo for recoverability but is stripped
// at build time and never runs. What remains here is the DE-WIRING GUARD (so the bespoke renderer cannot
// silently come back into the build/boot path) plus the smoke-overlay boot bits that are still shipped.

const buildAndBootUrl = new URL("../build-and-boot.mjs", import.meta.url);
const openVmToolsWantsUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/multi-user.target.wants/open-vm-tools.service",
  import.meta.url,
);
const tty1GettyMaskUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/getty@tty1.service",
  import.meta.url,
);

test("smoke build de-wires the bespoke renderer and wires the three-mode overlay", async () => {
  // The custom Rust compositor + CEF/osr renderer is ARCHIVED. The smoke build must NOT build
  // packages/compositor-core or ship the bespoke renderer; it stages a FILTERED smoke overlay (boot
  // markers only) plus the new mode-overlay (platform server + cage/chromium kiosk + vita-mode
  // generator). This test guards the de-wiring so the renderer cannot silently come back.
  const buildAndBoot = await readText(buildAndBootUrl);

  // The renderer build path is gone: no rust-in-docker compositor build, no CEF overlay install.
  assert.doesNotMatch(buildAndBoot, /run\([^)]*rust-in-docker/u);
  assert.doesNotMatch(buildAndBoot, /const cefOverlay = /u);
  assert.doesNotMatch(buildAndBoot, /function installCefOverlay\(\)/u);
  assert.doesNotMatch(buildAndBoot, /\bCEF_RUNTIME_PACKAGES\b/u);

  // The filtered smoke overlay (markers only) + the mode overlay are staged and consumed by mkosi.
  assertContains(buildAndBoot, "function installSmokeOverlayWithoutRenderer()");
  assertContains(buildAndBoot, "function installModeOverlay()");
  assertContains(buildAndBoot, 'const SMOKE_VERIFICATION_PACKAGES = ["--package=open-vm-tools"];');
  assert.match(
    buildAndBoot,
    /const smokeOverlay = installSmokeOverlayWithoutRenderer\(\);[\s\S]+const modeOverlay = installModeOverlay\(\);[\s\S]+`--extra-tree=\$\{smokeOverlay\}`[\s\S]+`--extra-tree=\$\{modeOverlay\}`/u,
  );
  // The three-mode selector is baked onto the kernel cmdline.
  assertContains(buildAndBoot, "vita.mode=${MODE_SELECT}");
  assertContains(buildAndBoot, "console=ttyS0,115200");
  assert.doesNotMatch(buildAndBoot, /console=tty0/u);
  assertContains(buildAndBoot, "systemd.mask=getty@tty1.service");
});

test("smoke build strips the archived compositor self-test from the staged overlay", async () => {
  // The committed smoke-overlay still carries the self-test source for recoverability, but the build
  // staging removes the unit, its enablement, and the binary dir so it is never enabled or shipped.
  const buildAndBoot = await readText(buildAndBootUrl);

  assertContains(buildAndBoot, 'rmSync(join(sys, "vita-compositor-selftest.service"), { force: true });');
  assertContains(
    buildAndBoot,
    'rmSync(join(sys, "multi-user.target.wants", "vita-compositor-selftest.service"), { force: true });',
  );
  assertContains(buildAndBoot, 'rmSync(join(staged, "usr", "lib", "vita", "compositor"), { recursive: true, force: true });');
});

test("smoke overlay enables VMware Tools for authenticated screenshot artifact copy", async () => {
  const wantsTarget = await readText(openVmToolsWantsUrl);

  assert.equal(wantsTarget.trimEnd(), "../open-vm-tools.service");
});

test("smoke overlay prevents tty1 getty from drawing over the scanout", async () => {
  const buildAndBoot = await readText(buildAndBootUrl);
  const tty1Unit = await readText(tty1GettyMaskUrl);

  assertContains(buildAndBoot, "systemd.mask=getty@tty1.service");
  assert.match(tty1Unit, /^ConditionPathExists=\/run\/vita-enable-tty1-getty$/mu);
  assert.match(tty1Unit, /^Type=oneshot$/mu);
  assert.match(tty1Unit, /^ExecStart=\/bin\/true$/mu);
});

async function readText(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

function assertContains(text: string, needle: string): void {
  assert.ok(text.includes(needle), `expected text to include ${needle}`);
}

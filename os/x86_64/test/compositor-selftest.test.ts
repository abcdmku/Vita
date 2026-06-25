import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rustHelperUrl = new URL("../../../tools/build/rust-in-docker.mjs", import.meta.url);
const buildAndBootUrl = new URL("../build-and-boot.mjs", import.meta.url);
const serviceUnitUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/vita-compositor-selftest.service",
  import.meta.url,
);
const wantsUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/multi-user.target.wants/vita-compositor-selftest.service",
  import.meta.url,
);
const openVmToolsWantsUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/multi-user.target.wants/open-vm-tools.service",
  import.meta.url,
);
const tty1GettyMaskUrl = new URL(
  "../smoke-overlay/usr/lib/systemd/system/getty@tty1.service",
  import.meta.url,
);
const wrapperUrl = new URL(
  "../smoke-overlay/usr/lib/vita/compositor/vita-compositor-selftest.sh",
  import.meta.url,
);

test("rust-in-docker builds the compositor as a locked linux x86_64 release binary", async () => {
  const helper = await readText(rustHelperUrl);

  assertContains(helper, 'const DEFAULT_RUST_IMAGE = "rust:1.88.0-bookworm";');
  assertContains(helper, 'const DEFAULT_MODULE_DIR = "packages/compositor-core";');
  assertContains(helper, 'const DEFAULT_TARGET = "x86_64-unknown-linux-gnu";');
  assertContains(helper, 'const DEFAULT_BINARY_NAME = "vita-compositor-core";');
  assertContains(
    helper,
    'const DEFAULT_OUTPUT = "os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor";',
  );
  assertContains(helper, '"--platform"');
  assertContains(helper, '"linux/amd64"');
  assertContains(helper, '"--pull=never"');
  assertContains(helper, '"--network"');
  assertContains(helper, '"none"');
  assertContains(helper, '"CARGO_NET_OFFLINE=true"');
  assertContains(helper, '"--release"');
  assertContains(helper, '"--locked"');
  assertContains(helper, '"--target"');
  assertContains(helper, 'const targetRoot = "/work/os/x86_64/out/rust/target";');
  assertContains(helper, "CARGO_TARGET_DIR=${targetRoot}");
  assertContains(helper, 'const DEFAULT_SOURCE_DATE_EPOCH = "1781308800";');
  assertContains(helper, "SOURCE_DATE_EPOCH=${DEFAULT_SOURCE_DATE_EPOCH}");
  assertContains(helper, "RUSTFLAGS=-C debuginfo=0 -C link-arg=-Wl,--build-id=none");
  assertContains(helper, "chmodSync(destination, 0o755)");
});

test("smoke build stages the compositor before mkosi consumes smoke-overlay", async () => {
  const buildAndBoot = await readText(buildAndBootUrl);

  assertContains(buildAndBoot, "function installCompositorOverlay()");
  assertContains(buildAndBoot, '"tools/build/rust-in-docker.mjs"');
  assertContains(buildAndBoot, '"packages/compositor-core"');
  assertContains(buildAndBoot, '"os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor"');
  assertContains(buildAndBoot, 'const SMOKE_VERIFICATION_PACKAGES = ["--package=open-vm-tools"];');
  assert.match(
    buildAndBoot,
    /const agentOverlay = installAgentOverlay\(\);[\s\S]+const smokeOverlay = installCompositorOverlay\(\);[\s\S]+`--extra-tree=\$\{smokeOverlay\}`/u,
  );
  assertContains(buildAndBoot, "console=ttyS0,115200");
  assert.doesNotMatch(buildAndBoot, /console=tty0/u);
  assertContains(buildAndBoot, "systemd.mask=getty@tty1.service");
});

test("compositor self-test service is enabled, ordered after GPU setup, and bounded", async () => {
  const unitText = await readText(serviceUnitUrl);
  const wantsTarget = await readText(wantsUrl);

  assert.equal(wantsTarget.trimEnd(), "../vita-compositor-selftest.service");
  assert.match(unitText, /^After=systemd-modules-load\.service systemd-udev-trigger\.service open-vm-tools\.service$/mu);
  assert.match(unitText, /^Wants=systemd-udev-trigger\.service open-vm-tools\.service$/mu);
  assert.doesNotMatch(unitText, /^Before=.*multi-user\.target$/mu);
  assert.match(unitText, /^Type=oneshot$/mu);
  assert.match(unitText, /^ExecStart=\/bin\/bash \/usr\/lib\/vita\/compositor\/vita-compositor-selftest\.sh$/mu);
  assert.match(unitText, /^TimeoutStartSec=60s$/mu);
  assert.match(unitText, /^StandardOutput=journal\+console$/mu);
  assert.match(unitText, /^StandardError=journal\+console$/mu);
  assert.match(unitText, /^NoNewPrivileges=yes$/mu);
  assert.match(unitText, /^CapabilityBoundingSet=CAP_SYS_TTY_CONFIG$/mu);
  assert.match(unitText, /^AmbientCapabilities=$/mu);
  assert.match(unitText, /^DevicePolicy=closed$/mu);
  assert.match(unitText, /^DeviceAllow=char-drm rw$/mu);
  assert.match(unitText, /^DeviceAllow=char-input r$/mu);
  assert.match(unitText, /^DeviceAllow=\/dev\/tty0 rw$/mu);
  assert.match(unitText, /^WantedBy=multi-user\.target$/mu);
});

test("smoke overlay enables VMware Tools for authenticated screenshot artifact copy", async () => {
  const wantsTarget = await readText(openVmToolsWantsUrl);

  assert.equal(wantsTarget.trimEnd(), "../open-vm-tools.service");
});

test("smoke overlay prevents tty1 getty from drawing over compositor scanout", async () => {
  const buildAndBoot = await readText(buildAndBootUrl);
  const tty1Unit = await readText(tty1GettyMaskUrl);

  assertContains(buildAndBoot, "systemd.mask=getty@tty1.service");
  assertContains(tty1Unit, "Vita SMOKE VM only - keep tty1 free for compositor KMS ownership.");
  assert.match(tty1Unit, /^ConditionPathExists=\/run\/vita-enable-tty1-getty$/mu);
  assert.match(tty1Unit, /^Type=oneshot$/mu);
  assert.match(tty1Unit, /^ExecStart=\/bin\/true$/mu);
});

test("self-test wrapper emits VITA-COMPOSITOR FAILSAFE instead of failing or hanging boot", async () => {
  const wrapper = await readText(wrapperUrl);

  assertContains(wrapper, "MARKER=VITA-COMPOSITOR");
  assertContains(wrapper, "BIN=/usr/lib/vita/compositor/vita-compositor");
  assertContains(wrapper, "TTY=/dev/ttyS0");
  assertContains(wrapper, "HOLD_SECONDS=30");
  assertContains(wrapper, "SCREENSHOT=/run/vita-compositor-demo.png");
  assertContains(wrapper, 'status=FAILSAFE reason=$1"');
  assertContains(wrapper, 'emit_failsafe "binary_missing"');
  assertContains(wrapper, 'emit_failsafe "dri_card0_absent"');
  assertContains(wrapper, 'rm -f "$SCREENSHOT"');
  assertContains(
    wrapper,
    'timeout 45s "$BIN" --demo --screenshot "$SCREENSHOT" --hold-seconds "$HOLD_SECONDS"',
  );
  assertContains(wrapper, 'grep -q "^$MARKER: .* status=OK " "$TMP"');
  assertContains(wrapper, '[ -s "$SCREENSHOT" ]');
  assertContains(wrapper, 'grep -q "^$MARKER:" "$TMP"');
  assertContains(wrapper, 'emit_failsafe "timeout"');
  assertContains(wrapper, 'emit_failsafe "screenshot_missing"');
  assertContains(wrapper, 'emit_failsafe "exit_$rc"');
  assertContains(wrapper, 'exit 0');
});

async function readText(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

function assertContains(text: string, needle: string): void {
  assert.ok(text.includes(needle), `expected text to include ${needle}`);
}

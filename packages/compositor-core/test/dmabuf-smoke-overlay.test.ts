import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const overlayRoot = new URL("../smoke-overlay/", import.meta.url);
const unitUrl = new URL(
  "usr/lib/systemd/system/vita-compositor-dmabuf-selftest.service",
  overlayRoot,
);
const wantsUrl = new URL(
  "usr/lib/systemd/system/multi-user.target.wants/vita-compositor-dmabuf-selftest.service",
  overlayRoot,
);
const wrapperUrl = new URL(
  "usr/lib/vita/compositor/vita-compositor-dmabuf-selftest.sh",
  overlayRoot,
);

test("DMABUF smoke overlay runs compositor self-test after card0 and emits marker", async () => {
  const unit = await readFile(unitUrl, "utf8");
  const wants = await readFile(wantsUrl, "utf8");
  const wrapper = await readFile(wrapperUrl, "utf8");

  assert.equal(wants.trimEnd(), "../vita-compositor-dmabuf-selftest.service");
  assert.match(unit, /^After=.*dev-dri-card0\.device/mu);
  assert.match(unit, /^Wants=.*dev-dri-card0\.device/mu);
  assert.match(
    unit,
    /^ExecStart=\/bin\/bash \/usr\/lib\/vita\/compositor\/vita-compositor-dmabuf-selftest\.sh$/mu,
  );
  assert.match(unit, /^StandardOutput=journal\+console$/mu);
  assert.match(unit, /^DeviceAllow=char-drm rw$/mu);

  assert.match(wrapper, /^MARKER=VITA-DMABUF$/mu);
  assert.match(wrapper, /\[ ! -e \/dev\/dri\/card0 \]/u);
  assert.match(wrapper, /"\$BIN" --dmabuf-self-test/u);
  assert.match(wrapper, /status=FAILSAFE reason=\$1/u);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  HostBridgeJson,
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  SETTINGS_APPEARANCE_KEYS,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import type {
  DesktopHost,
} from "../../src/desktop-sdk/index.ts";

test("readSetting rejects defined JSON that does not match the declared setting key", async () => {
  const { readSetting } = readSettingPortFor("not-a-real-theme");

  const result = await readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "HOST_BRIDGE_MALFORMED_RESPONSE");
    assert.equal(result.error.path, "/readSetting/value");
  }
});

test("readSetting returns the valid backend setting value unchanged", async () => {
  const backendTheme = "graphite";
  const { readSetting, requests } = readSettingPortFor(backendTheme);

  const result = await readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
  }));

  assert.deepEqual(result, {
    ok: true,
    value: backendTheme,
  });
  assert.deepEqual(requests, [
    {
      args: [
        {
          key: SETTINGS_APPEARANCE_KEYS.theme,
        },
      ],
      method: "readSetting",
    },
  ]);
});

test("readSetting rejects an unknown setting key instead of passing through a backend value", async () => {
  const { readSetting } = readSettingPortFor("light");

  const result = await readSetting(Object.freeze({
    key: "settings.unknown",
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "HOST_BRIDGE_MALFORMED_RESPONSE");
    assert.equal(result.error.path, "/readSetting/value");
  }
});

function readSettingPortFor(responseValue: HostBridgeJson): {
  readonly readSetting: NonNullable<DesktopHost["readSetting"]>;
  readonly requests: readonly SurfaceHostRequest[];
} {
  const requests: SurfaceHostRequest[] = [];
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);

      return hostAccept(responseValue);
    },
  } satisfies SurfaceHostTransport);
  const readSetting = host.readSetting;

  if (readSetting === undefined) {
    throw new Error("readSetting port was not installed for the fake transport.");
  }

  return Object.freeze({
    readSetting,
    requests,
  });
}

function hostAccept(value: HostBridgeJson): HostBridgeJson {
  return Object.freeze({
    ok: true,
    value,
  });
}

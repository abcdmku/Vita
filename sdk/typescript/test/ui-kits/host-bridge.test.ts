import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  DesktopAppLaunch,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopTheme,
  ShellComponentDefinition,
} from "../../src/desktop-sdk/index.ts";

test("createSurfaceHost forwards a JSON host call and returns the transport result", async () => {
  const requests: SurfaceHostRequest[] = [];
  const app = launchableApp("vita.app.files");
  const launch = launchResult(app);
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);

      assert.equal(request.method, "launchApp");
      return {
        ok: true,
        value: launch,
      };
    },
  } satisfies SurfaceHostTransport);

  const result = await host.launchApp(app);

  assert.deepEqual(result, {
    ok: true,
    value: launch,
  });
  assert.deepEqual(requests, [
    {
      args: [app],
      method: "launchApp",
    },
  ]);
  assert.notEqual(requests[0]?.args[0], app);
});

test("createSurfaceHost rejects function-bearing host calls before transport", () => {
  const requests: SurfaceHostRequest[] = [];
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);
      return {
        ok: true,
        value: {
          id: "desktop",
        },
      };
    },
  } satisfies SurfaceHostTransport);

  const result = host.registerComponent({
    defaultPlacement: {
      layer: "desktop",
      order: 0,
      zone: "root",
    },
    id: "desktop",
    render() {
      return null;
    },
    role: "desktop",
  } satisfies ShellComponentDefinition);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "HOST_BRIDGE_NON_JSON");
    assert.equal(result.error.path, "/registerComponent/args/0/render");
  }
  assert.deepEqual(requests, []);
});

test("createSurfaceHost rejects cyclic and DOM-like inputs fail-closed", async () => {
  const requests: SurfaceHostRequest[] = [];
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);
      return {
        ok: true,
        value: launchResult(launchableApp("vita.app.never")),
      };
    },
  } satisfies SurfaceHostTransport);
  const cyclic = cyclicLaunchableApp();
  const domLike = domLaunchableApp();

  const cyclicResult = await callLaunchApp(host, cyclic);
  const domResult = await callLaunchApp(host, domLike);

  assert.equal(cyclicResult.ok, false);
  assert.equal(domResult.ok, false);
  assert.deepEqual(requests, []);
});

test("createSurfaceHost degrades without transport and omits optional ports", async () => {
  const host = createSurfaceHost(undefined);
  const launch = await host.launchApp(launchableApp("vita.app.files"));
  const registered = host.registerComponent({
    defaultPlacement: {},
    id: "desktop",
    render() {
      return null;
    },
    role: "desktop",
  });
  const theme = host.readTheme();

  assert.equal(launch.ok, false);
  assert.equal(registered.ok, false);
  assert.equal(host.requestFile, undefined);
  assert.equal(host.readSetting, undefined);
  assert.equal(host.previewSetting, undefined);
  assert.equal(host.applySetting, undefined);
  assert.equal(host.emitLauncherIntent, undefined);
  assert.equal(host.currentShell, undefined);
  assert.equal(theme.id, "vita.host-bridge.degraded");
});

test("createSurfaceHost fails closed when transport throws or returns non-JSON", async () => {
  const throwingHost = createSurfaceHost({
    request() {
      throw new Error("offline");
    },
  } satisfies SurfaceHostTransport);
  const malformedHost = createSurfaceHost({
    request() {
      return {
        ok: true,
        value: () => true,
      };
    },
  } satisfies SurfaceHostTransport);

  const thrown = await throwingHost.launchApp(launchableApp("vita.app.files"));
  const malformed = await malformedHost.launchApp(launchableApp("vita.app.files"));

  assert.equal(thrown.ok, false);
  assert.equal(malformed.ok, false);
  if (!thrown.ok) assert.equal(thrown.error.code, "HOST_BRIDGE_FAILED");
  if (!malformed.ok) assert.equal(malformed.error.code, "HOST_BRIDGE_NON_JSON");
});

test("createSurfaceHost reads a JSON theme through the synchronous bridge", () => {
  const theme = desktopTheme();
  const requests: SurfaceHostRequest[] = [];
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);
      return theme;
    },
  } satisfies SurfaceHostTransport);

  assert.deepEqual(host.readTheme(), theme);
  assert.deepEqual(requests, [
    {
      args: [],
      method: "readTheme",
    },
  ]);
});

async function callLaunchApp(host: DesktopHost, input: unknown): Promise<DesktopHostResult<DesktopAppLaunch>> {
  const launchApp = host.launchApp as (app: unknown) => ReturnType<DesktopHost["launchApp"]>;

  return await launchApp(input);
}

function launchableApp(id: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
      props: Object.freeze({
        source: "test",
      }),
    }),
    surfaceKind: "tsx",
    title: id,
  });
}

function launchResult(app: DesktopLaunchableApp): DesktopAppLaunch {
  return Object.freeze({
    app,
    intents: Object.freeze([]),
    surfaceId: `surface:${app.id}`,
    textureId: `texture:${app.id}`,
    windowId: `window:${app.id}`,
  });
}

function cyclicLaunchableApp(): unknown {
  const props: { self?: unknown } = {};

  props.self = props;

  return {
    id: "vita.app.cyclic",
    runtime: {
      componentId: "vita.app.cyclic",
      props,
    },
    surfaceKind: "tsx",
    title: "Cyclic",
  };
}

class FakeElement {
  readonly nodeType = 1;
}

function domLaunchableApp(): unknown {
  return {
    id: "vita.app.dom",
    runtime: {
      componentId: "vita.app.dom",
      props: {
        element: new FakeElement(),
      },
    },
    surfaceKind: "tsx",
    title: "DOM",
  };
}

function desktopTheme(): DesktopTheme {
  return Object.freeze({
    id: "vita.test.theme",
    tokens: Object.freeze({
      colors: Object.freeze({
        background: "#101418",
      }),
      radii: Object.freeze({
        sm: 4,
      }),
      spacing: Object.freeze({
        sm: 8,
      }),
      typography: Object.freeze({
        body: "system-ui",
      }),
    }),
    version: "1.0.0",
  });
}

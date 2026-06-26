import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeWindow,
  collectWindowManagerIntents,
  computeWindowManagerIntents,
  createDesktopAppsBackend,
  createWindowModel,
  isDesktopAppLaunch,
  isDesktopAppStop,
  openWindow,
} from "../../src/desktop-sdk/index.ts";
import type {
  AgentdHostClient,
  AgentdHostResult,
  DesktopAppCapsuleDescriptor,
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopUiPackageManifest,
  LayoutConstraints,
  WindowManagerIntent,
  WindowModel,
  WindowOpenRequest,
} from "../../src/desktop-sdk/index.ts";
import type {
  PlainJsonObject,
} from "../../src/safe-normalize.ts";

test("apps backend launches and stops capsules with window surface allocation", async () => {
  const capsule = capsuleDescriptor("vita.desktop.test.tsx");
  const layoutConstraints = testLayoutConstraints();
  const emissions = createEmissionLog();
  const agentd = createFakeAgentd((capability) => {
    if (capability === "capsule.execute" || capability === "capsule.lifecycle") {
      return agentdOk();
    }

    return agentdError("unexpected_capability", "unexpected capability");
  });
  const backend = createDesktopAppsBackend({
    agentd: agentd.client,
    capsuleDescriptors: Object.freeze({
      tsx: capsule,
    }),
    emitLaunch: emissions.emitLaunch,
    emitStop: emissions.emitStop,
    layoutConstraints,
    package: manifest(Object.freeze([
      grant("apps.launch"),
      grant("apps.stop"),
    ])),
  });
  const app = launchableApp("vita.app.notes");

  const launched = await backend.launchApp(app);
  const launch = assertHostSuccess(launched);

  assert.equal(isDesktopAppLaunch(launch), true);
  assert.equal(launch.app.id, app.id);
  assert.equal(typeof launch.surfaceId, "string");
  assert.equal(typeof launch.windowId, "string");
  assert.equal(typeof launch.textureId, "string");
  assert.deepEqual(launch.intents, expectedLaunchIntents(launch, app, layoutConstraints));
  assert.deepEqual(emissions.launches, [launch]);
  assert.equal(backend.snapshot().launched.length, 1);
  assert.deepEqual(agentd.calls, [
    {
      capability: "capsule.execute",
      request: {
        desired: {
          id: capsule.id,
          integrity: capsule.integrity,
          version: capsule.version,
        },
      },
    },
  ]);

  const stopped = await backend.stopApp(app.id);
  const stop = assertHostSuccess(stopped);

  assert.deepEqual(stop, {
    appId: app.id,
    intents: expectedStopIntents(launch, app, layoutConstraints),
    surfaceId: launch.surfaceId,
    textureId: launch.textureId,
    windowId: launch.windowId,
  });
  assert.deepEqual(emissions.stops, [stop]);
  assert.equal(backend.snapshot().launched.length, 0);
  assert.deepEqual(agentd.calls[1], {
    capability: "capsule.lifecycle",
    request: {
      desired: {
        id: capsule.id,
        op: "stop",
      },
    },
  });

  const secondStop = await backend.stopApp(app.id);
  const secondStopValue = assertHostSuccess(secondStop);

  assert.deepEqual(secondStopValue, {
    appId: app.id,
    intents: [],
  });
  assert.equal(agentd.calls.length, 2);
  assert.equal(emissions.stops.length, 1);
});

test("apps backend leaves no dangling surface when capsule execute rejects", async () => {
  const emissions = createEmissionLog();
  const agentd = createFakeAgentd(() => agentdError("capsule_execute_rejected", "execute rejected"));
  const backend = createDesktopAppsBackend({
    agentd: agentd.client,
    emitLaunch: emissions.emitLaunch,
    emitStop: emissions.emitStop,
    package: manifest(Object.freeze([
      grant("apps.launch"),
      grant("apps.stop"),
    ])),
  });

  const launched = await backend.launchApp(launchableApp("vita.app.rejected"));

  assertHostFailure(launched, "APP_CAPSULE_EXECUTE_FAILED");
  assert.equal(agentd.calls.length, 1);
  assert.equal(agentd.calls[0]?.capability, "capsule.execute");
  assert.deepEqual(backend.snapshot().launched, []);
  assert.deepEqual(emissions.launches, []);
  assert.deepEqual(emissions.stops, []);
});

test("apps backend resolves web apps to the web capsule descriptor", async () => {
  const webCapsule = capsuleDescriptor("vita.desktop.test.web");
  const agentd = createFakeAgentd(() => agentdOk());
  const backend = createDesktopAppsBackend({
    agentd: agentd.client,
    capsuleDescriptors: Object.freeze({
      web: webCapsule,
    }),
    package: manifest(Object.freeze([
      grant("apps.launch"),
      grant("apps.stop"),
    ])),
  });

  const launched = assertHostSuccess(await backend.launchApp(webApp("vita.app.browser")));

  assert.equal(isDesktopAppLaunch(launched), true);
  assert.deepEqual(agentd.calls, [
    {
      capability: "capsule.execute",
      request: {
        desired: {
          id: webCapsule.id,
          integrity: webCapsule.integrity,
          version: webCapsule.version,
        },
      },
    },
  ]);
});

test("apps backend grant gates launch and stop before contacting capsules", async () => {
  const agentd = createFakeAgentd(() => agentdOk());
  const launchDenied = createDesktopAppsBackend({
    agentd: agentd.client,
    package: manifest(Object.freeze([
      grant("apps.stop"),
    ])),
  });

  assertHostFailure(await launchDenied.launchApp(launchableApp("vita.app.denied")), "APP_LAUNCH_CAPABILITY_DENIED");
  assert.equal(agentd.calls.length, 0);
  assert.deepEqual(launchDenied.snapshot().launched, []);

  const stopDenied = createDesktopAppsBackend({
    agentd: agentd.client,
    package: manifest(Object.freeze([
      grant("apps.launch"),
    ])),
  });
  const launched = await stopDenied.launchApp(launchableApp("vita.app.stop-denied"));

  assert.equal(launched.ok, true);
  assert.equal(agentd.calls.length, 1);
  assertHostFailure(await stopDenied.stopApp("vita.app.stop-denied"), "APP_STOP_CAPABILITY_DENIED");
  assert.equal(agentd.calls.length, 1);
  assert.equal(stopDenied.snapshot().launched.length, 1);
});

test("apps backend fails closed when the agentd transport is absent", async () => {
  const backend = createDesktopAppsBackend({
    package: manifest(Object.freeze([
      grant("apps.launch"),
      grant("apps.stop"),
    ])),
  });

  assertHostFailure(await backend.launchApp(launchableApp("vita.app.no-transport")), "APP_AGENTD_UNAVAILABLE");
  assertHostFailure(await backend.stopApp("vita.app.no-transport"), "APP_AGENTD_UNAVAILABLE");
  assert.deepEqual(backend.snapshot().launched, []);
});

test("desktop app guards reject malformed window manager intents", () => {
  const app = launchableApp("vita.app.guard");
  const validLaunch = Object.freeze({
    app,
    intents: Object.freeze([
      Object.freeze({
        rect: Object.freeze({
          height: 240,
          width: 320,
          x: 12,
          y: 16,
        }),
        textureId: "texture:vita.app:guard",
        type: "repositionTexture",
        windowId: "window:vita.app:guard",
      }) satisfies WindowManagerIntent,
      Object.freeze({
        type: "setFocus",
        windowId: "window:vita.app:guard",
      }) satisfies WindowManagerIntent,
      Object.freeze({
        textureId: "texture:vita.app:guard",
        type: "setTextureVisibility",
        visible: true,
        windowId: "window:vita.app:guard",
      }) satisfies WindowManagerIntent,
    ]),
    surfaceId: "surface:vita.app:guard",
    textureId: "texture:vita.app:guard",
    windowId: "window:vita.app:guard",
  }) satisfies DesktopAppLaunch;
  const validStop = Object.freeze({
    appId: app.id,
    intents: Object.freeze([
      Object.freeze({
        type: "setFocus",
        windowId: null,
      }) satisfies WindowManagerIntent,
    ]),
    surfaceId: validLaunch.surfaceId,
    textureId: validLaunch.textureId,
    windowId: validLaunch.windowId,
  }) satisfies DesktopAppStop;

  assert.equal(isDesktopAppLaunch(validLaunch), true);
  assert.equal(isDesktopAppStop(validStop), true);
  assert.equal(isDesktopAppLaunch({
    ...validLaunch,
    intents: Object.freeze([
      Object.freeze({
        type: "filesystem.delete",
      }),
    ]),
  }), false);
  assert.equal(isDesktopAppLaunch({
    ...validLaunch,
    intents: Object.freeze([
      Object.freeze({
        type: "repositionTexture",
      }),
    ]),
  }), false);
  assert.equal(isDesktopAppLaunch({
    ...validLaunch,
    intents: Object.freeze([
      Object.freeze({
        rect: Object.freeze({
          height: 240,
          width: 320,
          x: 12,
          y: 16,
        }),
        textureId: validLaunch.textureId,
        type: "repositionTexture",
        windowId: validLaunch.windowId,
        workspaceId: "workspace-1",
      }),
    ]),
  }), false);
  assert.equal(isDesktopAppStop({
    ...validStop,
    intents: Object.freeze([
      Object.freeze({
        textureId: validStop.textureId,
        type: "setTextureVisibility",
        visible: true,
        windowId: validStop.windowId,
        workspaceId: "workspace-1",
      }),
    ]),
  }), false);
  assert.equal(isDesktopAppStop({
    ...validStop,
    intents: Object.freeze([
      Object.freeze({
        rect: Object.freeze({
          height: 240,
          width: 320,
          x: 12,
          y: 16,
          z: 0,
        }),
        textureId: validStop.textureId,
        type: "repositionTexture",
        windowId: validStop.windowId,
      }),
    ]),
  }), false);
});

interface AgentdCall {
  readonly capability: string;
  readonly request: PlainJsonObject | undefined;
}

interface FakeAgentd {
  readonly calls: readonly AgentdCall[];
  readonly client: AgentdHostClient;
}

interface EmissionLog {
  readonly launches: readonly DesktopAppLaunch[];
  readonly stops: readonly DesktopAppStop[];
  readonly emitLaunch: (launch: DesktopAppLaunch) => void;
  readonly emitStop: (stop: DesktopAppStop) => void;
}

function createFakeAgentd(
  responder: (capability: string, request: PlainJsonObject | undefined) => AgentdHostResult | Promise<AgentdHostResult>,
): FakeAgentd {
  const calls: AgentdCall[] = [];
  const client = Object.freeze({
    async call(capability: string, request?: PlainJsonObject): Promise<AgentdHostResult> {
      calls.push(Object.freeze({
        capability,
        request,
      }));

      return await responder(capability, request);
    },
  }) satisfies AgentdHostClient;

  return Object.freeze({
    calls,
    client,
  });
}

function createEmissionLog(): EmissionLog {
  const launches: DesktopAppLaunch[] = [];
  const stops: DesktopAppStop[] = [];

  return Object.freeze({
    emitLaunch(launch: DesktopAppLaunch) {
      launches.push(launch);
    },
    emitStop(stop: DesktopAppStop) {
      stops.push(stop);
    },
    launches,
    stops,
  });
}

function expectedLaunchIntents(
  launch: DesktopAppLaunch,
  app: DesktopLaunchableApp,
  constraints: LayoutConstraints,
): readonly WindowManagerIntent[] {
  const previous = createWindowModel();
  const next = openWindow(previous, openRequest(launch, app));

  return computeWindowManagerIntents(previous, next, constraints);
}

function expectedStopIntents(
  launch: DesktopAppLaunch,
  app: DesktopLaunchableApp,
  constraints: LayoutConstraints,
): readonly WindowManagerIntent[] {
  const previous = openWindow(createWindowModel(), openRequest(launch, app));
  const next = closeWindow(previous, launch.windowId);

  return collectWindowManagerIntents(previous, next, constraints);
}

function openRequest(launch: DesktopAppLaunch, app: DesktopLaunchableApp): WindowOpenRequest {
  const request: {
    id: string;
    mode: "floating" | "tiled";
    rect: NonNullable<NonNullable<DesktopLaunchableApp["defaultWindow"]>["rect"]>;
    textureId: string;
    workspaceId?: string;
  } = {
    id: launch.windowId,
    mode: app.defaultWindow?.mode ?? "floating",
    rect: app.defaultWindow?.rect ?? {
      height: 480,
      width: 640,
      x: 0,
      y: 0,
    },
    textureId: launch.textureId,
  };

  if (app.defaultWindow?.workspaceId !== undefined) {
    request.workspaceId = app.defaultWindow.workspaceId;
  }

  return Object.freeze(request);
}

function testLayoutConstraints(): LayoutConstraints {
  return Object.freeze({
    bounds: Object.freeze({
      height: 720,
      width: 1024,
      x: 0,
      y: 0,
    }),
    gap: 8,
  });
}

function launchableApp(id: string): DesktopLaunchableApp {
  return Object.freeze({
    defaultWindow: Object.freeze({
      mode: "floating",
      rect: Object.freeze({
        height: 360,
        width: 520,
        x: 24,
        y: 32,
      }),
      workspaceId: "workspace-1",
    }),
    id,
    runtime: Object.freeze({
      componentId: id,
      props: Object.freeze({
        source: "apps-backend.test",
      }),
    }),
    surfaceKind: "tsx",
    title: id,
  });
}

function webApp(id: string): DesktopLaunchableApp {
  return Object.freeze({
    defaultWindow: Object.freeze({
      mode: "floating",
      rect: Object.freeze({
        height: 500,
        width: 700,
        x: 12,
        y: 18,
      }),
    }),
    id,
    runtime: Object.freeze({
      partition: `persist:${id}`,
      url: `apps/${id}/index.html`,
    }),
    surfaceKind: "web",
    title: id,
  });
}

function capsuleDescriptor(id: string): DesktopAppCapsuleDescriptor {
  return Object.freeze({
    id,
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    version: "1.0.0",
  });
}

function manifest(capabilityGrants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants,
    entry: "index.html",
    id: "vita.desktop.apps-backend.test",
    sdkVersion: "0.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapabilityGrant["capability"]): DesktopCapabilityGrant {
  return Object.freeze({
    capability,
  });
}

function agentdOk(): AgentdHostResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({}),
  });
}

function agentdError(code: string, message: string): AgentdHostResult {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
    }),
    ok: false,
  });
}

function assertHostSuccess<T>(result: DesktopHostResult<T>): T {
  if (!result.ok) assert.fail(result.error.message);

  return result.value;
}

function assertHostFailure<T>(result: DesktopHostResult<T>, code: DesktopHostError["code"]): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected host result to fail closed");
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, "string");
  assert.equal(typeof result.error.path, "string");
}

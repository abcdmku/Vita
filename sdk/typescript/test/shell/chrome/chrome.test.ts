import assert from "node:assert/strict";
import { test } from "node:test";

import { composeShellLayout } from "../../../src/shell/index.ts";
import type {
  ShellCompositionPorts,
  ShellSurfaceCreateRequest,
  ShellWindowManagerPlacementRequest,
} from "../../../src/shell/index.ts";
import {
  CHROME_LAUNCHER_COMPONENT_ID,
  CHROME_NOTIFICATIONS_COMPONENT_ID,
  CHROME_PANEL_COMPONENT_ID,
  chromeShellConfig,
  createChromeNotificationState,
  createChromeShellRegistry,
  filterLauncherApps,
  focusChromeWindow,
  launchChromeApp,
  reduceChromeNotifications,
} from "../../../src/shell/chrome/index.ts";
import type {
  ChromeLauncherApp,
  ChromeNotificationState,
  ChromeShellIntent,
} from "../../../src/shell/chrome/index.ts";

const APPS = Object.freeze([
  Object.freeze({
    id: "mail",
    keywords: Object.freeze(["email", "inbox"]),
    name: "Mail",
    subtitle: "Owner inbox",
  }),
  Object.freeze({
    id: "calendar",
    keywords: Object.freeze(["events", "schedule"]),
    name: "Calendar",
  }),
  Object.freeze({
    id: "terminal",
    keywords: Object.freeze(["shell", "system"]),
    name: "Terminal",
  }),
]) satisfies readonly ChromeLauncherApp[];

test("chrome shell components register and compose deterministically through WM placement", () => {
  const registryResult = createChromeShellRegistry();

  assert.equal(registryResult.ok, true);
  if (!registryResult.ok) {
    assert.fail("expected chrome registry creation to succeed");
  }

  const registry = registryResult.value;
  const registeredIds = registry.list().map((component) => component.id);

  assert.deepEqual(registeredIds, [
    CHROME_LAUNCHER_COMPONENT_ID,
    CHROME_NOTIFICATIONS_COMPONENT_ID,
    CHROME_PANEL_COMPONENT_ID,
  ]);

  const notifications = notificationsWithCritical();
  const surfaceCalls: ShellSurfaceCreateRequest[] = [];
  const wmCalls: ShellWindowManagerPlacementRequest[] = [];
  const ports = fakePorts(surfaceCalls, wmCalls);
  const config = chromeShellConfig({
    launcher: {
      apps: APPS,
      query: "mail",
      selectedAppId: "mail",
    },
    notifications,
    panel: {
      clockLabel: "10:15",
      edge: "top",
      focusedWindow: {
        id: "window-mail",
        title: "Mail - Owner inbox",
      },
      notificationCount: notifications.notifications.length,
      trayItems: [
        {
          id: "network",
          label: "Online",
          status: "ok",
        },
        {
          id: "battery",
          label: "42%",
          status: "warning",
        },
      ],
    },
  }, {
    revision: "rev-chrome",
  });

  const first = composeShellLayout(registry, config, ports);
  const second = composeShellLayout(registry, config, ports);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    assert.fail("expected deterministic chrome composition to succeed");
  }

  assert.deepEqual(second.value, first.value);
  assert.equal(first.value.configId, "vita.shell.chrome");
  assert.equal(first.value.revision, "rev-chrome");
  assert.match(first.value.css.text, /\.vita-chrome-panel\{align-items:center;display:flex;gap:12px\}/u);
  assert.deepEqual(first.value.surfaces.map((surface) => surface.id).sort(), [
    "surface:vita.shell.chrome.launcher:0.0-launcher",
    "surface:vita.shell.chrome.notifications:0.1-notifications",
    "surface:vita.shell.chrome.panel:0",
  ]);
  assert.equal(first.value.root.componentId, CHROME_PANEL_COMPONENT_ID);
  assert.equal(first.value.root.placement.zone, "top");
  assert.deepEqual(first.value.root.placement.rect, {
    height: 36,
    width: 1440,
    x: 0,
    y: 0,
  });
  assert.equal(first.value.root.payload["clock"], "10:15");
  assert.deepEqual(first.value.root.payload["focusedWindow"], {
    id: "window-mail",
    title: "Mail - Owner inbox",
  });
  assert.deepEqual(first.value.root.payload["focusIntent"], {
    type: "setFocus",
    windowId: "window-mail",
  });
  assert.equal(first.value.root.children[0]?.componentId, CHROME_LAUNCHER_COMPONENT_ID);
  assert.deepEqual(first.value.root.children[0]?.payload["launchIntent"], {
    appId: "mail",
    type: "launchApp",
  });
  assert.deepEqual(first.value.root.children[0]?.payload["results"], [
    {
      id: "mail",
      keywords: ["email", "inbox"],
      name: "Mail",
      subtitle: "Owner inbox",
    },
  ]);
  assert.equal(first.value.root.children[1]?.componentId, CHROME_NOTIFICATIONS_COMPONENT_ID);
  assert.equal(first.value.root.children[1]?.payload["count"], 2);
  assert.equal(first.value.root.children[1]?.payload["criticalCount"], 1);
  assert.equal(surfaceCalls.length, 6);
  assert.equal(wmCalls.length, 6);
});

test("launcher filtering is injected-data-only and emits launch intents without executing apps", () => {
  assert.deepEqual(filterLauncherApps(APPS, "MAIL").map((app) => app.id), ["mail"]);
  assert.deepEqual(filterLauncherApps(APPS, "shell").map((app) => app.id), ["terminal"]);
  assert.deepEqual(filterLauncherApps(APPS, "missing").map((app) => app.id), []);

  const intents: ChromeShellIntent[] = [];
  const launched = launchChromeApp(intentPort(intents), APPS, "terminal");
  const missing = launchChromeApp(intentPort(intents), APPS, "missing");

  assert.deepEqual(launched, {
    appId: "terminal",
    type: "launchApp",
  });
  assert.equal(missing, null);
  assert.deepEqual(intents, [
    {
      appId: "terminal",
      type: "launchApp",
    },
  ]);
});

test("panel focus action emits the PSD-004 setFocus intent shape", () => {
  const intents: ChromeShellIntent[] = [];
  const focused = focusChromeWindow(intentPort(intents), "window-calendar");
  const cleared = focusChromeWindow(intentPort(intents), null);

  assert.deepEqual(focused, {
    type: "setFocus",
    windowId: "window-calendar",
  });
  assert.deepEqual(cleared, {
    type: "setFocus",
    windowId: null,
  });
  assert.deepEqual(intents, [focused, cleared]);
});

test("notification reducer adds, dismisses, and expires by injected clock", () => {
  let state = createChromeNotificationState();

  state = reduceChromeNotifications(state, {
    notification: {
      body: "One-time update",
      id: "sync",
      title: "Sync complete",
      ttlMs: 500,
    },
    type: "add",
  }, {
    nowMs: 1_000,
  });
  state = reduceChromeNotifications(state, {
    notification: {
      id: "battery",
      severity: "critical",
      title: "Battery low",
    },
    type: "add",
  }, {
    nowMs: 1_100,
  });

  assert.deepEqual(state.notifications.map((notification) => notification.id), ["battery", "sync"]);
  assert.equal(state.notifications.find((notification) => notification.id === "sync")?.expiresAtMs, 1_500);

  const beforeExpiry = reduceChromeNotifications(state, {
    type: "expire",
  }, {
    nowMs: 1_499,
  });

  assert.deepEqual(beforeExpiry.notifications.map((notification) => notification.id), ["battery", "sync"]);

  const afterExpiry = reduceChromeNotifications(beforeExpiry, {
    type: "expire",
  }, {
    nowMs: 1_500,
  });

  assert.deepEqual(afterExpiry.notifications.map((notification) => notification.id), ["battery"]);

  const dismissed = reduceChromeNotifications(afterExpiry, {
    notificationId: "battery",
    type: "dismiss",
  }, {
    nowMs: 1_600,
  });

  assert.deepEqual(dismissed.notifications, []);
});

function notificationsWithCritical(): ChromeNotificationState {
  let state = createChromeNotificationState();

  state = reduceChromeNotifications(state, {
    notification: {
      id: "sync",
      severity: "success",
      title: "Sync complete",
    },
    type: "add",
  }, {
    nowMs: 2_000,
  });

  return reduceChromeNotifications(state, {
    notification: {
      id: "battery",
      severity: "critical",
      title: "Battery low",
    },
    type: "add",
  }, {
    nowMs: 2_100,
  });
}

function fakePorts(
  surfaceCalls: ShellSurfaceCreateRequest[],
  wmCalls: ShellWindowManagerPlacementRequest[],
): ShellCompositionPorts {
  return {
    substrate: {
      createSurface(request) {
        surfaceCalls.push(request);
        return {
          kind: "fake-substrate",
          surfaceId: request.surfaceId,
        };
      },
      removeSurface() {
        return {
          removed: true,
        };
      },
    },
    wm: {
      placeSurface(request) {
        wmCalls.push(request);
        if (request.requestedPlacement.zone === "top") {
          return {
            ...request.requestedPlacement,
            rect: {
              height: 36,
              width: 1440,
              x: 0,
              y: 0,
            },
          };
        }

        return request.requestedPlacement;
      },
    },
  };
}

function intentPort(intents: ChromeShellIntent[]) {
  return {
    emitIntent(intent: ChromeShellIntent): void {
      intents.push(intent);
    },
  };
}

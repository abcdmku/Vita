// preview-entry — the browser entry for the desktop spike preview (desktop.html).
//
// Mounts the REAL window manager + the web-app window host into the page, then opens the spike Puter
// app in a managed Vita window. The vendored puter.js inside the iframe points fs/kv/auth at the local
// api_origin (served by serve-spike.ts at /api) and posts ui messages to THIS page (the broker).
//
// This is deno-bundled to spike-preview.js (build-preview.mjs) — the same offline-bundle toolchain the
// desktop runtime uses. No remote imports. The page also installs a tiny on-screen broker dialog for
// ui.alert so the owner SEES the control plane working.

import { createWindowManager } from "../../window-manager.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { createUiBroker } from "../ui-broker.ts";
import type { BrokerNotificationInput, BrokerSinks } from "../ui-broker.ts";
import { createWebAppWindowHost, setWebAppWindowTitle } from "../web-app-window.ts";
import type { WmDocument } from "../../window-manager.ts";

interface PreviewGlobals {
  document: unknown;
  location: { origin: string };
  __VITA_SPIKE__?: unknown;
}

export function bootSpikePreview(): void {
  const g = globalThis as unknown as PreviewGlobals;
  const doc = g.document as WmDocument & { getElementById(id: string): HtmlLike | null };
  const origin = g.location.origin;
  const apiOrigin = `${origin}/api`;

  // The window the broker listens on (the real browser window).
  const win = globalThis as unknown as import("../ui-broker.ts").BrokerWindow;

  const wm = createWindowManager(doc);
  const capabilities = createCapabilityRegistry();

  // Map an instance id back to its WM appId so setWindowTitle / notifications target the right window.
  const instanceToAppId = new Map<string, string>();

  const sinks: BrokerSinks = {
    async alert(instanceId, message): Promise<string> {
      showBrokerToast(doc, `alert: ${message}`);
      return "OK";
    },
    createWindow(): string {
      return "preview-child";
    },
    launchApp(_instanceId, appName): void {
      showBrokerToast(doc, `launchApp: ${appName}`);
    },
    async prompt(): Promise<string | null> {
      return null;
    },
    setWindowTitle(instanceId, title): void {
      setWebAppWindowTitle(wm, instanceToAppId.get(instanceId), title);
      showBrokerToast(doc, `setWindowTitle: ${title}`);
    },
    showNotification(_instanceId, input: BrokerNotificationInput): void {
      showBrokerToast(doc, `notification: ${input.title ? input.title + " — " : ""}${input.message}`);
    },
  };

  const broker = createUiBroker({ capabilities, sinks, window: win });

  broker.start();

  const host = createWebAppWindowHost({
    apiOrigin,
    broker,
    capabilities,
    doc,
    guiOrigin: origin,
    wm,
  });

  // Surface the summary the spike app posts back, so the owner sees PASS/FAIL on the page.
  win.addEventListener("message", (event) => {
    const data = (event as { data?: unknown }).data;

    if (data !== null && typeof data === "object" && (data as { type?: string }).type === "vita-spike-summary") {
      const summary = data as { passed: number; total: number };

      showBrokerToast(doc, `spike: ${summary.passed}/${summary.total} checks passed`);
    }
  });

  // The api_origin runs in a SEPARATE process (serve-spike.ts) with its OWN registry, so the iframe
  // must authenticate with the token THAT server pre-minted. desktop.html injects it as a global; the
  // host pre-mints the same token+instance into THIS registry so the ui broker also recognizes the app.
  const injected = (globalThis as unknown as { __VITA_SPIKE_SESSION__?: { token?: string; appInstanceId?: string } }).__VITA_SPIKE_SESSION__;

  const launchButton = doc.getElementById("launch-spike");
  const launch = (): void => {
    const handle = host.open({
      appId: "spike.puter.testapp",
      appUrl: "/spike/app/index.html",
      icon: "🧪",
      title: "Puter Spike",
      ...(injected?.token === undefined ? {} : { token: injected.token }),
      ...(injected?.appInstanceId === undefined ? {} : { appInstanceId: injected.appInstanceId }),
    });

    instanceToAppId.set(handle.appInstanceId, handle.appId);
    showBrokerToast(doc, `launched ${handle.appId} (instance ${handle.appInstanceId.slice(0, 8)}…)`);
  };

  launchButton?.addEventListener("click", launch as never);
  // Auto-launch on boot so the preview is immediately live.
  launch();
}

// A tiny structural HTMLElement surface for the toast (avoids the DOM lib, house style).
interface HtmlLike {
  innerHTML: string;
  textContent: string | null;
  style: { setProperty(name: string, value: string): void; cssText: string };
  appendChild(child: HtmlLike): HtmlLike;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  setAttribute(name: string, value: string): void;
}

function showBrokerToast(doc: { getElementById(id: string): HtmlLike | null; createElement(tag: string): HtmlLike }, text: string): void {
  const log = doc.getElementById("broker-log");

  if (log === null) return;

  const row = doc.createElement("div");

  row.textContent = `▸ ${text}`;
  row.style.cssText = "padding:3px 0;color:#c7cad3;font:12px ui-monospace,monospace";
  log.appendChild(row);
}

// Boot when the bundle loads.
bootSpikePreview();

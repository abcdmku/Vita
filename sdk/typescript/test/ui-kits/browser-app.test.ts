import assert from "node:assert/strict";
import { test } from "node:test";

import browserAppPackage, {
  BROWSER_APP_ENTRY,
  BROWSER_APP_ID,
  BROWSER_APP_PARTITION,
} from "../../../../apps/browser/manifest.ts";
import {
  BROWSER_BLOCKED_OFFLINE_MESSAGE,
  createBrowserAppViewModel,
  createBrowserLocalContentResolver,
} from "../../../../ui_kits/desktop/viewmodels/apps/browser-app.ts";
import type {
  BrowserLocalContentResolverPort,
  BrowserPage,
} from "../../../../ui_kits/desktop/viewmodels/apps/browser-app.ts";
import {
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";

test("browser app manifest is a valid offline first-party web app package", () => {
  const app = defineAppPackage(browserAppPackage);

  assert.equal(app.manifest.id, BROWSER_APP_ID);
  assert.equal(app.manifest.entry, BROWSER_APP_ENTRY);
  assert.equal(app.descriptor.id, BROWSER_APP_ID);
  assert.equal(app.descriptor.title, "Browser");
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, BROWSER_APP_PARTITION);
  assert.equal(app.manifest.capabilityGrants.length, 0);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read"), false);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.read"), false);
  assert.equal(JSON.stringify(app.manifest.capabilityGrants).includes("network"), false);
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants), true);
});

test("browser view-model loads allow-listed local content and maintains history", () => {
  const vm = createBrowserAppViewModel({
    resolver: createBrowserLocalContentResolver(pages()),
  });

  const initial = vm.snapshot();

  assert.equal(Object.isFrozen(initial), true);
  assert.equal(initial.currentUrl, null);
  assert.equal(initial.status, "idle");
  assert.equal(initial.loading, false);
  assert.equal(initial.blocked, null);

  const start = vm.navigate("vita://browser/start");

  assert.equal(start.ok, true);
  assert.equal(start.state.currentUrl, "vita://browser/start");
  assert.equal(start.state.pageTitle, "Start");
  assert.equal(start.state.pageContent, "Deterministic start page.");
  assert.equal(start.state.status, "loaded");
  assert.equal(start.state.loading, false);
  assert.equal(start.state.blocked, null);
  assert.deepEqual(urls(start.state.backStack), []);
  assert.deepEqual(urls(start.state.forwardStack), []);

  const help = vm.navigate("local://browser/help");

  assert.equal(help.ok, true);
  assert.equal(help.state.currentUrl, "local://browser/help");
  assert.equal(help.state.pageTitle, "Help");
  assert.deepEqual(urls(help.state.backStack), ["vita://browser/start"]);
  assert.deepEqual(urls(help.state.forwardStack), []);
  assert.equal(help.state.canGoBack, true);
  assert.equal(help.state.canGoForward, false);
});

test("browser back, forward, and reload move the history cursor deterministically", () => {
  const vm = createBrowserAppViewModel({
    resolver: createBrowserLocalContentResolver(pages()),
  });

  assert.equal(vm.navigate("vita://browser/start").ok, true);
  assert.equal(vm.navigate("local://browser/help").ok, true);

  const back = vm.back();

  assert.equal(back.ok, true);
  assert.equal(back.state.currentUrl, "vita://browser/start");
  assert.deepEqual(urls(back.state.backStack), []);
  assert.deepEqual(urls(back.state.forwardStack), ["local://browser/help"]);
  assert.equal(back.state.canGoForward, true);

  const forward = vm.forward();

  assert.equal(forward.ok, true);
  assert.equal(forward.state.currentUrl, "local://browser/help");
  assert.deepEqual(urls(forward.state.backStack), ["vita://browser/start"]);
  assert.deepEqual(urls(forward.state.forwardStack), []);

  const beforeReload = vm.snapshot();
  const reload = vm.reload();

  assert.equal(reload.ok, true);
  assert.equal(reload.state.currentUrl, "local://browser/help");
  assert.deepEqual(urls(reload.state.backStack), urls(beforeReload.backStack));
  assert.deepEqual(urls(reload.state.forwardStack), urls(beforeReload.forwardStack));
  assert.equal(reload.state.status, "loaded");
  assert.equal(reload.state.blocked, null);
});

test("browser blocks non-allow-listed local and http URLs fail-closed", () => {
  const vm = createBrowserAppViewModel({
    resolver: createBrowserLocalContentResolver(pages()),
  });

  assert.equal(vm.navigate("vita://browser/start").ok, true);
  const beforeMissing = vm.snapshot();
  const missing = vm.navigate("vita://browser/missing");

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected missing local page to be blocked");
  }
  assert.equal(missing.error.code, "BROWSER_URL_BLOCKED");
  assert.equal(missing.error.message, BROWSER_BLOCKED_OFFLINE_MESSAGE);
  assert.equal(missing.state.currentUrl, beforeMissing.currentUrl);
  assert.equal(missing.state.status, "blocked");
  assert.equal(missing.state.loading, false);
  assert.equal(missing.state.blocked?.url, "vita://browser/missing");

  const events: string[] = [];
  const remoteResolver: BrowserLocalContentResolverPort = {
    resolve(request) {
      events.push(request.url);
      assert.fail("remote URL must not reach the local resolver");
    },
  };
  const remoteVm = createBrowserAppViewModel({
    resolver: remoteResolver,
  });
  const blocked = remoteVm.navigate("https://example.test/");

  assert.equal(blocked.ok, false);
  if (blocked.ok) {
    assert.fail("expected remote URL to be blocked");
  }
  assert.equal(blocked.error.code, "BROWSER_URL_BLOCKED");
  assert.equal(blocked.error.message, BROWSER_BLOCKED_OFFLINE_MESSAGE);
  assert.equal(blocked.state.currentUrl, null);
  assert.equal(blocked.state.status, "blocked");
  assert.equal(blocked.state.blocked?.url, "https://example.test/");
  assert.deepEqual(events, []);
});

test("browser fails closed when resolver port is absent or throws", () => {
  const missingPort = createBrowserAppViewModel();
  const missingBefore = missingPort.snapshot();
  const missing = missingPort.navigate("vita://browser/start");

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected absent resolver to fail closed");
  }
  assert.equal(missing.error.code, "BROWSER_RESOLVER_UNAVAILABLE");
  assert.equal(missing.error.message, BROWSER_BLOCKED_OFFLINE_MESSAGE);
  assert.equal(missing.state.currentUrl, null);
  assert.equal(missing.state.status, "blocked");
  assert.equal(missingBefore.currentUrl, null);

  const throwing = createBrowserAppViewModel({
    resolver: {
      resolve() {
        throw new Error("resolver should fail closed");
      },
    },
  });
  const thrown = throwing.navigate("vita://browser/start");

  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail("expected throwing resolver to fail closed");
  }
  assert.equal(thrown.error.code, "BROWSER_RESOLVER_FAILED");
  assert.equal(thrown.error.message, BROWSER_BLOCKED_OFFLINE_MESSAGE);
  assert.equal(thrown.state.currentUrl, null);
  assert.equal(thrown.state.status, "blocked");
});

test("browser snapshots are frozen and stable across read-only access", () => {
  const vm = createBrowserAppViewModel({
    resolver: createBrowserLocalContentResolver(pages()),
  });

  assert.equal(vm.navigate("vita://browser/start").ok, true);

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.backStack), true);
  assert.equal(Object.isFrozen(first.forwardStack), true);
  assert.equal(Object.isFrozen(first.blocked ?? Object.freeze({})), true);

  const blocked = vm.navigate("http://example.test/");

  assert.equal(blocked.ok, false);
  assert.equal(Object.isFrozen(blocked.state), true);
  assert.equal(Object.isFrozen(blocked.state.blocked), true);
  assert.equal(Object.isFrozen(blocked.state.blocked?.error), true);
});

test("browser rejects hostile accessor inputs without invoking them", () => {
  let optionReads = 0;
  const hostileOptions: Record<string, unknown> = {};

  Object.defineProperty(hostileOptions, "resolver", {
    enumerable: true,
    get() {
      optionReads += 1;
      return createBrowserLocalContentResolver(pages());
    },
  });

  const missingResolver = createBrowserAppViewModel(hostileOptions).navigate("vita://browser/start");

  assert.equal(optionReads, 0);
  assert.equal(missingResolver.ok, false);
  if (missingResolver.ok) {
    assert.fail("expected accessor options to fail closed");
  }
  assert.equal(missingResolver.error.code, "BROWSER_RESOLVER_UNAVAILABLE");

  let resultReads = 0;
  const hostileResult: Record<string, unknown> = {
    value: Object.freeze({
      content: "should not be loaded",
      title: "Hostile",
    }),
  };

  Object.defineProperty(hostileResult, "ok", {
    enumerable: true,
    get() {
      resultReads += 1;
      return true;
    },
  });

  const hostileResolver = createBrowserAppViewModel({
    resolver: {
      resolve() {
        return hostileResult;
      },
    },
  });
  const rejectedResult = hostileResolver.navigate("vita://browser/start");

  assert.equal(resultReads, 0);
  assert.equal(rejectedResult.ok, false);
  if (rejectedResult.ok) {
    assert.fail("expected accessor resolver result to fail closed");
  }
  assert.equal(rejectedResult.error.code, "BROWSER_CONTENT_INVALID");
  assert.equal(rejectedResult.state.currentUrl, null);
});

function pages(): readonly BrowserPage[] {
  return Object.freeze([
    Object.freeze({
      content: "Deterministic start page.",
      title: "Start",
      url: "vita://browser/start",
    }),
    Object.freeze({
      content: "Deterministic help page.",
      title: "Help",
      url: "local://browser/help",
    }),
  ]);
}

function urls(pagesList: readonly BrowserPage[]): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < pagesList.length; index += 1) {
    const page = pagesList[index];

    if (page !== undefined) output.push(page.url);
  }

  return output;
}

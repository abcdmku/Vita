// control-plane tests — exercise the deploy/management console's bridge: the stub control plane's
// lifecycle state machine AND the api_origin's /control/* routing + capability gate.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-control-plane.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ApiOrigin,
  type ApiRequest,
  createApiOrigin,
} from "../../../../ui_kits/desktop/runtime/puter/api-origin.ts";
import {
  createCapabilityRegistry,
  type PuterCapability,
} from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { createMemoryStore } from "../../../../ui_kits/desktop/runtime/puter/store.ts";
import {
  type ConsoleAppView,
  type LifecycleResult,
  type NodeStatus,
  createStubControlPlane,
} from "../../../../ui_kits/desktop/runtime/puter/control-plane.ts";

const TOKEN = "console-token";
const NO_CONTROL_TOKEN = "no-control-token";

function setup(): { api: ApiOrigin } {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();
  const grantsAll: PuterCapability[] = ["control", "auth", "kv.read", "kv.write"];
  const grantsNoControl: PuterCapability[] = ["auth", "kv.read"];

  caps.mintAppSession({ appId: "vita.app.deploy-console", appInstanceId: "i1", grants: grantsAll, token: TOKEN });
  caps.mintAppSession({ appId: "other.app", appInstanceId: "i2", grants: grantsNoControl, token: NO_CONTROL_TOKEN });

  const controlPlane = createStubControlPlane({ now: () => 1_700_000_000_000 });

  return { api: createApiOrigin({ capabilities: caps, store, controlPlane }) };
}

function req(method: string, path: string, token?: string): ApiRequest {
  const headers: Record<string, string> = {};

  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;

  return { body: new Uint8Array(0), headers, method, path, query: {} };
}

function bodyOf<T>(res: { body: Uint8Array }): T {
  return JSON.parse(new TextDecoder().decode(res.body)) as T;
}

// ---- stub control plane (the model) ----

test("stub: seed exposes installed/running/disabled capsules", async () => {
  const cp = createStubControlPlane();
  const apps = await cp.listApps();

  assert.equal(apps.length, 3);
  assert.ok(apps.find((a) => a.id === "hello-web" && a.running && a.health === "OK"));
  assert.ok(apps.find((a) => a.id === "metrics-collector" && !a.running && a.installState === "installed"));
  assert.ok(apps.find((a) => a.id === "edge-cache" && a.installState === "disabled"));
});

test("stub: start an installed-stopped capsule mints a unit + uid and flips running/health", async () => {
  const cp = createStubControlPlane();
  const r = await cp.start("metrics-collector");

  assert.equal(r.outcome, "committed");
  assert.equal(r.app.running, true);
  assert.equal(r.app.health, "OK");
  assert.notEqual(r.app.unit, "");
  assert.notEqual(r.app.dynamicUid, "");
});

test("stub: stop a running capsule tears down the unit", async () => {
  const cp = createStubControlPlane();
  const r = await cp.stop("hello-web");

  assert.equal(r.outcome, "committed");
  assert.equal(r.app.running, false);
  assert.equal(r.app.unit, "");
});

test("stub: starting a disabled capsule is rejected with a reason", async () => {
  const cp = createStubControlPlane();
  const r = await cp.start("edge-cache");

  assert.equal(r.outcome, "rejected");
  assert.match(r.reason ?? "", /disabled/u);
});

test("stub: start/stop on a non-running/already-running capsule is a noop", async () => {
  const cp = createStubControlPlane();

  assert.equal((await cp.stop("metrics-collector")).outcome, "noop"); // not running
  assert.equal((await cp.start("hello-web")).outcome, "noop"); // already running
});

test("stub: logs grow on lifecycle events and carry VITA-CAPSULE markers", async () => {
  const cp = createStubControlPlane();
  const before = await cp.logs("metrics-collector", 100);

  await cp.start("metrics-collector");

  const after = await cp.logs("metrics-collector", 100);

  assert.ok(after.length > before.length);
  assert.ok(after.some((l) => l.message.includes("VITA-CAPSULE-EXECUTED")));
});

test("stub: status reflects running/installed counts", async () => {
  const cp = createStubControlPlane();
  const s0 = await cp.status();

  assert.equal(s0.ready, true);
  assert.equal(s0.runningCount, 1);

  await cp.start("metrics-collector");

  assert.equal((await cp.status()).runningCount, 2);
});

// ---- api_origin /control/* routing + gate ----

test("control: GET /control/status returns the node status (gated on control)", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/status", TOKEN));

  assert.equal(res.status, 200);
  const status = bodyOf<NodeStatus>(res);
  assert.equal(status.ready, true);
  assert.equal(status.installedCount, 2);
});

test("control: GET /control/apps lists capsules", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/apps", TOKEN));

  assert.equal(res.status, 200);
  const { apps } = bodyOf<{ apps: ConsoleAppView[] }>(res);
  assert.equal(apps.length, 3);
});

test("control: POST start then GET app reflects running, then stop", async () => {
  const { api } = setup();

  const started = bodyOf<LifecycleResult>(await api.handleAsync(req("POST", "/control/apps/metrics-collector/start", TOKEN)));
  assert.equal(started.outcome, "committed");
  assert.equal(started.app.running, true);

  const got = bodyOf<ConsoleAppView>(await api.handleAsync(req("GET", "/control/apps/metrics-collector", TOKEN)));
  assert.equal(got.running, true);

  const stopped = bodyOf<LifecycleResult>(await api.handleAsync(req("POST", "/control/apps/metrics-collector/stop", TOKEN)));
  assert.equal(stopped.outcome, "committed");
  assert.equal(stopped.app.running, false);
});

test("control: GET /control/apps/:id/logs returns log lines", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/apps/hello-web/logs", TOKEN));

  assert.equal(res.status, 200);
  const { lines } = bodyOf<{ lines: unknown[] }>(res);
  assert.ok(Array.isArray(lines) && lines.length > 0);
});

test("control: missing token → 401 (fail-closed)", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/apps"));

  assert.equal(res.status, 401);
});

test("control: valid token WITHOUT the control grant → 403 (default-deny)", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/apps", NO_CONTROL_TOKEN));

  assert.equal(res.status, 403);
});

test("control: GET unknown app → 404", async () => {
  const { api } = setup();
  const res = await api.handleAsync(req("GET", "/control/apps/does-not-exist", TOKEN));

  assert.equal(res.status, 404);
});

test("control: an api_origin with NO control plane mounted → 404 on /control/*", async () => {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();
  const grants: PuterCapability[] = ["control"];

  caps.mintAppSession({ appId: "x", appInstanceId: "ix", grants, token: TOKEN });

  const api = createApiOrigin({ capabilities: caps, store }); // no controlPlane
  const res = await api.handleAsync(req("GET", "/control/apps", TOKEN));

  assert.equal(res.status, 404);
});

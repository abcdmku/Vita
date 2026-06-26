import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  SurfaceShellHostPorts,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  createShellBackend,
  defineShellComponent,
  defineShellConfig,
  shellSurface,
} from "../../src/desktop-sdk/index.ts";
import type {
  ShellApplyResult,
  ShellBackend,
  ShellBackendOptions,
  ShellComponentDefinition,
  ShellComposedLayout,
  ShellCompositionPorts,
  ShellManagedSnapshot,
  ShellPreviewResult,
  ShellRollbackResult,
} from "../../src/desktop-sdk/index.ts";

const ROOT_COMPONENT_ID = "vita.test.shell.root";
const PANEL_COMPONENT_ID = "vita.test.shell.panel";

test("createShellBackend is drop-in for SurfaceShellHostPorts", () => {
  const backend = createShellBackend();
  const ports: Required<SurfaceShellHostPorts> = backend;

  assert.equal(typeof ports.registerComponent, "function");
  assert.equal(typeof ports.previewShell, "function");
  assert.equal(typeof ports.applyShell, "function");
  assert.equal(typeof ports.rollbackShell, "function");
  assert.equal(typeof ports.currentShell, "function");
});

test("register then apply composes a layout", () => {
  const backend = createRegisteredBackend();
  const applied = backend.applyShell(shellConfig("vita.test.shell.primary", "rev-1", "panel-a"));

  assertShellApplyResult(applied);
  const layout = expectCommitted(applied);

  assert.equal(layout.configId, "vita.test.shell.primary");
  assert.equal(layout.revision, "rev-1");
  assert.equal(layout.root.componentId, ROOT_COMPONENT_ID);
  assert.equal(layout.root.children.length, 1);
  assert.equal(layout.surfaces.length, 2);
});

test("preview is side-effect-free", () => {
  const backend = createRegisteredBackend();
  const committed = expectCommitted(backend.applyShell(shellConfig("vita.test.shell.committed", "rev-1", "panel-a")));
  const before = backend.currentShell();

  assertShellManagedSnapshot(before);

  const preview = backend.previewShell(shellConfig("vita.test.shell.preview", "rev-preview", "panel-b"));

  assertShellPreviewResult(preview);
  assert.equal(preview.ok, true);

  const after = backend.currentShell();

  assertShellManagedSnapshot(after);
  assert.equal(before.layout.configId, committed.configId);
  assert.equal(before.layout.revision, committed.revision);
  assert.equal(after.layout.configId, before.layout.configId);
  assert.equal(after.layout.revision, before.layout.revision);
});

test("rollback restores prior layout and falls back when no prior layout exists", () => {
  const fresh = createShellBackend();
  const noPrior = fresh.rollbackShell();

  assertShellRollbackResult(noPrior);
  assert.equal(noPrior.ok, true);
  assert.equal(noPrior.outcome, "fallback");

  const backend = createRegisteredBackend();
  const first = expectCommitted(backend.applyShell(shellConfig("vita.test.shell.first", "rev-1", "panel-a")));
  const second = expectCommitted(backend.applyShell(shellConfig("vita.test.shell.second", "rev-2", "panel-b")));

  assert.notEqual(second.configId, first.configId);

  const rollback = backend.rollbackShell();

  assertShellRollbackResult(rollback);
  assert.equal(rollback.ok, true);
  assert.equal(rollback.outcome, "rolledBack");
  assert.equal(rollback.layout.configId, first.configId);
  assert.equal(rollback.layout.revision, first.revision);

  const current = backend.currentShell();

  assertShellManagedSnapshot(current);
  assert.equal(current.source, "configured");
  assert.equal(current.layout.configId, first.configId);
  assert.equal(current.layout.revision, first.revision);
});

test("currentShell snapshot reflects fallback then committed state", () => {
  const backend = createShellBackend();
  const fresh = backend.currentShell();

  assertShellManagedSnapshot(fresh);
  assert.equal(fresh.source, "fallback");
  assertShellLayout(fresh.layout);

  registerCoreComponents(backend);
  const layout = expectCommitted(backend.applyShell(shellConfig("vita.test.shell.current", "rev-current", "panel-a")));
  const current = backend.currentShell();

  assertShellManagedSnapshot(current);
  assert.equal(current.source, "configured");
  assert.equal(current.layout.configId, layout.configId);
  assert.equal(current.layout.revision, layout.revision);
});

test("duplicate component registration fails closed", () => {
  const backend = createShellBackend();
  const component = rootComponent();
  const first = backend.registerComponent(component);
  const duplicate = backend.registerComponent(component);

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) assert.fail("duplicate component registration unexpectedly succeeded");
  assert.equal(duplicate.error.code, "DUPLICATE_COMPONENT");
});

test("apply failure falls back and failsafe-class compose errors return FAILSAFE without mutating current", () => {
  const backend = createRegisteredBackend();
  const committed = expectCommitted(backend.applyShell(shellConfig("vita.test.shell.good", "rev-good", "panel-a")));
  const failed = backend.applyShell(missingComponentConfig());

  assertShellApplyResult(failed);
  assert.equal(failed.ok, false);
  if (failed.ok) assert.fail("missing component apply unexpectedly committed");
  assert.equal(failed.outcome, "fallback");
  assertCurrentLayout(backend, committed);

  let failRemove = false;
  const ports: ShellCompositionPorts = Object.freeze({
    substrate: Object.freeze({
      createSurface() {
        return Object.freeze({
          kind: "test-substrate",
        });
      },
      removeSurface() {
        if (failRemove) {
          throw new Error("remove failed");
        }
      },
    }),
  });
  const failsafeBackend = createRegisteredBackend({ ports });
  const prior = expectCommitted(failsafeBackend.applyShell(shellConfig("vita.test.shell.failsafe.prior", "rev-prior", "panel-a")));

  failRemove = true;

  const failsafe = failsafeBackend.applyShell(shellConfig("vita.test.shell.failsafe.next", "rev-next", "panel-b"));

  assertShellApplyResult(failsafe);
  assert.equal(failsafe.ok, false);
  if (failsafe.ok) assert.fail("failing substrate remove unexpectedly committed");
  assert.equal(failsafe.outcome, "failsafe");
  assert.equal(failsafe.status, "FAILSAFE");
  assertCurrentLayout(failsafeBackend, prior);
});

function createRegisteredBackend(options?: ShellBackendOptions): ShellBackend {
  const backend = createShellBackend(options);

  registerCoreComponents(backend);

  return backend;
}

function registerCoreComponents(backend: Required<SurfaceShellHostPorts>): void {
  const root = backend.registerComponent(rootComponent());
  const panel = backend.registerComponent(panelComponent());

  assert.equal(root.ok, true);
  assert.equal(panel.ok, true);
}

function rootComponent(): ShellComponentDefinition {
  return defineShellComponent({
    defaultPlacement: {
      layer: "desktop",
      order: 0,
      zone: "root",
    },
    id: ROOT_COMPONENT_ID,
    render: (_props, context) => shellSurface({
      componentId: context.componentId,
      role: context.role,
      slot: "root",
    }, {
      className: "vita-test-root",
    }),
    role: "desktop",
  });
}

function panelComponent(): ShellComponentDefinition {
  return defineShellComponent({
    defaultPlacement: {
      layer: "chrome",
      order: 10,
      zone: "top",
    },
    id: PANEL_COMPONENT_ID,
    render: (props, context) => shellSurface({
      componentId: context.componentId,
      label: props["label"] ?? "panel",
      role: context.role,
      slot: "panel",
    }, {
      className: "vita-test-panel",
    }),
    role: "panel",
  });
}

function shellConfig(id: string, revision: string, panelKey: string) {
  return defineShellConfig({
    css: Object.freeze({
      rules: Object.freeze([
        Object.freeze({
          declarations: Object.freeze({
            color: "#ffffff",
          }),
          selector: ".vita-test-panel",
        }),
      ]),
      text: ".vita-test-root{display:grid}",
    }),
    id,
    render: ({ component }) => component(ROOT_COMPONENT_ID, {
      children: Object.freeze([
        component(PANEL_COMPONENT_ID, {
          key: panelKey,
          placement: {
            layer: "chrome",
            order: 1,
            zone: "top",
          },
          props: Object.freeze({
            label: panelKey,
          }),
          role: "panel",
        }),
      ]),
      key: "root",
      placement: {
        layer: "desktop",
        order: 0,
        zone: "root",
      },
      role: "desktop",
    }),
    revision,
  });
}

function missingComponentConfig() {
  return defineShellConfig({
    id: "vita.test.shell.missing",
    render: ({ component }) => component("vita.test.shell.missing.component"),
    revision: "rev-missing",
  });
}

function expectCommitted(result: ShellApplyResult): ShellComposedLayout {
  assertShellApplyResult(result);
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("shell apply failed");
  assert.equal(result.outcome, "committed");
  assertShellLayout(result.layout);

  return result.layout;
}

function assertCurrentLayout(backend: Required<SurfaceShellHostPorts>, expected: ShellComposedLayout): void {
  const current = backend.currentShell();

  assertShellManagedSnapshot(current);
  assert.equal(current.layout.configId, expected.configId);
  assert.equal(current.layout.revision, expected.revision);
}

function assertShellPreviewResult(value: unknown): asserts value is ShellPreviewResult {
  assert.equal(isShellPreviewResult(value), true);
}

function assertShellApplyResult(value: unknown): asserts value is ShellApplyResult {
  assert.equal(isShellApplyResult(value), true);
}

function assertShellRollbackResult(value: unknown): asserts value is ShellRollbackResult {
  assert.equal(isShellRollbackResult(value), true);
}

function assertShellManagedSnapshot(value: unknown): asserts value is ShellManagedSnapshot {
  assert.equal(isShellManagedSnapshot(value), true);
}

function assertShellLayout(value: unknown): asserts value is ShellComposedLayout {
  assert.equal(isShellLayout(value), true);
}

function isShellPreviewResult(value: unknown): value is ShellPreviewResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return isShellLayout(result["layout"]) && isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    isHostError(result["error"]) &&
    isShellLayout(result["fallbackLayout"]) &&
    isShellDiff(result["diff"]);
}

function isShellApplyResult(value: unknown): value is ShellApplyResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return result["outcome"] === "committed" &&
      isShellLayout(result["layout"]) &&
      isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]) &&
    isShellLayout(result["fallbackLayout"]) &&
    (result["status"] === undefined || result["status"] === "FAILSAFE");
}

function isShellRollbackResult(value: unknown): value is ShellRollbackResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return (result["outcome"] === "rolledBack" || result["outcome"] === "fallback") &&
      isShellLayout(result["layout"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]) &&
    (result["status"] === undefined || result["status"] === "FAILSAFE");
}

function isShellManagedSnapshot(value: unknown): value is ShellManagedSnapshot {
  const snapshot = jsonObject(value);

  return snapshot !== undefined &&
    (snapshot["source"] === "configured" || snapshot["source"] === "fallback") &&
    isShellLayout(snapshot["layout"]) &&
    (snapshot["error"] === undefined || isHostError(snapshot["error"]));
}

function isShellLayout(value: unknown): value is ShellComposedLayout {
  const layout = jsonObject(value);

  return layout !== undefined &&
    typeof layout["configId"] === "string" &&
    typeof layout["revision"] === "string" &&
    isShellStyleSheet(layout["css"]) &&
    isShellResolvedSurface(layout["root"]) &&
    isShellSurfaceArray(layout["surfaces"]);
}

function isShellStyleSheet(value: unknown): boolean {
  const styleSheet = jsonObject(value);

  return styleSheet !== undefined &&
    typeof styleSheet["text"] === "string" &&
    Array.isArray(styleSheet["rules"]);
}

function isShellResolvedSurface(value: unknown): boolean {
  const surface = jsonObject(value);

  return surface !== undefined &&
    typeof surface["id"] === "string" &&
    typeof surface["componentId"] === "string" &&
    typeof surface["role"] === "string" &&
    typeof surface["path"] === "string" &&
    isPlacement(surface["placement"]) &&
    jsonObject(surface["payload"]) !== undefined &&
    jsonObject(surface["substrate"]) !== undefined &&
    isShellSurfaceArray(surface["children"]);
}

function isShellSurfaceArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (!isShellResolvedSurface(value[index])) return false;
  }

  return true;
}

function isShellDiff(value: unknown): boolean {
  const diff = jsonObject(value);

  return diff !== undefined &&
    isStringArray(diff["added"]) &&
    isStringArray(diff["removed"]) &&
    isStringArray(diff["changed"]);
}

function isHostError(value: unknown): boolean {
  const error = jsonObject(value);

  return error !== undefined &&
    typeof error["code"] === "string" &&
    typeof error["message"] === "string" &&
    typeof error["path"] === "string";
}

function isPlacement(value: unknown): boolean {
  const placement = jsonObject(value);

  return placement !== undefined &&
    typeof placement["zone"] === "string" &&
    typeof placement["layer"] === "string" &&
    isFiniteNumber(placement["order"]);
}

function isStringArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return false;
  }

  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as Readonly<Record<string, unknown>>;
}

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KNOWN_GOOD_FALLBACK_SHELL_ID,
  ManagedShellConfigController,
  ShellComponentRegistry,
  composeKnownGoodFallbackShell,
  composeShellLayout,
  defineShellComponent,
  defineShellConfig,
  evaluateShellConfig,
  shellComponent,
  shellSurface,
} from "../../src/shell/index.ts";
import type {
  ShellComposedLayout,
  ShellCompositionPorts,
  ShellSurfaceCreateRequest,
  ShellWindowManagerPlacementRequest,
} from "../../src/shell/index.ts";

test("registry composes deterministic TSX/CSS layout through WM and substrate ports", () => {
  const registry = testRegistry();
  const surfaceCalls: ShellSurfaceCreateRequest[] = [];
  const wmCalls: ShellWindowManagerPlacementRequest[] = [];
  const ports = fakePorts(surfaceCalls, wmCalls);
  const first = composeShellLayout(registry, ownerShell("rev-a"), ports);
  const second = composeShellLayout(registry, ownerShell("rev-a"), ports);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    assert.fail("expected shell composition to succeed");
  }

  assert.deepEqual(second.value, first.value);
  assert.equal(first.value.configId, "owner.shell");
  assert.equal(first.value.revision, "rev-a");
  assert.equal(first.value.root.componentId, "vita.shell.desktop");
  assert.equal(first.value.root.children.length, 1);
  assert.equal(first.value.root.children[0]?.children.length, 2);
  assert.match(first.value.css.text, /\.panel\{display:flex;gap:8px\}/u);
  assert.deepEqual(surfaceIds(first.value), [
    "surface:vita.shell.desktop:0",
    "surface:vita.shell.panel:0.0-panel",
    "surface:vita.shell.widget:0.0-panel.0-launcher",
    "surface:vita.shell.widget:0.0-panel.1-status",
  ]);
  assert.equal(first.value.root.children[0]?.placement.zone, "top");
  assert.equal(first.value.root.children[0]?.placement.rect?.width, 1920);
  assert.equal(first.value.root.children[0]?.children[1]?.placement.zone, "right");
  assert.equal(surfaceCalls.length, 8);
  assert.equal(wmCalls.length, 8);
  assert.equal(surfaceCalls[0]?.payload["title"], "Vita Desktop");
});

test("preview is a pure dry-run and does not call substrate or WM ports", () => {
  const registry = testRegistry();
  const surfaceCalls: ShellSurfaceCreateRequest[] = [];
  const wmCalls: ShellWindowManagerPlacementRequest[] = [];
  const controller = new ManagedShellConfigController(registry, fakePorts(surfaceCalls, wmCalls));

  surfaceCalls.length = 0;
  wmCalls.length = 0;

  const preview = controller.preview(ownerShell("rev-preview"));

  assert.equal(preview.ok, true);
  if (!preview.ok) {
    assert.fail("expected pure preview to succeed");
  }
  assert.equal(surfaceCalls.length, 0);
  assert.equal(wmCalls.length, 0);
  assert.equal(preview.layout.root.componentId, "vita.shell.desktop");
  assert.equal(preview.layout.root.children[0]?.placement.rect, undefined);
});

test("successful apply removes prior fallback surfaces and leaves live substrate equal to current", () => {
  const registry = testRegistry();
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Set<string>();
  const fallbackSurfaceId = `surface:${KNOWN_GOOD_FALLBACK_SHELL_ID}:0`;
  const controller = new ManagedShellConfigController(registry, trackingPorts(created, removed, liveSurfaces));

  assert.deepEqual([...liveSurfaces].sort(), [fallbackSurfaceId]);
  created.length = 0;
  removed.length = 0;

  const applied = controller.apply(ownerShell("rev-live"));

  assert.equal(applied.ok, true);
  if (!applied.ok) {
    assert.fail("expected apply to commit");
  }
  assert.deepEqual(removed, [fallbackSurfaceId]);
  assert.deepEqual([...liveSurfaces].sort(), surfaceIds(applied.layout));
  assert.deepEqual([...liveSurfaces].sort(), surfaceIds(controller.current().layout));
});

test("registry is keyed safely for JavaScript-special component ids", () => {
  const registry = new ShellComponentRegistry();
  const registered = registry.register(defineShellComponent({
    defaultPlacement: {
      zone: "center",
    },
    id: "__proto__",
    render: () => shellSurface({
      title: "special",
    }),
    role: "panel",
  }));

  assert.equal(registered.ok, true);

  const composed = composeShellLayout(registry, defineShellConfig({
    id: "special.shell",
    render: ({ component }) => component("__proto__"),
  }));

  assert.equal(composed.ok, true);
  if (!composed.ok) {
    assert.fail("expected special component id to compose");
  }
  assert.equal(composed.value.root.componentId, "__proto__");
});

test("preview does not mutate current shell and invalid edits return fallback with surfaced error", () => {
  const registry = testRegistry();
  const controller = new ManagedShellConfigController(registry);
  const applied = controller.apply(ownerShell("rev-good"));

  assert.equal(applied.ok, true);
  if (!applied.ok) {
    assert.fail("expected initial apply to commit");
  }
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-good");

  const preview = controller.preview(defineShellConfig({
    id: "owner.shell",
    render: () => shellComponent("missing.component"),
    revision: "rev-bad",
  }));

  assert.equal(preview.ok, false);
  if (preview.ok) {
    assert.fail("expected preview rejection");
  }
  assert.equal(preview.error.code, "UNKNOWN_COMPONENT");
  assert.equal(preview.fallbackLayout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-good");
});

test("throwing apply surfaces the error and keeps the last configured shell active", () => {
  const registry = testRegistry();
  const controller = new ManagedShellConfigController(registry);
  const committed = controller.apply(ownerShell("rev-good"));

  assert.equal(committed.ok, true);
  assert.equal(controller.current().source, "configured");

  const broken = controller.apply(defineShellConfig({
    id: "owner.shell",
    render: () => {
      throw new Error("bad owner edit");
    },
    revision: "rev-broken",
  }));

  assert.equal(broken.ok, false);
  if (broken.ok) {
    assert.fail("expected broken apply to fail");
  }
  assert.equal(broken.outcome, "fallback");
  assert.equal(broken.error.code, "SHELL_CONFIG_RENDER_FAILED");
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-good");
  assert.equal(controller.current().error?.code, "SHELL_CONFIG_RENDER_FAILED");
  assert.equal(broken.layout.revision, "rev-good");
  assert.equal(broken.fallbackLayout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
});

test("apply validates a full tree before creating owner substrate surfaces", () => {
  const registry = testRegistry();
  const registered = registry.register(defineShellComponent({
    defaultPlacement: {
      zone: "center",
    },
    id: "vita.shell.bad-child",
    render: () => {
      throw new Error("bad child edit");
    },
    role: "widget",
  }));
  const surfaceCalls: ShellSurfaceCreateRequest[] = [];
  const wmCalls: ShellWindowManagerPlacementRequest[] = [];
  const controller = new ManagedShellConfigController(registry, fakePorts(surfaceCalls, wmCalls));

  assert.equal(registered.ok, true);
  surfaceCalls.length = 0;
  wmCalls.length = 0;

  const broken = controller.apply(defineShellConfig({
    id: "owner.shell",
    render: ({ component }) => component("vita.shell.desktop", {
      children: [
        component("vita.shell.bad-child", {
          key: "bad",
        }),
      ],
    }),
    revision: "rev-bad-child",
  }));

  assert.equal(broken.ok, false);
  if (broken.ok) {
    assert.fail("expected child render failure to fall back");
  }
  assert.equal(broken.error.code, "SHELL_COMPONENT_RENDER_FAILED");
  assert.equal(controller.current().source, "fallback");
  assert.equal(controller.current().layout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
  assert.deepEqual(surfaceCalls.map((request) => request.surfaceId), []);
  assert.equal(surfaceCalls.some((request) => request.surfaceId === "surface:vita.shell.desktop:0"), false);
});

test("apply removes created owner surfaces when a deep substrate create allocates then fails", () => {
  const registry = testRegistry();
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Set<string>();
  const failureSurfaceId = "surface:vita.shell.widget:0.0-panel.1-status";
  const fallbackSurfaceId = `surface:${KNOWN_GOOD_FALLBACK_SHELL_ID}:0`;
  const controller = new ManagedShellConfigController(registry, {
    substrate: {
      createSurface(request) {
        created.push(request.surfaceId);
        if (request.surfaceId === failureSurfaceId) {
          liveSurfaces.add(request.surfaceId);
          throw new Error("deep substrate failure");
        }

        liveSurfaces.add(request.surfaceId);
        return {
          kind: "fake-substrate",
          surfaceId: request.surfaceId,
        };
      },
      removeSurface(surfaceId) {
        removed.push(surfaceId);
        liveSurfaces.delete(surfaceId);
        return {
          removed: true,
          surfaceId,
        };
      },
    },
    wm: {
      placeSurface(request) {
        return request.requestedPlacement;
      },
    },
  });

  created.length = 0;
  removed.length = 0;

  const broken = controller.apply(ownerShell("rev-substrate-fail"));

  assert.equal(broken.ok, false);
  if (broken.ok) {
    assert.fail("expected substrate failure to fall back");
  }
  assert.equal(broken.error.code, "SUBSTRATE_CREATE_FAILED");
  assert.equal(controller.current().source, "fallback");
  assert.equal(controller.current().layout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
  assert.deepEqual(created, [
    "surface:vita.shell.desktop:0",
    "surface:vita.shell.panel:0.0-panel",
    "surface:vita.shell.widget:0.0-panel.0-launcher",
    failureSurfaceId,
  ]);
  assert.deepEqual(removed, [
    failureSurfaceId,
    "surface:vita.shell.widget:0.0-panel.0-launcher",
    "surface:vita.shell.panel:0.0-panel",
    "surface:vita.shell.desktop:0",
  ]);
  assert.deepEqual([...liveSurfaces].sort(), [
    fallbackSurfaceId,
  ]);
});

test("failed apply leaves the previous configured layout live with no partial surfaces", () => {
  const registry = testRegistry();
  const registered = registry.register(defineShellComponent({
    defaultPlacement: {
      zone: "center",
    },
    id: "vita.shell.extra",
    render: () => shellSurface({
      title: "extra",
    }),
    role: "widget",
  }));
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Set<string>();
  const failureSurfaceId = "surface:vita.shell.extra:0.0-extra";
  const controller = new ManagedShellConfigController(
    registry,
    trackingPorts(created, removed, liveSurfaces, {
      failOnCreateSurfaceId: failureSurfaceId,
    }),
  );

  assert.equal(registered.ok, true);

  const committed = controller.apply(ownerShell("rev-good"));

  assert.equal(committed.ok, true);
  if (!committed.ok) {
    assert.fail("expected initial apply to commit");
  }

  const liveBeforeFailure = [...liveSurfaces].sort();
  created.length = 0;
  removed.length = 0;

  const broken = controller.apply(defineShellConfig({
    id: "owner.shell",
    render: ({ component }) => component("vita.shell.desktop", {
      children: [
        component("vita.shell.extra", {
          key: "extra",
        }),
      ],
    }),
    revision: "rev-fails-after-root",
  }));

  assert.equal(broken.ok, false);
  if (broken.ok) {
    assert.fail("expected substrate failure to reject apply");
  }
  assert.equal(broken.error.code, "SUBSTRATE_CREATE_FAILED");
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-good");
  assert.equal(controller.current().error?.code, "SUBSTRATE_CREATE_FAILED");
  assert.deepEqual(created, [
    "surface:vita.shell.desktop:0",
    failureSurfaceId,
    "surface:vita.shell.desktop:0",
  ]);
  assert.deepEqual(removed, [
    failureSurfaceId,
  ]);
  assert.deepEqual([...liveSurfaces].sort(), liveBeforeFailure);
  assert.deepEqual(surfaceIds(broken.layout), liveBeforeFailure);
});

test("failed apply with reused surface ids restores the previous payloads exactly", () => {
  const registry = testRegistry();
  const registered = registry.register(defineShellComponent({
    defaultPlacement: {
      zone: "center",
    },
    id: "vita.shell.extra",
    render: () => shellSurface({
      title: "extra",
    }),
    role: "widget",
  }));
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Map<string, ShellSurfaceCreateRequest>();
  const failureSurfaceId = "surface:vita.shell.extra:0.0-panel.1-extra";
  const controller = new ManagedShellConfigController(
    registry,
    statefulPorts(created, removed, liveSurfaces, {
      allocateBeforeThrow: true,
      failOnCreateSurfaceId: failureSurfaceId,
    }),
  );

  assert.equal(registered.ok, true);

  const committed = controller.apply(ownerShell("rev-good"));

  assert.equal(committed.ok, true);
  if (!committed.ok) {
    assert.fail("expected initial apply to commit");
  }

  const liveBeforeFailure = liveRequestSnapshots(liveSurfaces);
  created.length = 0;
  removed.length = 0;

  const broken = controller.apply(defineShellConfig({
    id: "owner.shell",
    render: ({ component }) => component("vita.shell.desktop", {
      children: [
        component("vita.shell.panel", {
          className: "panel",
          key: "panel",
          placement: {
            layer: "panel",
            order: 1,
            zone: "top",
          },
          props: {
            title: "mutated panel",
          },
          children: [
            component("vita.shell.widget", {
              key: "launcher",
              props: {
                label: "mutated launcher",
              },
            }),
            component("vita.shell.extra", {
              key: "extra",
            }),
          ],
        }),
      ],
    }),
    revision: "rev-reused-ids-fail",
  }));

  assert.equal(broken.ok, false);
  if (broken.ok) {
    assert.fail("expected substrate failure to reject apply");
  }
  assert.equal(broken.error.code, "SUBSTRATE_CREATE_FAILED");
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-good");
  assert.deepEqual(removed, [
    failureSurfaceId,
  ]);
  assert.deepEqual(liveRequestSnapshots(liveSurfaces), liveBeforeFailure);
  assert.equal(liveSurfaces.get("surface:vita.shell.panel:0.0-panel")?.payload["title"], "top panel");
  assert.equal(liveSurfaces.get("surface:vita.shell.widget:0.0-panel.0-launcher")?.payload["label"], "launcher");
});

test("apply cleanup failure is surfaced as failsafe and restores the previous live layout", () => {
  const registry = testRegistry();
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Map<string, ShellSurfaceCreateRequest>();
  const fallbackSurfaceId = `surface:${KNOWN_GOOD_FALLBACK_SHELL_ID}:0`;
  const controller = new ManagedShellConfigController(
    registry,
    statefulPorts(created, removed, liveSurfaces, {
      failOnRemoveSurfaceId: fallbackSurfaceId,
    }),
  );
  const liveBeforeFailure = liveRequestSnapshots(liveSurfaces);

  created.length = 0;
  removed.length = 0;

  const applied = controller.apply(ownerShell("rev-cleanup-fails"));

  assert.equal(applied.ok, false);
  if (applied.ok) {
    assert.fail("expected cleanup failure to reject apply");
  }
  assert.equal(applied.outcome, "failsafe");
  assert.equal(applied.status, "FAILSAFE");
  assert.equal(applied.error.code, "SUBSTRATE_REMOVE_FAILED");
  assert.equal(controller.current().source, "fallback");
  assert.equal(controller.current().error?.code, "SUBSTRATE_REMOVE_FAILED");
  assert.deepEqual(liveRequestSnapshots(liveSurfaces), liveBeforeFailure);
  assert.equal(removed[0], fallbackSurfaceId);
});

test("rollback removes the current layout and recreates the previous layout through the substrate", () => {
  const registry = testRegistry();
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Set<string>();
  const fallbackSurfaceId = `surface:${KNOWN_GOOD_FALLBACK_SHELL_ID}:0`;
  const controller = new ManagedShellConfigController(registry, trackingPorts(created, removed, liveSurfaces));
  const committed = controller.apply(ownerShell("rev-before-rollback"));

  assert.equal(committed.ok, true);
  created.length = 0;
  removed.length = 0;

  const rollback = controller.rollback();

  assert.equal(rollback.ok, true);
  assert.equal(rollback.outcome, "rolledBack");
  assert.deepEqual(removed, [
    "surface:vita.shell.widget:0.0-panel.0-launcher",
    "surface:vita.shell.widget:0.0-panel.1-status",
    "surface:vita.shell.panel:0.0-panel",
    "surface:vita.shell.desktop:0",
  ]);
  assert.deepEqual(created, [
    fallbackSurfaceId,
  ]);
  assert.equal(controller.current().source, "fallback");
  assert.deepEqual([...liveSurfaces].sort(), [
    fallbackSurfaceId,
  ]);
  assert.deepEqual([...liveSurfaces].sort(), surfaceIds(controller.current().layout));
});

test("rollback cleanup failure is surfaced as failsafe and restores the current live layout", () => {
  const registry = testRegistry();
  const created: string[] = [];
  const removed: string[] = [];
  const liveSurfaces = new Map<string, ShellSurfaceCreateRequest>();
  const options: StatefulPortOptions = {};
  const controller = new ManagedShellConfigController(
    registry,
    statefulPorts(created, removed, liveSurfaces, options),
  );
  const committed = controller.apply(ownerShell("rev-before-failed-rollback"));

  assert.equal(committed.ok, true);
  if (!committed.ok) {
    assert.fail("expected initial apply to commit");
  }

  const liveBeforeRollback = liveRequestSnapshots(liveSurfaces);
  created.length = 0;
  removed.length = 0;
  options.failOnRemoveSurfaceId = "surface:vita.shell.desktop:0";

  const rollback = controller.rollback();

  assert.equal(rollback.ok, false);
  if (rollback.ok) {
    assert.fail("expected rollback cleanup failure to be surfaced");
  }
  assert.equal(rollback.outcome, "failsafe");
  assert.equal(rollback.status, "FAILSAFE");
  assert.equal(rollback.error.code, "SUBSTRATE_REMOVE_FAILED");
  assert.equal(controller.current().source, "configured");
  assert.equal(controller.current().layout.revision, "rev-before-failed-rollback");
  assert.equal(controller.current().error?.code, "SUBSTRATE_REMOVE_FAILED");
  assert.deepEqual(liveRequestSnapshots(liveSurfaces), liveBeforeRollback);
});

test("malformed shell output fails closed without invoking accessors or iterators", () => {
  const registry = testRegistry();
  const controller = new ManagedShellConfigController(registry);
  let getterReads = 0;
  const maliciousRoot: Record<string, unknown> = {};

  Object.defineProperty(maliciousRoot, "component", {
    enumerable: true,
    get(): never {
      getterReads += 1;
      throw new Error("getter must not run");
    },
  });

  const accessorPreview = controller.preview(defineShellConfig({
    id: "owner.shell",
    render: () => maliciousRoot,
  }));

  assert.equal(accessorPreview.ok, false);
  assert.equal(getterReads, 0);
  assert.equal(controller.current().source, "fallback");

  const cyclic: Record<string, unknown> = {
    component: "vita.shell.desktop",
  };
  cyclic["self"] = cyclic;

  const cyclicPreview = controller.preview(defineShellConfig({
    id: "owner.shell",
    render: () => cyclic,
  }));

  assert.equal(cyclicPreview.ok, false);
  if (cyclicPreview.ok) {
    assert.fail("expected cyclic shell rejection");
  }
  assert.equal(cyclicPreview.fallbackLayout.root.componentId, KNOWN_GOOD_FALLBACK_SHELL_ID);
});

test("public shell definition boundaries reject proxies before traps can run", () => {
  const registry = new ShellComponentRegistry();
  let componentProxyTraps = 0;
  const componentProxy = new Proxy({
    defaultPlacement: {
      zone: "center",
    },
    id: "proxy.component",
    render: () => shellSurface({
      title: "proxy",
    }),
    role: "panel",
  }, {
    getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
      componentProxyTraps += 1;
      throw new Error("component descriptor trap must not run");
    },
    getPrototypeOf(): object | null {
      componentProxyTraps += 1;
      throw new Error("component prototype trap must not run");
    },
    ownKeys(): (string | symbol)[] {
      componentProxyTraps += 1;
      throw new Error("component ownKeys trap must not run");
    },
  });
  const registered = registry.register(componentProxy);

  assert.equal(registered.ok, false);
  assert.equal(componentProxyTraps, 0);
  if (registered.ok) {
    assert.fail("expected proxy component definition rejection");
  }
  assert.equal(registered.error.code, "INVALID_OBJECT");

  let configProxyTraps = 0;
  const configProxy = new Proxy({
    id: "proxy.shell",
    render: () => shellComponent("proxy.component"),
  }, {
    getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
      configProxyTraps += 1;
      throw new Error("config descriptor trap must not run");
    },
    getPrototypeOf(): object | null {
      configProxyTraps += 1;
      throw new Error("config prototype trap must not run");
    },
    ownKeys(): (string | symbol)[] {
      configProxyTraps += 1;
      throw new Error("config ownKeys trap must not run");
    },
  });
  const evaluated = evaluateShellConfig(configProxy);

  assert.equal(evaluated.ok, false);
  assert.equal(configProxyTraps, 0);
  if (evaluated.ok) {
    assert.fail("expected proxy config definition rejection");
  }
  assert.equal(evaluated.error.code, "INVALID_OBJECT");
});

test("nondeterministic component render is rejected and apply falls back", () => {
  const registry = new ShellComponentRegistry();
  let renderCount = 0;
  const registered = registry.register(defineShellComponent({
    defaultPlacement: {
      zone: "center",
    },
    id: "unstable.component",
    render: () => {
      renderCount += 1;
      return shellSurface({
        renderCount,
      });
    },
    role: "panel",
  }));

  assert.equal(registered.ok, true);

  const controller = new ManagedShellConfigController(registry);
  const applied = controller.apply(defineShellConfig({
    id: "unstable.shell",
    render: ({ component }) => component("unstable.component"),
  }));

  assert.equal(applied.ok, false);
  if (applied.ok) {
    assert.fail("expected nondeterministic component rejection");
  }
  assert.equal(applied.error.code, "NON_DETERMINISTIC_COMPONENT");
  assert.equal(applied.layout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
});

test("known-good fallback shell composes without owner registry", () => {
  const layout = composeKnownGoodFallbackShell();

  assert.equal(layout.configId, KNOWN_GOOD_FALLBACK_SHELL_ID);
  assert.equal(layout.root.componentId, KNOWN_GOOD_FALLBACK_SHELL_ID);
  assert.equal(layout.root.payload["safeMode"], true);
  assert.match(layout.css.text, /vita-fallback-shell/u);
});

function testRegistry(): ShellComponentRegistry {
  const registry = new ShellComponentRegistry();

  assert.equal(registry.register(defineShellComponent({
    defaultPlacement: {
      layer: "desktop",
      order: 0,
      zone: "center",
    },
    id: "vita.shell.desktop",
    render: (_props, context) => shellSurface({
      path: context.path,
      title: "Vita Desktop",
    }),
    role: "desktop",
  })).ok, true);

  assert.equal(registry.register(defineShellComponent({
    defaultPlacement: {
      layer: "panel",
      order: 10,
      zone: "top",
    },
    id: "vita.shell.panel",
    render: (props) => shellSurface({
      title: String(props["title"]),
    }),
    role: "panel",
  })).ok, true);

  assert.equal(registry.register(defineShellComponent({
    defaultPlacement: {
      layer: "panel",
      order: 20,
      zone: "left",
    },
    id: "vita.shell.widget",
    render: (props) => shellSurface({
      label: String(props["label"]),
    }, {
      className: "widget-surface",
    }),
    role: "widget",
  })).ok, true);

  return registry;
}

function ownerShell(revision: string) {
  return defineShellConfig({
    css: {
      rules: [
        {
          declarations: {
            display: "flex",
            gap: "8px",
          },
          selector: ".panel",
        },
      ],
    },
    id: "owner.shell",
    render: ({ component }) => component("vita.shell.desktop", {
      children: [
        component("vita.shell.panel", {
          className: "panel",
          key: "panel",
          placement: {
            layer: "panel",
            order: 1,
            zone: "top",
          },
          props: {
            title: "top panel",
          },
          role: "panel",
          children: [
            component("vita.shell.widget", {
              key: "launcher",
              props: {
                label: "launcher",
              },
            }),
            component("vita.shell.widget", {
              key: "status",
              placement: {
                order: 2,
                zone: "right",
              },
              props: {
                label: "status",
              },
            }),
          ],
        }),
      ],
    }),
    revision,
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
          className: request.className ?? "",
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
              height: 48,
              width: 1920,
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

interface TrackingPortOptions {
  readonly failOnCreateSurfaceId?: string;
  readonly allocateBeforeThrow?: boolean;
}

function trackingPorts(
  created: string[],
  removed: string[],
  liveSurfaces: Set<string>,
  options: TrackingPortOptions = {},
): ShellCompositionPorts {
  return {
    substrate: {
      createSurface(request) {
        created.push(request.surfaceId);
        if (request.surfaceId === options.failOnCreateSurfaceId) {
          if (options.allocateBeforeThrow === true) {
            liveSurfaces.add(request.surfaceId);
          }
          throw new Error("configured substrate create failure");
        }

        liveSurfaces.add(request.surfaceId);
        return {
          kind: "tracking-substrate",
          surfaceId: request.surfaceId,
        };
      },
      removeSurface(surfaceId) {
        removed.push(surfaceId);
        liveSurfaces.delete(surfaceId);
        return {
          removed: true,
          surfaceId,
        };
      },
    },
    wm: {
      placeSurface(request) {
        return request.requestedPlacement;
      },
    },
  };
}

interface StatefulPortOptions {
  failOnCreateSurfaceId?: string;
  failOnRemoveSurfaceId?: string;
  allocateBeforeThrow?: boolean;
}

function statefulPorts(
  created: string[],
  removed: string[],
  liveSurfaces: Map<string, ShellSurfaceCreateRequest>,
  options: StatefulPortOptions = {},
): ShellCompositionPorts {
  return {
    substrate: {
      createSurface(request) {
        created.push(request.surfaceId);
        if (request.surfaceId === options.failOnCreateSurfaceId) {
          if (options.allocateBeforeThrow === true) {
            liveSurfaces.set(request.surfaceId, snapshotCreateRequest(request));
          }
          throw new Error("configured substrate create failure");
        }

        liveSurfaces.set(request.surfaceId, snapshotCreateRequest(request));
        return {
          kind: "stateful-substrate",
          surfaceId: request.surfaceId,
        };
      },
      removeSurface(surfaceId) {
        removed.push(surfaceId);
        if (surfaceId === options.failOnRemoveSurfaceId) {
          throw new Error("configured substrate remove failure");
        }
        liveSurfaces.delete(surfaceId);
        return {
          removed: true,
          surfaceId,
        };
      },
    },
    wm: {
      placeSurface(request) {
        return request.requestedPlacement;
      },
    },
  };
}

function snapshotCreateRequest(request: ShellSurfaceCreateRequest): ShellSurfaceCreateRequest {
  const output: {
    surfaceId: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellSurfaceCreateRequest["placement"];
    payload: ShellSurfaceCreateRequest["payload"];
    className?: string;
  } = {
    componentId: request.componentId,
    path: request.path,
    payload: request.payload,
    placement: request.placement,
    role: request.role,
    surfaceId: request.surfaceId,
  };

  if (request.className !== undefined) output.className = request.className;

  return Object.freeze(output);
}

interface LiveRequestSnapshot {
  readonly surfaceId: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly className?: string;
  readonly payload: ShellSurfaceCreateRequest["payload"];
  readonly placement: ShellSurfaceCreateRequest["placement"];
}

function liveRequestSnapshots(
  liveSurfaces: ReadonlyMap<string, ShellSurfaceCreateRequest>,
): readonly LiveRequestSnapshot[] {
  const snapshots: LiveRequestSnapshot[] = [];
  const requests = [...liveSurfaces.values()].sort((left, right) => {
    if (left.surfaceId < right.surfaceId) return -1;
    if (left.surfaceId > right.surfaceId) return 1;

    return 0;
  });

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];

    if (request === undefined) continue;

    const snapshot: {
      surfaceId: string;
      componentId: string;
      role: string;
      path: string;
      className?: string;
      payload: ShellSurfaceCreateRequest["payload"];
      placement: ShellSurfaceCreateRequest["placement"];
    } = {
      componentId: request.componentId,
      path: request.path,
      payload: request.payload,
      placement: request.placement,
      role: request.role,
      surfaceId: request.surfaceId,
    };

    if (request.className !== undefined) snapshot.className = request.className;
    snapshots.push(Object.freeze(snapshot));
  }

  return Object.freeze(snapshots);
}

function surfaceIds(layout: ShellComposedLayout): readonly string[] {
  return layout.surfaces.map((surface) => surface.id).sort();
}

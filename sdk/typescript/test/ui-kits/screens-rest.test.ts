import assert from "node:assert/strict";
import { test } from "node:test";

import activityScreen from "../../../../ui_kits/desktop/screens/activity.ts";
import filesScreen from "../../../../ui_kits/desktop/screens/files.ts";
import lockScreen from "../../../../ui_kits/desktop/screens/lock.ts";
import notificationsScreen from "../../../../ui_kits/desktop/screens/notifications.ts";
import shellScreen from "../../../../ui_kits/desktop/screens/shell.ts";
import tilingScreen from "../../../../ui_kits/desktop/screens/tiling.ts";
import type {
  FilesOpsCapabilityPort,
  FilesOpsRequest,
} from "../../../../ui_kits/desktop/viewmodels/files-ops.ts";
import type {
  ActivityMetricsPort,
} from "../../../../ui_kits/desktop/viewmodels/Activity.ts";
import type {
  LockAuthPort,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";
import type {
  ShellCommandRequest,
  ShellSessionPort,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";
import type {
  TilingWindowManagerPort,
} from "../../../../ui_kits/desktop/viewmodels/Tiling.ts";
import {
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  DesktopHost,
  DesktopHostResult,
  DesktopMaybePromise,
  FilesErrorResponse,
  FilesResponse,
  Rect,
  ShellResult,
  TextureId,
  WindowId,
} from "../../src/desktop-sdk/index.ts";

test("files screen refreshes the current directory through the files view-model", async () => {
  const calls: FilesOpsRequest[] = [];
  const root = element();
  const refresh = element({
    "data-vita-action": "files.refresh",
  });
  const path = element({
    "data-vita-bind-text": "files.path",
  });
  const entries = element({
    "data-vita-bind-list": "files.entries",
  });
  entries.appendChild(element({
    "data-vita-key": "template",
  }, "template"));
  root.appendChild(refresh);
  root.appendChild(path);
  root.appendChild(entries);

  const screen = await resolveMaybe(hydrateScreen(root, filesScreen, hostWith({
    files: filesPort(calls),
  })));

  assert.equal(screen.ok, true);
  assert.equal(path.textContent, "/src");
  assert.equal(entries.children.length, 0);

  root.dispatch("click", refresh);
  await flush();

  assert.deepEqual(calls.map((request) => `${request.op}:${request.path}`), ["list:/src"]);
  assert.equal(entries.children.length, 2);
  assert.equal(entries.children[0]?.textContent, "apps  Folder  -  2026-06-24T09:00:00Z");
  assert.equal(entries.children[1]?.textContent, "kernel.ts  File  8.2 KB  2026-06-24T10:18:00Z");
});

test("shell screen submits a command and renders command output", async () => {
  const commands: ShellCommandRequest[] = [];
  const root = element();
  const submit = element({
    "data-vita-action": "shell.submit",
    "data-vita-command": "vita status",
  });
  const cwd = element({
    "data-vita-bind-text": "shell.cwd",
  });
  const output = element({
    "data-vita-bind-list": "shell.output",
  });
  output.appendChild(element({
    "data-vita-key": "template",
  }, "template"));
  root.appendChild(submit);
  root.appendChild(cwd);
  root.appendChild(output);

  const screen = await resolveMaybe(hydrateScreen(root, shellScreen, hostWith({
    shellSession: shellSession(commands),
  })));

  assert.equal(screen.ok, true);
  assert.equal(cwd.textContent, "~/vita");

  root.dispatch("click", submit);
  await flush();

  assert.equal(commands[0]?.input, "vita status");
  assert.equal(output.children.length, 2);
  assert.equal(output.children[0]?.textContent, "> vita status");
  assert.equal(output.children[1]?.textContent, "  ok");
});

test("activity screen samples metrics and reflects process rows", async () => {
  const root = element();
  const refresh = element({
    "data-vita-action": "activity.refresh",
  });
  const cpu = element({
    "data-vita-bind-text": "activity.cpu",
  });
  const processes = element({
    "data-vita-bind-list": "activity.processes",
  });
  processes.appendChild(element({
    "data-vita-key": "template",
  }, "template"));
  root.appendChild(refresh);
  root.appendChild(cpu);
  root.appendChild(processes);

  const screen = await resolveMaybe(hydrateScreen(root, activityScreen, hostWith({
    activityClock: Object.freeze({
      nowMs(): number {
        return 1_000;
      },
    }),
    metrics: activityMetrics(),
  })));

  assert.equal(screen.ok, true);
  assert.equal(cpu.textContent, "0%");

  root.dispatch("click", refresh);
  await flush();

  assert.equal(cpu.textContent, "64%");
  assert.equal(processes.children.length, 2);
  assert.equal(processes.children[0]?.textContent, "Studio  46%  612 MB");
  assert.equal(processes.children[1]?.textContent, "Shell  12%  88 MB");
});

test("notifications screen toggles a registered control", async () => {
  const root = element();
  const controls = element({
    "data-vita-bind-list": "notifications.controls",
  });
  controls.appendChild(element({
    "data-vita-key": "template",
  }, "template"));
  root.appendChild(controls);

  const screen = await resolveMaybe(hydrateScreen(root, notificationsScreen, hostWith({})));

  assert.equal(screen.ok, true);

  const wifi = childWithDataset(controls, "vitaControlId", "wifi");

  assert.notEqual(wifi, undefined);
  assert.equal(wifi?.textContent, "Wi-Fi On");

  root.dispatch("click", requiredElement(wifi));

  assert.equal(wifi?.textContent, "Wi-Fi Off");
});

test("lock screen submits credentials and reflects unlocked state", async () => {
  const authCalls: string[] = [];
  const root = element();
  const submit = element({
    "data-vita-action": "lock.submit",
    "data-vita-credential": "secret",
  });
  const state = element({
    "data-vita-bind-text": "lock.state",
  });
  root.appendChild(submit);
  root.appendChild(state);

  const screen = await resolveMaybe(hydrateScreen(root, lockScreen, hostWith({
    lockAuth: lockAuth(authCalls),
  })));

  assert.equal(screen.ok, true);
  assert.equal(state.textContent, "locked");

  root.dispatch("click", submit);
  await flush();

  assert.deepEqual(authCalls, ["secret"]);
  assert.equal(state.textContent, "unlocked");
});

test("tiling screen cycles layout and emits window-manager intents", async () => {
  const events: string[] = [];
  const root = element();
  const cycle = element({
    "data-vita-action": "tiling.cycleLayout",
  });
  const layout = element({
    "data-vita-bind-text": "tiling.layout",
  });
  root.appendChild(cycle);
  root.appendChild(layout);

  const screen = await resolveMaybe(hydrateScreen(root, tilingScreen, hostWith({
    windowManager: windowManager(events),
  })));

  assert.equal(screen.ok, true);
  assert.equal(layout.textContent, "tile");

  root.dispatch("click", cycle);

  assert.equal(layout.textContent, "columns");
  assert.equal(events.length > 0, true);
});

interface TestHostExtensions {
  readonly activityClock?: {
    nowMs(): number;
  };
  readonly files?: FilesOpsCapabilityPort;
  readonly lockAuth?: LockAuthPort;
  readonly metrics?: ActivityMetricsPort;
  readonly shellSession?: ShellSessionPort;
  readonly windowManager?: TilingWindowManagerPort;
}

function hostWith(extensions: TestHostExtensions): DesktopHost {
  const host = {
    ...createSurfaceHost(undefined),
    ...extensions,
  };

  return Object.freeze(host);
}

function filesPort(calls: FilesOpsRequest[]): FilesOpsCapabilityPort {
  return Object.freeze({
    request(request: FilesOpsRequest): FilesResponse | FilesErrorResponse {
      calls.push(request);

      if (request.op === "list" && request.path === "/src") {
        return Object.freeze({
          entries: Object.freeze([
            entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
            entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
          ]),
        });
      }

      return Object.freeze({
        error: Object.freeze({
          code: "AccessForbidden",
          message: "path unavailable",
        }),
      });
    },
  });
}

function shellSession(commands: ShellCommandRequest[]): ShellSessionPort {
  return Object.freeze({
    runCommand(request: ShellCommandRequest): DesktopHostResult<{
      readonly cwd: string;
      readonly exitCode: number;
      readonly lines: readonly string[];
    }> {
      commands.push(request);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          cwd: request.cwd,
          exitCode: 0,
          lines: Object.freeze(["ok"]),
        }),
      });
    },
  });
}

function activityMetrics(): ActivityMetricsPort {
  return Object.freeze({
    sample(): DesktopHostResult<{
      readonly cpuPercent: number;
      readonly memory: {
        readonly totalBytes: number;
        readonly usedBytes: number;
      };
      readonly processes: readonly {
        readonly cpuPercent: number;
        readonly memoryBytes: number;
        readonly name: string;
        readonly pid: number;
      }[];
    }> {
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          cpuPercent: 64,
          memory: Object.freeze({
            totalBytes: 16 * 1024 * 1024 * 1024,
            usedBytes: 8 * 1024 * 1024 * 1024,
          }),
          processes: Object.freeze([
            Object.freeze({
              cpuPercent: 12,
              memoryBytes: 88 * 1024 * 1024,
              name: "Shell",
              pid: 31,
            }),
            Object.freeze({
              cpuPercent: 46,
              memoryBytes: 612 * 1024 * 1024,
              name: "Studio",
              pid: 14,
            }),
          ]),
        }),
      });
    },
  });
}

function lockAuth(calls: string[]): LockAuthPort {
  return Object.freeze({
    authenticate(request: {
      readonly attemptNumber: number;
      readonly credential: string;
      readonly userId: string;
    }): DesktopHostResult<{
      readonly user: {
        readonly displayName: string;
        readonly id: string;
        readonly initials: string;
      };
    }> {
      calls.push(request.credential);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          user: Object.freeze({
            displayName: "Vita User",
            id: request.userId,
            initials: "V",
          }),
        }),
      });
    },
  });
}

function windowManager(events: string[]): TilingWindowManagerPort {
  return Object.freeze({
    repositionTexture(textureId: TextureId, rect: Rect, windowId: WindowId): void {
      events.push(`move:${windowId}:${textureId}:${rect.width}x${rect.height}`);
    },
    setFocus(windowId: WindowId | null): void {
      events.push(`focus:${windowId ?? "none"}`);
    },
    setTextureVisibility(textureId: TextureId, visible: boolean, windowId: WindowId): void {
      events.push(`visible:${windowId}:${textureId}:${visible}`);
    },
  });
}

function entry(
  name: string,
  kind: "file" | "dir" | "symlink-skipped",
  size: number,
  mtime: string,
): NonNullable<FilesResponse["entries"]>[number] {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

async function resolveMaybe<T>(value: DesktopMaybePromise<T>): Promise<T> {
  return await value;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

class StubElement implements VitaElement {
  readonly dataset: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  readonly children: StubElement[] = [];
  readonly classList = Object.freeze({
    toggle: (token: string, force?: boolean): boolean => {
      const enabled = force ?? !this.#classes.has(token);

      if (enabled) {
        this.#classes.add(token);
      } else {
        this.#classes.delete(token);
      }

      return enabled;
    },
  });

  readonly #attributes = new Map<string, string>();
  readonly #classes = new Set<string>();
  readonly #listeners = new Map<string, VitaEventListener[]>();
  #parent: StubElement | null = null;
  #text = "";

  constructor(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = "") {
    this.#text = text;

    const keys = Object.keys(attrs);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : attrs[key];

      if (key !== undefined && value !== undefined) {
        this.setAttribute(key, value);
      }
    }
  }

  get textContent(): string {
    return this.#text;
  }

  set textContent(value: string | null) {
    this.#text = value ?? "";
  }

  querySelectorAll(selector: string): VitaElementList {
    const selectors = selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    const output: StubElement[] = [];

    this.#collectMatches(selectors, output);
    return output;
  }

  closest(selector: string): VitaElement | null {
    let current: StubElement | null = this;

    while (current !== null) {
      if (matchesSelector(current, selector)) return current;
      current = current.#parent;
    }

    return null;
  }

  addEventListener(type: string, listener: VitaEventListener): void {
    let listeners = this.#listeners.get(type);

    if (listeners === undefined) {
      listeners = [];
      this.#listeners.set(type, listeners);
    }

    listeners.push(listener);
  }

  removeEventListener(type: string, listener: VitaEventListener): void {
    const listeners = this.#listeners.get(type);

    if (listeners === undefined) return;

    const index = listeners.indexOf(listener);

    if (index >= 0) listeners.splice(index, 1);
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  cloneNode(deep = false): VitaElement {
    const clone = new StubElement();

    for (const [name, value] of this.#attributes) {
      clone.setAttribute(name, value);
    }

    clone.#text = this.#text;

    if (deep) {
      for (let index = 0; index < this.children.length; index += 1) {
        const child = this.children[index];

        if (child !== undefined) {
          clone.appendChild(child.cloneNode(true));
        }
      }
    }

    return clone;
  }

  appendChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) {
      throw new TypeError("stub only accepts stub children");
    }

    if (child.#parent !== null) {
      child.#parent.removeChild(child);
    }

    child.#parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) {
      throw new TypeError("stub only removes stub children");
    }

    const index = this.children.indexOf(child);

    if (index < 0) throw new Error("child not found");

    this.children.splice(index, 1);
    child.#parent = null;
    return child;
  }

  dispatch(type: string, target: StubElement): void {
    const listeners = this.#listeners.get(type) ?? [];
    const event: VitaEventLike = Object.freeze({
      target,
      type,
    });
    const pending = [...listeners];

    for (let index = 0; index < pending.length; index += 1) {
      pending[index]?.(event);
    }
  }

  attribute(name: string): string | undefined {
    return this.#attributes.get(name);
  }

  #collectMatches(selectors: readonly string[], output: StubElement[]): void {
    for (let index = 0; index < this.children.length; index += 1) {
      const child = this.children[index];

      if (child === undefined) continue;

      for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
        const selector = selectors[selectorIndex];

        if (selector !== undefined && matchesSelector(child, selector)) {
          output.push(child);
          break;
        }
      }

      child.#collectMatches(selectors, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function childWithDataset(parent: StubElement, key: string, value: string): StubElement | undefined {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];

    if (child?.dataset[key] === value) return child;
  }

  return undefined;
}

function requiredElement(elementValue: StubElement | undefined): StubElement {
  if (elementValue === undefined) assert.fail("expected element to exist");

  return elementValue;
}

function matchesSelector(element: StubElement, selector: string): boolean {
  if (!selector.startsWith("[") || !selector.endsWith("]")) return false;

  const attrName = selector.slice(1, -1);

  return element.attribute(attrName) !== undefined;
}

function datasetKey(name: string): string {
  const raw = name.slice("data-".length).toLowerCase();
  let output = "";

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "-" && next !== undefined && next >= "a" && next <= "z") {
      output += next.toUpperCase();
      index += 1;
    } else {
      output += char ?? "";
    }
  }

  return output;
}

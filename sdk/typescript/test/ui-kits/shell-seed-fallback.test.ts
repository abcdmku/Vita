import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  applyBindSinks,
  captureBindTargets,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import {
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import shellScreen from "../../../../ui_kits/desktop/screens/shell.ts";
import {
  createShellViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";
import type {
  ShellCommandRequest,
  ShellCommandResult,
  ShellSessionPort,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";
import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../src/desktop-sdk/index.ts";

const SHELL_HTML_PATH = resolve("ui_kits/desktop/Shell.html");
const FABRICATED_STRINGS = Object.freeze([
  "kernel ready",
  "mounted vfs",
  "compositor online",
  "0.42s",
  "60fps",
  "k.processes.where",
  "pid: 14",
]);

test("shell output list markup does not contain the fabricated boot transcript", () => {
  const container = shellOutputContainerHtml();
  const visibleText = htmlText(container);

  for (let index = 0; index < FABRICATED_STRINGS.length; index += 1) {
    const needle = FABRICATED_STRINGS[index];

    if (needle !== undefined) {
      assert.equal(container.includes(needle), false, `raw shell output container still includes ${needle}`);
      assert.equal(visibleText.includes(needle), false, `shell output text still includes ${needle}`);
    }
  }
});

test("empty shell output clears un-keyed seed rows in degraded no-host mode", async () => {
  const dom = shellDom();
  const screen = await resolveMaybe(hydrateScreen(dom.root, shellScreen, hostWith({})));

  assert.equal(screen.ok, true);
  if (!screen.ok) assert.fail("expected shell screen to hydrate");
  assert.deepEqual(screen.snapshot().activeTab.outputBuffer, []);
  assert.deepEqual(renderedRows(dom.output), []);
  assert.deepEqual(renderedKeys(dom.output), []);
});

test("shell output renders only the live buffer rows after a real session command", async () => {
  const calls: ShellCommandRequest[] = [];
  const dom = shellDom("vita status");
  const screen = await resolveMaybe(hydrateScreen(dom.root, shellScreen, hostWith({
    shellSession: shellSession(calls, Object.freeze(["real kernel", "real compositor"])),
  })));

  assert.equal(screen.ok, true);
  assert.deepEqual(renderedRows(dom.output), []);

  dom.root.dispatch("click", dom.submit);
  await flush();

  assert.deepEqual(calls.map((request) => request.input), ["vita status"]);
  assert.deepEqual(renderedRows(dom.output), [
    "> vita status",
    "  real kernel",
    "  real compositor",
  ]);
  assert.deepEqual(renderedKeys(dom.output), ["line:0", "line:1", "line:2"]);
  assertNoFabricatedRows(dom.output);
});

test("applyListTarget reconciliation leaves only keyed rows derived from shell.output", async () => {
  const calls: ShellCommandRequest[] = [];
  const vm = createShellViewModel({
    session: shellSession(calls, Object.freeze(["from live buffer"])),
  });
  const output = outputListWithFabricatedSeed();
  const root = element();

  root.appendChild(output);

  const targets = captureBindTargets(root);

  applyBindSinks(targets, vm.snapshot(), shellScreen.binds);

  assert.deepEqual(renderedRows(output), []);

  const submitted = await vm.submit("whoami");

  assert.equal(submitted.ok, true);

  applyBindSinks(targets, vm.snapshot(), shellScreen.binds);

  assert.deepEqual(renderedRows(output), [
    "> whoami",
    "  from live buffer",
  ]);
  assert.deepEqual(renderedKeys(output), ["line:0", "line:1"]);
  assertNoFabricatedRows(output);
});

interface ShellDom {
  readonly root: StubElement;
  readonly output: StubElement;
  readonly submit: StubElement;
}

interface HostExtensions {
  readonly shellSession?: ShellSessionPort;
}

function shellDom(command = "pwd"): ShellDom {
  const root = element();
  const submit = element({
    "data-vita-action": "shell.submit",
    "data-vita-command": command,
  });
  const output = outputListWithFabricatedSeed();

  root.appendChild(submit);
  root.appendChild(output);

  return Object.freeze({
    output,
    root,
    submit,
  });
}

function outputListWithFabricatedSeed(): StubElement {
  const output = element({
    "data-vita-bind-list": "shell.output",
  });

  output.appendChild(element({}, "// Vita shell - a TypeScript REPL with full system access"));
  output.appendChild(element({}, "import { Kernel } from \"./kernel.ts\""));
  output.appendChild(element({}, "await k.boot(\"init.ts\")"));
  output.appendChild(element({}, "kernel ready 0.42s"));
  output.appendChild(element({}, "mounted vfs at /"));
  output.appendChild(element({}, "compositor online 60fps"));
  output.appendChild(element({}, "k.processes.where(p => p.cpu > 1)"));
  output.appendChild(element({}, "[ { pid: 14, name: \"compositor\", cpu: 3.8 } ]"));
  output.appendChild(element({
    "data-vita-key": "template",
  }, "template"));

  return output;
}

function hostWith(extensions: HostExtensions): DesktopHost {
  const host = {
    ...createSurfaceHost(undefined),
    ...extensions,
  };

  return Object.freeze(host);
}

function shellSession(
  calls: ShellCommandRequest[],
  lines: readonly string[],
): ShellSessionPort {
  return Object.freeze({
    runCommand(request: ShellCommandRequest): ShellCommandResult {
      calls.push(request);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          cwd: request.cwd,
          exitCode: 0,
          lines: Object.freeze([...lines]),
        }),
      });
    },
  });
}

function renderedRows(output: StubElement): readonly string[] {
  const rows: string[] = [];

  for (let index = 0; index < output.children.length; index += 1) {
    const child = output.children[index];

    if (child !== undefined) rows.push(child.textContent);
  }

  return Object.freeze(rows);
}

function renderedKeys(output: StubElement): readonly string[] {
  const keys: string[] = [];

  for (let index = 0; index < output.children.length; index += 1) {
    const key = output.children[index]?.dataset.vitaKey;

    if (key !== undefined) keys.push(key);
  }

  return Object.freeze(keys);
}

function assertNoFabricatedRows(output: StubElement): void {
  const rows = renderedRows(output);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];

    if (row === undefined) continue;

    for (let needleIndex = 0; needleIndex < FABRICATED_STRINGS.length; needleIndex += 1) {
      const needle = FABRICATED_STRINGS[needleIndex];

      if (needle !== undefined) {
        assert.equal(row.includes(needle), false, `rendered shell row still includes ${needle}`);
      }
    }
  }
}

function shellOutputContainerHtml(): string {
  const html = readFileSync(SHELL_HTML_PATH, "utf8");
  const marker = 'data-vita-bind-list="shell.output"';
  const markerIndex = html.indexOf(marker);

  assert.notEqual(markerIndex, -1, "Shell.html must contain the shell.output bind-list");

  const start = html.lastIndexOf("<div", markerIndex);

  assert.notEqual(start, -1, "shell.output bind-list must be on a div");

  return balancedDiv(html, start);
}

function balancedDiv(source: string, start: number): string {
  let index = start;
  let depth = 0;

  while (index < source.length) {
    const nextOpen = source.indexOf("<div", index);
    const nextClose = source.indexOf("</div>", index);

    if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
      depth += 1;
      index = nextOpen + "<div".length;
      continue;
    }

    if (nextClose >= 0) {
      depth -= 1;
      index = nextClose + "</div>".length;

      if (depth === 0) return source.slice(start, index);

      continue;
    }

    break;
  }

  assert.fail("shell.output bind-list div was not balanced");
}

function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"");
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

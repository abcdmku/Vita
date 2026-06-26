import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import type {
  FilesAppBootstrapRuntime,
  FilesAppRuntime,
} from "../../../../apps/files/runtime/bootstrap.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

type FilesAppBootstrapModule = Pick<
  typeof import("../../../../apps/files/runtime/bootstrap.ts"),
  "bootstrapFilesApp"
>;

test("Files app HTML removes the baked seed rows and keeps a keyed binder template", () => {
  const html = readFilesHtml();
  const section = filesEntriesSection(html);
  const listBody = filesEntriesListBody(html);

  assert.equal(html.includes('data-vita-entry-name="apps"'), false);
  assert.equal(html.includes('data-vita-entry-name="readme.md"'), false);
  assert.equal(listBody.includes(">Folder<"), false);
  assert.equal(listBody.includes(">2 KB<"), false);
  assert.equal(listBody.includes('class="row header"'), false);
  assert.notEqual(section.indexOf('class="row header"'), -1);
  assert.ok(section.indexOf('class="row header"') < section.indexOf('data-vita-bind-list="files.entries"'));
  assert.equal(listBody.includes('data-vita-bind-list="files.entries"'), true);
  assert.equal(listBody.includes('data-vita-key="entry:template"'), true);
  assert.equal(listBody.includes('data-vita-bind-text="files.entry.name"'), true);
  assert.equal(html.includes('<script type="module" src="runtime/bootstrap.js"></script>'), true);
});

test("Files app emitted bootstrap bundle exists for the HTML-loaded runtime", async () => {
  const bundleUrl = new URL("../../../../apps/files/runtime/bootstrap.js", import.meta.url);
  const stat = statSync(bundleUrl);
  const code = readFileSync(bundleUrl, "utf8");
  const bootstrapFilesApp = await loadBootstrapFilesApp();

  assert.ok(stat.size > 5_000);
  assert.equal(typeof bootstrapFilesApp, "function");
  assert.match(code, /bootstrapFilesApp/u);
  assert.match(code, /requestFile/u);
  assert.doesNotMatch(code, /\bfrom\s*["']/u);
  assert.doesNotMatch(code, /\bimport\s*["']/u);
  assert.doesNotMatch(code, /bootstrap\.ts["']/u);
});

test("Files app bootstrap hydrates entries and path from the injected host bridge files port", async () => {
  const bootstrapFilesApp = await loadBootstrapFilesApp();
  const calls: FilesRequest[] = [];
  const dom = filesDom();
  const runtime = expectActive(await bootstrapFilesApp({
    initialPath: "/workspace",
    root: dom.root,
    transport: filesBridge(calls, (request) => {
      assert.equal(request.op, "list");
      assert.equal(request.grant, "workspace");
      assert.equal(request.path, "/workspace");

      return listResponse(Object.freeze([
        entry("zeta.log", "file", 3_072, "2026-06-25T11:00:00Z"),
        entry("notes", "dir", 0, "2026-06-25T10:00:00Z"),
        entry("alpha.txt", "file", 512, "2026-06-25T09:00:00Z"),
      ]));
    }),
  }));

  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace",
    },
  ]);
  assert.equal(dom.path.textContent, "/workspace");
  assert.equal(dom.root.getAttribute("data-vita-status"), "ready");
  assert.equal(dom.root.getAttribute("data-vita-error-code"), "");
  assert.equal(dom.notice.textContent, "");
  assertHeaderSurvived(dom);
  assert.deepEqual(runtime.snapshot().entries, [
    {
      kind: "dir",
      modified: "2026-06-25T10:00:00Z",
      name: "notes",
      size: 0,
    },
    {
      kind: "file",
      modified: "2026-06-25T09:00:00Z",
      name: "alpha.txt",
      size: 512,
    },
    {
      kind: "file",
      modified: "2026-06-25T11:00:00Z",
      name: "zeta.log",
      size: 3_072,
    },
  ]);

  const rows = entryRows(dom.list);

  assert.deepEqual(rows.map(rowName), ["notes", "alpha.txt", "zeta.log"]);
  assert.deepEqual(rowCells(requiredElement(rows[0])), ["▣", "notes", "Folder", "-", "2026-06-25T10:00:00Z"]);
  assert.deepEqual(rowCells(requiredElement(rows[1])), ["□", "alpha.txt", "File", "512 B", "2026-06-25T09:00:00Z"]);
  assert.deepEqual(rowCells(requiredElement(rows[2])), ["□", "zeta.log", "File", "3 KB", "2026-06-25T11:00:00Z"]);
});

test("Files app bootstrap fails closed honestly when grant or port injection is missing", async () => {
  const bootstrapFilesApp = await loadBootstrapFilesApp();
  const grantlessCalls: FilesRequest[] = [];
  const grantlessDom = filesDom();
  const grantless = expectActive(await bootstrapFilesApp({
    host: hostWith({
      files: filesPort(grantlessCalls, () => listResponse(Object.freeze([]))),
      grants: Object.freeze([]),
    }),
    initialPath: "/secure",
    root: grantlessDom.root,
  }));

  assert.deepEqual(grantlessCalls, []);
  assert.equal(grantless.snapshot().error?.code, "MissingFilesGrant");
  assert.equal(grantlessDom.root.getAttribute("data-vita-status"), "forbidden");
  assert.equal(grantlessDom.root.getAttribute("data-vita-error-code"), "MissingFilesGrant");
  assert.match(grantlessDom.notice.textContent ?? "", /MissingFilesGrant/u);
  assertHeaderSurvived(grantlessDom);
  assert.deepEqual(entryRows(grantlessDom.list), []);

  const portlessDom = filesDom();
  const portless = expectActive(await bootstrapFilesApp({
    host: hostWith({
      grants: Object.freeze([
        grant("files.read", "workspace"),
      ]),
    }),
    initialPath: "/workspace",
    root: portlessDom.root,
  }));

  assert.equal(portless.snapshot().error?.code, "MissingFilesPort");
  assert.equal(portlessDom.root.getAttribute("data-vita-status"), "error");
  assert.equal(portlessDom.root.getAttribute("data-vita-error-code"), "MissingFilesPort");
  assert.match(portlessDom.notice.textContent ?? "", /MissingFilesPort/u);
  assertHeaderSurvived(portlessDom);
  assert.deepEqual(entryRows(portlessDom.list), []);
});

test("Files app bootstrap fails closed when transport exists without an injected grant package", async () => {
  const bootstrapFilesApp = await loadBootstrapFilesApp();
  const calls: FilesRequest[] = [];
  const dom = filesDom();
  const runtime = expectActive(await bootstrapFilesApp({
    initialPath: "/transport",
    root: dom.root,
    transport: Object.freeze({
      request(request: SurfaceHostRequest) {
        assert.equal(request.method, "requestFile");

        const fileRequest = expectFilesRequest(request.args[0]);

        calls.push(fileRequest);
        return listResponse(Object.freeze([
          entry("should-not-render.txt", "file", 128, "2026-06-25T13:00:00Z"),
        ]));
      },
    }),
  }));

  assert.deepEqual(calls, []);
  assert.equal(runtime.snapshot().error?.code, "MissingFilesGrant");
  assert.equal(dom.root.getAttribute("data-vita-status"), "forbidden");
  assert.equal(dom.root.getAttribute("data-vita-error-code"), "MissingFilesGrant");
  assert.match(dom.notice.textContent ?? "", /MissingFilesGrant/u);
  assertHeaderSurvived(dom);
  assert.deepEqual(entryRows(dom.list), []);
});

test("Files app select and open actions update state through the injected files port", async () => {
  const bootstrapFilesApp = await loadBootstrapFilesApp();
  const calls: FilesRequest[] = [];
  const dom = filesDom();
  const runtime = expectActive(await bootstrapFilesApp({
    host: hostWith({
      files: filesPort(calls, (request) => {
        if (request.path === "/workspace") {
          return listResponse(Object.freeze([
            entry("report.txt", "file", 1_536, "2026-06-25T12:00:00Z"),
            entry("docs", "dir", 0, "2026-06-25T11:30:00Z"),
          ]));
        }
        if (request.path === "/workspace/docs") {
          return listResponse(Object.freeze([
            entry("guide.md", "file", 2_560, "2026-06-25T12:30:00Z"),
          ]));
        }

        return forbidden();
      }),
      grants: Object.freeze([
        grant("files.read", "workspace"),
      ]),
    }),
    initialPath: "/workspace",
    root: dom.root,
  }));

  assert.deepEqual(calls.map(requestKey), ["workspace:list:/workspace"]);
  assert.deepEqual(entryRows(dom.list).map(rowName), ["docs", "report.txt"]);

  const reportRow = requiredElement(rowByName(dom.list, "report.txt"));

  dom.root.dispatch("click", reportRow);
  await flush();

  assert.equal(runtime.snapshot().selected?.name, "report.txt");
  assert.equal(rowByName(dom.list, "report.txt")?.getAttribute("data-vita-selected"), "true");
  assert.deepEqual(calls.map(requestKey), ["workspace:list:/workspace"]);

  const docsRow = requiredElement(rowByName(dom.list, "docs"));

  dom.root.dispatch("click", docsRow);
  await flush();

  assert.deepEqual(calls.map(requestKey), [
    "workspace:list:/workspace",
    "workspace:list:/workspace/docs",
  ]);
  assert.equal(runtime.snapshot().path, "/workspace/docs");
  assert.equal(dom.path.textContent, "/workspace/docs");
  assert.equal(runtime.snapshot().selected, undefined);
  assert.deepEqual(entryRows(dom.list).map(rowName), ["guide.md"]);
});

interface FilesDom {
  readonly content: StubElement;
  readonly header: StubElement;
  readonly root: StubElement;
  readonly path: StubElement;
  readonly notice: StubElement;
  readonly list: StubElement;
}

interface HostInput {
  readonly files?: FilesCapabilityPort;
  readonly grants?: readonly DesktopCapabilityGrant[];
}

function readFilesHtml(): string {
  return readFileSync(new URL("../../../../apps/files/index.html", import.meta.url), "utf8");
}

function filesEntriesSection(html: string): string {
  const marker = 'data-vita-bind-list="files.entries"';
  const markerIndex = html.indexOf(marker);

  assert.notEqual(markerIndex, -1);

  const sectionStart = html.lastIndexOf("<section", markerIndex);
  const sectionEnd = html.indexOf("</section>", markerIndex);

  assert.notEqual(sectionStart, -1);
  assert.notEqual(sectionEnd, -1);

  return html.slice(sectionStart, sectionEnd);
}

function filesEntriesListBody(html: string): string {
  const marker = 'data-vita-bind-list="files.entries"';
  const markerIndex = html.indexOf(marker);

  assert.notEqual(markerIndex, -1);

  const listStart = html.lastIndexOf("<div", markerIndex);
  const listEnd = html.indexOf("</div>", markerIndex);

  assert.notEqual(listStart, -1);
  assert.notEqual(listEnd, -1);

  return html.slice(listStart, listEnd);
}

async function loadBootstrapFilesApp(): Promise<FilesAppBootstrapModule["bootstrapFilesApp"]> {
  const moduleValue: unknown = await import(new URL("../../../../apps/files/runtime/bootstrap.js", import.meta.url).href);

  if (!isObjectRecord(moduleValue)) assert.fail("expected bootstrap bundle module object");

  const bootstrapFilesApp = readOwnData(moduleValue, "bootstrapFilesApp");

  if (typeof bootstrapFilesApp !== "function") assert.fail("expected bootstrapFilesApp export");

  return bootstrapFilesApp as FilesAppBootstrapModule["bootstrapFilesApp"];
}

function filesDom(): FilesDom {
  const root = element({
    "data-vita-app": "vita.app.files",
    "data-vita-bind-attr-0": "data-vita-status:files.status",
    "data-vita-bind-attr-1": "data-vita-error-code:files.errorCode",
  });
  const refresh = element({
    "data-vita-action": "files.refresh",
  });
  const up = element({
    "data-vita-action": "files.up",
  });
  const path = element({
    "data-vita-bind-text": "files.path",
  }, "/");
  const notice = element({
    "data-vita-bind-text": "files.notice",
  });
  const content = element();
  const header = element({}, "header");
  const list = element({
    "data-vita-bind-list": "files.entries",
  });
  const template = element({
    "data-vita-action": "files.select",
    "data-vita-bind-attr-0": "data-vita-action:files.entry.action",
    "data-vita-bind-attr-1": "data-vita-entry-name:files.entry.name",
    "data-vita-bind-attr-2": "data-vita-path:files.entry.path",
    "data-vita-bind-attr-3": "data-vita-selected:files.entry.selected",
    "data-vita-entry-name": "",
    "data-vita-key": "entry:template",
    "data-vita-path": "",
    "data-vita-selected": "false",
  });

  template.appendChild(element({
    "data-vita-bind-text": "files.entry.icon",
  }));
  template.appendChild(element({
    "data-vita-bind-text": "files.entry.name",
  }));
  template.appendChild(element({
    "data-vita-bind-text": "files.entry.kind",
  }));
  template.appendChild(element({
    "data-vita-bind-text": "files.entry.size",
  }));
  template.appendChild(element({
    "data-vita-bind-text": "files.entry.modified",
  }));
  list.appendChild(template);
  root.appendChild(refresh);
  root.appendChild(up);
  root.appendChild(path);
  root.appendChild(notice);
  content.appendChild(header);
  content.appendChild(list);
  root.appendChild(content);

  return Object.freeze({
    content,
    header,
    list,
    notice,
    path,
    root,
  });
}

function assertHeaderSurvived(dom: FilesDom): void {
  assert.equal(childIndex(dom.content, dom.header), 0);
  assert.equal(childIndex(dom.list, dom.header), -1);
  assert.equal(dom.header.textContent, "header");
}

function filesBridge(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): SurfaceHostTransport {
  return Object.freeze({
    package: packageWith(Object.freeze([
      grant("files.read", "workspace"),
    ])),
    request(request: SurfaceHostRequest) {
      assert.equal(request.method, "requestFile");

      const fileRequest = expectFilesRequest(request.args[0]);

      calls.push(fileRequest);
      return handler(fileRequest);
    },
  });
}

function hostWith(input: HostInput): DesktopHost {
  const hostPackage = packageWith(input.grants ?? Object.freeze([
    grant("files.read", "workspace"),
  ]));
  const base = createSurfaceHost(undefined, {
    package: hostPackage,
  });

  if (input.files !== undefined) {
    return Object.freeze({
      ...base,
      files: input.files,
      package: hostPackage,
    });
  }

  return Object.freeze({
    ...base,
    package: hostPackage,
  });
}

function packageWith(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "index.html",
    id: "vita.app.files.test",
    sdkVersion: "0.0.0",
    version: "0.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId: string): DesktopCapabilityGrant {
  return Object.freeze({
    capability,
    resourceId,
  });
}

function filesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest) {
      calls.push(request);
      return handler(request);
    },
  });
}

function listResponse(entries: readonly FilesEntry[]): FilesResponse {
  return Object.freeze({
    entries: Object.freeze([...entries]),
  });
}

function entry(
  name: string,
  kind: FilesEntry["kind"],
  size: number,
  mtime: string,
): FilesEntry {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

function forbidden(): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path unavailable",
    }),
  });
}

function expectActive(runtime: FilesAppBootstrapRuntime): FilesAppRuntime {
  if (!runtime.ok) {
    assert.fail(`expected active files app runtime: ${runtime.error.message}`);
  }

  return runtime;
}

function requestKey(request: FilesRequest): string {
  return `${request.grant}:${request.op}:${request.path}`;
}

function expectFilesRequest(value: unknown): FilesRequest {
  if (!isFilesRequest(value)) {
    assert.fail("expected files request");
  }

  return value;
}

function isFilesRequest(value: unknown): value is FilesRequest {
  if (!isObjectRecord(value)) return false;

  const op = readOwnData(value, "op");
  const grantValue = readOwnData(value, "grant");
  const path = readOwnData(value, "path");
  const data = readOwnData(value, "data");

  return (
    (op === "list" || op === "read" || op === "write" || op === "stat") &&
    typeof grantValue === "string" &&
    typeof path === "string" &&
    (data === undefined || typeof data === "string")
  );
}

function entryRows(list: StubElement): readonly StubElement[] {
  const output: StubElement[] = [];

  for (let index = 0; index < list.children.length; index += 1) {
    const child = list.children[index];
    const key = child?.dataset.vitaKey;

    if (child !== undefined && key !== undefined && key.startsWith("entry:")) {
      output.push(child);
    }
  }

  return Object.freeze(output);
}

function rowByName(list: StubElement, name: string): StubElement | undefined {
  const rows = entryRows(list);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row !== undefined && rowName(row) === name) return row;
  }

  return undefined;
}

function rowName(row: StubElement): string {
  return row.dataset.vitaEntryName ?? "";
}

function rowCells(row: StubElement): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < row.children.length; index += 1) {
    output.push(row.children[index]?.textContent ?? "");
  }

  return Object.freeze(output);
}

function requiredElement(elementValue: StubElement | undefined): StubElement {
  if (elementValue === undefined) assert.fail("expected element to exist");

  return elementValue;
}

function childIndex(parent: StubElement, child: StubElement): number {
  for (let index = 0; index < parent.children.length; index += 1) {
    if (parent.children[index] === child) return index;
  }

  return -1;
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
    const selectors = parseSelectors(selector);
    const output: StubElement[] = [];

    this.#collectMatches(selectors, output);
    return output;
  }

  closest(selector: string): VitaElement | null {
    const selectors = parseSelectors(selector);
    let current: StubElement | null = this;

    while (current !== null) {
      if (matchesAnySelector(current, selectors)) return current;
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

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);

    if (name.startsWith("data-")) {
      delete this.dataset[datasetKey(name)];
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

      if (matchesAnySelector(child, selectors)) output.push(child);
      child.#collectMatches(selectors, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function parseSelectors(selector: string): readonly string[] {
  return Object.freeze(selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
}

function matchesAnySelector(elementValue: StubElement, selectors: readonly string[]): boolean {
  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index];

    if (selector !== undefined && matchesSelector(elementValue, selector)) return true;
  }

  return false;
}

function matchesSelector(elementValue: StubElement, selector: string): boolean {
  if (!selector.startsWith("[") || !selector.endsWith("]")) return false;

  const attrName = selector.slice(1, -1);

  return elementValue.attribute(attrName) !== undefined;
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

function readOwnData(source: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

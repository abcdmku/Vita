import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  HostBridgeJson,
  HostBridgeJsonObject,
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import {
  lockScreen,
} from "../../../../ui_kits/desktop/screens/lock.ts";
import type {
  LockAuthenticateRequest,
  LockUser,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";

const UNLOCKED_USER = Object.freeze({
  displayName: "Vita Owner",
  id: "vita-owner",
  initials: "VO",
}) satisfies LockUser;

test("lock screen hydrates active and submits through the advertised auth bridge", async () => {
  const credential = "owner-passphrase-383";
  const calls: LockAuthenticateRequest[] = [];
  const fixture = lockDom(credential);
  const host = createSurfaceHost(lockAuthTransport((request) => {
    calls.push(request);

    return hostAccept(authSession(UNLOCKED_USER));
  }));
  const screen = await hydrateScreen(fixture.root, lockScreen, host);

  assert.equal(screen.ok, true);
  if (!screen.ok) {
    assert.fail("expected lock screen to hydrate");
  }

  assert.equal(fixture.date.textContent, "Tuesday, June 25");
  assert.equal(fixture.time.textContent, "10:24");
  assert.equal(fixture.user.textContent, "Vita User");
  assert.equal(fixture.initials.textContent, "V");
  assert.equal(fixture.remainingAttempts.textContent, "5");

  fixture.root.dispatch("click", fixture.submit);
  await flushAsyncActions();

  assert.deepEqual(calls, [
    {
      attemptNumber: 1,
      credential,
      userId: "vita-user",
    },
  ]);
  assert.equal(screen.snapshot().lockState, "unlocked");
  assert.equal(screen.snapshot().user.displayName, "Vita Owner");
  assert.equal(fixture.root.hasClass("is-unlocked"), true);
  assert.equal(fixture.root.hasClass("is-authenticating"), false);
});

test("lock screen failed auth writes the error sink without credential echo", async () => {
  const credential = "raw-credential-must-not-render-383";
  const calls: LockAuthenticateRequest[] = [];
  const fixture = lockDom(credential);
  const host = createSurfaceHost(lockAuthTransport((request) => {
    calls.push(request);

    return hostReject("NO_MATCH", `credential ${credential} rejected by fake auth`, "/fake/auth");
  }));
  const screen = await hydrateScreen(fixture.root, lockScreen, host);

  assert.equal(screen.ok, true);
  if (!screen.ok) {
    assert.fail("expected lock screen to hydrate");
  }

  fixture.root.dispatch("click", fixture.submit);
  await flushAsyncActions();

  const snapshot = screen.snapshot();

  assert.equal(snapshot.lockState, "locked");
  assert.equal(snapshot.attemptCount, 1);
  assert.equal(snapshot.remainingAttempts, 4);
  assert.equal(snapshot.error?.code, "AUTHENTICATION_REJECTED");
  assert.equal(fixture.error.textContent, "credential was not accepted.");
  assert.equal(fixture.remainingAttempts.textContent, "4");
  assert.equal(fixture.root.hasClass("is-unlocked"), false);
  assert.equal(JSON.stringify(snapshot).includes(credential), false);
  assert.equal(aggregateText(fixture.root).includes(credential), false);
  assert.deepEqual(calls.map((request) => request.attemptNumber), [1]);
});

test("lock screen stays inert without an auth bridge and submit never throws", async () => {
  const fixture = lockDom("offline-credential-383");
  const host = createSurfaceHost(undefined);
  const screen = await hydrateScreen(fixture.root, lockScreen, host);

  assert.equal(screen.ok, true);
  if (!screen.ok) {
    assert.fail("expected lock screen to hydrate with default ports");
  }

  assert.equal(fixture.date.textContent, "Tuesday, June 25");
  assert.equal(fixture.time.textContent, "10:24");
  assert.equal(fixture.user.textContent, "Vita User");
  assert.equal(fixture.initials.textContent, "V");
  assert.equal(fixture.remainingAttempts.textContent, "5");

  assert.doesNotThrow(() => {
    fixture.root.dispatch("click", fixture.submit);
  });
  await flushAsyncActions();

  const snapshot = screen.snapshot();

  assert.equal(snapshot.lockState, "locked");
  assert.equal(snapshot.attemptCount, 0);
  assert.equal(snapshot.remainingAttempts, 5);
  assert.equal(snapshot.error?.code, "AUTH_PORT_UNAVAILABLE");
  assert.equal(fixture.error.textContent, "auth port is unavailable.");
  assert.equal(fixture.root.hasClass("is-unlocked"), false);
});

interface LockDomFixture {
  readonly root: StubElement;
  readonly date: StubElement;
  readonly error: StubElement;
  readonly initials: StubElement;
  readonly remainingAttempts: StubElement;
  readonly submit: StubElement;
  readonly time: StubElement;
  readonly user: StubElement;
}

function lockDom(credential: string): LockDomFixture {
  const root = element({
    class: "v-screen theme-dark",
    "data-vita-bind-class": "is-unlocked:lock.unlocked is-authenticating:lock.authenticating",
    "data-vita-screen": "desktop/lock",
  });
  const date = element({
    "data-vita-bind-text": "lock.date",
  }, "Tuesday, June 25");
  const time = element({
    "data-vita-bind-text": "lock.time",
  }, "10:24");
  const initials = element({
    "data-vita-bind-text": "lock.initials",
  }, "V");
  const user = element({
    "data-vita-bind-text": "lock.user",
  }, "Vita User");
  const submit = element({
    "data-vita-action": "lock.submit",
    "data-vita-credential": credential,
  });
  const error = element({
    "data-vita-bind-text": "lock.error",
  }, "Touch ID or enter password");
  const remainingAttempts = element({
    "data-vita-bind-text": "lock.remainingAttempts",
  }, "5");

  root.appendChild(date);
  root.appendChild(time);
  root.appendChild(initials);
  root.appendChild(user);
  root.appendChild(submit);
  root.appendChild(error);
  root.appendChild(remainingAttempts);

  return {
    date,
    error,
    initials,
    remainingAttempts,
    root,
    submit,
    time,
    user,
  };
}

function lockAuthTransport(
  authenticate: (request: LockAuthenticateRequest) => HostBridgeJson,
): SurfaceHostTransport {
  return Object.freeze({
    methods: Object.freeze(["authenticateOwner"]),
    request(request: SurfaceHostRequest): HostBridgeJson {
      if (request.method === "authenticateOwner") {
        const authRequest = lockAuthRequest(request);

        return authRequest === undefined
          ? hostReject("MALFORMED_AUTH", "authenticateOwner requires a credential request.", "/authenticateOwner")
          : authenticate(authRequest);
      }

      return hostReject("UNUSED_METHOD", "method is unused by this test.", `/${request.method}`);
    },
  } satisfies SurfaceHostTransport);
}

function lockAuthRequest(request: SurfaceHostRequest): LockAuthenticateRequest | undefined {
  const input = jsonObject(request.args[0]);
  const credential = input?.["credential"];
  const userId = input?.["userId"];
  const attemptNumber = input?.["attemptNumber"];

  return typeof credential === "string" &&
    typeof userId === "string" &&
    typeof attemptNumber === "number"
    ? Object.freeze({
      attemptNumber,
      credential,
      userId,
    })
    : undefined;
}

function authSession(user: LockUser): HostBridgeJsonObject {
  return Object.freeze({
    authenticatedAtMs: Date.UTC(2026, 5, 25, 14, 30, 0),
    sessionId: `session:${user.id}`,
    user: Object.freeze({
      displayName: user.displayName,
      id: user.id,
      initials: user.initials,
    }),
  }) satisfies HostBridgeJsonObject;
}

function hostAccept(value: HostBridgeJson): HostBridgeJsonObject {
  return Object.freeze({
    ok: true,
    value,
  }) satisfies HostBridgeJsonObject;
}

function hostReject(code: string, message: string, path: string): HostBridgeJsonObject {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  }) satisfies HostBridgeJsonObject;
}

function jsonObject(value: HostBridgeJson | undefined): HostBridgeJsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: HostBridgeJson | undefined): value is HostBridgeJsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return false;

  return true;
}

async function flushAsyncActions(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function aggregateText(element: StubElement): string {
  let output = element.textContent;

  for (let index = 0; index < element.children.length; index += 1) {
    const child = element.children[index];

    if (child !== undefined) output += aggregateText(child);
  }

  return output;
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

    if (name === "class") {
      this.#classes.clear();
      const tokens = value.split(/\s+/u);

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];

        if (token !== undefined && token.length > 0) this.#classes.add(token);
      }
    }

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

  hasClass(token: string): boolean {
    return this.#classes.has(token);
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

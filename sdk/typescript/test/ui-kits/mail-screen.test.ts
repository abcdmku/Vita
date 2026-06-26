import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_SCREEN_MODULES,
} from "../../../../ui_kits/desktop/runtime/bootstrap.ts";
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
import mailScreen from "../../../../ui_kits/desktop/screens/mail.ts";
import type {
  MailScreenState,
} from "../../../../ui_kits/desktop/screens/mail.ts";
import type {
  LocalMailboxPort,
  MailAppSnapshot,
  MailboxFolder,
  MailboxMessage,
  MailboxMessageDetails,
  MailboxPortResult,
  MailQueueDraftInput,
  MailQueuedDraft,
} from "../../../../ui_kits/desktop/viewmodels/apps/mail-app.ts";
import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../src/desktop-sdk/index.ts";

test("mail markup removes the baked fake inbox and declares the hydrated screen", () => {
  const html = readMailHtml();

  assert.equal(html.includes('data-vita-screen="desktop/mail"'), true);
  assert.equal(html.includes("Welcome to offline Mail"), false);
  assert.equal(html.includes("Queued compose flow"), false);
  assert.equal(html.includes('data-vita-viewmodel'), false);
  assert.equal(html.includes("<span>Inbox</span>"), false);
  assert.equal(html.includes("<span>Sent</span>"), false);
  assert.equal(html.includes("<span>Outbox</span>"), false);
  assert.equal(html.includes("<span>Archive</span>"), false);
  assert.equal(html.includes('<span class="count">2</span>'), false);
  assert.equal(html.includes('<span class="count">1</span>'), false);
  assert.equal(html.includes('<span class="count">0</span>'), false);
  assert.equal(html.includes('data-vita-bind-list="mail.folders"'), true);
  assert.equal(html.includes('data-vita-bind-list="mail.messages"'), true);
});

test("mail markup references an existing desktop runtime script", () => {
  const html = readMailHtml();
  const scriptSrc = runtimeScriptSource(html);

  assert.equal(scriptSrc, "../../ui_kits/desktop/runtime/bootstrap.js");
  assert.equal(existsSync(new URL(scriptSrc, mailHtmlUrl())), true);
});

test("mail screen is registered in the default desktop modules", () => {
  assert.equal(mailScreen.id, "desktop/mail");
  assert.equal(DEFAULT_SCREEN_MODULES.some((module) => module.id === "desktop/mail"), true);
});

test("mail screen renders caller-injected mailbox data and reloads from the port", async () => {
  const dom = mailDom();
  const mailbox = mutableMailbox(
    [
      folder("inbox", "Primary", "inbox", 10),
      folder("outbox", "Local Queue", "outbox", 20),
    ],
    [
      message("m-1", "inbox", "Kai", "Caller chosen subject", "Injected body.", true, "2026-06-25T12:00:00Z"),
    ],
  );

  const screen = await resolveMaybe(hydrateScreen(dom.root, mailScreen, hostWithMailbox(mailbox.port)));

  assert.equal(screen.ok, true);
  assert.deepEqual(folderLabels(dom.folders), ["Primary", "Local Queue"]);
  assert.deepEqual(folderCounts(dom.folders), ["1", "0"]);
  assert.deepEqual(messageSubjects(dom.messages), ["Caller chosen subject"]);
  assert.equal(messageSubjects(dom.messages).includes("Welcome to offline Mail"), false);
  assert.equal(rootSnapshot(screen.snapshot()).activeFolderId, "inbox");

  mailbox.setMessages([
    message("m-2", "inbox", "Rin", "Port mutation is visible", "Changed after hydration.", false, "2026-06-25T13:00:00Z"),
  ]);
  dom.root.dispatch("click", requiredChild(dom.folders, 0));

  assert.deepEqual(messageSubjects(dom.messages), ["Port mutation is visible"]);
  assert.deepEqual(folderCounts(dom.folders), ["0", "0"]);
});

test("mail empty-inbox state is visible for an injected empty folder", async () => {
  const dom = mailDom();
  const mailbox = mutableMailbox(
    [
      folder("inbox", "Quiet", "inbox", 10),
      folder("outbox", "Outbox", "outbox", 20),
    ],
    [],
  );

  const screen = await resolveMaybe(hydrateScreen(dom.root, mailScreen, hostWithMailbox(mailbox.port)));

  assert.equal(screen.ok, true);
  assert.equal(dom.messages.children.length, 0);
  assert.equal(dom.empty.hasClass("visible"), true);
  assert.equal(dom.empty.textContent, "No messages in Quiet");
});

test("mail screen fails closed honestly when no mailbox port is injected", async () => {
  const dom = mailDom();
  const screen = await resolveMaybe(hydrateScreen(dom.root, mailScreen, hostWithMailbox(undefined)));

  assert.equal(screen.ok, true);

  const snapshot = rootSnapshot(screen.snapshot());

  assert.equal(snapshot.status, "denied");
  assert.equal(snapshot.error?.code, "MISSING_MAILBOX_PORT");
  assert.deepEqual(snapshot.folders, []);
  assert.deepEqual(snapshot.messages, []);
});

test("mail queue action reads compose form values and queues the entered draft", async () => {
  const dom = mailDom();
  const mailbox = mutableMailbox(
    [
      folder("inbox", "Inbox", "inbox", 10),
      folder("outbox", "Outbox", "outbox", 20),
    ],
    [],
  );

  const screen = await resolveMaybe(hydrateScreen(dom.root, mailScreen, hostWithMailbox(mailbox.port)));

  assert.equal(screen.ok, true);

  dom.to.value = "desk@local";
  dom.subject.value = "Offline queue";
  dom.body.value = "Queued from the compose form.";
  dom.root.dispatch("click", dom.queue);

  const snapshot = rootSnapshot(screen.snapshot());

  assert.equal(snapshot.status, "ready");
  assert.notEqual(snapshot.error?.code, "INVALID_DRAFT");
  assert.equal(snapshot.activeFolderId, "outbox");
  assert.deepEqual(mailbox.queuedInputs[0]?.draft.to, ["desk@local"]);
  assert.equal(mailbox.queuedInputs[0]?.draft.subject, "Offline queue");
  assert.equal(mailbox.queuedInputs[0]?.draft.body, "Queued from the compose form.");
  assert.deepEqual(snapshot.messages.map((item) => [item.subject, item.to]), [
    ["Offline queue", ["desk@local"]],
  ]);
  assert.equal(snapshot.selectedMessage?.body, "Queued from the compose form.");
});

interface MailDom {
  readonly root: StubElement;
  readonly folders: StubElement;
  readonly messages: StubElement;
  readonly empty: StubElement;
  readonly selectedSubject: StubElement;
  readonly selectedMeta: StubElement;
  readonly selectedBody: StubElement;
  readonly form: StubElement;
  readonly to: StubElement;
  readonly subject: StubElement;
  readonly body: StubElement;
  readonly queue: StubElement;
}

interface MutableMailboxFixture {
  readonly port: LocalMailboxPort;
  readonly queuedInputs: readonly MailQueueDraftInput[];
  setMessages(next: readonly MailboxMessageDetails[]): void;
}

function mailDom(): MailDom {
  const root = element({
    "data-vita-screen": "desktop/mail",
  });
  const folders = element({
    "data-vita-bind-list": "mail.folders",
  });
  const folderTemplate = element({
    "data-vita-key": "template",
  });
  const folderLabel = element({
    "data-vita-bind-text": "mail.folder.label",
  });
  const folderCount = element({
    "data-vita-bind-text": "mail.folder.count",
  });
  const messages = element({
    "data-vita-bind-list": "mail.messages",
  });
  const messageTemplate = element({
    "data-vita-key": "template",
  });
  const sender = element({
    "data-vita-bind-text": "mail.message.sender",
  });
  const date = element({
    "data-vita-bind-attr-0": "datetime:mail.message.dateTime",
    "data-vita-bind-text": "mail.message.date",
  });
  const subject = element({
    "data-vita-bind-text": "mail.message.subject",
  });
  const preview = element({
    "data-vita-bind-text": "mail.message.preview",
  });
  const empty = element({
    "data-vita-bind-class": "visible:mail.emptyInbox",
    "data-vita-bind-text": "mail.emptyInboxText",
  });
  const selectedSubject = element({
    "data-vita-bind-text": "mail.selectedMessage.subject",
  });
  const selectedMeta = element({
    "data-vita-bind-text": "mail.selectedMessage.meta",
  });
  const selectedBody = element({
    "data-vita-bind-text": "mail.selectedMessage.body",
  });
  const form = element({
    "data-vita-action": "mail.composeDraft",
    "data-vita-compose-form": "",
    "data-vita-event": "input",
  });
  const to = element({
    "data-vita-compose-field": "to",
  });
  const composeSubject = element({
    "data-vita-compose-field": "subject",
  });
  const body = element({
    "data-vita-compose-field": "body",
  });
  const queue = element({
    "data-vita-action": "mail.queueDraft",
  });

  folderTemplate.appendChild(folderLabel);
  folderTemplate.appendChild(folderCount);
  folders.appendChild(folderTemplate);

  messageTemplate.appendChild(sender);
  messageTemplate.appendChild(date);
  messageTemplate.appendChild(subject);
  messageTemplate.appendChild(preview);
  messages.appendChild(messageTemplate);

  form.appendChild(to);
  form.appendChild(composeSubject);
  form.appendChild(body);
  form.appendChild(queue);

  root.appendChild(folders);
  root.appendChild(messages);
  root.appendChild(empty);
  root.appendChild(selectedSubject);
  root.appendChild(selectedMeta);
  root.appendChild(selectedBody);
  root.appendChild(form);

  return Object.freeze({
    body,
    empty,
    folders,
    form,
    messages,
    queue,
    root,
    selectedBody,
    selectedMeta,
    selectedSubject,
    subject: composeSubject,
    to,
  });
}

function readMailHtml(): string {
  return readFileSync(mailHtmlUrl(), "utf8");
}

function mailHtmlUrl(): URL {
  return new URL("../../../../apps/mail/index.html", import.meta.url);
}

function runtimeScriptSource(html: string): string {
  const match = /<script\s+type="module"\s+src="([^"]+)"\s*><\/script>/u.exec(html);
  const src = match?.[1];

  if (src === undefined) assert.fail("missing module runtime script");

  return src;
}

function mutableMailbox(
  folders: readonly MailboxFolder[],
  initialMessages: readonly MailboxMessageDetails[],
): MutableMailboxFixture {
  let messages = [...initialMessages];
  const queuedInputs: MailQueueDraftInput[] = [];
  const port = Object.freeze({
    listFolders(): MailboxPortResult<readonly MailboxFolder[]> {
      return acceptPort(Object.freeze(folders.map((item) => folderWithUnreadCount(item, messages))));
    },
    listMessages(folderId: string): MailboxPortResult<readonly MailboxMessage[]> {
      if (!hasFolder(folders, folderId)) {
        return rejectPort("UNKNOWN_FOLDER", `folder '${folderId}' is not available.`, `/folders/${folderId}`);
      }

      return acceptPort(Object.freeze(messages.filter((item) => item.folderId === folderId).map(messageSummary)));
    },
    readMessage(messageId: string): MailboxPortResult<MailboxMessageDetails> {
      const found = findMessage(messages, messageId);

      if (found === undefined) {
        return rejectPort("UNKNOWN_MESSAGE", `message '${messageId}' is not available.`, `/messages/${messageId}`);
      }

      return acceptPort(found);
    },
    markRead(messageId: string): MailboxPortResult<MailboxMessageDetails> {
      const found = findMessage(messages, messageId);

      if (found === undefined) {
        return rejectPort("UNKNOWN_MESSAGE", `message '${messageId}' is not available.`, `/messages/${messageId}`);
      }

      const read = Object.freeze({
        ...found,
        unread: false,
      });

      messages = messages.map((item) => item.id === messageId ? read : item);
      return acceptPort(read);
    },
    queueDraft(input: MailQueueDraftInput): MailboxPortResult<MailQueuedDraft> {
      const outbox = findOutbox(folders, input.outboxFolderId);

      if (outbox === undefined) {
        return rejectPort("OUTBOX_UNAVAILABLE", "queued drafts require a local Outbox folder.", "/folders/outbox");
      }

      queuedInputs.push(input);

      const queued = message(
        `queued-${queuedInputs.length}`,
        outbox.id,
        "me@local",
        input.draft.subject,
        input.draft.body,
        false,
        `1970-01-01T00:00:00.${String(queuedInputs.length).padStart(3, "0")}Z`,
        input.draft.to,
      );

      messages = [...messages, queued];

      return acceptPort(Object.freeze({
        folderId: outbox.id,
        messageId: queued.id,
      }));
    },
  }) satisfies LocalMailboxPort;

  return Object.freeze({
    port,
    queuedInputs,
    setMessages(next: readonly MailboxMessageDetails[]): void {
      messages = [...next];
    },
  });
}

function folder(
  id: string,
  label: string,
  kind: MailboxFolder["kind"],
  sortOrder: number,
): MailboxFolder {
  return Object.freeze({
    id,
    kind,
    label,
    sortOrder,
    unreadCount: 0,
  });
}

function folderWithUnreadCount(
  input: MailboxFolder,
  messages: readonly MailboxMessageDetails[],
): MailboxFolder {
  let unreadCount = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];

    if (item !== undefined && item.folderId === input.id && item.unread) unreadCount += 1;
  }

  const output: {
    id: string;
    label: string;
    kind: MailboxFolder["kind"];
    unreadCount: number;
    sortOrder?: number;
  } = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    unreadCount,
  };

  if (input.sortOrder !== undefined) output.sortOrder = input.sortOrder;

  return Object.freeze(output);
}

function message(
  id: string,
  folderId: string,
  from: string,
  subject: string,
  body: string,
  unread: boolean,
  date: string,
  to: readonly string[] = Object.freeze(["me@local"]),
): MailboxMessageDetails {
  return Object.freeze({
    body,
    date,
    folderId,
    from,
    id,
    preview: body,
    subject,
    to: Object.freeze([...to]),
    unread,
  });
}

function messageSummary(messageValue: MailboxMessageDetails): MailboxMessage {
  return Object.freeze({
    date: messageValue.date,
    folderId: messageValue.folderId,
    from: messageValue.from,
    id: messageValue.id,
    preview: messageValue.preview,
    subject: messageValue.subject,
    to: messageValue.to,
    unread: messageValue.unread,
  });
}

function hasFolder(folders: readonly MailboxFolder[], folderId: string): boolean {
  return findFolder(folders, folderId) !== undefined;
}

function findFolder(folders: readonly MailboxFolder[], folderId: string): MailboxFolder | undefined {
  for (let index = 0; index < folders.length; index += 1) {
    const item = folders[index];

    if (item !== undefined && item.id === folderId) return item;
  }

  return undefined;
}

function findOutbox(folders: readonly MailboxFolder[], folderId: string): MailboxFolder | undefined {
  const folderValue = findFolder(folders, folderId);

  return folderValue !== undefined && folderValue.kind === "outbox" ? folderValue : undefined;
}

function findMessage(
  messages: readonly MailboxMessageDetails[],
  messageId: string,
): MailboxMessageDetails | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];

    if (item !== undefined && item.id === messageId) return item;
  }

  return undefined;
}

function acceptPort<T>(value: T): MailboxPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectPort<T>(code: string, message: string, path: string): MailboxPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function hostWithMailbox(mailbox: LocalMailboxPort | undefined): DesktopHost {
  const base = createSurfaceHost(undefined);

  if (mailbox === undefined) return base;

  return Object.freeze({
    ...base,
    mailbox,
  });
}

function folderLabels(list: StubElement): readonly string[] {
  return Object.freeze(list.children.map((row) => row.children[0]?.textContent ?? ""));
}

function folderCounts(list: StubElement): readonly string[] {
  return Object.freeze(list.children.map((row) => row.children[1]?.textContent ?? ""));
}

function messageSubjects(list: StubElement): readonly string[] {
  return Object.freeze(list.children.map((row) => row.children[2]?.textContent ?? ""));
}

function requiredChild(parent: StubElement, index: number): StubElement {
  const child = parent.children[index];

  if (child === undefined) assert.fail(`missing child ${index}`);

  return child;
}

function rootSnapshot(snapshot: MailScreenState): MailAppSnapshot {
  if ("scope" in snapshot) assert.fail("expected root mail snapshot");

  return snapshot;
}

async function resolveMaybe<T>(value: DesktopMaybePromise<T>): Promise<T> {
  return await value;
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

  value = "";

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
    const selectors = selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
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

    if (name === "value") {
      this.value = value;
    }

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);

    if (name.startsWith("data-")) {
      Reflect.deleteProperty(this.dataset, datasetKey(name));
    }
  }

  cloneNode(deep = false): VitaElement {
    const clone = new StubElement();

    for (const [name, value] of this.#attributes) {
      clone.setAttribute(name, value);
    }

    clone.#text = this.#text;
    clone.value = this.value;

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

      if (matchesAnySelector(child, selectors)) output.push(child);
      child.#collectMatches(selectors, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
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

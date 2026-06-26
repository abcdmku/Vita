import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAIL_APP_ENTRY,
  MAIL_APP_ID,
  MAIL_APP_PARTITION,
  mailAppPackage,
} from "../../../../apps/mail/manifest.ts";
import {
  createInMemoryMailAppMailboxPort,
  createMailAppViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/mail-app.ts";
import type {
  InMemoryMailboxSeed,
  MailboxFolder,
  MailboxMessageDetails,
} from "../../../../ui_kits/desktop/viewmodels/apps/mail-app.ts";
import {
  SDK_VERSION,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";

test("mail app manifest is a valid offline web app package", () => {
  const app = defineAppPackage(mailAppPackage);

  assert.equal(app.manifest.id, MAIL_APP_ID);
  assert.equal(app.manifest.version, "1.0.0");
  assert.equal(app.manifest.sdkVersion, SDK_VERSION);
  assert.equal(app.manifest.entry, MAIL_APP_ENTRY);
  assert.deepEqual(app.manifest.capabilityGrants, []);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read"), false);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.write"), false);
  assert.equal(hasAppCapabilityGrant(app.manifest, "apps.launch"), false);
  assert.equal(app.descriptor.id, MAIL_APP_ID);
  assert.equal(app.descriptor.title, "Mail");
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, MAIL_APP_PARTITION);
});

test("mail view-model selects folders and sorts messages by date desc then id", () => {
  const model = createMailAppViewModel({
    initialFolderId: "inbox",
    mailbox: createInMemoryMailAppMailboxPort(mailboxSeed()),
  });

  assert.equal(model.snapshot().status, "ready");
  assert.equal(model.snapshot().activeFolderId, "inbox");
  assert.deepEqual(model.snapshot().folders.map((folder) => [folder.id, folder.active, folder.unreadCount]), [
    ["inbox", true, 2],
    ["sent", false, 0],
    ["outbox", false, 0],
  ]);
  assert.deepEqual(model.snapshot().messages.map((message) => message.id), [
    "later-a",
    "later-b",
    "older",
  ]);

  const outbox = model.selectFolder("outbox");

  assert.equal(outbox.ok, true);
  assert.equal(outbox.snapshot.activeFolderId, "outbox");
  assert.deepEqual(outbox.snapshot.messages, []);
  assert.deepEqual(outbox.snapshot.folders.map((folder) => [folder.id, folder.active]), [
    ["inbox", false],
    ["sent", false],
    ["outbox", true],
  ]);
});

test("mail view-model selects message body and marks unread mail as read", () => {
  const model = createMailAppViewModel({
    initialFolderId: "inbox",
    mailbox: createInMemoryMailAppMailboxPort(mailboxSeed()),
  });

  const selected = model.selectMessage("later-b");

  assert.equal(selected.ok, true);
  assert.equal(selected.snapshot.selectedMessage?.id, "later-b");
  assert.equal(selected.snapshot.selectedMessage?.body, "Second message body.");
  assert.deepEqual(selected.snapshot.messages.map((message) => [message.id, message.selected]), [
    ["later-a", false],
    ["later-b", true],
    ["older", false],
  ]);

  const marked = model.markRead("later-b");

  assert.equal(marked.ok, true);
  assert.equal(marked.snapshot.selectedMessage?.id, "later-b");
  assert.equal(marked.snapshot.selectedMessage?.unread, false);
  assert.equal(marked.snapshot.folders.find((folder) => folder.id === "inbox")?.unreadCount, 1);
  assert.equal(marked.snapshot.messages.find((message) => message.id === "later-b")?.unread, false);
});

test("mail view-model composes and queues drafts into local Outbox only", () => {
  const model = createMailAppViewModel({
    initialFolderId: "inbox",
    mailbox: createInMemoryMailAppMailboxPort(mailboxSeed()),
  });

  const draft = model.composeDraft({
    body: "Queued locally for a later sender.",
    subject: "Offline queue",
    to: ["desk@local"],
  });

  assert.equal(draft.ok, true);
  assert.deepEqual(draft.snapshot.draft, {
    bcc: [],
    body: "Queued locally for a later sender.",
    cc: [],
    subject: "Offline queue",
    to: ["desk@local"],
  });

  const queued = model.queueDraft();

  assert.equal(queued.ok, true);
  assert.equal(queued.snapshot.activeFolderId, "outbox");
  assert.deepEqual(queued.snapshot.draft, {
    bcc: [],
    body: "",
    cc: [],
    subject: "",
    to: [],
  });
  assert.deepEqual(queued.snapshot.messages.map((message) => [message.id, message.subject, message.unread]), [
    ["local-outbox-1", "Offline queue", false],
  ]);
  assert.equal(queued.snapshot.selectedMessage?.id, "local-outbox-1");
  assert.equal(queued.snapshot.selectedMessage?.body, "Queued locally for a later sender.");
});

test("mail view-model fails closed without an injected mailbox port", () => {
  const model = createMailAppViewModel();

  assert.equal(model.snapshot().status, "denied");
  assert.equal(model.snapshot().error?.code, "MISSING_MAILBOX_PORT");
  assert.deepEqual(model.snapshot().folders, []);
  assert.deepEqual(model.snapshot().messages, []);

  const selected = model.selectFolder("inbox");

  assert.equal(selected.ok, false);
  assert.equal(selected.error.code, "MISSING_MAILBOX_PORT");
  assert.equal(selected.snapshot.status, "denied");
  assert.deepEqual(selected.snapshot.messages, []);
});

test("mail view-model snapshots are frozen and deterministic", () => {
  const model = createMailAppViewModel({
    initialFolderId: "inbox",
    mailbox: createInMemoryMailAppMailboxPort(mailboxSeed()),
  });
  const first = model.snapshot();
  const second = model.snapshot();

  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.folders), true);
  assert.equal(Object.isFrozen(first.folders[0]), true);
  assert.equal(Object.isFrozen(first.messages), true);
  assert.equal(Object.isFrozen(first.messages[0]), true);
  assert.equal(Object.isFrozen(first.draft), true);
  assert.deepEqual(first, second);
});

function mailboxSeed(): InMemoryMailboxSeed {
  return Object.freeze({
    folders: Object.freeze([
      folder("outbox", "Outbox", "outbox", 0, 30),
      folder("inbox", "Inbox", "inbox", 0, 10),
      folder("sent", "Sent", "sent", 0, 20),
    ]),
    messages: Object.freeze([
      message("older", "inbox", "2026-06-24T08:00:00Z", "Avery", "Older", true, "Older body."),
      message("later-b", "inbox", "2026-06-25T10:00:00Z", "Blair", "Second", true, "Second message body."),
      message("later-a", "inbox", "2026-06-25T10:00:00Z", "Casey", "First", false, "First message body."),
      message("sent-1", "sent", "2026-06-23T12:00:00Z", "Me", "Sent", false, "Sent body."),
    ]),
  });
}

function folder(
  id: string,
  label: string,
  kind: MailboxFolder["kind"],
  unreadCount: number,
  sortOrder: number,
): MailboxFolder {
  return Object.freeze({
    id,
    kind,
    label,
    sortOrder,
    unreadCount,
  });
}

function message(
  id: string,
  folderId: string,
  date: string,
  from: string,
  subject: string,
  unread: boolean,
  body: string,
): MailboxMessageDetails {
  return Object.freeze({
    body,
    date,
    folderId,
    from,
    id,
    preview: body,
    subject,
    to: Object.freeze(["me@local"]),
    unread,
  });
}

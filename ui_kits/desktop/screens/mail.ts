import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaElement,
  VitaListAttributePatch,
  VitaListClassPatch,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenActionHandler,
  ScreenBindResolver,
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createMailAppViewModel,
} from "../viewmodels/apps/mail-app.ts";
import type {
  LocalMailboxPort,
  MailAppSnapshot,
  MailAppViewModel,
  MailComposeDraftPatch,
  MailFolderView,
  MailMessageView,
} from "../viewmodels/apps/mail-app.ts";
import {
  datasetValue,
  optionalHostPort,
  readOwnData,
} from "./shared.ts";

export interface MailScreenPorts {
  readonly mailbox?: LocalMailboxPort;
}

export interface MailFolderRowState {
  readonly scope: "mail.folder";
  readonly id: string;
  readonly label: string;
  readonly unreadCount: number;
  readonly active: boolean;
  readonly current: "page" | false;
}

export interface MailMessageRowState {
  readonly scope: "mail.message";
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly preview: string;
  readonly date: string;
  readonly dateTime: string;
  readonly unread: boolean;
  readonly selected: boolean;
}

export type MailScreenState =
  | MailAppSnapshot
  | MailFolderRowState
  | MailMessageRowState;

export const mailScreenActions: ReadonlyMap<string, ScreenActionHandler<MailAppViewModel, MailScreenState>> =
  new Map<string, ScreenActionHandler<MailAppViewModel, MailScreenState>>([
    ["mail.selectFolder", (viewModel, context) => {
      const folderId = datasetValue(context.target, Object.freeze(["vitaFolderId"]));

      if (folderId !== undefined) viewModel.selectFolder(folderId);
    }],
    ["mail.selectMessage", (viewModel, context) => {
      const messageId = datasetValue(context.target, Object.freeze(["vitaMessageId"]));

      if (messageId !== undefined) viewModel.selectMessage(messageId);
    }],
    ["mail.composeDraft", (viewModel, context) => {
      viewModel.composeDraft(draftPatchFromContext(context));
    }],
    ["mail.queueDraft", (viewModel, context) => {
      const composed = viewModel.composeDraft(draftPatchFromContext(context));

      if (composed.ok) viewModel.queueDraft();
    }],
  ]);

export const mailScreenBinds: ReadonlyMap<string, ScreenBindResolver<MailScreenState>> =
  new Map<string, ScreenBindResolver<MailScreenState>>([
    ["mail.status", (snapshot) => isRootState(snapshot) ? snapshot.status : ""],
    ["mail.error", (snapshot) => isRootState(snapshot) ? snapshot.error?.message ?? "" : ""],
    ["mail.errorCode", (snapshot) => isRootState(snapshot) ? snapshot.error?.code ?? "" : ""],
    ["mail.activeFolderLabel", (snapshot) => isRootState(snapshot) ? activeFolderLabel(snapshot) : ""],
    ["mail.emptyInbox", (snapshot) => isRootState(snapshot) ? isEmptyInbox(snapshot) : false],
    ["mail.emptyInboxText", (snapshot) => isRootState(snapshot) && isEmptyInbox(snapshot) ? `No messages in ${activeFolderLabel(snapshot)}` : ""],
    ["mail.folders", (snapshot) => isRootState(snapshot) ? snapshot.folders.map(folderItem) : Object.freeze([])],
    ["mail.messages", (snapshot) => isRootState(snapshot) ? snapshot.messages.map(messageItem) : Object.freeze([])],
    ["mail.selectedMessage.subject", (snapshot) => isRootState(snapshot) ? snapshot.selectedMessage?.subject ?? "Select a message" : ""],
    ["mail.selectedMessage.meta", (snapshot) => isRootState(snapshot) ? selectedMessageMeta(snapshot) : ""],
    ["mail.selectedMessage.body", (snapshot) => isRootState(snapshot) ? snapshot.selectedMessage?.body ?? "" : ""],
    ["mail.folder.id", (snapshot) => isFolderRowState(snapshot) ? snapshot.id : ""],
    ["mail.folder.label", (snapshot) => isFolderRowState(snapshot) ? snapshot.label : ""],
    ["mail.folder.count", (snapshot) => isFolderRowState(snapshot) ? `${snapshot.unreadCount}` : ""],
    ["mail.folder.current", (snapshot) => isFolderRowState(snapshot) ? snapshot.current : false],
    ["mail.folder.active", (snapshot) => isFolderRowState(snapshot) ? snapshot.active : false],
    ["mail.message.id", (snapshot) => isMessageRowState(snapshot) ? snapshot.id : ""],
    ["mail.message.sender", (snapshot) => isMessageRowState(snapshot) ? snapshot.from : ""],
    ["mail.message.subject", (snapshot) => isMessageRowState(snapshot) ? snapshot.subject : ""],
    ["mail.message.preview", (snapshot) => isMessageRowState(snapshot) ? snapshot.preview : ""],
    ["mail.message.date", (snapshot) => isMessageRowState(snapshot) ? snapshot.date : ""],
    ["mail.message.dateTime", (snapshot) => isMessageRowState(snapshot) ? snapshot.dateTime : ""],
    ["mail.message.unread", (snapshot) => isMessageRowState(snapshot) ? snapshot.unread : false],
    ["mail.message.selected", (snapshot) => isMessageRowState(snapshot) ? snapshot.selected : false],
  ]);

export const mailScreen = Object.freeze({
  actions: mailScreenActions,
  binds: mailScreenBinds,
  createViewModel(ports: MailScreenPorts): MailAppViewModel {
    const input: {
      mailbox?: LocalMailboxPort;
    } = {};

    if (ports.mailbox !== undefined) input.mailbox = ports.mailbox;

    return createMailAppViewModel(input);
  },
  eventTypes: Object.freeze(["click", "input"] as const),
  id: "desktop/mail",
  selectPorts(host: DesktopHost): MailScreenPorts {
    const mailbox = mailboxPortFromHost(host);
    const output: {
      mailbox?: LocalMailboxPort;
    } = {};

    if (mailbox !== undefined) output.mailbox = mailbox;

    return Object.freeze(output);
  },
}) satisfies ScreenModule<MailScreenState, MailScreenPorts, MailAppViewModel>;

export default mailScreen;

function mailboxPortFromHost(host: DesktopHost): LocalMailboxPort | undefined {
  return optionalHostPort(host, "mailbox", isLocalMailboxPort) ??
    optionalHostPort(host, "mailboxPort", isLocalMailboxPort) ??
    optionalHostPort(host, "localMailbox", isLocalMailboxPort) ??
    optionalHostPort(host, "localMailboxPort", isLocalMailboxPort);
}

function isLocalMailboxPort(value: unknown): value is LocalMailboxPort {
  return value !== null &&
    typeof value === "object" &&
    typeof readOwnData(value, "listFolders") === "function" &&
    typeof readOwnData(value, "listMessages") === "function" &&
    typeof readOwnData(value, "readMessage") === "function" &&
    typeof readOwnData(value, "markRead") === "function" &&
    typeof readOwnData(value, "queueDraft") === "function";
}

function folderItem(folder: MailFolderView): VitaListItem {
  const row = folderRow(folder);

  return Object.freeze({
    attrs: Object.freeze([
      attr("data-vita-action", "mail.selectFolder"),
      attr("data-vita-folder-id", row.id),
      attr("aria-current", row.current),
    ]),
    classes: Object.freeze([
      classPatch("on", row.active),
    ]),
    key: `folder:${row.id}`,
    snapshot: row,
  });
}

function messageItem(message: MailMessageView): VitaListItem {
  const row = messageRow(message);

  return Object.freeze({
    attrs: Object.freeze([
      attr("data-vita-action", "mail.selectMessage"),
      attr("data-vita-message-id", row.id),
      attr("aria-selected", row.selected ? "true" : "false"),
      attr("role", "option"),
      attr("tabindex", "0"),
    ]),
    classes: Object.freeze([
      classPatch("unread", row.unread),
    ]),
    key: `message:${row.id}`,
    snapshot: row,
  });
}

function folderRow(folder: MailFolderView): MailFolderRowState {
  return Object.freeze({
    active: folder.active,
    current: folder.active ? "page" : false,
    id: folder.id,
    label: folder.label,
    scope: "mail.folder",
    unreadCount: folder.unreadCount,
  });
}

function messageRow(message: MailMessageView): MailMessageRowState {
  return Object.freeze({
    date: message.date,
    dateTime: message.date,
    from: message.from,
    id: message.id,
    preview: message.preview,
    scope: "mail.message",
    selected: message.selected,
    subject: message.subject,
    unread: message.unread,
  });
}

function activeFolderLabel(snapshot: MailAppSnapshot): string {
  for (let index = 0; index < snapshot.folders.length; index += 1) {
    const folder = snapshot.folders[index];

    if (folder !== undefined && folder.active) return folder.label;
  }

  if (snapshot.status === "denied") return "Mailbox unavailable";

  return "Mail";
}

function isEmptyInbox(snapshot: MailAppSnapshot): boolean {
  return snapshot.status === "ready" &&
    snapshot.activeFolderId !== undefined &&
    snapshot.messages.length === 0;
}

function selectedMessageMeta(snapshot: MailAppSnapshot): string {
  const selected = snapshot.selectedMessage;

  if (selected === undefined) return "";

  return `${selected.from} to ${formatRecipients(selected.to)}`;
}

function formatRecipients(recipients: readonly string[]): string {
  if (recipients.length === 0) return "undisclosed recipients";

  return recipients.join(", ");
}

function draftPatchFromContext(context: VitaActionContext<MailScreenState>): MailComposeDraftPatch {
  const form = composeFormFromTarget(context.target) ?? composeFormFromEventTarget(context.event.target);

  if (form !== undefined) return draftPatchFromForm(form);

  return draftPatchFromDataset(context.target);
}

function composeFormFromEventTarget(target: unknown): VitaElement | undefined {
  return isVitaElement(target) ? composeFormFromTarget(target) : undefined;
}

function composeFormFromTarget(target: VitaElement): VitaElement | undefined {
  try {
    const form = target.closest("[data-vita-compose-form]");

    return form === null ? undefined : form;
  } catch {
    return undefined;
  }
}

function draftPatchFromForm(form: VitaElement): MailComposeDraftPatch {
  const fields = composeFields(form);

  return Object.freeze({
    body: fields.body,
    subject: fields.subject,
    to: parseRecipients(fields.to),
  });
}

function draftPatchFromDataset(target: VitaElement): MailComposeDraftPatch {
  const to = datasetValue(target, Object.freeze(["vitaTo", "vitaRecipient"]));
  const subject = datasetValue(target, Object.freeze(["vitaSubject"]));
  const body = datasetValue(target, Object.freeze(["vitaBody"]));
  const output: {
    to?: readonly string[];
    subject?: string;
    body?: string;
  } = {};

  if (to !== undefined) output.to = parseRecipients(to);
  if (subject !== undefined) output.subject = subject;
  if (body !== undefined) output.body = body;

  return Object.freeze(output);
}

function composeFields(form: VitaElement): {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
} {
  const output: {
    to: string;
    subject: string;
    body: string;
  } = {
    body: "",
    subject: "",
    to: "",
  };

  try {
    const fields = form.querySelectorAll("[data-vita-compose-field]");

    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const name = field === undefined
        ? undefined
        : datasetValue(field, Object.freeze(["vitaComposeField"]));

      if (field === undefined || name === undefined) continue;

      const value = fieldValue(field);

      if (name === "to") {
        output.to = value;
      } else if (name === "subject") {
        output.subject = value;
      } else if (name === "body") {
        output.body = value;
      }
    }
  } catch {
    return Object.freeze(output);
  }

  return Object.freeze(output);
}

function fieldValue(field: VitaElement): string {
  const value = readString(field, "value");

  if (value !== undefined) return value;

  try {
    const attrValue = field.getAttribute?.("value");

    if (typeof attrValue === "string") return attrValue;
  } catch {
    return "";
  }

  try {
    return field.textContent ?? "";
  } catch {
    return "";
  }
}

function readString(source: object, key: string): string | undefined {
  try {
    const value = Reflect.get(source, key);

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseRecipients(value: string): readonly string[] {
  const pieces = value.split(/[,;\n]/u);
  const output: string[] = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]?.trim();

    if (piece !== undefined && piece.length > 0) output.push(piece);
  }

  return Object.freeze(output);
}

function isRootState(snapshot: MailScreenState): snapshot is MailAppSnapshot {
  return !("scope" in snapshot);
}

function isFolderRowState(snapshot: MailScreenState): snapshot is MailFolderRowState {
  return "scope" in snapshot && snapshot.scope === "mail.folder";
}

function isMessageRowState(snapshot: MailScreenState): snapshot is MailMessageRowState {
  return "scope" in snapshot && snapshot.scope === "mail.message";
}

function isVitaElement(value: unknown): value is VitaElement {
  return value !== null &&
    typeof value === "object" &&
    typeof readFunction(value, "closest") === "function" &&
    typeof readFunction(value, "querySelectorAll") === "function";
}

function attr(name: string, value: VitaListAttributePatch["value"]): VitaListAttributePatch {
  return Object.freeze({
    name,
    value,
  });
}

function classPatch(className: string, enabled: boolean): VitaListClassPatch {
  return Object.freeze({
    className,
    enabled,
  });
}

function readFunction(source: object, key: string): unknown {
  try {
    return Reflect.get(source, key);
  } catch {
    return undefined;
  }
}

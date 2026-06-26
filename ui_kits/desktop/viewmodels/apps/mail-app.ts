export type MailFolderKind =
  | "archive"
  | "custom"
  | "drafts"
  | "inbox"
  | "outbox"
  | "sent"
  | "trash";

export type MailAppStatus = "denied" | "error" | "ready";
export type MailAppAction =
  | "composeDraft"
  | "init"
  | "markRead"
  | "queueDraft"
  | "selectFolder"
  | "selectMessage";

export interface MailAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type MailAppResult =
  | {
      readonly ok: true;
      readonly action: MailAppAction;
      readonly snapshot: MailAppSnapshot;
    }
  | {
      readonly ok: false;
      readonly action: MailAppAction;
      readonly error: MailAppError;
      readonly snapshot: MailAppSnapshot;
    };

export interface MailboxFolder {
  readonly id: string;
  readonly label: string;
  readonly kind: MailFolderKind;
  readonly unreadCount: number;
  readonly sortOrder?: number;
}

export interface MailboxMessage {
  readonly id: string;
  readonly folderId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly preview: string;
  readonly date: string;
  readonly unread: boolean;
}

export interface MailboxMessageDetails extends MailboxMessage {
  readonly body: string;
}

export interface MailFolderView {
  readonly id: string;
  readonly label: string;
  readonly kind: MailFolderKind;
  readonly unreadCount: number;
  readonly active: boolean;
}

export interface MailMessageView extends MailboxMessage {
  readonly selected: boolean;
}

export interface MailSelectedMessage extends MailMessageView {
  readonly body: string;
}

export interface MailComposeDraft {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export interface MailComposeDraftPatch {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
}

export interface MailQueueDraftInput {
  readonly outboxFolderId: string;
  readonly draft: MailComposeDraft;
}

export interface MailQueuedDraft {
  readonly folderId: string;
  readonly messageId: string;
}

export type MailboxPortResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: MailAppError;
    };

export interface LocalMailboxPort {
  listFolders(): MailboxPortResult<readonly MailboxFolder[]>;
  listMessages(folderId: string): MailboxPortResult<readonly MailboxMessage[]>;
  readMessage(messageId: string): MailboxPortResult<MailboxMessageDetails>;
  markRead(messageId: string): MailboxPortResult<MailboxMessageDetails>;
  queueDraft(input: MailQueueDraftInput): MailboxPortResult<MailQueuedDraft>;
}

export interface MailAppSnapshot {
  readonly status: MailAppStatus;
  readonly folders: readonly MailFolderView[];
  readonly messages: readonly MailMessageView[];
  readonly draft: MailComposeDraft;
  readonly activeFolderId?: string;
  readonly selectedMessage?: MailSelectedMessage;
  readonly error?: MailAppError;
}

export interface MailAppViewModelOptions {
  readonly mailbox?: LocalMailboxPort;
  readonly initialFolderId?: string;
}

export interface MailAppViewModel {
  readonly state: MailAppSnapshot;
  snapshot(): MailAppSnapshot;
  selectFolder(id: string): MailAppResult;
  selectMessage(id: string): MailAppResult;
  markRead(id: string): MailAppResult;
  composeDraft(fields: MailComposeDraftPatch): MailAppResult;
  queueDraft(): MailAppResult;
}

export interface InMemoryMailboxSeed {
  readonly folders: readonly MailboxFolder[];
  readonly messages: readonly MailboxMessageDetails[];
}

const EMPTY_FOLDERS = Object.freeze([]) satisfies readonly MailFolderView[];
const EMPTY_MESSAGES = Object.freeze([]) satisfies readonly MailMessageView[];
const EMPTY_DRAFT = freezeDraft({
  bcc: Object.freeze([]),
  body: "",
  cc: Object.freeze([]),
  subject: "",
  to: Object.freeze([]),
});

export function createMailAppViewModel(
  options: MailAppViewModelOptions = Object.freeze({}),
): MailAppViewModel {
  return new MailAppModel(options);
}

export function createInMemoryMailAppMailboxPort(seed: InMemoryMailboxSeed): LocalMailboxPort {
  const folders = freezeMailboxFolders(seed.folders);
  const folderIds = new Set<string>();
  const messages = new Map<string, MailboxMessageDetails>();
  let queuedCount = 0;

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];

    if (folder !== undefined) folderIds.add(folder.id);
  }

  for (let index = 0; index < seed.messages.length; index += 1) {
    const message = seed.messages[index];

    if (message === undefined || !folderIds.has(message.folderId)) continue;
    messages.set(message.id, freezeMessageDetails(message));
  }

  const port: LocalMailboxPort = Object.freeze({
    listFolders(): MailboxPortResult<readonly MailboxFolder[]> {
      return acceptPort(foldersWithUnreadCounts(folders, messages));
    },
    listMessages(folderId: string): MailboxPortResult<readonly MailboxMessage[]> {
      if (!folderIds.has(folderId)) {
        return rejectPort("UNKNOWN_FOLDER", `folder '${folderId}' is not available.`, `/folders/${pathToken(folderId)}`);
      }

      const output: MailboxMessage[] = [];

      for (const message of messages.values()) {
        if (message.folderId === folderId) output.push(freezeMessage(message));
      }

      return acceptPort(Object.freeze(output));
    },
    markRead(messageId: string): MailboxPortResult<MailboxMessageDetails> {
      const message = messages.get(messageId);

      if (message === undefined) {
        return rejectPort("UNKNOWN_MESSAGE", `message '${messageId}' is not available.`, `/messages/${pathToken(messageId)}`);
      }

      const readMessage = freezeMessageDetails({
        ...message,
        unread: false,
      });

      messages.set(messageId, readMessage);
      return acceptPort(readMessage);
    },
    queueDraft(input: MailQueueDraftInput): MailboxPortResult<MailQueuedDraft> {
      const outbox = findFolder(folders, input.outboxFolderId);

      if (outbox === undefined || outbox.kind !== "outbox") {
        return rejectPort("OUTBOX_UNAVAILABLE", "queued drafts require a local Outbox folder.", "/folders/outbox");
      }

      queuedCount += 1;

      const messageId = nextQueuedMessageId(messages, queuedCount);
      const queued = freezeMessageDetails({
        body: input.draft.body,
        date: `1970-01-01T00:00:00.${String(queuedCount).padStart(3, "0")}Z`,
        folderId: outbox.id,
        from: "me@local",
        id: messageId,
        preview: previewText(input.draft.body, input.draft.subject),
        subject: input.draft.subject,
        to: input.draft.to,
        unread: false,
      });

      messages.set(queued.id, queued);

      return acceptPort(Object.freeze({
        folderId: outbox.id,
        messageId: queued.id,
      }));
    },
    readMessage(messageId: string): MailboxPortResult<MailboxMessageDetails> {
      const message = messages.get(messageId);

      if (message === undefined) {
        return rejectPort("UNKNOWN_MESSAGE", `message '${messageId}' is not available.`, `/messages/${pathToken(messageId)}`);
      }

      return acceptPort(freezeMessageDetails(message));
    },
  });

  return port;
}

class MailAppModel implements MailAppViewModel {
  readonly #mailbox: LocalMailboxPort | undefined;
  #draft: MailComposeDraft = EMPTY_DRAFT;
  #snapshot: MailAppSnapshot = freezeSnapshot({
    draft: EMPTY_DRAFT,
    folders: EMPTY_FOLDERS,
    messages: EMPTY_MESSAGES,
    status: "ready",
  });

  constructor(options: MailAppViewModelOptions) {
    this.#mailbox = options.mailbox;
    this.#snapshot = this.#loadFolder("init", options.initialFolderId, undefined).snapshot;
  }

  get state(): MailAppSnapshot {
    return this.#snapshot;
  }

  snapshot(): MailAppSnapshot {
    return this.#snapshot;
  }

  selectFolder(id: string): MailAppResult {
    return this.#loadFolder("selectFolder", id, undefined);
  }

  selectMessage(id: string): MailAppResult {
    const activeFolderId = this.#snapshot.activeFolderId;

    if (activeFolderId === undefined) {
      return this.#fail("selectMessage", error(
        "NO_ACTIVE_FOLDER",
        "mail view-model has no active folder.",
        "/folders/active",
      ));
    }
    if (findMessage(this.#snapshot.messages, id) === undefined) {
      return this.#fail("selectMessage", error(
        "UNKNOWN_MESSAGE",
        `message '${id}' is not in the active folder.`,
        `/messages/${pathToken(id)}`,
      ));
    }

    const mailbox = this.#mailbox;

    if (mailbox === undefined) {
      return this.#missingMailbox("selectMessage");
    }

    const details = callPort("readMessage", () => mailbox.readMessage(id));

    if (!details.ok) return this.#failFromPort("selectMessage", details.error);
    if (details.value.folderId !== activeFolderId) {
      return this.#fail("selectMessage", error(
        "MESSAGE_FOLDER_MISMATCH",
        "mailbox port returned a message from a different folder.",
        `/messages/${pathToken(id)}/folderId`,
      ));
    }

    this.#snapshot = freezeSnapshot({
      activeFolderId,
      draft: this.#draft,
      folders: this.#snapshot.folders,
      messages: this.#snapshot.messages,
      selectedMessage: details.value,
      status: "ready",
    });

    return acceptAction("selectMessage", this.#snapshot);
  }

  markRead(id: string): MailAppResult {
    const mailbox = this.#mailbox;

    if (mailbox === undefined) {
      return this.#missingMailbox("markRead");
    }

    const marked = callPort("markRead", () => mailbox.markRead(id));

    if (!marked.ok) return this.#failFromPort("markRead", marked.error);

    return this.#loadFolder("markRead", this.#snapshot.activeFolderId ?? marked.value.folderId, this.#snapshot.selectedMessage?.id);
  }

  composeDraft(fields: MailComposeDraftPatch): MailAppResult {
    const normalized = normalizeDraftPatch(fields);

    if (!normalized.ok) {
      return this.#fail("composeDraft", normalized.error);
    }

    this.#draft = freezeDraft({
      bcc: normalized.value.bcc ?? this.#draft.bcc,
      body: normalized.value.body ?? this.#draft.body,
      cc: normalized.value.cc ?? this.#draft.cc,
      subject: normalized.value.subject ?? this.#draft.subject,
      to: normalized.value.to ?? this.#draft.to,
    });
    this.#snapshot = freezeSnapshot({
      activeFolderId: this.#snapshot.activeFolderId,
      draft: this.#draft,
      error: this.#snapshot.error,
      folders: this.#snapshot.folders,
      messages: this.#snapshot.messages,
      selectedMessage: this.#snapshot.selectedMessage,
      status: this.#snapshot.status,
    });

    return acceptAction("composeDraft", this.#snapshot);
  }

  queueDraft(): MailAppResult {
    const mailbox = this.#mailbox;

    if (mailbox === undefined) {
      return this.#missingMailbox("queueDraft");
    }
    if (this.#draft.to.length === 0) {
      return this.#fail("queueDraft", error(
        "INVALID_DRAFT",
        "queued drafts require at least one local recipient.",
        "/draft/to",
      ));
    }

    const folders = callPort("listFolders", () => mailbox.listFolders());

    if (!folders.ok) return this.#failFromPort("queueDraft", folders.error);

    const normalizedFolders = freezeMailboxFolders(folders.value);
    const outbox = findOutboxFolder(normalizedFolders);

    if (outbox === undefined) {
      return this.#fail("queueDraft", error(
        "OUTBOX_UNAVAILABLE",
        "queued drafts require a local Outbox folder.",
        "/folders/outbox",
      ));
    }

    const queued = callPort("queueDraft", () => mailbox.queueDraft(Object.freeze({
      draft: this.#draft,
      outboxFolderId: outbox.id,
    })));

    if (!queued.ok) return this.#failFromPort("queueDraft", queued.error);
    if (queued.value.folderId !== outbox.id) {
      return this.#fail("queueDraft", error(
        "OUTBOX_MISMATCH",
        "mailbox port queued the draft outside the local Outbox.",
        "/outbox",
      ));
    }

    const queuedDraft = queued.value;
    const priorDraft = this.#draft;
    this.#draft = EMPTY_DRAFT;

    const loaded = this.#loadFolder("queueDraft", queuedDraft.folderId, queuedDraft.messageId);

    if (!loaded.ok) {
      this.#draft = priorDraft;
      this.#snapshot = freezeSnapshot({
        activeFolderId: this.#snapshot.activeFolderId,
        draft: this.#draft,
        error: loaded.error,
        folders: this.#snapshot.folders,
        messages: this.#snapshot.messages,
        selectedMessage: this.#snapshot.selectedMessage,
        status: this.#snapshot.status,
      });

      return rejectAction("queueDraft", loaded.error, this.#snapshot);
    }

    return loaded;
  }

  #loadFolder(
    action: MailAppAction,
    requestedFolderId: string | undefined,
    selectedMessageId: string | undefined,
  ): MailAppResult {
    const mailbox = this.#mailbox;

    if (mailbox === undefined) {
      return this.#missingMailbox(action);
    }

    const foldersResult = callPort("listFolders", () => mailbox.listFolders());

    if (!foldersResult.ok) {
      return this.#failFromPort(action, foldersResult.error);
    }

    const folders = freezeMailboxFolders(foldersResult.value);
    const activeFolderId = resolveActiveFolderId(folders, requestedFolderId);

    if (activeFolderId === undefined) {
      this.#snapshot = freezeSnapshot({
        draft: this.#draft,
        folders: activeFolderViews(folders, undefined),
        messages: EMPTY_MESSAGES,
        status: "ready",
      });

      return acceptAction(action, this.#snapshot);
    }
    if (requestedFolderId !== undefined && findFolder(folders, requestedFolderId) === undefined) {
      return this.#fail(action, error(
        "UNKNOWN_FOLDER",
        `folder '${requestedFolderId}' is not available.`,
        `/folders/${pathToken(requestedFolderId)}`,
      ));
    }

    const messagesResult = callPort("listMessages", () => mailbox.listMessages(activeFolderId));

    if (!messagesResult.ok) {
      return this.#failFromPort(action, messagesResult.error);
    }

    const messages = sortMessages(messagesResult.value);
    const selectedDetails = selectedMessageId === undefined
      ? undefined
      : this.#readSelectedMessage(mailbox, activeFolderId, messages, selectedMessageId);

    if (selectedDetails !== undefined && !selectedDetails.ok) {
      return this.#failFromPort(action, selectedDetails.error);
    }

    this.#snapshot = freezeSnapshot({
      activeFolderId,
      draft: this.#draft,
      folders: activeFolderViews(folders, activeFolderId),
      messages,
      selectedMessage: selectedDetails?.value,
      status: "ready",
    });

    return acceptAction(action, this.#snapshot);
  }

  #readSelectedMessage(
    mailbox: LocalMailboxPort,
    activeFolderId: string,
    messages: readonly MailboxMessage[],
    selectedMessageId: string,
  ): MailboxPortResult<MailboxMessageDetails> | undefined {
    if (findMessage(messages, selectedMessageId) === undefined) return undefined;

    const details = callPort("readMessage", () => mailbox.readMessage(selectedMessageId));

    if (!details.ok) return details;
    if (details.value.folderId !== activeFolderId) {
      return rejectPort(
        "MESSAGE_FOLDER_MISMATCH",
        "mailbox port returned a message from a different folder.",
        `/messages/${pathToken(selectedMessageId)}/folderId`,
      );
    }

    return details;
  }

  #missingMailbox(action: MailAppAction): MailAppResult {
    this.#snapshot = failClosedSnapshot(this.#draft, error(
      "MISSING_MAILBOX_PORT",
      "mail view-model requires an injected local mailbox port.",
      "/mailbox",
    ), "denied");

    return rejectAction(action, this.#snapshot.error, this.#snapshot);
  }

  #failFromPort(action: MailAppAction, errorValue: MailAppError): MailAppResult {
    const status = isDeniedError(errorValue) ? "denied" : "error";

    this.#snapshot = failClosedSnapshot(this.#draft, errorValue, status);
    return rejectAction(action, errorValue, this.#snapshot);
  }

  #fail(action: MailAppAction, errorValue: MailAppError): MailAppResult {
    this.#snapshot = freezeSnapshot({
      activeFolderId: this.#snapshot.activeFolderId,
      draft: this.#draft,
      error: errorValue,
      folders: this.#snapshot.folders,
      messages: this.#snapshot.messages,
      selectedMessage: this.#snapshot.selectedMessage,
      status: "error",
    });

    return rejectAction(action, errorValue, this.#snapshot);
  }
}

function failClosedSnapshot(
  draft: MailComposeDraft,
  errorValue: MailAppError,
  status: MailAppStatus,
): MailAppSnapshot {
  return freezeSnapshot({
    draft,
    error: errorValue,
    folders: EMPTY_FOLDERS,
    messages: EMPTY_MESSAGES,
    status,
  });
}

function freezeSnapshot(input: {
  readonly status: MailAppStatus;
  readonly folders: readonly MailboxFolder[] | readonly MailFolderView[];
  readonly messages: readonly MailboxMessage[] | readonly MailMessageView[];
  readonly draft: MailComposeDraft;
  readonly activeFolderId?: string | undefined;
  readonly selectedMessage?: MailboxMessageDetails | MailSelectedMessage | undefined;
  readonly error?: MailAppError | undefined;
}): MailAppSnapshot {
  const selectedId = input.selectedMessage?.id;
  const output: {
    status: MailAppStatus;
    folders: readonly MailFolderView[];
    messages: readonly MailMessageView[];
    draft: MailComposeDraft;
    activeFolderId?: string;
    selectedMessage?: MailSelectedMessage;
    error?: MailAppError;
  } = {
    draft: freezeDraft(input.draft),
    folders: freezeFolderViews(input.folders, input.activeFolderId),
    messages: freezeMessageViews(input.messages, selectedId),
    status: input.status,
  };

  if (input.activeFolderId !== undefined) output.activeFolderId = input.activeFolderId;
  if (input.selectedMessage !== undefined) output.selectedMessage = freezeSelectedMessage(input.selectedMessage);
  if (input.error !== undefined) output.error = freezeError(input.error);

  return Object.freeze(output);
}

function freezeMailboxFolders(folders: readonly MailboxFolder[]): readonly MailboxFolder[] {
  const output: MailboxFolder[] = [];

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];

    if (folder !== undefined) output.push(freezeMailboxFolder(folder));
  }

  output.sort(compareFolders);
  return Object.freeze(output);
}

function freezeMailboxFolder(folder: MailboxFolder): MailboxFolder {
  const output: {
    id: string;
    label: string;
    kind: MailFolderKind;
    unreadCount: number;
    sortOrder?: number;
  } = {
    id: folder.id,
    kind: folder.kind,
    label: folder.label,
    unreadCount: normalizeUnreadCount(folder.unreadCount),
  };

  if (folder.sortOrder !== undefined && Number.isFinite(folder.sortOrder)) {
    output.sortOrder = folder.sortOrder;
  }

  return Object.freeze(output);
}

function activeFolderViews(
  folders: readonly MailboxFolder[],
  activeFolderId: string | undefined,
): readonly MailFolderView[] {
  return freezeFolderViews(folders, activeFolderId);
}

function freezeFolderViews(
  folders: readonly MailboxFolder[] | readonly MailFolderView[],
  activeFolderId: string | undefined,
): readonly MailFolderView[] {
  const output: MailFolderView[] = [];

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];

    if (folder === undefined) continue;
    output.push(Object.freeze({
      active: folder.id === activeFolderId,
      id: folder.id,
      kind: folder.kind,
      label: folder.label,
      unreadCount: normalizeUnreadCount(folder.unreadCount),
    }));
  }

  return Object.freeze(output);
}

function sortMessages(messages: readonly MailboxMessage[]): readonly MailboxMessage[] {
  const output: MailboxMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message !== undefined) output.push(freezeMessage(message));
  }

  output.sort(compareMessages);
  return Object.freeze(output);
}

function freezeMessageViews(
  messages: readonly MailboxMessage[] | readonly MailMessageView[],
  selectedId: string | undefined,
): readonly MailMessageView[] {
  const output: MailMessageView[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message === undefined) continue;
    output.push(Object.freeze({
      date: message.date,
      folderId: message.folderId,
      from: message.from,
      id: message.id,
      preview: message.preview,
      selected: message.id === selectedId,
      subject: message.subject,
      to: freezeStringArray(message.to),
      unread: message.unread,
    }));
  }

  return Object.freeze(output);
}

function freezeMessage(message: MailboxMessage): MailboxMessage {
  return Object.freeze({
    date: message.date,
    folderId: message.folderId,
    from: message.from,
    id: message.id,
    preview: message.preview,
    subject: message.subject,
    to: freezeStringArray(message.to),
    unread: message.unread,
  });
}

function freezeMessageDetails(message: MailboxMessageDetails): MailboxMessageDetails {
  return Object.freeze({
    ...freezeMessage(message),
    body: message.body,
  });
}

function freezeSelectedMessage(message: MailboxMessageDetails | MailSelectedMessage): MailSelectedMessage {
  return Object.freeze({
    body: message.body,
    date: message.date,
    folderId: message.folderId,
    from: message.from,
    id: message.id,
    preview: message.preview,
    selected: true,
    subject: message.subject,
    to: freezeStringArray(message.to),
    unread: message.unread,
  });
}

function freezeDraft(draft: MailComposeDraft): MailComposeDraft {
  return Object.freeze({
    bcc: freezeStringArray(draft.bcc),
    body: draft.body,
    cc: freezeStringArray(draft.cc),
    subject: draft.subject,
    to: freezeStringArray(draft.to),
  });
}

function freezeError(errorValue: MailAppError): MailAppError {
  return Object.freeze({
    code: errorValue.code,
    message: errorValue.message,
    path: errorValue.path,
  });
}

function freezeStringArray(input: readonly string[]): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];

    if (value !== undefined) output.push(value);
  }

  return Object.freeze(output);
}

function normalizeDraftPatch(input: unknown): MailboxPortResult<MailComposeDraftPatch> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return rejectPort("INVALID_DRAFT_PATCH", "draft patch must be a plain object.", "/draft");
  }

  const prototype = Object.getPrototypeOf(input);

  if (prototype !== Object.prototype && prototype !== null) {
    return rejectPort("INVALID_DRAFT_PATCH", "draft patch must be a plain object.", "/draft");
  }

  const keys = Reflect.ownKeys(input);
  const output: {
    to?: readonly string[];
    cc?: readonly string[];
    bcc?: readonly string[];
    subject?: string;
    body?: string;
  } = {};

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || typeof key === "symbol") {
      return rejectPort("INVALID_DRAFT_PATCH", "draft patch contains an unsupported field.", "/draft");
    }

    const descriptor = Object.getOwnPropertyDescriptor(input, key);

    if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      return rejectPort("INVALID_DRAFT_PATCH", "draft patch must contain only data fields.", `/draft/${pathToken(key)}`);
    }

    const value: unknown = descriptor.value;

    if (key === "to" || key === "cc" || key === "bcc") {
      const normalized = normalizeStringArray(value, `/draft/${key}`);

      if (!normalized.ok) return normalized;
      output[key] = normalized.value;
    } else if (key === "subject" || key === "body") {
      if (typeof value !== "string") {
        return rejectPort("INVALID_DRAFT_PATCH", "draft text fields must be strings.", `/draft/${key}`);
      }

      output[key] = value;
    } else {
      return rejectPort("INVALID_DRAFT_PATCH", "draft patch contains an unsupported field.", `/draft/${pathToken(key)}`);
    }
  }

  return acceptPort(Object.freeze(output));
}

function normalizeStringArray(value: unknown, path: string): MailboxPortResult<readonly string[]> {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return rejectPort("INVALID_DRAFT_PATCH", "recipient fields must be arrays of strings.", path);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");

  if (lengthDescriptor === undefined || !isDataDescriptor(lengthDescriptor)) {
    return rejectPort("INVALID_DRAFT_PATCH", "recipient fields must be dense arrays.", path);
  }

  const length = lengthDescriptor.value;

  if (!Number.isSafeInteger(length) || length < 0) {
    return rejectPort("INVALID_DRAFT_PATCH", "recipient fields must be dense arrays.", path);
  }

  const keys = Reflect.ownKeys(value);

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];

    if (key === undefined || !isArrayOwnKey(key, length)) {
      return rejectPort("INVALID_DRAFT_PATCH", "recipient fields must be dense arrays.", path);
    }
  }

  const output: string[] = [];

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

    if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      return rejectPort("INVALID_DRAFT_PATCH", "recipient fields must be dense arrays.", `${path}/${index}`);
    }
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      return rejectPort("INVALID_DRAFT_PATCH", "recipients must be non-empty strings.", `${path}/${index}`);
    }

    output.push(descriptor.value);
  }

  return acceptPort(Object.freeze(output));
}

function foldersWithUnreadCounts(
  folders: readonly MailboxFolder[],
  messages: ReadonlyMap<string, MailboxMessageDetails>,
): readonly MailboxFolder[] {
  const output: MailboxFolder[] = [];

  for (let folderIndex = 0; folderIndex < folders.length; folderIndex += 1) {
    const folder = folders[folderIndex];

    if (folder === undefined) continue;

    let unreadCount = 0;

    for (const message of messages.values()) {
      if (message.folderId === folder.id && message.unread) unreadCount += 1;
    }

    const input: {
      id: string;
      label: string;
      kind: MailFolderKind;
      unreadCount: number;
      sortOrder?: number;
    } = {
      id: folder.id,
      kind: folder.kind,
      label: folder.label,
      unreadCount,
    };

    if (folder.sortOrder !== undefined) input.sortOrder = folder.sortOrder;
    output.push(freezeMailboxFolder(input));
  }

  return Object.freeze(output);
}

function resolveActiveFolderId(
  folders: readonly MailboxFolder[],
  requestedFolderId: string | undefined,
): string | undefined {
  if (requestedFolderId !== undefined && findFolder(folders, requestedFolderId) !== undefined) {
    return requestedFolderId;
  }

  const inbox = findFolderByKind(folders, "inbox");

  if (inbox !== undefined) return inbox.id;

  return folders[0]?.id;
}

function findOutboxFolder(folders: readonly MailboxFolder[]): MailboxFolder | undefined {
  const byKind = findFolderByKind(folders, "outbox");

  if (byKind !== undefined) return byKind;

  return findFolder(folders, "outbox");
}

function findFolderByKind(
  folders: readonly MailboxFolder[],
  kind: MailFolderKind,
): MailboxFolder | undefined {
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];

    if (folder !== undefined && folder.kind === kind) return folder;
  }

  return undefined;
}

function findFolder(
  folders: readonly MailboxFolder[] | readonly MailFolderView[],
  id: string,
): MailboxFolder | MailFolderView | undefined {
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];

    if (folder !== undefined && folder.id === id) return folder;
  }

  return undefined;
}

function findMessage(
  messages: readonly MailboxMessage[] | readonly MailMessageView[],
  id: string,
): MailboxMessage | MailMessageView | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message !== undefined && message.id === id) return message;
  }

  return undefined;
}

function nextQueuedMessageId(
  messages: ReadonlyMap<string, MailboxMessageDetails>,
  queuedCount: number,
): string {
  let suffix = queuedCount;
  let id = `local-outbox-${suffix}`;

  while (messages.has(id)) {
    suffix += 1;
    id = `local-outbox-${suffix}`;
  }

  return id;
}

function previewText(body: string, subject: string): string {
  const trimmed = body.trim();

  if (trimmed.length === 0) return subject;
  if (trimmed.length <= 96) return trimmed;

  return `${trimmed.slice(0, 95)}...`;
}

function compareFolders(left: MailboxFolder, right: MailboxFolder): number {
  const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const order = leftOrder - rightOrder;

  if (order !== 0) return order;

  const label = compareStrings(left.label, right.label);

  if (label !== 0) return label;

  return compareStrings(left.id, right.id);
}

function compareMessages(left: MailboxMessage, right: MailboxMessage): number {
  const date = compareStrings(right.date, left.date);

  if (date !== 0) return date;

  return compareStrings(left.id, right.id);
}

function normalizeUnreadCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;

  return Math.trunc(value);
}

function callPort<T>(
  path: string,
  callback: () => MailboxPortResult<T>,
): MailboxPortResult<T> {
  try {
    return callback();
  } catch {
    return rejectPort(
      "MAILBOX_PORT_FAILED",
      "local mailbox port failed closed.",
      `/mailbox/${path}`,
    );
  }
}

function acceptAction(action: MailAppAction, snapshot: MailAppSnapshot): MailAppResult {
  return Object.freeze({
    action,
    ok: true,
    snapshot,
  });
}

function rejectAction(
  action: MailAppAction,
  errorValue: MailAppError | undefined,
  snapshot: MailAppSnapshot,
): MailAppResult {
  return Object.freeze({
    action,
    error: errorValue ?? error("MAIL_APP_ERROR", "mail action failed closed.", "/mail"),
    ok: false,
    snapshot,
  });
}

function acceptPort<T>(value: T): MailboxPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectPort<T>(code: string, message: string, path: string): MailboxPortResult<T> {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}

function error(code: string, message: string, path: string): MailAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function isDeniedError(errorValue: MailAppError): boolean {
  return (
    errorValue.code.includes("DENIED") ||
    errorValue.code.includes("FORBIDDEN") ||
    errorValue.code.includes("MISSING")
  );
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isArrayOwnKey(key: string | symbol, length: number): boolean {
  if (typeof key === "symbol") return false;
  if (key === "length") return true;

  const index = Number(key);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

    const code = char.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    token += alphaNumeric || code === 45 || code === 46
      ? char
      : `_${code.toString(16).padStart(4, "0")}`;
  }

  return token.length === 0 ? "_" : token;
}

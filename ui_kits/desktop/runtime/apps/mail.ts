// Mail — a REAL dark two-pane mailbox mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): a folder list (left), a message list (middle), and a reading pane (right),
// driven by the mail view-model (viewmodels/apps/mail-app.ts): select folder, select message, mark
// read, unread counts. The mailbox is BACKED BY ctx.host.requestFile on /mail — on mount we try to
// read /mail/mailbox.json (op "read") and build the in-memory mailbox port from it. If that file is
// unavailable (no grant / not provisioned), we fall back to a small bundled local sample so the
// two-pane UI stays real and navigable, and the status line says so honestly.
//
// Token-driven dark theme (var(--surface)/var(--text)/var(--hairline)/var(--accent)). One delegated
// click listener drives folder/message selection; listeners removed on close.

import type {
  DesktopHost,
  FilesResponse,
  FilesErrorResponse,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createInMemoryMailAppMailboxPort,
  createMailAppViewModel,
} from "../../viewmodels/apps/mail-app.ts";
import type {
  InMemoryMailboxSeed,
  MailAppSnapshot,
  MailAppViewModel,
  MailboxFolder,
  MailboxMessageDetails,
} from "../../viewmodels/apps/mail-app.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";
import type {
  WmElement,
} from "../window-manager.ts";

const MAILBOX_PATH = "/mail/mailbox.json";
const MAILBOX_GRANT = "mail";

export const mailApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["files.read"] as const),
    icon: "✉️",
    id: "vita.app.mail",
    title: "Mail",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    let disposed = false;
    let viewModel: MailAppViewModel | undefined;
    let sourceNote = "";

    root.style.cssText = "display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text)";
    root.innerHTML = loadingState();
    ctx.window.setBadge("/mail");

    void (async () => {
      const loaded = await loadMailbox(ctx.host);

      if (disposed) return;

      sourceNote = loaded.note;
      viewModel = createMailAppViewModel({
        initialFolderId: "inbox",
        mailbox: createInMemoryMailAppMailboxPort(loaded.seed),
      });
      rerender();
    })();

    function rerender(): void {
      if (disposed || viewModel === undefined) return;

      root.innerHTML = renderMail(viewModel.snapshot(), sourceNote);
    }

    // Delegated click: a folder row selects a folder; a message row selects+reads a message.
    const onClick = (event: unknown): void => {
      if (viewModel === undefined) return;

      const folderId = attrValue(event, "data-vita-mail-folder");

      if (folderId !== undefined) {
        viewModel.selectFolder(folderId);
        rerender();
        return;
      }

      const messageId = attrValue(event, "data-vita-mail-message");

      if (messageId !== undefined) {
        const selected = viewModel.selectMessage(messageId);

        // Reading a message marks it read (the view-model reloads unread counts).
        if (selected.ok && selected.snapshot.selectedMessage?.unread === true) {
          viewModel.markRead(messageId);
        }

        rerender();
      }
    };

    root.addEventListener("click", onClick as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("click", onClick as never);
      offClose();
    }

    return cleanup;
  },
});

export default mailApp;

interface LoadedMailbox {
  readonly seed: InMemoryMailboxSeed;
  readonly note: string;
}

// Try to load the on-disk mailbox via the host files port; fall back to a bundled local sample.
async function loadMailbox(host: DesktopHost): Promise<LoadedMailbox> {
  const requestFile = host.requestFile;

  if (requestFile === undefined) {
    return Object.freeze({ note: "no files backend — showing a local sample mailbox.", seed: sampleSeed() });
  }

  let response: FilesResponse | FilesErrorResponse;

  try {
    response = await Promise.resolve(
      requestFile(Object.freeze({ grant: MAILBOX_GRANT, op: "read", path: MAILBOX_PATH })) as never,
    ) as FilesResponse | FilesErrorResponse;
  } catch {
    return Object.freeze({ note: "mail backend failed closed — showing a local sample mailbox.", seed: sampleSeed() });
  }

  if (hasError(response)) {
    return Object.freeze({
      note: `${MAILBOX_PATH} unavailable (${response.error.code}) — showing a local sample mailbox.`,
      seed: sampleSeed(),
    });
  }

  const data = (response as FilesResponse).data;
  const parsed = typeof data === "string" ? parseSeed(data) : undefined;

  if (parsed === undefined) {
    return Object.freeze({
      note: `${MAILBOX_PATH} could not be parsed — showing a local sample mailbox.`,
      seed: sampleSeed(),
    });
  }

  return Object.freeze({ note: `Live: ${MAILBOX_PATH}`, seed: parsed });
}

function parseSeed(data: string): InMemoryMailboxSeed | undefined {
  let raw: unknown;

  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }

  if (raw === null || typeof raw !== "object") return undefined;

  const folders = normalizeFolders((raw as { folders?: unknown }).folders);
  const messages = normalizeMessages((raw as { messages?: unknown }).messages);

  if (folders.length === 0) return undefined;

  return Object.freeze({ folders, messages });
}

function normalizeFolders(input: unknown): readonly MailboxFolder[] {
  if (!Array.isArray(input)) return Object.freeze([]);

  const out: MailboxFolder[] = [];

  for (const entry of input) {
    if (entry === null || typeof entry !== "object") continue;

    const id = stringField(entry, "id");
    const label = stringField(entry, "label");
    const kind = stringField(entry, "kind");

    if (id === undefined || label === undefined || !isFolderKind(kind)) continue;

    const sortOrder = numberField(entry, "sortOrder");
    const folder: { id: string; label: string; kind: MailboxFolder["kind"]; unreadCount: number; sortOrder?: number } = {
      id,
      kind,
      label,
      unreadCount: numberField(entry, "unreadCount") ?? 0,
    };

    if (sortOrder !== undefined) folder.sortOrder = sortOrder;
    out.push(Object.freeze(folder));
  }

  return Object.freeze(out);
}

function normalizeMessages(input: unknown): readonly MailboxMessageDetails[] {
  if (!Array.isArray(input)) return Object.freeze([]);

  const out: MailboxMessageDetails[] = [];

  for (const entry of input) {
    if (entry === null || typeof entry !== "object") continue;

    const id = stringField(entry, "id");
    const folderId = stringField(entry, "folderId");
    const from = stringField(entry, "from");
    const subject = stringField(entry, "subject");
    const body = stringField(entry, "body");
    const date = stringField(entry, "date");

    if (id === undefined || folderId === undefined || from === undefined || subject === undefined) continue;

    out.push(Object.freeze({
      body: body ?? "",
      date: date ?? "1970-01-01T00:00:00Z",
      folderId,
      from,
      id,
      preview: (body ?? subject).slice(0, 96),
      subject,
      to: Object.freeze(["me@local"]),
      unread: booleanField(entry, "unread") ?? false,
    }));
  }

  return Object.freeze(out);
}

// A small, deterministic offline sample so the two-pane UI is fully exercisable without provisioning.
function sampleSeed(): InMemoryMailboxSeed {
  return Object.freeze({
    folders: Object.freeze([
      Object.freeze({ id: "inbox", kind: "inbox" as const, label: "Inbox", sortOrder: 10, unreadCount: 0 }),
      Object.freeze({ id: "sent", kind: "sent" as const, label: "Sent", sortOrder: 20, unreadCount: 0 }),
      Object.freeze({ id: "outbox", kind: "outbox" as const, label: "Outbox", sortOrder: 30, unreadCount: 0 }),
    ]),
    messages: Object.freeze([
      Object.freeze({
        body: "Welcome to Vita Mail. This local sample is shown when /mail is not provisioned yet.\n\nSelect a message to read it; reading marks it as read.",
        date: "2026-06-25T09:30:00Z",
        folderId: "inbox",
        from: "Vita",
        id: "welcome",
        preview: "Welcome to Vita Mail.",
        subject: "Welcome to Vita Mail",
        to: Object.freeze(["me@local"]),
        unread: true,
      }),
      Object.freeze({
        body: "The mailbox is backed by the host files port at /mail/mailbox.json. Drop a mailbox file there and it loads live.",
        date: "2026-06-24T16:05:00Z",
        folderId: "inbox",
        from: "Desktop",
        id: "backing",
        preview: "The mailbox is backed by the host files port…",
        subject: "How the mailbox is backed",
        to: Object.freeze(["me@local"]),
        unread: true,
      }),
      Object.freeze({
        body: "Thanks — got it.",
        date: "2026-06-23T11:00:00Z",
        folderId: "sent",
        from: "me@local",
        id: "reply",
        preview: "Thanks — got it.",
        subject: "Re: Setup",
        to: Object.freeze(["desk@local"]),
        unread: false,
      }),
    ]),
  });
}

function renderMail(snapshot: MailAppSnapshot, sourceNote: string): string {
  const folders = snapshot.folders.map((folder) => {
    const active = folder.active;
    const bg = active ? "background:var(--surface-raised)" : "background:transparent";
    const badge = folder.unreadCount > 0
      ? `<span style="background:var(--accent);color:#fff;border-radius:9px;padding:1px 7px;font-size:10px">${folder.unreadCount}</span>`
      : "";

    return (
      `<div data-vita-mail-folder="${escapeHtml(folder.id)}" role="button" tabindex="0" ` +
      `style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;` +
      `padding:9px 14px;${bg};color:${active ? "var(--text)" : "var(--text-secondary)"}">` +
      `<span>${folderGlyph(folder.kind)} ${escapeHtml(folder.label)}</span>${badge}</div>`
    );
  }).join("");

  const messages = snapshot.messages.length === 0
    ? `<div style="padding:22px 16px;color:var(--text-faint);font-size:12px">No messages in this folder.</div>`
    : snapshot.messages.map((message) => {
        const selected = message.selected;
        const bg = selected ? "background:var(--surface-raised)" : "background:transparent";
        const weight = message.unread ? "font-weight:600" : "font-weight:400";

        return (
          `<div data-vita-mail-message="${escapeHtml(message.id)}" role="button" tabindex="0" ` +
          `style="cursor:pointer;padding:10px 14px;border-bottom:1px solid var(--hairline);${bg}">` +
          `<div style="display:flex;justify-content:space-between;gap:8px;${weight};color:var(--text)">` +
          `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(message.from)}</span>` +
          `<span style="color:var(--text-faint);font-size:11px;white-space:nowrap">${escapeHtml(shortDate(message.date))}</span></div>` +
          `<div style="color:var(--text);${weight};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(message.subject)}</div>` +
          `<div style="color:var(--text-faint);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(message.preview)}</div></div>`
        );
      }).join("");

  const reading = snapshot.selectedMessage === undefined
    ? `<div style="padding:30px 20px;color:var(--text-faint);text-align:center">Select a message to read it.</div>`
    : (
        `<div style="padding:16px 20px;border-bottom:1px solid var(--hairline)">` +
        `<div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px">${escapeHtml(snapshot.selectedMessage.subject)}</div>` +
        `<div style="font-size:12px;color:var(--text-secondary)">From ${escapeHtml(snapshot.selectedMessage.from)} · ${escapeHtml(shortDate(snapshot.selectedMessage.date))}</div></div>` +
        `<div style="padding:18px 20px;color:var(--text);white-space:pre-wrap;line-height:1.6;font-size:13px">${escapeHtml(snapshot.selectedMessage.body)}</div>`
      );

  const note = sourceNote.length > 0
    ? `<div style="padding:5px 14px;border-top:1px solid var(--hairline);font-size:11px;color:var(--text-faint)">${escapeHtml(sourceNote)}</div>`
    : "";

  return (
    `<div style="flex:1;display:flex;min-height:0">` +
    `<div style="width:172px;border-right:1px solid var(--hairline);overflow:auto;background:var(--surface)">${folders}</div>` +
    `<div style="width:280px;border-right:1px solid var(--hairline);overflow:auto;background:var(--surface)">${messages}</div>` +
    `<div style="flex:1;overflow:auto;background:var(--surface)">${reading}</div>` +
    `</div>${note}`
  );
}

function loadingState(): string {
  return `<div style="padding:22px 16px;color:var(--text-faint)">Loading mailbox via the host bridge…</div>`;
}

function folderGlyph(kind: MailboxFolder["kind"]): string {
  switch (kind) {
    case "inbox":
      return "📥";
    case "sent":
      return "📤";
    case "outbox":
      return "📦";
    case "drafts":
      return "📝";
    case "trash":
      return "🗑️";
    case "archive":
      return "🗄️";
    default:
      return "📁";
  }
}

function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(0, 10) : date;
}

function hasError(response: FilesResponse | FilesErrorResponse): response is FilesErrorResponse {
  return Object.hasOwn(response as object, "error") && (response as FilesErrorResponse).error !== undefined;
}

function isFolderKind(value: string | undefined): value is MailboxFolder["kind"] {
  return (
    value === "archive" ||
    value === "custom" ||
    value === "drafts" ||
    value === "inbox" ||
    value === "outbox" ||
    value === "sent" ||
    value === "trash"
  );
}

function stringField(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];

  return typeof field === "string" ? field : undefined;
}

function numberField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];

  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function booleanField(value: object, key: string): boolean | undefined {
  const field = (value as Record<string, unknown>)[key];

  return typeof field === "boolean" ? field : undefined;
}

function attrValue(event: unknown, attr: string): string | undefined {
  try {
    const node = (event as { target?: unknown }).target;

    if (node === null || typeof node !== "object") return undefined;

    const closest = (node as { closest?: (s: string) => unknown }).closest;

    if (typeof closest !== "function") return undefined;

    const el = closest.call(node, `[${attr}]`) as { getAttribute?: (n: string) => string | null } | null;

    if (el === null || typeof el?.getAttribute !== "function") return undefined;

    const value = el.getAttribute(attr);

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

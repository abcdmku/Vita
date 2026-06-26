import {
  textEditorAppPackage,
} from "./manifest.ts";
import {
  createEditorAppViewModel,
} from "../../ui_kits/desktop/viewmodels/apps/editor-app.ts";
import type {
  EditorAppAction,
  EditorAppError,
  EditorAppResult,
  EditorAppSnapshot,
  EditorAppViewModel,
  EditorDocument,
  EditorLanguage,
} from "../../ui_kits/desktop/viewmodels/apps/editor-app.ts";
import type {
  AppPackageManifest,
  FilesCapabilityPort,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export type EditorBindId =
  | "editor.content"
  | "editor.cursor"
  | "editor.dirty"
  | "editor.language"
  | "editor.lineNumbers"
  | "editor.path"
  | "editor.title";

export type EditorActionId =
  | "editor.open"
  | "editor.redo"
  | "editor.save"
  | "editor.undo";

export interface EditorLaunchInput {
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
  readonly initialPath?: string;
  readonly package?: AppPackageManifest;
  readonly path?: string;
}

export interface EditorLaunchFields {
  readonly content: string;
  readonly cursor: string;
  readonly dirty: string;
  readonly error: EditorAppError | undefined;
  readonly language: string;
  readonly lineNumbers: string;
  readonly path: string;
  readonly title: string;
}

export interface EditorLaunchSnapshot {
  readonly editor: EditorLaunchFields;
}

export interface EditorLaunchEditor extends EditorLaunchFields {
  edit(replacement: string): EditorAppResult<"edit", EditorDocument>;
  open(path?: string): Promise<EditorAppResult<"open", EditorDocument>>;
  redo(): EditorAppResult<"redo", EditorDocument>;
  save(): Promise<EditorAppResult<"save", EditorDocument>>;
  undo(): EditorAppResult<"undo", EditorDocument>;
}

export type EditorLaunchActionResult =
  | EditorAppResult<"redo", EditorDocument>
  | EditorAppResult<"undo", EditorDocument>
  | Promise<EditorAppResult<"open", EditorDocument>>
  | Promise<EditorAppResult<"save", EditorDocument>>;

export type EditorLaunchActionHandler = () => EditorLaunchActionResult;

export interface EditorLaunchViewModel {
  readonly actions: ReadonlyMap<EditorActionId, EditorLaunchActionHandler>;
  readonly binds: ReadonlyMap<EditorBindId, () => string>;
  readonly editor: EditorLaunchEditor;
  snapshot(): EditorLaunchSnapshot;
}

const LANGUAGE_LABELS: Readonly<Record<EditorLanguage, string>> = Object.freeze({
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  plaintext: "Plain Text",
  typescript: "TypeScript",
});

export async function launchEditorApp(
  input: EditorLaunchInput = Object.freeze({}),
): Promise<EditorLaunchViewModel> {
  const modelInput: {
    files?: FilesCapabilityPort;
    grant: string;
    package: AppPackageManifest;
  } = {
    grant: input.grant ?? "",
    package: input.package ?? textEditorAppPackage.manifest,
  };

  if (input.files !== undefined) modelInput.files = input.files;

  const launch = new EditorLaunchModel(
    createEditorAppViewModel(modelInput),
    input.path ?? input.initialPath,
  );

  await launch.hydrate();

  return launch;
}

export const hydrateEditorApp = launchEditorApp;

class EditorLaunchModel implements EditorLaunchViewModel {
  readonly actions: ReadonlyMap<EditorActionId, EditorLaunchActionHandler>;
  readonly binds: ReadonlyMap<EditorBindId, () => string>;
  readonly editor: EditorLaunchEditor;
  readonly #model: EditorAppViewModel;
  #lastError: EditorAppError | undefined;
  #path: string | undefined;

  constructor(model: EditorAppViewModel, path: string | undefined) {
    this.#model = model;
    this.#path = path;
    const owner = this;

    this.editor = Object.freeze({
      get content(): string {
        return owner.#fields().content;
      },
      get cursor(): string {
        return owner.#fields().cursor;
      },
      get dirty(): string {
        return owner.#fields().dirty;
      },
      get error(): EditorAppError | undefined {
        return owner.#fields().error;
      },
      get language(): string {
        return owner.#fields().language;
      },
      get lineNumbers(): string {
        return owner.#fields().lineNumbers;
      },
      get path(): string {
        return owner.#fields().path;
      },
      get title(): string {
        return owner.#fields().title;
      },
      edit(replacement: string): EditorAppResult<"edit", EditorDocument> {
        return owner.#edit(replacement);
      },
      open(path?: string): Promise<EditorAppResult<"open", EditorDocument>> {
        return owner.#open(path);
      },
      redo(): EditorAppResult<"redo", EditorDocument> {
        return owner.#redo();
      },
      save(): Promise<EditorAppResult<"save", EditorDocument>> {
        return owner.#save();
      },
      undo(): EditorAppResult<"undo", EditorDocument> {
        return owner.#undo();
      },
    });

    this.binds = Object.freeze(new Map<EditorBindId, () => string>([
      ["editor.content", () => owner.editor.content],
      ["editor.cursor", () => owner.editor.cursor],
      ["editor.dirty", () => owner.editor.dirty],
      ["editor.language", () => owner.editor.language],
      ["editor.lineNumbers", () => owner.editor.lineNumbers],
      ["editor.path", () => owner.editor.path],
      ["editor.title", () => owner.editor.title],
    ]));

    this.actions = Object.freeze(new Map<EditorActionId, EditorLaunchActionHandler>([
      ["editor.open", () => owner.#open()],
      ["editor.redo", () => owner.#redo()],
      ["editor.save", () => owner.#save()],
      ["editor.undo", () => owner.#undo()],
    ]));
  }

  async hydrate(): Promise<void> {
    if (this.#path !== undefined) {
      await this.#open(this.#path);
    }
  }

  snapshot(): EditorLaunchSnapshot {
    return Object.freeze({
      editor: this.#fields(),
    });
  }

  #fields(): EditorLaunchFields {
    return fieldsFromSnapshot(this.#model.snapshot(), this.#lastError);
  }

  async #open(path?: string): Promise<EditorAppResult<"open", EditorDocument>> {
    return this.#recordResult(await this.#model.open(path ?? this.#path ?? ""));
  }

  #edit(replacement: string): EditorAppResult<"edit", EditorDocument> {
    return this.#recordResult(this.#model.edit(replacement));
  }

  #undo(): EditorAppResult<"undo", EditorDocument> {
    return this.#recordResult(this.#model.undo());
  }

  #redo(): EditorAppResult<"redo", EditorDocument> {
    return this.#recordResult(this.#model.redo());
  }

  async #save(): Promise<EditorAppResult<"save", EditorDocument>> {
    return this.#recordResult(await this.#model.save());
  }

  #recordResult<Action extends EditorAppAction, Value>(
    result: EditorAppResult<Action, Value>,
  ): EditorAppResult<Action, Value> {
    if (result.ok) {
      this.#lastError = undefined;
    } else {
      this.#lastError = result.error;
    }

    if (result.state.document !== undefined) {
      this.#path = result.state.document.path;
    }

    return result;
  }
}

function fieldsFromSnapshot(
  snapshot: EditorAppSnapshot,
  error: EditorAppError | undefined,
): EditorLaunchFields {
  const document = snapshot.document;
  const content = document?.content ?? "";

  return Object.freeze({
    content,
    cursor: `Ln ${snapshot.cursor.line}, Col ${snapshot.cursor.column}`,
    dirty: snapshot.dirty ? "Unsaved" : "Saved",
    error,
    language: document === undefined ? "Plain Text" : LANGUAGE_LABELS[document.language],
    lineNumbers: lineNumbersForContent(content),
    path: document?.path ?? "No file open",
    title: document === undefined ? "Untitled" : titleForPath(document.path),
  });
}

function titleForPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  const title = slash < 0 ? trimmed : trimmed.slice(slash + 1);

  return title.length > 0 ? title : path;
}

function lineNumbersForContent(content: string): string {
  let lines = 1;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") lines += 1;
  }

  const output: string[] = [];

  for (let line = 1; line <= lines; line += 1) {
    output.push(`${line}`);
  }

  return output.join("\n");
}

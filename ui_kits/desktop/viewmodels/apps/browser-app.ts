export const BROWSER_BLOCKED_OFFLINE_MESSAGE = "blocked: offline browser";
export const BROWSER_DEFAULT_TITLE = "Browser";

export type BrowserAppStatus = "idle" | "loading" | "loaded" | "blocked";
export type BrowserAppAction = "navigate" | "back" | "forward" | "reload";

export interface BrowserAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface BrowserResolvedContent {
  readonly title: string;
  readonly content: string;
}

export interface BrowserPage extends BrowserResolvedContent {
  readonly url: string;
}

export type BrowserHistoryEntry = BrowserPage;

export interface BrowserBlockedState {
  readonly url: string;
  readonly error: BrowserAppError;
}

export interface BrowserAppSnapshot {
  readonly currentUrl: string | null;
  readonly pageTitle: string;
  readonly pageContent: string;
  readonly backStack: readonly BrowserHistoryEntry[];
  readonly forwardStack: readonly BrowserHistoryEntry[];
  readonly status: BrowserAppStatus;
  readonly loading: boolean;
  readonly blocked: BrowserBlockedState | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type BrowserResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: BrowserAppError;
    };

export type BrowserAppActionResult =
  | {
      readonly ok: true;
      readonly action: BrowserAppAction;
      readonly state: BrowserAppSnapshot;
    }
  | {
      readonly ok: false;
      readonly action: BrowserAppAction;
      readonly error: BrowserAppError;
      readonly state: BrowserAppSnapshot;
    };

export interface BrowserResolveRequest {
  readonly url: string;
}

export type BrowserContentResult = BrowserResult<BrowserResolvedContent>;

export interface BrowserLocalContentResolverPort {
  readonly resolve: (request: BrowserResolveRequest) => BrowserContentResult;
}

export interface BrowserAppViewModelOptions {
  readonly resolver?: BrowserLocalContentResolverPort;
  readonly initialUrl?: string;
}

export interface BrowserAppViewModel {
  snapshot(): BrowserAppSnapshot;
  navigate(url: unknown): BrowserAppActionResult;
  back(): BrowserAppActionResult;
  forward(): BrowserAppActionResult;
  reload(): BrowserAppActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
    };

interface NormalizedBrowserOptions {
  readonly resolver?: UnknownBrowserContentResolverPort;
  readonly initialUrl?: string;
}

interface UnknownBrowserContentResolverPort {
  readonly resolve: (request: BrowserResolveRequest) => unknown;
}

const EMPTY_STACK: readonly BrowserHistoryEntry[] = Object.freeze([]);
const OPTION_FIELDS = Object.freeze(["initialUrl", "resolver"]);
const RESOLVER_FIELDS = Object.freeze(["resolve"]);
const RESOLVE_REQUEST_FIELDS = Object.freeze(["url"]);
const RESULT_FIELDS = Object.freeze(["error", "ok", "value"]);
const CONTENT_FIELDS = Object.freeze(["content", "title"]);
const ERROR_FIELDS = Object.freeze(["code", "message", "path"]);

const INITIAL_BROWSER_STATE: BrowserAppSnapshot = Object.freeze({
  backStack: EMPTY_STACK,
  blocked: null,
  canGoBack: false,
  canGoForward: false,
  currentUrl: null,
  forwardStack: EMPTY_STACK,
  loading: false,
  pageContent: "",
  pageTitle: BROWSER_DEFAULT_TITLE,
  status: "idle",
});

export const DEFAULT_BROWSER_LOCAL_PAGES = Object.freeze([
  freezePage({
    content: "Offline browser ready.",
    title: "Browser Start",
    url: "vita://browser/start",
  }),
  freezePage({
    content: "Only resolver-provided vita:// and local:// pages can load.",
    title: "Browser Help",
    url: "vita://browser/help",
  }),
  freezePage({
    content: "Network URLs are blocked by construction.",
    title: "About Browser",
    url: "local://browser/about",
  }),
]) satisfies readonly BrowserPage[];

export function createBrowserAppViewModel(options: unknown = Object.freeze({})): BrowserAppViewModel {
  const normalized = normalizeBrowserOptions(options);

  return new OfflineBrowserAppViewModel(normalized.ok ? normalized.value : Object.freeze({}));
}

export function createBrowserLocalContentResolver(
  pages: readonly BrowserPage[] = DEFAULT_BROWSER_LOCAL_PAGES,
): BrowserLocalContentResolverPort {
  const byUrl = new Map<string, BrowserResolvedContent>();

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];

    if (page === undefined) continue;

    const normalized = normalizePageInput(page);

    if (!normalized.ok || byUrl.has(normalized.value.url)) continue;

    byUrl.set(normalized.value.url, Object.freeze({
      content: normalized.value.content,
      title: normalized.value.title,
    }));
  }

  return Object.freeze({
    resolve(request: BrowserResolveRequest): BrowserContentResult {
      const normalizedRequest = normalizeResolveRequest(request);

      if (!normalizedRequest.ok) {
        return rejectContent(blockedOfflineError("BROWSER_URL_BLOCKED", "", "/url"));
      }

      const page = byUrl.get(normalizedRequest.value);

      if (page === undefined) {
        return rejectContent(blockedOfflineError("BROWSER_URL_BLOCKED", normalizedRequest.value, "/url"));
      }

      return accept(Object.freeze({
        content: page.content,
        title: page.title,
      }));
    },
  });
}

export const createStaticBrowserContentResolver = createBrowserLocalContentResolver;

class OfflineBrowserAppViewModel implements BrowserAppViewModel {
  readonly #resolver: UnknownBrowserContentResolverPort | undefined;
  #current: BrowserPage | null = null;
  #backStack: readonly BrowserHistoryEntry[] = EMPTY_STACK;
  #forwardStack: readonly BrowserHistoryEntry[] = EMPTY_STACK;
  #state: BrowserAppSnapshot = INITIAL_BROWSER_STATE;

  constructor(options: NormalizedBrowserOptions) {
    this.#resolver = options.resolver;

    if (options.initialUrl !== undefined) {
      this.navigate(options.initialUrl);
    }
  }

  snapshot(): BrowserAppSnapshot {
    return this.#state;
  }

  navigate(url: unknown): BrowserAppActionResult {
    const normalizedUrl = normalizeNavigationUrl(url);

    if (!normalizedUrl.ok) {
      return this.#block("navigate", displayUrl(url), blockedOfflineError("BROWSER_URL_BLOCKED", displayUrl(url), "/url"));
    }

    const loaded = this.#load(normalizedUrl.value);

    if (!loaded.ok) {
      return this.#block("navigate", normalizedUrl.value, loaded.error);
    }

    const current = this.#current;

    if (current !== null && current.url !== loaded.value.url) {
      this.#backStack = freezeStack([...this.#backStack, current]);
      this.#forwardStack = EMPTY_STACK;
    }

    this.#current = loaded.value;
    this.#state = stateFor(this.#current, this.#backStack, this.#forwardStack, "loaded", null);

    return actionAccept("navigate", this.#state);
  }

  back(): BrowserAppActionResult {
    const target = this.#backStack[this.#backStack.length - 1];

    if (this.#current === null || target === undefined) {
      return actionReject(
        "back",
        error("BROWSER_HISTORY_EMPTY", "back history is empty.", "/history/back"),
        this.#state,
      );
    }

    this.#backStack = freezeStack(this.#backStack.slice(0, -1));
    this.#forwardStack = freezeStack([this.#current, ...this.#forwardStack]);
    this.#current = target;
    this.#state = stateFor(this.#current, this.#backStack, this.#forwardStack, "loaded", null);

    return actionAccept("back", this.#state);
  }

  forward(): BrowserAppActionResult {
    const target = this.#forwardStack[0];

    if (this.#current === null || target === undefined) {
      return actionReject(
        "forward",
        error("BROWSER_HISTORY_EMPTY", "forward history is empty.", "/history/forward"),
        this.#state,
      );
    }

    this.#forwardStack = freezeStack(this.#forwardStack.slice(1));
    this.#backStack = freezeStack([...this.#backStack, this.#current]);
    this.#current = target;
    this.#state = stateFor(this.#current, this.#backStack, this.#forwardStack, "loaded", null);

    return actionAccept("forward", this.#state);
  }

  reload(): BrowserAppActionResult {
    const current = this.#current;

    if (current === null) {
      return actionReject(
        "reload",
        error("BROWSER_HISTORY_EMPTY", "no page is loaded.", "/currentUrl"),
        this.#state,
      );
    }

    const loaded = this.#load(current.url);

    if (!loaded.ok) {
      return this.#block("reload", current.url, loaded.error);
    }

    this.#current = loaded.value;
    this.#state = stateFor(this.#current, this.#backStack, this.#forwardStack, "loaded", null);

    return actionAccept("reload", this.#state);
  }

  #load(url: string): BrowserResult<BrowserPage> {
    if (this.#resolver === undefined) {
      return reject(blockedOfflineError("BROWSER_RESOLVER_UNAVAILABLE", url, "/resolver"));
    }

    let result: unknown;

    try {
      result = this.#resolver.resolve(Object.freeze({
        url,
      }));
    } catch {
      return reject(blockedOfflineError("BROWSER_RESOLVER_FAILED", url, "/resolver/resolve"));
    }

    const normalized = normalizeContentResult(result);

    if (!normalized.ok) {
      return reject(blockedOfflineError("BROWSER_CONTENT_INVALID", url, "/resolver/result"));
    }
    if (!normalized.value.ok) {
      return reject(normalized.value.error);
    }

    return accept(freezePage({
      content: normalized.value.value.content,
      title: normalized.value.value.title,
      url,
    }));
  }

  #block(action: BrowserAppAction, url: string, blockedError: BrowserAppError): BrowserAppActionResult {
    this.#state = stateFor(
      this.#current,
      this.#backStack,
      this.#forwardStack,
      "blocked",
      Object.freeze({
        error: freezeError(blockedError),
        url,
      }),
    );

    return actionReject(action, blockedError, this.#state);
  }
}

function normalizeBrowserOptions(input: unknown): NormalizeResult<NormalizedBrowserOptions> {
  const object = snapshotObject(input, OPTION_FIELDS);

  if (!object.ok) return rejectNormalize();

  const output: {
    resolver?: UnknownBrowserContentResolverPort;
    initialUrl?: string;
  } = {};
  const resolverValue = object.value.get("resolver");
  const initialUrlValue = object.value.get("initialUrl");

  if (resolverValue !== undefined) {
    const resolver = normalizeResolverPort(resolverValue);

    if (!resolver.ok) return rejectNormalize();

    output.resolver = resolver.value;
  }
  if (initialUrlValue !== undefined) {
    if (typeof initialUrlValue !== "string" || initialUrlValue.trim().length === 0) {
      return rejectNormalize();
    }

    output.initialUrl = initialUrlValue;
  }

  return acceptNormalize(Object.freeze(output));
}

function normalizeResolverPort(input: unknown): NormalizeResult<UnknownBrowserContentResolverPort> {
  const object = snapshotObject(input, RESOLVER_FIELDS);

  if (!object.ok) return rejectNormalize();

  const resolve = object.value.get("resolve");

  if (typeof resolve !== "function") return rejectNormalize();

  return acceptNormalize(Object.freeze({
    resolve: (request: BrowserResolveRequest): unknown => Reflect.apply(resolve, undefined, [request]),
  }));
}

function normalizeResolveRequest(input: unknown): NormalizeResult<string> {
  const object = snapshotObject(input, RESOLVE_REQUEST_FIELDS);

  if (!object.ok) return rejectNormalize();

  return normalizeNavigationUrl(object.value.get("url"));
}

function normalizeContentResult(input: unknown): NormalizeResult<BrowserContentResult> {
  const object = snapshotObject(input, RESULT_FIELDS);

  if (!object.ok) return rejectNormalize();

  const ok = object.value.get("ok");

  if (ok === true) {
    const content = normalizeResolvedContent(object.value.get("value"));

    if (!content.ok || object.value.has("error")) return rejectNormalize();

    return acceptNormalize(accept(content.value));
  }
  if (ok === false) {
    const normalizedError = normalizeError(object.value.get("error"));

    if (!normalizedError.ok || object.value.has("value")) return rejectNormalize();

    return acceptNormalize(reject(normalizedError.value));
  }

  return rejectNormalize();
}

function normalizeResolvedContent(input: unknown): NormalizeResult<BrowserResolvedContent> {
  const object = snapshotObject(input, CONTENT_FIELDS);

  if (!object.ok) return rejectNormalize();

  const title = object.value.get("title");
  const content = object.value.get("content");

  if (typeof title !== "string" || title.length === 0 || typeof content !== "string") {
    return rejectNormalize();
  }

  return acceptNormalize(Object.freeze({
    content,
    title,
  }));
}

function normalizePageInput(input: unknown): NormalizeResult<BrowserPage> {
  const pageObject = snapshotObject(input, Object.freeze(["content", "title", "url"]));

  if (!pageObject.ok) return rejectNormalize();

  const url = normalizeNavigationUrl(pageObject.value.get("url"));
  const content = normalizeResolvedContent(Object.freeze({
    content: pageObject.value.get("content"),
    title: pageObject.value.get("title"),
  }));

  if (!url.ok || !content.ok) return rejectNormalize();

  return acceptNormalize(freezePage({
    content: content.value.content,
    title: content.value.title,
    url: url.value,
  }));
}

function normalizeError(input: unknown): NormalizeResult<BrowserAppError> {
  const object = snapshotObject(input, ERROR_FIELDS);

  if (!object.ok) return rejectNormalize();

  const code = object.value.get("code");
  const message = object.value.get("message");
  const path = object.value.get("path");

  if (
    typeof code !== "string" ||
    code.length === 0 ||
    typeof message !== "string" ||
    message.length === 0 ||
    typeof path !== "string" ||
    path.length === 0
  ) {
    return rejectNormalize();
  }

  return acceptNormalize(error(code, message, path));
}

function normalizeNavigationUrl(input: unknown): NormalizeResult<string> {
  if (typeof input !== "string") return rejectNormalize();

  const trimmed = input.trim();

  if (trimmed.length === 0 || trimmed.startsWith("//")) return rejectNormalize();

  const scheme = schemePrefix(trimmed);

  if (scheme === null) {
    return isSafeLocalPath(trimmed) ? acceptNormalize(trimmed) : rejectNormalize();
  }

  const folded = scheme.toLocaleLowerCase("en-US");

  if (folded !== "vita" && folded !== "local") return rejectNormalize();

  return acceptNormalize(`${folded}${trimmed.slice(scheme.length)}`);
}

function schemePrefix(value: string): string | null {
  const colonIndex = value.indexOf(":");

  if (colonIndex <= 0) return null;

  for (let index = 0; index < colonIndex; index += 1) {
    const code = value.charCodeAt(index);
    const alpha =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    const punctuation = code === 43 || code === 45 || code === 46;

    if (index === 0 ? !alpha : !(alpha || digit || punctuation)) {
      return null;
    }
  }

  return value.slice(0, colonIndex);
}

function isSafeLocalPath(value: string): boolean {
  if (
    value.includes("\\") ||
    value.includes("/../") ||
    value === ".." ||
    value.startsWith("../") ||
    value.startsWith("//")
  ) {
    return false;
  }

  return (
    value === "index.html" ||
    value.startsWith("./") ||
    value.startsWith("/apps/") ||
    value.startsWith("apps/")
  );
}

function stateFor(
  current: BrowserPage | null,
  backStack: readonly BrowserHistoryEntry[],
  forwardStack: readonly BrowserHistoryEntry[],
  status: BrowserAppStatus,
  blocked: BrowserBlockedState | null,
): BrowserAppSnapshot {
  return Object.freeze({
    backStack: freezeStack(backStack),
    blocked,
    canGoBack: backStack.length > 0,
    canGoForward: forwardStack.length > 0,
    currentUrl: current?.url ?? null,
    forwardStack: freezeStack(forwardStack),
    loading: status === "loading",
    pageContent: current?.content ?? "",
    pageTitle: current?.title ?? BROWSER_DEFAULT_TITLE,
    status,
  });
}

function freezePage(page: BrowserPage): BrowserPage {
  return Object.freeze({
    content: page.content,
    title: page.title,
    url: page.url,
  });
}

function freezeStack(stack: readonly BrowserHistoryEntry[]): readonly BrowserHistoryEntry[] {
  const output: BrowserHistoryEntry[] = [];

  for (let index = 0; index < stack.length; index += 1) {
    const page = stack[index];

    if (page !== undefined) output.push(freezePage(page));
  }

  return Object.freeze(output);
}

function snapshotObject(input: unknown, allowedKeys: readonly string[]): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return rejectNormalize();
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return rejectNormalize();
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return rejectNormalize();
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectNormalize();
      }

      output.set(key, descriptor.value);
    }

    return acceptNormalize(output);
  } catch {
    return rejectNormalize();
  }
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function displayUrl(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function blockedOfflineError(code: string, url: string, path: string): BrowserAppError {
  const outputPath = url.length > 0 && path === "/url" ? `${path}/${pathToken(url)}` : path;

  return error(code, BROWSER_BLOCKED_OFFLINE_MESSAGE, outputPath);
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function error(code: string, message: string, path: string): BrowserAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function freezeError(input: BrowserAppError): BrowserAppError {
  return error(input.code, input.message, input.path);
}

function actionAccept(action: BrowserAppAction, state: BrowserAppSnapshot): BrowserAppActionResult {
  return Object.freeze({
    action,
    ok: true,
    state,
  });
}

function actionReject(
  action: BrowserAppAction,
  errorValue: BrowserAppError,
  state: BrowserAppSnapshot,
): BrowserAppActionResult {
  return Object.freeze({
    action,
    error: freezeError(errorValue),
    ok: false,
    state,
  });
}

function accept<T>(value: T): BrowserResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: BrowserAppError): BrowserResult<T> {
  return Object.freeze({
    error: freezeError(errorValue),
    ok: false,
  });
}

function acceptNormalize<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectNormalize<T>(): NormalizeResult<T> {
  return Object.freeze({
    ok: false,
  });
}

function rejectContent(errorValue: BrowserAppError): BrowserContentResult {
  return reject(errorValue);
}

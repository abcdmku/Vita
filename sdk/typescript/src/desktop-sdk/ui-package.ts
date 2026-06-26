import type {
  RegisteredShellComponent,
  ShellApplyResult,
  ShellComponentDefinition,
  ShellConfigDefinition,
  ShellManagedSnapshot,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
} from "../shell/index.ts";
import type {
  NotificationPostInput,
  ShellNotification,
  TrayItem,
  TrayItemInput,
} from "../shell/notifications/index.ts";
import type { FilesErrorResponse, FilesRequest, FilesResponse } from "../files-grant.ts";
import type { SemverRange } from "../semver-range.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type { TsxAppDescriptor, WebAppDescriptor } from "../appshell/index.ts";
import type { WindowId, WindowManagerIntent } from "../wm/policy.ts";
import { safeNormalize } from "../safe-normalize.ts";
import type {
  LockAuthenticateRequest,
  LockAuthPort,
  LockAuthSession,
  LockViewModelError,
  LockViewModelErrorCode,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";

export type DesktopMaybePromise<T> = T | Promise<T>;

export type DesktopCapability =
  | "apps.launch"
  | "apps.stop"
  | "files.read"
  | "files.write"
  | "launcher.launch"
  | "owner.auth"
  | "settings.read"
  | "settings.write"
  | "shell.notifications.post"
  | "shell.tray.register";

export interface DesktopCapabilityGrant {
  readonly capability: DesktopCapability;
  readonly resourceId?: string;
}

export type DesktopSdkCompatibility = string | SemverRange;

export interface DesktopUiPackageManifest {
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: DesktopSdkCompatibility;
  readonly entry: string;
  readonly capabilityGrants: readonly DesktopCapabilityGrant[];
}

export type DesktopLaunchableApp = TsxAppDescriptor | WebAppDescriptor;

export interface DesktopAppLaunch {
  readonly app: DesktopLaunchableApp;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly textureId: string;
  readonly intents: readonly WindowManagerIntent[];
}

export interface DesktopAppStop {
  readonly appId: string;
  readonly surfaceId?: string;
  readonly windowId?: WindowId;
  readonly textureId?: string;
  readonly intents: readonly WindowManagerIntent[];
}

export type DesktopHostResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

export interface DesktopHostError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface DesktopThemeTokens {
  readonly colors: Readonly<Record<string, string>>;
  readonly spacing: Readonly<Record<string, number>>;
  readonly radii: Readonly<Record<string, number>>;
  readonly typography: Readonly<Record<string, string | number>>;
}

export interface DesktopTheme {
  readonly id: string;
  readonly version: string;
  readonly tokens: DesktopThemeTokens;
}

export interface DesktopSettingsReadRequest {
  readonly key: string;
}

export interface DesktopSettingsWriteRequest {
  readonly key: string;
  readonly value: PlainJson;
}

export interface DesktopSettingsPreview {
  readonly revision: string;
  readonly diff: PlainJsonObject;
}

export interface DesktopSettingsApply {
  readonly revision: string;
  readonly applied: PlainJsonObject;
}

export interface DesktopLauncherIntent {
  readonly type: "launcher.open" | "launcher.close" | "launcher.launch";
  readonly appId?: string;
  readonly query?: string;
}

export type OwnerAuthAgentdCapability = "webauthn.get";

export interface OwnerAuthAgentdTransport {
  call(capability: OwnerAuthAgentdCapability, request: PlainJsonObject): DesktopMaybePromise<unknown>;
}

export interface OwnerAuthUser {
  readonly id: string;
  readonly displayName: string;
  readonly initials: string;
}

export interface OwnerAuthAssertion {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
  readonly action: string;
}

export interface OwnerAuthRequest {
  readonly assertion: OwnerAuthAssertion;
  readonly user: OwnerAuthUser;
}

export interface OwnerAuthSession {
  readonly user: OwnerAuthUser;
  readonly authenticatedAtMs?: number;
  readonly sessionId?: string;
}

export interface OwnerAuthPortOptions {
  readonly user?: OwnerAuthUser;
}

export interface DesktopHost {
  readonly package: DesktopUiPackageManifest;
  registerComponent(definition: ShellComponentDefinition): ShellResult<RegisteredShellComponent>;
  previewShell(definition: ShellConfigDefinition): ShellPreviewResult;
  applyShell(definition: ShellConfigDefinition): ShellApplyResult;
  rollbackShell(): ShellRollbackResult;
  currentShell?(): ShellManagedSnapshot;
  launchApp(app: DesktopLaunchableApp): DesktopMaybePromise<DesktopHostResult<DesktopAppLaunch>>;
  stopApp(appId: string): DesktopMaybePromise<DesktopHostResult<DesktopAppStop>>;
  postNotification(input: NotificationPostInput): ShellResult<ShellNotification>;
  registerTrayItem(input: TrayItemInput): ShellResult<TrayItem>;
  requestFile?(request: FilesRequest): DesktopMaybePromise<FilesResponse | FilesErrorResponse>;
  readSetting?(request: DesktopSettingsReadRequest): DesktopMaybePromise<DesktopHostResult<PlainJson>>;
  previewSetting?(request: DesktopSettingsWriteRequest): DesktopMaybePromise<DesktopHostResult<DesktopSettingsPreview>>;
  applySetting?(request: DesktopSettingsWriteRequest): DesktopMaybePromise<DesktopHostResult<DesktopSettingsApply>>;
  emitLauncherIntent?(intent: DesktopLauncherIntent): DesktopMaybePromise<DesktopHostResult<true>>;
  authenticateOwner?(request: OwnerAuthRequest): DesktopMaybePromise<DesktopHostResult<OwnerAuthSession>>;
  readTheme(): DesktopTheme;
}

export interface DesktopUiInstance {
  readonly packageId?: string;
  unmount(): DesktopMaybePromise<void>;
}

export interface DesktopUiPackage {
  readonly manifest: DesktopUiPackageManifest;
  mount(host: DesktopHost): DesktopMaybePromise<DesktopUiInstance>;
}

const LOCK_REQUEST_FIELDS = Object.freeze(["attemptNumber", "credential", "userId"]);
const OWNER_AUTH_ASSERTION_FIELDS = Object.freeze([
  "action",
  "authenticatorData",
  "clientDataJSON",
  "credentialId",
  "signature",
]);
const OWNER_AUTH_USER_FIELDS = Object.freeze(["displayName", "id", "initials"]);
const OWNER_AUTH_SESSION_REQUIRED_FIELDS = Object.freeze(["user"]);
const OWNER_AUTH_SESSION_OPTIONAL_FIELDS = Object.freeze(["authenticatedAtMs", "sessionId"]);

export function createOwnerAuthPort(
  host: Pick<DesktopHost, "authenticateOwner">,
  options: OwnerAuthPortOptions = Object.freeze({}),
): LockAuthPort {
  return Object.freeze({
    async authenticate(request: LockAuthenticateRequest): Promise<DesktopHostResult<LockAuthSession>> {
      const ownerRequest = ownerAuthRequestFromLockRequest(request, options);

      if (!ownerRequest.ok) return ownerRequest;

      const authenticateOwner = host.authenticateOwner;

      if (authenticateOwner === undefined) {
        return lockReject("AUTH_PORT_UNAVAILABLE", "owner authentication port is unavailable.", "/auth");
      }

      let result: DesktopHostResult<OwnerAuthSession>;

      try {
        result = await authenticateOwner(ownerRequest.value);
      } catch {
        return lockReject("AUTH_PORT_FAILED", "owner authentication port failed closed.", "/auth");
      }

      if (!result.ok) {
        return lockReject(
          hostErrorCodeToLockCode(result.error.code),
          "owner authentication was rejected.",
          result.error.path,
        );
      }

      const session = normalizeOwnerAuthSession(result.value, "/auth/result/value");

      return session.ok ? hostAccept(session.value) : session;
    },
  });
}

function ownerAuthRequestFromLockRequest(
  request: LockAuthenticateRequest,
  options: OwnerAuthPortOptions,
): DesktopHostResult<OwnerAuthRequest> {
  const normalized = safeNormalize(request);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return lockReject("AUTH_PORT_MALFORMED", "lock authentication request must be plain JSON.", "/auth/request");
  }

  const fields = expectFields(normalized.value, LOCK_REQUEST_FIELDS, Object.freeze([]), "/auth/request");

  if (!fields.ok) return lockReject("AUTH_PORT_MALFORMED", fields.error.message, fields.error.path);

  const credential = field(normalized.value, "credential");
  const userId = field(normalized.value, "userId");
  const attemptNumber = field(normalized.value, "attemptNumber");

  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    typeof userId !== "string" ||
    userId.length === 0 ||
    typeof attemptNumber !== "number" ||
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber <= 0
  ) {
    return lockReject("AUTH_PORT_MALFORMED", "lock authentication request is malformed.", "/auth/request");
  }

  const parsed = parseOwnerAuthCredential(credential);

  if (!parsed.ok) return parsed;

  const optionUser = options.user === undefined
    ? undefined
    : normalizeOwnerAuthUser(options.user, "/auth/options/user");

  if (optionUser !== undefined && !optionUser.ok) {
    return lockReject("AUTH_PORT_MALFORMED", optionUser.error.message, optionUser.error.path);
  }

  return hostAccept(Object.freeze({
    assertion: parsed.value.assertion,
    user: optionUser?.value ?? parsed.value.user ?? lockUserFromId(userId),
  }));
}

function parseOwnerAuthCredential(credential: string): DesktopHostResult<{
  readonly assertion: OwnerAuthAssertion;
  readonly user?: OwnerAuthUser;
}> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(credential) as unknown;
  } catch {
    return lockReject("AUTH_PORT_MALFORMED", "owner passkey assertion must be JSON.", "/credential");
  }

  const normalized = safeNormalize(parsed);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return lockReject("AUTH_PORT_MALFORMED", "owner passkey assertion must be plain JSON.", "/credential");
  }

  if (Object.hasOwn(normalized.value, "assertion")) {
    const fields = expectFields(normalized.value, Object.freeze(["assertion"]), Object.freeze(["user"]), "/credential");

    if (!fields.ok) return lockReject("AUTH_PORT_MALFORMED", fields.error.message, fields.error.path);

    const assertion = normalizeOwnerAuthAssertion(field(normalized.value, "assertion"), "/credential/assertion");
    const userValue = field(normalized.value, "user");
    const user = userValue === undefined ? undefined : normalizeOwnerAuthUser(userValue, "/credential/user");

    if (!assertion.ok) return assertion;
    if (user !== undefined && !user.ok) return user;

    const output: {
      assertion: OwnerAuthAssertion;
      user?: OwnerAuthUser;
    } = {
      assertion: assertion.value,
    };

    if (user !== undefined) output.user = user.value;

    return hostAccept(Object.freeze(output));
  }

  const assertion = normalizeOwnerAuthAssertion(normalized.value, "/credential");

  if (!assertion.ok) return assertion;

  return hostAccept(Object.freeze({
    assertion: assertion.value,
  }));
}

function normalizeOwnerAuthAssertion(input: PlainJson | undefined, path: string): DesktopHostResult<OwnerAuthAssertion> {
  if (!isPlainObject(input)) {
    return lockReject("AUTH_PORT_MALFORMED", "owner passkey assertion must be an object.", path);
  }

  const fields = expectFields(input, OWNER_AUTH_ASSERTION_FIELDS, Object.freeze([]), path);

  if (!fields.ok) return lockReject("AUTH_PORT_MALFORMED", fields.error.message, fields.error.path);

  const credentialId = nonEmptyString(field(input, "credentialId"));
  const authenticatorData = nonEmptyString(field(input, "authenticatorData"));
  const clientDataJSON = nonEmptyString(field(input, "clientDataJSON"));
  const signature = nonEmptyString(field(input, "signature"));
  const action = nonEmptyString(field(input, "action"));

  if (
    credentialId === undefined ||
    authenticatorData === undefined ||
    clientDataJSON === undefined ||
    signature === undefined ||
    action === undefined
  ) {
    return lockReject("AUTH_PORT_MALFORMED", "owner passkey assertion fields must be non-empty strings.", path);
  }

  return hostAccept(Object.freeze({
    action,
    authenticatorData,
    clientDataJSON,
    credentialId,
    signature,
  }));
}

function normalizeOwnerAuthSession(input: unknown, path: string): DesktopHostResult<LockAuthSession> {
  const normalized = safeNormalize(input);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return lockReject("AUTH_PORT_MALFORMED", "owner authentication session must be plain JSON.", path);
  }

  const fields = expectFields(normalized.value, OWNER_AUTH_SESSION_REQUIRED_FIELDS, OWNER_AUTH_SESSION_OPTIONAL_FIELDS, path);

  if (!fields.ok) return lockReject("AUTH_PORT_MALFORMED", fields.error.message, fields.error.path);

  const user = normalizeOwnerAuthUser(field(normalized.value, "user"), `${path}/user`);

  if (!user.ok) return user;

  const sessionId = field(normalized.value, "sessionId");
  const authenticatedAtMs = field(normalized.value, "authenticatedAtMs");
  const output: {
    user: OwnerAuthUser;
    authenticatedAtMs?: number;
    sessionId?: string;
  } = {
    user: user.value,
  };

  if (sessionId !== undefined) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return lockReject("AUTH_PORT_MALFORMED", "owner authentication session is malformed.", `${path}/sessionId`);
    }
    output.sessionId = sessionId;
  }
  if (authenticatedAtMs !== undefined) {
    if (typeof authenticatedAtMs !== "number" || !Number.isFinite(authenticatedAtMs)) {
      return lockReject("AUTH_PORT_MALFORMED", "owner authentication session is malformed.", `${path}/authenticatedAtMs`);
    }
    output.authenticatedAtMs = authenticatedAtMs;
  }

  return hostAccept(Object.freeze(output));
}

function normalizeOwnerAuthUser(input: unknown, path: string): DesktopHostResult<OwnerAuthUser> {
  const normalized = safeNormalize(input);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return lockReject("AUTH_PORT_MALFORMED", "owner auth user must be plain JSON.", path);
  }

  const fields = expectFields(normalized.value, OWNER_AUTH_USER_FIELDS, Object.freeze([]), path);

  if (!fields.ok) return lockReject("AUTH_PORT_MALFORMED", fields.error.message, fields.error.path);

  const id = nonEmptyString(field(normalized.value, "id"));
  const displayName = nonEmptyString(field(normalized.value, "displayName"));
  const initials = nonEmptyString(field(normalized.value, "initials"));

  if (id === undefined || displayName === undefined || initials === undefined) {
    return lockReject("AUTH_PORT_MALFORMED", "owner auth user fields must be non-empty strings.", path);
  }

  return hostAccept(Object.freeze({
    displayName,
    id,
    initials,
  }));
}

function lockUserFromId(userId: string): OwnerAuthUser {
  const first = userId.trim().charAt(0).toUpperCase();

  return Object.freeze({
    displayName: userId,
    id: userId,
    initials: first.length === 0 ? "U" : first,
  });
}

function hostErrorCodeToLockCode(code: string): LockViewModelErrorCode {
  if (code === "MALFORMED_OWNER_AUTH_RESPONSE" || code === "INVALID_HOST_REQUEST") {
    return "AUTH_PORT_MALFORMED";
  }
  if (code === "OWNER_AUTH_PORT_UNAVAILABLE") {
    return "AUTH_PORT_UNAVAILABLE";
  }

  return "AUTHENTICATION_REJECTED";
}

function expectFields(
  value: PlainJsonObject,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): DesktopHostResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !contains(requiredFields, key) && !contains(optionalFields, key)) {
      return hostReject("UNEXPECTED_FIELD", "object contains an unsupported field.", `${path}/${pathToken(key)}`);
    }
  }

  for (let index = 0; index < requiredFields.length; index += 1) {
    const key = requiredFields[index];

    if (key !== undefined && !Object.hasOwn(value, key)) {
      return hostReject("MISSING_FIELD", "object is missing a required field.", `${path}/${key}`);
    }
  }

  return hostAccept(true);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function nonEmptyString(value: PlainJson | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function hostAccept<T>(value: T): Extract<DesktopHostResult<T>, { readonly ok: true }> {
  return {
    ok: true,
    value,
  };
}

function hostReject<T>(code: string, message: string, path: string): Extract<DesktopHostResult<T>, { readonly ok: false }> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function lockReject<T>(
  code: LockViewModelErrorCode,
  message: string,
  path: string,
): Extract<DesktopHostResult<T>, { readonly ok: false }> {
  return {
    error: Object.freeze({
      code,
      message,
      path,
    } satisfies LockViewModelError),
    ok: false,
  };
}

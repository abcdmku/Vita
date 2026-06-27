// Puter platform server - the ON-DEVICE Deno BOOT ENTRY (the LAUNCH.md "remaining glue").
//
// This is the tiny entry the OS image stages under /usr/lib/vita/app-platform/.../server/server-entry.ts
// and the vita-platform.service unit runs under the pinned, vendored Deno runtime (/usr/lib/vita/deno).
// It is the executable realization of the LAUNCH CONTRACT (server/LAUNCH.md): it reads the boot
// environment, maps it onto ServiceOptions, starts startPuterPlatformService(...), mints a well-known
// local session so the trust-on-host kiosk/diagnostic path can reach the api_origin, raises systemd
// readiness (sd_notify READY=1) once the faces are listening, and then stays alive.
//
// Runtime: Deno 2.8.x (the vita-ts.service runtime). The platform service itself is written against the
// node:* surface (node:http / node:https / node:fs / node:crypto via server.ts + backend.ts + tls.ts +
// fs-store.ts); Deno's node-compat layer runs it unchanged. We deliberately REUSE the harness-verified
// service factory (single shared registry, real persistence, owner-token gate, in-process TLS) rather
// than re-implementing the request router on top of Deno.serve - the verified server logic IS the
// server, and Deno serves node:http/node:https listeners natively. (LAUNCH.md notes Deno.serveTls as
// the "native equivalent"; node:https under Deno is the same TLS posture with zero code divergence, so
// we keep ONE implementation path that the harness already proves.)
//
// NEVER import from the browser bundle. node-only modules + Deno-only globals (Deno.env / Deno.Command).

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAuditLog,
  createDevExecBackend,
  createMetaPlane,
  createOnDeviceControlPlane,
  createPackageRegistry,
  DEFAULT_AGENTD_SOCKET,
  DEFAULT_SHELL_APPS,
  KIOSK_ENTRY_PATH,
  nodeSourceFs,
  randomOpaqueToken,
  startPuterPlatformService,
  type AgentControlPlane,
  type CapabilityAuditSink,
  type ChildProcessLike,
  type ExecBackend,
  type InstalledPackage,
  type PuterOwner,
  type ServiceOptions,
  type ShellAppEntry,
  type VitaMode,
} from "./index.ts";

// The deploy/management console — the ONLY app minted the `control` capability (default-deny everywhere
// else). Mirrors apps/vita-deploy-console/manifest.ts (DEPLOY_CONSOLE_APP_ID / PUTER_API_ORIGIN_GRANTS);
// kept inline so the boot entry has no dependency on the apps/ tree.
const DEPLOY_CONSOLE_APP_ID = "vita.app.deploy-console";
const DEPLOY_CONSOLE_GRANTS = ["control", "auth", "kv.read", "kv.write"] as const;

const MARKER = "VITA-PLATFORM";

// ---------------------------------------------------------------------------------------------------
// Environment access - works under Deno (Deno.env) and Node (process.env), so the same entry runs in
// the dev harness (node --experimental-strip-types) and on-device (deno run).
// ---------------------------------------------------------------------------------------------------
function env(name: string): string | undefined {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;

  if (d !== undefined) {
    const v = d.env.get(name);

    return v === undefined || v === "" ? undefined : v;
  }

  const p = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  const v = p?.env?.[name];

  return v === undefined || v === "" ? undefined : v;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);

  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);

  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function emit(line: string): void {
  // The serial console is where the boot log is captured (QEMU -serial). stdout is journal+console on
  // the unit, so a single console.log lands on the serial. Match the house marker style ("VITA-*: ...").
  // eslint-disable-next-line no-console
  console.log(line);
}

// A readable file at `path`? Used to decide whether an owner-provided TLS cert/key actually exists
// (the unit always sets the env paths, but the files exist only when the owner delivered them).
function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Mode mapping - the IMAGE three-mode dialect (vita.mode=, written to /run/vita/platform.env by the
// vita-mode generator) vs. the server VitaMode the service factory understands.
//
//   image "headless" -> server "network-desktop": a server node with NO on-device kiosk browser, BUT
//                       BOTH faces bound - the loopback face is kept for same-machine diagnostics /
//                       a same-host browser, and the network TLS+owner face is the primary remote face.
//                       ("headless" = no DISPLAY, not "no local HTTP face": the kiosk UNIT is masked by
//                       the generator. The headless boot verification curls BOTH the loopback face and
//                       the network TLS face, so both must bind.)
//   image "desktop"  -> server "network-desktop": local kiosk browser (cage+chromium) on the loopback
//                       face PLUS the network face.
//   image "network"  -> server "network-desktop": the NETWORK DESKTOP node — the routable TLS+owner
//                       network face is the PRIMARY face an external client reaches, AND the loopback
//                       face stays bound for same-machine diagnostics (the baked self-test + an on-box
//                       curl). There is no on-device kiosk (the generator MASKS vita-kiosk.service in
//                       network mode, so no display stack is pulled in), but the local HTTP face is NOT
//                       a display: it is the loopback diagnostics face the three-modes doc calls out
//                       ("loopback face available for diagnostics"). Mapping network -> "headless"
//                       (network face ONLY) would drop that diagnostics face and break the self-test's
//                       loopback whoami/persistence checks, so we keep BOTH faces here.
//
// Override the derived server mode directly with VITA_SERVER_MODE for tests / unusual nodes.
// ---------------------------------------------------------------------------------------------------
function resolveServerMode(): VitaMode {
  const override = env("VITA_SERVER_MODE");

  if (override === "headless" || override === "local-desktop" || override === "network-desktop") {
    return override;
  }

  switch (env("VITA_MODE")) {
    case "network":
      return "network-desktop"; // routable TLS+owner network face (primary) + loopback diagnostics face
    case "desktop":
      return "network-desktop"; // local kiosk + network
    case "headless":
    default:
      return "network-desktop"; // loopback (diagnostics) + network; no kiosk browser
  }
}

// sd_notify(3) - tell the service manager the unit's state. Type=notify holds the unit "activating"
// until READY=1 arrives, so the kiosk unit (After=) only starts once the faces actually listen.
//
// Reliable path: shell out to `systemd-notify` (always present on a systemd node; it speaks the
// NOTIFY_SOCKET datagram protocol natively). Deno's own unix-DGRAM transport is unstable
// (--unstable-net) and host-verified-absent here, so we do NOT depend on it. The unit grants
// --allow-run=systemd-notify. No-op if NOTIFY_SOCKET is unset (dev / hand-start).
async function sdNotify(state: string): Promise<void> {
  if (env("NOTIFY_SOCKET") === undefined) return;

  const deno = (globalThis as {
    Deno?: { Command?: new (cmd: string, opts: { args: string[]; stdout: "null"; stderr: "null" }) => { output(): Promise<{ success: boolean }> } };
  }).Deno;

  if (deno?.Command === undefined) {
    emit(`${MARKER}: sd_notify skipped (no Deno.Command to invoke systemd-notify)`);

    return;
  }

  // Each non-empty status line becomes one `systemd-notify KEY=VALUE` argument.
  const args = state.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  try {
    const out = await new deno.Command("systemd-notify", { args, stderr: "null", stdout: "null" }).output();

    if (!out.success) emit(`${MARKER}: systemd-notify exited non-zero for ${args.join(" ")}`);
  } catch (err) {
    emit(`${MARKER}: sd_notify(${args.join(" ")}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Read the owner token from the systemd-credential file (VITA_OWNER_TOKEN_FILE) when present. Returns
// the trimmed contents, or undefined if the var is unset / the file is unreadable (fall through to the
// env value or a minted token). A non-empty token file is the production path.
function readOwnerToken(): string | undefined {
  const path = env("VITA_OWNER_TOKEN_FILE");

  if (path === undefined) return undefined;

  try {
    const raw = readFileSync(path, "utf8").trim();

    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

// Resolve the node's REAL owner identity for the LIVE owner-auth path. §16: the owner HOLDS the
// private key; the node only ever consults the owner's PUBLIC identity (a uuid + a display
// username + an emailConfirmed flag). We read it from a small JSON record the node persists on /var
// (VITA_OWNER_IDENTITY_FILE, default /var/lib/vita/owner/owner-identity.json), which the on-device
// owner-identity provisioning writes from agentd's owner record (identity.attestation /
// owner.identity). This file carries NO key material — only the public owner identity — so reading
// it here never touches the owner's private key.
//
// Returns undefined when the file is absent/unreadable/malformed (the platform then falls back to
// the trust-on-host single-owner default "owner"). The registry re-validates the identity strictly
// and refuses to mint a session on a malformed identity, so a bad file fails closed rather than
// minting a forged owner.
function readOwnerIdentity(): PuterOwner | undefined {
  const path = env("VITA_OWNER_IDENTITY_FILE") ?? "/var/lib/vita/owner/owner-identity.json";

  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // not provisioned → fall back to the default owner
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    emit(`${MARKER}: owner-identity file is not valid JSON at ${path} — falling back to default owner`);

    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    emit(`${MARKER}: owner-identity file is not an object at ${path} — falling back to default owner`);

    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const uuid = record["uuid"];
  const username = record["username"];
  // emailConfirmed is optional in the file; default true for the single trusted owner.
  const emailConfirmed = record["emailConfirmed"];

  if (typeof uuid !== "string" || uuid.length === 0 || typeof username !== "string" || username.length === 0) {
    emit(`${MARKER}: owner-identity file is missing uuid/username at ${path} — falling back to default owner`);

    return undefined;
  }

  return Object.freeze({
    emailConfirmed: typeof emailConfirmed === "boolean" ? emailConfirmed : true,
    username,
    uuid,
  });
}

// Persist a small file under /run/vita (tmpfs, per-boot). The platform DynamicUser can write here via
// RuntimeDirectory=; the baked boot probe reads these to present the local session token + owner token.
function writeRunFile(path: string, contents: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode: 0o640 });
  } catch (err) {
    emit(`${MARKER}: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Adapt node:child_process.spawn to the exec-plane's ChildProcessLike port (the dev exec backend spawns
// allow-listed commands with NO shell, a scrubbed env, and a private cwd — see exec-plane.ts). The on-
// device Terminal runs here over loopback (trust-on-host); the capability gate already restricted /pty to
// the exec-granted Terminal before any process is spawned.
const nodeChildProcess: ChildProcessLike = {
  spawn(command, args, options) {
    const child = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      stderr: { on: (_e, cb) => child.stderr?.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stdout: { on: (_e, cb) => child.stdout?.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stdin: { write: (d: string) => child.stdin?.write(d), end: () => child.stdin?.end() },
      on: (event, cb) => { child.on(event, cb as never); },
      kill: (signal?: string) => { child.kill((signal ?? "SIGTERM") as NodeJS.Signals); },
    };
  },
};

// Build the EXEC backend for the on-device Terminal: the hardened dev-sandbox backend (allow-list,
// no-shell, scrubbed env, private throwaway cwd per session, wall-clock + output caps). The /pty gate
// (exec capability) is enforced by the platform BEFORE this backend ever opens a session.
function buildExecBackend(): ExecBackend {
  return createDevExecBackend({
    childProcess: nodeChildProcess,
    makeCwd: () => mkdtempSync(join(tmpdir(), "vita-term-")),
    pathEnv: env("PATH") ?? "/usr/bin:/bin",
  });
}

// Project the shell catalog into InstalledPackage records so the Package Manager's /meta surface lists
// the REAL apps (id/name/version/kind/source/requested). The grants in the shell registry are the
// REQUESTED set the owner has granted; the meta plane reads the LIVE grant store for the granted set.
function shellAppsAsPackages(apps: readonly ShellAppEntry[], appsRoot: string): InstalledPackage[] {
  return apps.map((app) => ({
    id: app.id,
    name: app.title,
    version: "1.0.0",
    kind: "web-app" as const,
    sourceDir: resolve(appsRoot, app.id),
    entry: app.entry,
    // The meta plane only surfaces the GRANTABLE data caps (fs/kv/ui/auth) as "requested"; privileged
    // planes (control/exec/meta) are not owner-grantable through the meta UI.
    requested: app.grants.filter((g): g is "fs.read" | "fs.write" | "kv.read" | "kv.write" | "ui" | "auth" =>
      g === "fs.read" || g === "fs.write" || g === "kv.read" || g === "kv.write" || g === "ui" || g === "auth"),
    state: "installed" as const,
    description: app.description,
  }));
}

async function main(): Promise<void> {
  const serverMode = resolveServerMode();

  // APPS_ROOT (LAUNCH.md) | VITA_APPS_ROOT (the image unit env) - accept both; default the on-device mount.
  const appsRoot = env("APPS_ROOT") ?? env("VITA_APPS_ROOT") ?? "/var/lib/vita/apps";

  // Local face: VITA_LOCAL_PORT (LAUNCH.md) | VITA_PLATFORM_PORT (the image unit/kiosk env) - accept
  // both; the image pins 7681 in all three places.
  const localHost = env("VITA_LOCAL_HOST") ?? "127.0.0.1";
  const localPort = env("VITA_LOCAL_PORT") !== undefined ? envInt("VITA_LOCAL_PORT", 7681) : envInt("VITA_PLATFORM_PORT", 7681);
  const networkHost = env("VITA_NETWORK_HOST") ?? "0.0.0.0";
  const networkPort = envInt("VITA_NETWORK_PORT", 7443);

  // Owner token (the network-face bearer secret). Sourcing, in priority order:
  //   1. VITA_OWNER_TOKEN_FILE - a path (systemd LoadCredential delivers the secret as a 0400 file in
  //      $CREDENTIALS_DIRECTORY, the secure mechanism; the unit sets this to %d/owner_token). The file
  //      is minted+persisted on first boot on the /var partition (vita-owner-token.service).
  //   2. VITA_OWNER_TOKEN - a direct value (dev / hand-start).
  //   3. a freshly minted ephemeral token (logged) - bootstrap with no persisted token.
  const ownerToken = readOwnerToken() ?? env("VITA_OWNER_TOKEN") ?? randomOpaqueToken();

  // The node's REAL owner identity (the LIVE owner-auth source). Resolved from the node's persisted
  // PUBLIC owner record (no key material — §16). Absent ⇒ the platform uses the trust-on-host
  // default owner. The owner identity is what /whoami + minted sessions answer as.
  const ownerIdentity = readOwnerIdentity();

  // Owner-provided TLS material (spec §16: the owner holds the private key). The unit ALWAYS points
  // VITA_TLS_CERT/KEY at the conventional /var/lib/vita/tls paths, but those files exist only when the
  // owner actually delivered a cert. So we only hand the paths to the service when BOTH files are
  // present (resolveTlsMaterial throws if a given path is unreadable - fail-loud on a misconfigured
  // production cert). When they are absent the service SELF-SIGNS in-process (server/tls.ts) and we log
  // the SHA-256 fingerprint to pin out-of-band - the owner token, not the cert chain, is the trust anchor.
  const tlsCertEnv = env("VITA_TLS_CERT");
  const tlsKeyEnv = env("VITA_TLS_KEY");
  const tlsCert = tlsCertEnv !== undefined && fileExists(tlsCertEnv) ? tlsCertEnv : undefined;
  const tlsKey = tlsKeyEnv !== undefined && fileExists(tlsKeyEnv) ? tlsKeyEnv : undefined;

  if ((tlsCertEnv !== undefined || tlsKeyEnv !== undefined) && (tlsCert === undefined || tlsKey === undefined)) {
    emit(`${MARKER}: TLS owner cert/key not present at VITA_TLS_CERT/KEY - self-signing in-process`);
  }

  // Per-boot runtime dir for the published session + owner token (tmpfs). On-device the unit grants
  // this via RuntimeDirectory=vita -> /run/vita (owned by the DynamicUser). Overridable for the dev
  // harness (which is not root and cannot write a root-owned /run/vita).
  const runDir = env("VITA_RUN_DIR") ?? "/run/vita";

  emit(`${MARKER}: boot entry - image_mode=${env("VITA_MODE") ?? "headless"} server_mode=${serverMode} apps_root=${appsRoot}`);
  emit(`${MARKER}: faces local=${localHost}:${localPort} network=${networkHost}:${networkPort}`);

  // CONTROL PLANE: wire the deploy/management console to the LIVE node control plane (agentd) via the
  // on-device host-proxy. agentd serves its control surface over a unix socket (ADR-0008); the host-proxy
  // dials that socket per request and exposes agentd's real shapes (GET /state, POST /apply, GET
  // /healthz, GET /read/capsule.logs) behind the api_origin's /control/* bridge. The platform process is
  // in the vita-agent group, so agentd authenticates the connection by peer credentials (no token on this
  // hop); the api_origin's `control` capability gate is the per-app authorization layer.
  //
  // Enabled when the agentd socket is present (the on-device default) OR VITA_CONTROL_PLANE=1 is set
  // (a dev override). Absent socket + no override → /control/* answers 404 (data-plane-only), so a
  // node booted without agentd still serves the platform.
  const agentdSocket = env("VITA_AGENTD_SOCKET") ?? DEFAULT_AGENTD_SOCKET;
  const controlPlaneForced = env("VITA_CONTROL_PLANE") === "1";
  const controlPlaneEnabled = controlPlaneForced || fileExists(agentdSocket);
  let controlPlane: AgentControlPlane | undefined;

  if (controlPlaneEnabled) {
    try {
      controlPlane = createOnDeviceControlPlane({ socketPath: agentdSocket });
      emit(`${MARKER}: control plane WIRED to agentd at ${agentdSocket} (/control/* live)`);
    } catch (err) {
      emit(`${MARKER}: control plane NOT wired (${err instanceof Error ? err.message : String(err)}) — /control/* will 404`);
      controlPlane = undefined;
    }
  } else {
    emit(`${MARKER}: control plane disabled (no agentd socket at ${agentdSocket}, VITA_CONTROL_PLANE!=1) — /control/* will 404`);
  }

  // MULTI-WINDOW SHELL (the on-device kiosk desktop). On by default — the local/kiosk face serves the
  // shell page (multi-window desktop hosting Vita Desk + deploy console + terminal + editor + package
  // manager + the third-party apps, each in its own capability-gated window) at `/`, instead of the
  // single-app Vita Desk kiosk-entry. Set VITA_SHELL=0 to fall back to the legacy single-app kiosk.
  // The service mints ONE default-deny capability session per registry app (console=control,
  // package-manager=meta, terminal=exec, others minimal); the per-app map is served only on the local face.
  //
  // Path layout (staged + dev both): the runtime dir is .../ui_kits/desktop/runtime/puter. The shell
  // page + bundle live under shell/; Vita Desk (app/) + the third-party apps (apps/) + the package
  // manager (pkgmgr-app/) are sub-paths of staticRoot (the runtime dir) and need no alias. The deploy
  // console (apps/vita-deploy-console) and the editor (runtime/devloop/editor) live OUTSIDE the runtime
  // dir, so they get explicit aliases (/console, /editor); /ui_kits + /shell serve the shell's own assets.
  const shellEnabled = env("VITA_SHELL") !== "0";
  const runtimeDir = resolve(fileURLToPath(import.meta.url), "..", ".."); // .../runtime/puter
  const repoRootStaged = resolve(runtimeDir, "..", "..", "..", ".."); // app-platform root (or repo root)
  let shell: ServiceOptions["shell"];

  if (shellEnabled) {
    const shellHtmlPath = resolve(runtimeDir, "shell", "shell.html");

    if (existsSync(shellHtmlPath)) {
      shell = {
        apps: DEFAULT_SHELL_APPS,
        htmlPath: shellHtmlPath,
        staticAliases: {
          "/console": resolve(repoRootStaged, "apps", "vita-deploy-console"),
          "/editor": resolve(runtimeDir, "..", "devloop", "editor"),
          "/shell": resolve(runtimeDir, "shell"),
          "/ui_kits": resolve(repoRootStaged, "ui_kits"),
        },
      };
      emit(`${MARKER}: SHELL enabled — local face serves the multi-window desktop (${DEFAULT_SHELL_APPS.length} apps) at /`);
    } else {
      emit(`${MARKER}: SHELL requested but shell.html not found at ${shellHtmlPath} — falling back to single-app kiosk`);
    }
  } else {
    emit(`${MARKER}: SHELL disabled (VITA_SHELL=0) — local face serves the single-app kiosk-entry`);
  }

  // AUDIT SINK (finding #5): wire ONE capability audit log into the shared registry so EVERY gate
  // decision (allow + deny) is recorded. The SAME log is the meta-plane's audit source below, so the
  // Package Manager's activity view + the /meta audit endpoint surface what each app actually did
  // (especially DENIALS — the owner's signal that an app tried to exceed its grant). Without this the
  // gate recorded nothing.
  const auditLog = createAuditLog();
  const audit: CapabilityAuditSink = auditLog;

  // META PLANE (finding #7): the Package Manager's /meta/* control-plane-for-permissions, gated on the
  // `meta` capability (the Package Manager app only — now SAFE because control/exec/meta are distinct
  // broker scopes after finding #1). Built against the SHARED grant + capability registry, so a
  // grant change it writes is the grant store the broker reads on the next gated call (live revoke). The
  // package registry is seeded from the real shell catalog so /meta lists the installed apps.
  const metaPlaneFactory: ServiceOptions["metaPlaneFactory"] = ({ capabilities, grants }) => {
    const packages = createPackageRegistry({ fs: nodeSourceFs, seed: shellAppsAsPackages(DEFAULT_SHELL_APPS, appsRoot) });

    return createMetaPlane({ audit: auditLog, capabilities, grants, packages });
  };

  // EXEC BACKEND (finding #7): the on-device Terminal's /pty process plane (hardened dev sandbox). Mounted
  // on the LOCAL face only, gated on `exec` (the Terminal only). Safe now that exec is a distinct cap.
  const execBackend = buildExecBackend();

  const options: ServiceOptions = {
    appsRoot,
    audit,
    execBackend,
    faces: { localHost, localPort, networkHost, networkPort },
    metaPlaneFactory,
    mode: serverMode,
    ownerToken,
    ...(controlPlane !== undefined ? { controlPlane } : {}),
    ...(ownerIdentity !== undefined ? { ownerIdentity } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(tlsCert !== undefined && tlsKey !== undefined ? { tls: { certPath: tlsCert, keyPath: tlsKey } } : {}),
  };

  if (ownerIdentity !== undefined) {
    emit(`${MARKER}: owner identity resolved (uuid=${ownerIdentity.uuid} username=${ownerIdentity.username}) — live owner-auth source`);
  } else {
    emit(`${MARKER}: no owner-identity record — using trust-on-host default owner`);
  }

  let service;

  try {
    service = await startPuterPlatformService(options);
  } catch (err) {
    emit(`${MARKER}: FATAL service start failed: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`);
    await sdNotify("STATUS=service start failed\nERRNO=1\n");
    exit(1);

    return;
  }

  // Well-known LOCAL session: mint an app session so the trust-on-host loopback path (the kiosk browser
  // AND the boot diagnostic curl) can call the api_origin (/whoami, fs, kv). The local face has no owner
  // gate, but the api_origin STILL requires a valid app-session token (the per-app capability gate is
  // always on). This is the owner's own app-store session. The token is written to /run for the kiosk
  // page + the boot probe; on the network face it must be presented IN ADDITION to the owner token.
  const localAppId = env("VITA_LOCAL_APP_ID") ?? "vita.kiosk";
  const localApp = service.mintApp({
    appId: localAppId,
    grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"],
    instanceId: `boot-${randomOpaqueToken().slice(0, 12)}`,
  });

  // Publish the minted kiosk token to the LOCAL face so its `GET /session.js` hands it to the
  // in-browser puter.js SDK (which then authenticates to the local api_origin — fixes the documented
  // 401: kiosk-entry.html previously called /api/whoami with NO token). The network face has no
  // session-token provider, so the token is NEVER served to a remote client (owner-gated separately).
  service.setLocalSessionToken(localApp.token);

  // SHELL sessions: when the shell is on, the service already minted ONE default-deny capability session
  // per registry app (console=control, package-manager=meta, terminal=exec, others minimal) and serves the
  // map at /shell-session.js on the local face. Publish that map to /run so the diagnostic probe can
  // confirm each app got exactly its grants (and the console + pkgmgr + terminal carry their privileged caps).
  if (shell !== undefined && Object.keys(service.shellSessions).length > 0) {
    writeRunFile(`${runDir}/shell-sessions.json`, `${JSON.stringify({
      apiOrigin: "/api",
      sessions: service.shellSessions,
    }, null, 2)}\n`);
    const summary = DEFAULT_SHELL_APPS.map((a) => `${a.id}[${a.grants.join("+")}]`).join(" ");
    emit(`${MARKER}: SHELL sessions minted (${Object.keys(service.shellSessions).length} apps): ${summary}`);
  }

  // DEPLOY CONSOLE session (legacy single-app kiosk path): when the shell is OFF and the control plane is
  // wired, mint the console app's session with the `control` grant so it can clear /control/*. With the
  // shell ON, the registry's `vita.app.deploy-console` entry already holds `control` via the shared
  // registry (minted above), so this separate mint is skipped to avoid a redundant duplicate.
  if (shell === undefined && controlPlane !== undefined) {
    const consoleApp = service.mintApp({
      appId: DEPLOY_CONSOLE_APP_ID,
      grants: [...DEPLOY_CONSOLE_GRANTS],
      instanceId: `console-${randomOpaqueToken().slice(0, 12)}`,
    });

    writeRunFile(`${runDir}/console-session.json`, `${JSON.stringify({
      appId: consoleApp.appId,
      appToken: consoleApp.token,
      grants: consoleApp.grants,
    }, null, 2)}\n`);
    emit(`${MARKER}: deploy console session minted app_id=${consoleApp.appId} (control granted; token in ${runDir}/console-session.json)`);
  }

  // Publish the runtime facts the kiosk page + the boot probe consume (tmpfs, per-boot).
  writeRunFile(`${runDir}/platform-session.json`, `${JSON.stringify({
    appId: localApp.appId,
    appToken: localApp.token,
    kioskEntryPath: KIOSK_ENTRY_PATH,
    kioskUrl: service.kioskUrl ?? `http://${localHost}:${localPort}${KIOSK_ENTRY_PATH}`,
    localUrl: service.localUrl ?? `http://${localHost}:${localPort}`,
    networkUrl: service.networkUrl ?? null,
  }, null, 2)}\n`);
  // The owner token is the network-face bearer secret; keep it 0640 under /run for the owner/probe to
  // read out-of-band. (The durable copy lives on /var via the first-boot mint script.)
  writeRunFile(`${runDir}/owner-token`, `${ownerToken}\n`);

  // Witness the newly-wired planes so the on-device boot confirm can assert them (findings #5 + #7):
  // the capability audit sink records every gate decision; the meta plane (/meta/*) + the exec plane
  // (/pty) are mounted on the local face (gated on `meta` / `exec`, which are now DISTINCT broker scopes
  // after finding #1, so the Package Manager + Terminal work without capability confusion).
  emit(`${MARKER}: AUDIT sink wired (capability allow/deny recorded) status=OK`);
  emit(`${MARKER}: META plane wired (/meta/* gated on meta — Package Manager) status=OK`);
  emit(`${MARKER}: EXEC plane wired (/pty gated on exec — Terminal, local face) status=OK`);

  if (service.localUrl !== undefined) emit(`${MARKER}: LOCAL face up ${service.localUrl} (kiosk ${service.kioskUrl})`);
  if (service.networkUrl !== undefined) emit(`${MARKER}: NETWORK face up ${service.networkUrl} (owner-token${service.tls ? " + TLS" : " PLAINTEXT"})`);
  if (service.tls?.source === "self-signed") emit(`${MARKER}: TLS self-signed cert fingerprint(sha256)=${service.tls.fingerprintSha256}`);
  if (service.tls?.source === "owner-provided") emit(`${MARKER}: TLS owner-provided cert in use`);
  emit(`${MARKER}: local session minted app_id=${localApp.appId} (token in ${runDir}/platform-session.json)`);

  // systemd readiness: both faces are bound (startPuterPlatformService resolves only after listen), so
  // signal READY=1 now. The kiosk unit's After=vita-platform.service then unblocks.
  await sdNotify(`READY=1\nSTATUS=serving mode=${serverMode} local=${service.localUrl ?? "-"} network=${service.networkUrl ?? "-"}\n`);
  emit(`${MARKER}: READY (sd_notify) mode=${serverMode}`);

  // Stay alive: the listeners keep the event loop busy. Install signal handlers for a clean shutdown
  // (SIGTERM from systemd on stop/restart) so the store flushes and the ports free.
  await new Promise<void>((resolve) => {
    const shutdown = (sig: string): void => {
      emit(`${MARKER}: ${sig} - closing faces`);
      service
        .close()
        .catch(() => undefined)
        .finally(() => resolve());
    };
    const d = (globalThis as { Deno?: { addSignalListener(s: string, cb: () => void): void } }).Deno;

    if (d !== undefined) {
      try {
        d.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
        d.addSignalListener("SIGINT", () => shutdown("SIGINT"));
      } catch {
        // some platforms restrict signal listeners; the listeners still keep us alive.
      }
    } else {
      const p = (globalThis as { process?: { on(s: string, cb: () => void): void } }).process;

      p?.on("SIGTERM", () => shutdown("SIGTERM"));
      p?.on("SIGINT", () => shutdown("SIGINT"));
    }
  });
}

function exit(code: number): void {
  const d = (globalThis as { Deno?: { exit(c: number): never } }).Deno;

  if (d !== undefined) d.exit(code);
  const p = (globalThis as { process?: { exit(c: number): never } }).process;

  p?.exit(code);
}

await main();

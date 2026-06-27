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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  KIOSK_ENTRY_PATH,
  randomOpaqueToken,
  startPuterPlatformService,
  type ServiceOptions,
  type VitaMode,
} from "./index.ts";

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
//   image "network"  -> server "headless" (network face ONLY): a remote-only node, no loopback face.
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
      return "headless"; // network face only (remote-only node)
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

  const options: ServiceOptions = {
    appsRoot,
    faces: { localHost, localPort, networkHost, networkPort },
    mode: serverMode,
    ownerToken,
    ...(tlsCert !== undefined && tlsKey !== undefined ? { tls: { certPath: tlsCert, keyPath: tlsKey } } : {}),
  };

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

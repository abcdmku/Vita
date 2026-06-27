// Vita multi-window shell — the SHELL-SESSION wiring (node side).
//
// The shell page (shell.html) needs, for EACH registry app, a capability session minted server-side
// so the app's sandboxed iframe authenticates to the LOCAL api_origin. This mirrors /session.js (which
// hands the single kiosk app one token) but keyed by appId: it mints one session per app and publishes
// the {appId → {token, instanceId}} map to the browser as `window.__vitaShell`.
//
// Pure-ish: `mintShellSessions` mints sessions into a registry; `buildShellSessionScript` renders the
// browser bootstrap. No node:http here — the serve script wires the route. Browser-portable types only.

import type { PuterCapabilityRegistry } from "../capability.ts";
import type { ShellAppEntry, ShellAppSession, ShellSessionPayload } from "./app-registry.ts";

// Mint one capability session per registry app into the shared registry. Returns the {appId → session}
// map the shell publishes. Deterministic instance ids (`<appId>::shell`) so the broker + iframe agree.
export function mintShellSessions(
  capabilities: PuterCapabilityRegistry,
  apps: readonly ShellAppEntry[],
): Record<string, ShellAppSession> {
  const out: Record<string, ShellAppSession> = {};

  for (const app of apps) {
    const instanceId = `${app.id}::shell`;
    const session = capabilities.mintAppSession({
      appId: app.id,
      appInstanceId: instanceId,
      grants: app.grants,
    });

    out[app.id] = Object.freeze({ appId: app.id, instanceId, token: session.token });
  }

  return out;
}

// Render the same-origin bootstrap script served at /shell-session.js. It sets `window.__vitaShell`
// to the payload (api origin + per-app sessions) BEFORE the shell bundle loads, so the shell hands each
// app its own token. The payload is embedded as a JSON literal (cannot break out of the string).
export function buildShellSessionScript(payload: ShellSessionPayload): string {
  const literal = JSON.stringify(payload);

  return [
    "// Vita SHELL session bootstrap — served only on the trust-on-host face (per-app tokens).",
    `window.__vitaShell = ${literal};`,
    "",
  ].join("\n");
}

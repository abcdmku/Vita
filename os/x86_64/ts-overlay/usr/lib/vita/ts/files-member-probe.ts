// Vita household-member uid probe (P1-073).
//
// This is NOT part of the boot oneshot. It is a tiny, OPTIONAL helper that main.ts
// tries to spawn under uid 65540 (via `systemd-run --uid=65540`) to PRESENT a second
// authenticated unix peer for the household-member role_forbidden proof:
//
//   - main.ts runs as the runtime's own (DynamicUser) uid, which agentd binds to the
//     OWNER role through the vita-agent group. It therefore can NEVER trigger the
//     household-member decision itself.
//   - agentd resolves the household-member role ONLY from a peer whose SO_PEERCRED uid
//     is 65540 (see agent/cmd/agentd/main.go). So the role_forbidden denial on the
//     member-forbidden grant can only be produced by a peer authenticating as that uid.
//
// This probe opens its OWN agentd connection (so the kernel reports ITS uid over
// SO_PEERCRED), attempts the forbidden write, and prints exactly agentd's error code
// on stdout. It relays agentd's verdict — it cannot influence the role, which agentd
// derives solely from the authenticated peer uid. It NEVER fabricates a verdict.
//
// On the single-node smoke image this probe is effectively unreachable: vita-ts.service
// starts the runtime WITHOUT --allow-run and under NoNewPrivileges/RestrictSUIDSGID, so
// Deno denies the subprocess before this file is ever read (main.ts then DEFERS the
// member-forbidden marker rather than synthesizing it). The probe exists so the
// uid-helper mechanism is real, reviewable, and typechecked, and so a future
// boot-composition slice that DOES grant a uid-65540 peer can drive it unchanged.

import { createFilesClient, isFilesClientError } from "./vita/files-client.ts";
import { createDenoUnixSocketFilesAgentTransport } from "./vita/unix-socket-transport.ts";

const AGENTD_SOCKET_PATH = "/run/vita-agent/agentd.sock";
const AGENTD_BASE_URL = "http://agentd";
const MEMBER_FORBIDDEN_GRANT = "runtime-files-shared-member-forbidden";
const PROBE_PATH = "shared-roundtrip.txt";

async function main(): Promise<number> {
  const client = createFilesClient({
    baseUrl: AGENTD_BASE_URL,
    transport: createDenoUnixSocketFilesAgentTransport({ socketPath: AGENTD_SOCKET_PATH }),
  });

  try {
    // A write under the household-member role on the member-forbidden grant. If this
    // does NOT throw, the role gate failed open — print a sentinel so the caller
    // fails closed rather than treating it as a denial.
    await client.write(MEMBER_FORBIDDEN_GRANT, PROBE_PATH, new TextEncoder().encode("x"));
    console.log("not_rejected");
    return 1;
  } catch (cause) {
    if (isFilesClientError(cause)) {
      // agentd's sanitized error code (expected: role_forbidden). The caller checks
      // it equals role_forbidden before emitting the OK reject marker.
      console.log(cause.reason);
      return 0;
    }
    console.log("transport_error");
    return 1;
  }
}

main().then((code) => {
  Deno.exit(code);
}).catch(() => {
  console.log("probe_error");
  Deno.exit(1);
});

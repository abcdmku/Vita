const PACKAGE_ID = "com.vita.desktop.stub";
const SESSION_ID = "stub-session";
const HEARTBEAT_VOLUME_PATH = "/var/lib/vita/runtime/volumes/com.vita.desktop.stub/desktop-session";
const HEARTBEAT_FILE_NAME = "heartbeat.line";
const LAUNCH_NONCE_FILE_NAME = "launch-nonce";
const timestamp = new Date().toISOString();
const nonce = await readLaunchNonce(`${HEARTBEAT_VOLUME_PATH}/${LAUNCH_NONCE_FILE_NAME}`);
const heartbeatLine =
  "VITA-DESKTOP-HEARTBEAT: " +
  `id=${PACKAGE_ID} ` +
  `session=${SESSION_ID} ` +
  "sequence=1 " +
  `timestamp=${timestamp} ` +
  `nonce=${nonce} ` +
  "state=running status=OK";

Deno.writeTextFileSync(`${HEARTBEAT_VOLUME_PATH}/${HEARTBEAT_FILE_NAME}`, `${heartbeatLine}\n`);
console.log(heartbeatLine);

setInterval(() => {
  // Keep the no-op desktop session alive until capsule.lifecycle stops it.
}, 60_000);

async function readLaunchNonce(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;

  while (Date.now() <= deadline) {
    try {
      const nonce = normalizeNonce(await Deno.readTextFile(path));
      if (nonce !== undefined) {
        return nonce;
      }
    } catch {
      // The substrate writes the per-run launch nonce after capsule.execute starts.
    }

    await delay(100);
  }

  console.log(
    "VITA-DESKTOP-HEARTBEAT: " +
      `id=${PACKAGE_ID} ` +
      `session=${SESSION_ID} ` +
      "sequence=0 timestamp=unknown nonce=missing state=running status=FAILSAFE",
  );
  Deno.exit(2);
}

function normalizeNonce(raw: string): string | undefined {
  const nonce = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(nonce)) {
    return undefined;
  }

  return nonce;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

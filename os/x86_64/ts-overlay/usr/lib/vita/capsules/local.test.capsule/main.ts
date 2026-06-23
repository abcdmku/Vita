const VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const RECORD_PATH = `${VOLUME_PATH}/record.txt`;

Deno.writeTextFileSync(
  RECORD_PATH,
  `local.test.capsule volume write ${new Date().toISOString()}\n`,
  { append: true },
);

console.log("VITA-CAPSULE-WORKLOAD: id=local.test.capsule status=OK");

setInterval(() => {
  // Keep the proof capsule active so agentd can confirm systemd state and read DynamicUser's uid.
}, 60_000);

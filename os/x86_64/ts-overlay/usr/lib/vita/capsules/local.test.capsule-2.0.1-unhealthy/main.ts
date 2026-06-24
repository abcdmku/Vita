const VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const RECORD_PATH = `${VOLUME_PATH}/record.txt`;

Deno.writeTextFileSync(
  RECORD_PATH,
  `local.test.capsule unhealthy candidate write ${new Date().toISOString()}\n`,
  { append: true },
);

console.log("VITA-CAPSULE-WORKLOAD: id=local.test.capsule version=2.0.1-unhealthy status=STARTED");

setInterval(() => {
  // The manifest's TCP health check intentionally stays down to prove rollback.
}, 60_000);

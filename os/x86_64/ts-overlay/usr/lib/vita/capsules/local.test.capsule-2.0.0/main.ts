const VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const RECORD_PATH = `${VOLUME_PATH}/record.txt`;

Deno.writeTextFileSync(
  RECORD_PATH,
  `local.test.capsule v2 write ${new Date().toISOString()}\n`,
  { append: true },
);

console.log("VITA-CAPSULE-WORKLOAD: id=local.test.capsule version=2.0.0 status=OK");

setInterval(() => {
  // Keep the lifecycle proof capsule active for agentd health checks.
}, 60_000);

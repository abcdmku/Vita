const CAPSULE_ID = "local.test.capsule";
const VOLUME_NAME = "state";
const VOLUME_PATH = "/var/lib/vita/runtime/volumes/state";
const RECORD_PATH = `${VOLUME_PATH}/record.txt`;
const RECORD = "id=local.test.capsule vol=state persisted=OK\n";

await Deno.mkdir(VOLUME_PATH, { recursive: true });

try {
  await Deno.readTextFile(RECORD_PATH);
} catch (cause) {
  if (!(cause instanceof Deno.errors.NotFound)) {
    throw cause;
  }

  await Deno.writeTextFile(RECORD_PATH, RECORD);
}

console.log(
  `VITA-CAPSULE-WORKLOAD: id=${CAPSULE_ID} vol=${VOLUME_NAME} path=${RECORD_PATH} write=OK status=OK`,
);

setInterval(() => {
  // Keep the proof capsule active so agentd can confirm systemd state and read DynamicUser's uid.
}, 60_000);

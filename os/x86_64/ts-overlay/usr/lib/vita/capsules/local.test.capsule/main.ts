const VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const RECORD_PATH = `${VOLUME_PATH}/record.txt`;
const CAPSULE_ID = "local.test.capsule";

Deno.writeTextFileSync(
  RECORD_PATH,
  `local.test.capsule volume write ${new Date().toISOString()}\n`,
  { append: true },
);

const proofPath = Deno.env.get("VITA_CAPSULE_NETNS_PROOF");
if (proofPath !== undefined && proofPath.length > 0) {
  const proof = await measureNetworkNamespace();
  Deno.writeTextFileSync(proofPath, `${JSON.stringify(proof)}\n`);
}

console.log("VITA-CAPSULE-WORKLOAD: id=local.test.capsule status=OK");

setInterval(() => {
  // Keep the proof capsule active so agentd can confirm systemd state and read DynamicUser's uid.
}, 60_000);

async function measureNetworkNamespace(): Promise<{
  readonly external: "FAIL" | "REACHABLE" | "TIMEOUT";
  readonly id: string;
  readonly loopback: "OK" | "FAIL";
  readonly status: "OK" | "FAIL";
}> {
  const loopback = await measureLoopback() ? "OK" : "FAIL";
  const external = await measureExternalReachability();
  return {
    external,
    id: CAPSULE_ID,
    loopback,
    status: loopback === "OK" && external === "FAIL" ? "OK" : "FAIL",
  };
}

async function measureLoopback(): Promise<boolean> {
  let listener: Deno.Listener | undefined;
  let accepted: Promise<void> | undefined;
  try {
    listener = Deno.listen({
      hostname: "127.0.0.1",
      port: 8787,
      transport: "tcp",
    });
    const activeListener = listener;
    accepted = (async () => {
      const conn = await activeListener.accept();
      conn.close();
    })();

    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port: 8787,
      transport: "tcp",
    });
    conn.close();
    await accepted;
    return true;
  } catch {
    listener?.close();
    listener = undefined;
    if (accepted !== undefined) {
      await accepted.catch(() => undefined);
    }
    return false;
  } finally {
    listener?.close();
  }
}

async function measureExternalReachability(): Promise<"FAIL" | "REACHABLE" | "TIMEOUT"> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 1500);
  try {
    await fetch("http://203.0.113.10:443/", {
      signal: controller.signal,
    });
    return "REACHABLE";
  } catch {
    return timedOut ? "TIMEOUT" : "FAIL";
  } finally {
    clearTimeout(timer);
  }
}

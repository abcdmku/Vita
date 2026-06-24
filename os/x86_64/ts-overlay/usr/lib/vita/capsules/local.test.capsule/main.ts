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
  readonly egress?: {
    readonly allowed: string;
    readonly denied: string;
    readonly drop: "enforced" | "not_enforced";
    readonly reach: "OK" | "FAIL" | "TIMEOUT";
    readonly status: "OK" | "FAIL";
  };
  readonly external: "FAIL" | "REACHABLE" | "TIMEOUT";
  readonly id: string;
  readonly loopback: "OK" | "FAIL";
  readonly status: "OK" | "FAIL";
}> {
  const loopback = await measureLoopback() ? "OK" : "FAIL";
  const egress = await measureEgress();
  const external = await measureExternalReachability(egress?.deniedAddr);
  const egressProof = egress === undefined
    ? undefined
    : {
        allowed: egress.allowedCidr,
        denied: egress.deniedCidr,
        drop: egress.denied === "OK" ? "not_enforced" : "enforced",
        reach: egress.allowed,
        status: egress.allowed === "OK" && egress.denied !== "OK" ? "OK" : "FAIL",
      } as const;
  return {
    ...(egressProof === undefined ? {} : { egress: egressProof }),
    external,
    id: CAPSULE_ID,
    loopback,
    status: loopback === "OK" && external === "FAIL" && (egressProof === undefined || egressProof.status === "OK")
      ? "OK"
      : "FAIL",
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

async function measureExternalReachability(deniedAddr: string | undefined): Promise<"FAIL" | "REACHABLE" | "TIMEOUT"> {
  if (deniedAddr !== undefined) {
    const denied = await measureTcpConnect(deniedAddr, 443, 1000);
    return denied === "OK" ? "REACHABLE" : "FAIL";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1500);
  try {
    await fetch("http://203.0.113.10:443/", {
      signal: controller.signal,
    });
    return "REACHABLE";
  } catch {
    return "FAIL";
  } finally {
    clearTimeout(timer);
  }
}

async function measureEgress(): Promise<
  | {
      readonly allowed: "OK" | "FAIL" | "TIMEOUT";
      readonly allowedCidr: string;
      readonly denied: "OK" | "FAIL" | "TIMEOUT";
      readonly deniedAddr: string;
      readonly deniedCidr: string;
    }
  | undefined
> {
  const allowedAddr = Deno.env.get("VITA_CAPSULE_EGRESS_ALLOWED_ADDR");
  const allowedCidr = Deno.env.get("VITA_CAPSULE_EGRESS_ALLOWED_CIDR");
  const allowedPortRaw = Deno.env.get("VITA_CAPSULE_EGRESS_ALLOWED_PORT");
  const deniedAddr = Deno.env.get("VITA_CAPSULE_EGRESS_DENIED_ADDR");
  const deniedCidr = Deno.env.get("VITA_CAPSULE_EGRESS_DENIED_CIDR");

  if (
    allowedAddr === undefined ||
    allowedCidr === undefined ||
    allowedPortRaw === undefined ||
    deniedAddr === undefined ||
    deniedCidr === undefined
  ) {
    return undefined;
  }

  const allowedPort = Number.parseInt(allowedPortRaw, 10);
  if (!Number.isSafeInteger(allowedPort) || allowedPort <= 0 || allowedPort > 65535) {
    return undefined;
  }

  const allowed = await measureTcpConnect(allowedAddr, allowedPort, 1000);
  const denied = await measureTcpConnect(deniedAddr, allowedPort, 1000);
  return {
    allowed,
    allowedCidr,
    denied,
    deniedAddr,
    deniedCidr,
  };
}

async function measureTcpConnect(
  hostname: string,
  port: number,
  timeoutMs: number,
): Promise<"OK" | "FAIL" | "TIMEOUT"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const connect = Deno.connect({
    hostname,
    port,
    transport: "tcp",
  });
  const measured = Promise.race([
    connect.then((conn) => {
      conn.close();
      return "OK" as const;
    }).catch(() => "FAIL" as const),
    new Promise<"TIMEOUT">((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve("TIMEOUT");
      }, timeoutMs);
    }),
  ]);
  const result = await measured;
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  if (timedOut) {
    connect.then((conn) => conn.close()).catch(() => undefined);
  }
  return result;
}

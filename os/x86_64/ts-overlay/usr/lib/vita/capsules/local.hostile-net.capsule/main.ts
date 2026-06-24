const CAPSULE_ID = "local.hostile-net.capsule";
const DEFAULT_INGRESS_GRANTED_PORT = 8787;
const DEFAULT_INGRESS_DENIED_PORT = 8788;

const ingressGrantedPort = readPortEnv("VITA_CAPSULE_INGRESS_GRANTED_PORT", DEFAULT_INGRESS_GRANTED_PORT);
const ingressDeniedPort = readPortEnv("VITA_CAPSULE_INGRESS_DENIED_PORT", DEFAULT_INGRESS_DENIED_PORT);
const grantedListener = startListener(ingressGrantedPort);
const deniedListener = startListener(ingressDeniedPort);

const proofPath = Deno.env.get("VITA_CAPSULE_NETNS_PROOF");
if (proofPath !== undefined && proofPath.length > 0) {
  const proof = await measureHostileNetworkLimits();
  Deno.writeTextFileSync(proofPath, `${JSON.stringify(proof)}\n`);
}

console.log("VITA-CAPSULE-NET-HOSTILE-WORKLOAD: id=local.hostile-net.capsule status=RUNNING");

setInterval(() => {
  // Keep the hostile probe capsule active so agentd can confirm health after denied bursts.
}, 60_000);

async function measureHostileNetworkLimits(): Promise<{
  readonly egress?: {
    readonly allowed: string;
    readonly denied: string;
    readonly drop: "enforced" | "not_enforced";
    readonly reach: "OK" | "FAIL" | "TIMEOUT";
    readonly status: "OK" | "FAIL";
  };
  readonly external: "FAIL" | "REACHABLE" | "TIMEOUT";
  readonly host: "FAIL" | "REACHABLE" | "TIMEOUT";
  readonly id: string;
  readonly ingress: {
    readonly deniedListener: "OK" | "FAIL";
    readonly deniedPort: number;
    readonly listener: "OK" | "FAIL";
    readonly port: number;
    readonly status: "OK" | "FAIL";
  };
  readonly loopback: "OK" | "FAIL";
  readonly burst: "OK" | "FAIL";
  readonly status: "OK" | "FAIL";
}> {
  const loopback = await measureTcpConnect("127.0.0.1", ingressGrantedPort, 1000) === "OK" ? "OK" : "FAIL";
  const egress = await measureEgress();
  const external = await measureExternalReachability(egress?.deniedAddr);
  const host = await measureHostReachability(egress?.allowedPort);
  const burst = await burstDeniedEgress(egress?.deniedAddr, egress?.allowedPort);
  const egressProof = egress === undefined
    ? undefined
    : {
        allowed: egress.allowedCidr,
        denied: egress.deniedCidr,
        drop: egress.denied === "OK" ? "not_enforced" : "enforced",
        reach: egress.allowed,
        status: egress.allowed === "OK" && egress.denied !== "OK" ? "OK" : "FAIL",
      } as const;
  const ingressStatus = grantedListener.status === "OK" && deniedListener.status === "OK" ? "OK" : "FAIL";

  return {
    ...(egressProof === undefined ? {} : { egress: egressProof }),
    burst,
    external,
    host,
    id: CAPSULE_ID,
    ingress: {
      deniedListener: deniedListener.status,
      deniedPort: ingressDeniedPort,
      listener: grantedListener.status,
      port: ingressGrantedPort,
      status: ingressStatus,
    },
    loopback,
    status: loopback === "OK" &&
        external === "FAIL" &&
        host !== "REACHABLE" &&
        burst === "OK" &&
        ingressStatus === "OK" &&
        (egressProof === undefined || egressProof.status === "OK")
      ? "OK"
      : "FAIL",
  };
}

type ListenerStatus = {
  readonly status: "OK" | "FAIL";
};

function startListener(port: number): ListenerStatus {
  try {
    const listener = Deno.listen({
      hostname: "0.0.0.0",
      port,
      transport: "tcp",
    });
    void acceptAndClose(listener);
    return { status: "OK" };
  } catch {
    return { status: "FAIL" };
  }
}

async function acceptAndClose(listener: Deno.Listener): Promise<void> {
  while (true) {
    try {
      const conn = await listener.accept();
      conn.close();
    } catch {
      listener.close();
      return;
    }
  }
}

async function measureEgress(): Promise<
  | {
      readonly allowed: "OK" | "FAIL" | "TIMEOUT";
      readonly allowedCidr: string;
      readonly allowedPort: number;
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
    allowedPort,
    denied,
    deniedAddr,
    deniedCidr,
  };
}

async function measureExternalReachability(deniedAddr: string | undefined): Promise<"FAIL" | "REACHABLE" | "TIMEOUT"> {
  if (deniedAddr === undefined) {
    return "FAIL";
  }
  const denied = await measureTcpConnect(deniedAddr, 443, 1000);
  return denied === "OK" ? "REACHABLE" : "FAIL";
}

async function measureHostReachability(allowedPort: number | undefined): Promise<"FAIL" | "REACHABLE" | "TIMEOUT"> {
  const hostAddr = Deno.env.get("VITA_CAPSULE_HOST_ADDR");
  if (hostAddr === undefined || allowedPort === undefined) {
    return "FAIL";
  }
  const reached = await measureTcpConnect(hostAddr, allowedPort, 1000);
  return reached === "OK" ? "REACHABLE" : reached;
}

async function burstDeniedEgress(
  deniedAddr: string | undefined,
  allowedPort: number | undefined,
): Promise<"OK" | "FAIL"> {
  if (deniedAddr === undefined || allowedPort === undefined) {
    return "FAIL";
  }
  const attempts: Promise<"OK" | "FAIL" | "TIMEOUT">[] = [];
  for (let index = 0; index < 24; index += 1) {
    attempts[attempts.length] = measureTcpConnect(deniedAddr, allowedPort, 250);
  }
  const results = await Promise.all(attempts);
  return results.every((result) => result !== "OK") ? "OK" : "FAIL";
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

function readPortEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const port = Number.parseInt(raw, 10);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

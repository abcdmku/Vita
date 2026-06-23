// Vita on-device TypeScript entrypoint (P1-033).
//
// Runs under the pinned, vendored Deno runtime as the vita-ts.service oneshot at boot.
// It keeps the original VITA-TS proof marker, then exercises the real deterministic
// config -> TransactionPlan evaluator vendored under ./vita/.
//
// Determinism / supply chain:
//   - NO remote imports. Every import is a relative path to a vendored file under this overlay.
//   - NO broad filesystem or network access. The only I/O is a scoped AF_UNIX health probe to agentd
//     after the pure evaluator/preview markers have run.
//   - The representative configs below are fixed literals, so the emitted plan hash is stable.

import { evaluateNodeConfig } from "./vita/evaluate.ts";
import { diffTransactionPlans, TransactionPlanDiffError } from "./vita/transaction-plan-diff.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const TS_MARKER = "VITA-TS";
const EVAL_MARKER = "VITA-EVAL";
const REJECT_MARKER = "VITA-EVAL-REJECT";
const PREVIEW_MARKER = "VITA-PREVIEW";
const PREVIEW_NOOP_MARKER = "VITA-PREVIEW-NOOP";
const PREVIEW_ERROR_MARKER = "VITA-PREVIEW-ERROR";
const CONNECT_MARKER = "VITA-CONNECT";
const CONNECT_ERROR_MARKER = "VITA-CONNECT-ERROR";
const AGENTD_SOCKET_PATH = "/run/vita-agent/agentd.sock";
const MAX_HEALTHZ_RESPONSE_BYTES = 64 * 1024;

const CAPABILITY_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);

const VALID_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "normal",
      remoteAccess: "disabled",
    }),
  }),
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze(["Pool.NTP.Org", "2001:0db8::1"]),
    }),
  }),
});

const INVALID_CONFIG = Object.freeze({
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze([]),
    }),
  }),
});

// Config-change PREVIEW (P1-034): evaluate a CURRENT and a DESIRED config via the
// real evaluator, then diff the two TransactionPlans by capability. The CURRENT
// config is the same valid baseline as VALID_CONFIG; the DESIRED config differs in
// exactly three ways so the preview demonstrates add + remove + change:
//   - ADD     "network.policy"   (present in DESIRED, absent from CURRENT)
//   - REMOVE  "time.sync"        (present in CURRENT, absent from DESIRED)
//   - CHANGE  "node.config"      (request differs: mode normal -> maintenance)
//   - keep    "hostname.set"     (identical in both -> not reported)
const PREVIEW_CURRENT_CONFIG = VALID_CONFIG;

const PREVIEW_DESIRED_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "maintenance",
      remoteAccess: "disabled",
    }),
  }),
  "network.policy": Object.freeze({
    desired: Object.freeze({
      allow: Object.freeze([
        Object.freeze({
          proto: "tcp",
          port: 443,
          sourceCidr: "10.0.0.5/24",
          interface: "eth0",
        }),
      ]),
    }),
  }),
});

function emit(line: string): void {
  console.log(line);
}

async function main(): Promise<number> {
  emit(`${TS_MARKER}: hello from Deno ${Deno.version.deno} status=OK`);

  const valid = evaluateNodeConfig(VALID_CONFIG, CAPABILITY_REGISTRY);

  if (!valid.ok) {
    const first = valid.rejections[0];
    const code = first?.code ?? "NO_REJECTION";
    emit(`${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ops=0 planHash=0 status=FAIL code=${code}`);
    return 1;
  }

  const canonicalPlan = stableStringify(valid.plan);
  emit(
    `${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ` +
      `ops=${valid.plan.operations.length} ` +
      `planHash=${fnv1a64Hex(canonicalPlan)} ` +
      "status=OK",
  );

  const invalid = evaluateNodeConfig(INVALID_CONFIG, CAPABILITY_REGISTRY);

  if (invalid.ok) {
    emit(`${REJECT_MARKER}: code=NOT_REJECTED status=FAIL`);
    return 1;
  }

  const firstRejection = invalid.rejections[0];
  const rejectionCode = firstRejection?.code ?? "NO_REJECTION";
  emit(`${REJECT_MARKER}: code=${rejectionCode} status=OK`);

  if (firstRejection === undefined) {
    return 1;
  }

  const previewStatus = runPreview();
  if (previewStatus !== 0) {
    return previewStatus;
  }

  await emitAgentdConnectMarker();
  return 0;
}

// Evaluate CURRENT + DESIRED configs and diff their TransactionPlans, emitting the
// grep-able preview markers. Returns 0 on success, non-zero on any failure.
function runPreview(): number {
  // Real change: CURRENT -> DESIRED adds/removes/changes one capability each.
  const current = evaluateNodeConfig(PREVIEW_CURRENT_CONFIG, CAPABILITY_REGISTRY);
  const desired = evaluateNodeConfig(PREVIEW_DESIRED_CONFIG, CAPABILITY_REGISTRY);

  if (!current.ok) {
    const code = current.rejections[0]?.code ?? "NO_REJECTION";
    emit(`${PREVIEW_MARKER}: added=0 removed=0 changed=0 status=FAIL code=${code}`);
    return 1;
  }

  if (!desired.ok) {
    const code = desired.rejections[0]?.code ?? "NO_REJECTION";
    emit(`${PREVIEW_MARKER}: added=0 removed=0 changed=0 status=FAIL code=${code}`);
    return 1;
  }

  // The diff is fail-CLOSED-by-throwing: a malformed/exotic plan throws
  // TransactionPlanDiffError rather than returning a benign "no changes". The
  // evaluator's own output is always clean, so the normal path never throws — but
  // we catch and emit an explicit fail-safe marker (NOT a bogus added=0/removed=0/
  // changed=0) so the fail-closed wiring is provably in place end to end.
  let change;
  let noopChange;
  try {
    // Real change: CURRENT -> DESIRED adds/removes/changes one capability each.
    change = diffTransactionPlans(current.plan, desired.plan);
    // No-op change: CURRENT diffed against itself yields an empty diff.
    noopChange = diffTransactionPlans(current.plan, current.plan);
  } catch (cause) {
    if (cause instanceof TransactionPlanDiffError) {
      emit(`${PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
      return 1;
    }

    throw cause;
  }

  emit(
    `${PREVIEW_MARKER}: ` +
      `added=${change.added.length} ` +
      `removed=${change.removed.length} ` +
      `changed=${change.changed.length} ` +
      "status=OK",
  );

  if (
    noopChange.added.length !== 0 ||
    noopChange.removed.length !== 0 ||
    noopChange.changed.length !== 0
  ) {
    emit(`${PREVIEW_NOOP_MARKER}: status=FAIL`);
    return 1;
  }

  emit(`${PREVIEW_NOOP_MARKER}: status=OK`);
  return 0;
}

async function emitAgentdConnectMarker(): Promise<void> {
  try {
    const health = await getAgentdHealth(AGENTD_SOCKET_PATH);

    if (!health.healthy || health.version.length === 0) {
      throw new Error("agentd healthz was not healthy");
    }

    emit(`${CONNECT_MARKER}: transport=unix peer=agentd healthz=OK status=OK`);
  } catch {
    emit(`${CONNECT_ERROR_MARKER}: status=FAILSAFE`);
  }
}

interface AgentdHealth {
  readonly version: string;
  readonly healthy: boolean;
}

async function getAgentdHealth(path: string): Promise<AgentdHealth> {
  let conn: Deno.Conn | undefined;

  try {
    conn = await Deno.connect({ transport: "unix", path });
    await writeAll(
      conn,
      new TextEncoder().encode(
        "GET /healthz HTTP/1.1\r\n" +
          "Host: agentd\r\n" +
          "Accept: application/json\r\n" +
          "Connection: close\r\n" +
          "\r\n",
      ),
    );

    const response = parseHttpResponse(await readAllText(conn));
    if (response.statusCode !== 200) {
      throw new Error(`agentd healthz returned HTTP ${response.statusCode}`);
    }

    return parseAgentdHealth(response.body);
  } finally {
    conn?.close();
  }
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;

  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));

    if (written <= 0) {
      throw new Error("socket write made no progress");
    }

    offset += written;
  }
}

async function readAllText(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  let total = 0;

  while (true) {
    const read = await conn.read(buffer);

    if (read === null) {
      break;
    }

    total += read;
    if (total > MAX_HEALTHZ_RESPONSE_BYTES) {
      throw new Error("agentd healthz response exceeded size limit");
    }

    chunks.push(buffer.slice(0, read));
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];

    if (chunk !== undefined) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return out;
}

interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

function parseHttpResponse(raw: string): HttpResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("agentd healthz response missing HTTP headers");
  }

  const headerLines = raw.slice(0, headerEnd).split("\r\n");
  const statusLine = headerLines[0];
  if (statusLine === undefined) {
    throw new Error("agentd healthz response missing HTTP status");
  }

  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?:\s|$)/u.exec(statusLine);
  const statusCodeText = statusMatch?.[1];
  if (statusCodeText === undefined) {
    throw new Error("agentd healthz response has invalid HTTP status");
  }

  const headers = new Map<string, string>();
  for (let index = 1; index < headerLines.length; index += 1) {
    const line = headerLines[index];

    if (line === undefined || line.length === 0) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("agentd healthz response has invalid HTTP header");
    }

    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim().toLowerCase(),
    );
  }

  let body = raw.slice(headerEnd + 4);
  const transferEncoding = headers.get("transfer-encoding") ?? "";
  const encodings = transferEncoding.split(",");
  for (let index = 0; index < encodings.length; index += 1) {
    if (encodings[index]?.trim() === "chunked") {
      body = decodeChunkedBody(body);
      break;
    }
  }

  return {
    statusCode: Number.parseInt(statusCodeText, 10),
    body,
  };
}

function decodeChunkedBody(body: string): string {
  let rest = body;
  let decoded = "";

  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) {
      throw new Error("chunked healthz response is missing a chunk header");
    }

    const sizeText = rest.slice(0, lineEnd).split(";", 1)[0];
    if (sizeText === undefined) {
      throw new Error("chunked healthz response has an invalid chunk size");
    }

    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("chunked healthz response has an invalid chunk size");
    }
    if (size === 0) {
      return decoded;
    }

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (rest.length < chunkEnd + 2 || rest.slice(chunkEnd, chunkEnd + 2) !== "\r\n") {
      throw new Error("chunked healthz response has an incomplete chunk");
    }

    decoded += rest.slice(chunkStart, chunkEnd);
    rest = rest.slice(chunkEnd + 2);
  }
}

function parseAgentdHealth(body: string): AgentdHealth {
  const parsed: unknown = JSON.parse(body);

  if (!isJsonObject(parsed)) {
    throw new Error("agentd healthz response is not a JSON object");
  }

  const version = parsed["version"];
  const healthy = parsed["healthy"];

  if (typeof version !== "string" || typeof healthy !== "boolean") {
    throw new Error("agentd healthz response is missing version or healthy");
  }

  return { version, healthy };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        items.push(stableStringify(item));
      }
    }

    return `[${items.join(",")}]`;
  }

  if (!isJsonObject(value)) {
    return JSON.stringify(null);
  }

  const keys = Object.keys(value).sort(compareStrings);
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) {
      entries.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
    }
  }

  return `{${entries.join(",")}}`;
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;

  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index);

    if (codePoint === undefined) {
      continue;
    }

    if (codePoint > 0xffff) {
      index += 1;
    }

    hash = writeUtf8Byte(hash, codePoint);
  }

  return hash.toString(16).padStart(16, "0");
}

function writeUtf8Byte(hash: bigint, codePoint: number): bigint {
  if (codePoint <= 0x7f) {
    return fnvStep(hash, codePoint);
  }

  if (codePoint <= 0x7ff) {
    return fnvStep(fnvStep(hash, 0xc0 | (codePoint >> 6)), 0x80 | (codePoint & 0x3f));
  }

  if (codePoint <= 0xffff) {
    return fnvStep(
      fnvStep(fnvStep(hash, 0xe0 | (codePoint >> 12)), 0x80 | ((codePoint >> 6) & 0x3f)),
      0x80 | (codePoint & 0x3f),
    );
  }

  return fnvStep(
    fnvStep(
      fnvStep(fnvStep(hash, 0xf0 | (codePoint >> 18)), 0x80 | ((codePoint >> 12) & 0x3f)),
      0x80 | ((codePoint >> 6) & 0x3f),
    ),
    0x80 | (codePoint & 0x3f),
  );
}

function fnvStep(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().then((code) => {
  Deno.exit(code);
});

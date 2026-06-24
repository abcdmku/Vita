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
import { explainTransactionPlanChange } from "./vita/transaction-plan-explain.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import { createAgentClient, isAgentClientError } from "./vita/agent-client.ts";
import { applyNodeConfig } from "./vita/apply-node-config.ts";
import { buildCapsuleRegistryConfig } from "./vita/capsule-registry-model.ts";
import {
  formatCapsuleRegistryPreviewMarker,
  ON_DEVICE_CAPSULE_ENTRY,
  ON_DEVICE_CAPSULE_REGISTRY,
  readCapsuleRegistryPreview,
} from "./vita/capsule-preview.ts";
import { formatAgentStateMarker, readAgentStateSummary } from "./vita/agent-state.ts";
import { formatPdsSyncStateReadMarker, readPdsSyncStateSummary } from "./vita/pds-read.ts";
import {
  applyPdsSyncStateWrite,
  formatPdsSyncStateWriteMarker,
  rejectInvalidPdsSyncStateWrite,
} from "./vita/pds-write.ts";
import {
  createFilesClient,
  isFilesClientError,
} from "./vita/files-client.ts";
import {
  formatBackupArchiveMarker,
  formatBackupArchiveRejectMarker,
  rejectTamperedBackupArchive,
  runBackupArchiveRoundTrip,
} from "./vita/backup.ts";
import {
  applyAndReadPdsRepoCreate,
  formatPdsRepoMarker,
  rejectInvalidPdsRepoCreate,
} from "./vita/pds-repo.ts";
import {
  createDenoUnixSocketAgentTransport,
  createDenoUnixSocketApplyAgentTransport,
  createDenoUnixSocketFilesAgentTransport,
} from "./vita/unix-socket-transport.ts";
import type { AgentApplyPlan, AgentApplyResult, AgentClient, AgentTransport } from "./vita/agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
} from "./vita/apply-node-config.ts";
import type { CapsuleEntry } from "./vita/capsule-registry-model.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const TS_MARKER = "VITA-TS";
const EVAL_MARKER = "VITA-EVAL";
const REJECT_MARKER = "VITA-EVAL-REJECT";
const PREVIEW_MARKER = "VITA-PREVIEW";
const PREVIEW_NOOP_MARKER = "VITA-PREVIEW-NOOP";
const PREVIEW_ERROR_MARKER = "VITA-PREVIEW-ERROR";
const EXPLAIN_MARKER = "VITA-EXPLAIN";
const CONNECT_MARKER = "VITA-CONNECT";
const CONNECT_ERROR_MARKER = "VITA-CONNECT-ERROR";
const STATE_ERROR_MARKER = "VITA-STATE-ERROR";
const APPLY_MARKER = "VITA-APPLY";
const APPLY_ERROR_MARKER = "VITA-APPLY-ERROR";
const CAPSULE_MARKER = "VITA-CAPSULE";
const CAPSULE_ERROR_MARKER = "VITA-CAPSULE-ERROR";
const CAPSULE_PREVIEW_ERROR_MARKER = "VITA-CAPSULE-PREVIEW-ERROR";
const CAPSULE_FETCH_MARKER = "VITA-CAPSULE-FETCH";
const CAPSULE_FETCH_REJECT_MARKER = "VITA-CAPSULE-FETCH-REJECT";
const CAPSULE_FETCH_ERROR_MARKER = "VITA-CAPSULE-FETCH-ERROR";
const CAPSULE_OCI_FETCH_MARKER = "VITA-CAPSULE-OCI-FETCH";
const CAPSULE_OCI_FETCH_REJECT_MARKER = "VITA-CAPSULE-OCI-FETCH-REJECT";
const CAPSULE_OCI_FETCH_ERROR_MARKER = "VITA-CAPSULE-OCI-FETCH-ERROR";
const CAPSULE_EXECUTED_MARKER = "VITA-CAPSULE-EXECUTED";
const CAPSULE_EXECUTE_REJECT_MARKER = "VITA-CAPSULE-EXECUTE-REJECT";
const CAPSULE_EXECUTE_ERROR_MARKER = "VITA-CAPSULE-EXECUTE-ERROR";
const CAPSULE_OCI_EXECUTED_MARKER = "VITA-CAPSULE-OCI-EXECUTED";
const CAPSULE_OCI_EXECUTE_REJECT_MARKER = "VITA-CAPSULE-OCI-EXECUTE-REJECT";
const CAPSULE_OCI_EXECUTE_ERROR_MARKER = "VITA-CAPSULE-OCI-EXECUTE-ERROR";
const CAPSULE_WASM_EXECUTED_MARKER = "VITA-CAPSULE-WASM-EXECUTED";
const CAPSULE_WASM_EXECUTE_REJECT_MARKER = "VITA-CAPSULE-WASM-EXECUTE-REJECT";
const CAPSULE_WASM_EXECUTE_ERROR_MARKER = "VITA-CAPSULE-WASM-EXECUTE-ERROR";
const CAPSULE_OCI_LIMITS_MARKER = "VITA-CAPSULE-OCI-LIMITS";
const CAPSULE_NET_PARSE_MARKER = "VITA-CAPSULE-NET-PARSE";
const CAPSULE_NET_REJECT_MARKER = "VITA-CAPSULE-NET-REJECT";
const CAPSULE_NET_NS_MARKER = "VITA-CAPSULE-NET-NS";
const CAPSULE_NET_NS_REJECT_MARKER = "VITA-CAPSULE-NET-NS-REJECT";
const CAPSULE_NET_NS_ERROR_MARKER = "VITA-CAPSULE-NET-NS-ERROR";
const CAPSULE_NET_EGRESS_MARKER = "VITA-CAPSULE-NET-EGRESS";
const CAPSULE_NET_EGRESS_REJECT_MARKER = "VITA-CAPSULE-NET-EGRESS-REJECT";
const CAPSULE_NET_EGRESS_ERROR_MARKER = "VITA-CAPSULE-NET-EGRESS-ERROR";
const CAPSULE_NET_INGRESS_MARKER = "VITA-CAPSULE-NET-INGRESS";
const CAPSULE_NET_INGRESS_REJECT_MARKER = "VITA-CAPSULE-NET-INGRESS-REJECT";
const CAPSULE_NET_INGRESS_ERROR_MARKER = "VITA-CAPSULE-NET-INGRESS-ERROR";
const CAPSULE_VOLUME_MARKER = "VITA-CAPSULE-VOLUME";
const CAPSULE_VOLUME_ERROR_MARKER = "VITA-CAPSULE-VOLUME-ERROR";
const CAPSULE_HEALTH_MARKER = "VITA-CAPSULE-HEALTH";
const CAPSULE_HEALTH_ERROR_MARKER = "VITA-CAPSULE-HEALTH-ERROR";
const FILES_MARKER = "VITA-FILES";
const FILES_REJECT_MARKER = "VITA-FILES-REJECT";
const FILES_ERROR_MARKER = "VITA-FILES-ERROR";
const AGENTD_SOCKET_PATH = "/run/vita-agent/agentd.sock";
const AGENTD_BASE_URL = "http://agentd";
const FILES_RW_GRANT = "runtime-files";
const FILES_RO_GRANT = "runtime-files-ro";
const FILES_ROUNDTRIP_PATH = "roundtrip.txt";
const CAPSULE_FETCH_CAPABILITY = "capsule.fetch";
const CAPSULE_EXECUTE_CAPABILITY = "capsule.execute";
const CAPSULE_BUNDLE_REF = "file:///usr/lib/vita/capsule-bundles/local.test.capsule.tar.zst";
const CAPSULE_BUNDLE_INTEGRITY = "sha256-ZxeTpiUU3aU+z6sDmWsoRUWAo28E+2pW6puG3DmkuNk=";
const BAD_CAPSULE_BUNDLE_INTEGRITY = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OCI_FETCH_CAPSULE_ID = "local.test.oci";
const OCI_FETCH_CAPSULE_VERSION = "1.0.0";
const OCI_IMAGE_REF = "file:///usr/lib/vita/capsule-bundles/local.test.oci-image.tar";
const OCI_IMAGE_TAMPERED_REF = "file:///usr/lib/vita/capsule-bundles/local.test.oci-image.tampered.tar";
const OCI_IMAGE_INTEGRITY = "sha256-+sXvwUEoLRyQ8XaGpTAZr7ZeRM+3/18dd2zb5liruNs=";
const OCI_IMAGE_TAMPERED_INTEGRITY = "sha256-kjEqlr0zeEJfbwhGjsnm8X8xna7YfXquFo4KTq8AeLY=";
const OCI_IMAGE_DIGEST = "sha256:740bb2d1795bcf0764f483cde41fd7927b14f67ea6e6923cdda02a893315306b";
const OCI_ARCH_FETCH_CAPSULE_ID = "local.test.oci-arch";
const OCI_ARCH_UNSUPPORTED_FETCH_CAPSULE_ID = "local.test.oci-arch-unsupported";
const OCI_ARCH_IMAGE_REF = "file:///usr/lib/vita/capsule-bundles/local.test.oci-arch-image.tar";
const OCI_ARCH_IMAGE_ARM64_ONLY_REF = "file:///usr/lib/vita/capsule-bundles/local.test.oci-arch-arm64-only.tar";
const OCI_ARCH_IMAGE_INTEGRITY = "sha256-LKddEbtCi27GF62Cbn7VyGJZaZmJXEWV1HgPOflcw7c=";
const OCI_ARCH_IMAGE_ARM64_ONLY_INTEGRITY = "sha256-sh16PUBqRDSQJ30jkOmi1GnKgNRAUkfcNxg2qU3RMUA=";
const OCI_ARCH_IMAGE_INDEX_DIGEST = "sha256:1bf8b548988924bb96b7baeeb48d7c3d20e764e085a67cd05a833ac85f4e494d";
const OCI_ARCH_IMAGE_ARM64_ONLY_INDEX_DIGEST = "sha256:a110b0d1411eac4982de77c6eab195832012b81290a6886d67a23de59ac11906";
const OCI_ARCH_IMAGE_AMD64_DIGEST = "sha256:ec47aaf781206f04a70ecfc5a46f97612c4670eea8e0da7b8596aa9b264ab248";
const CAPSULE_VOLUME_NAME = "state";
const CAPSULE_VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const OCI_CAPSULE_ENTRY = Object.freeze({
  id: "local.oci.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const MISSING_OCI_CAPSULE_ENTRY = Object.freeze({
  id: "local.missing-oci.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const HOSTILE_OCI_CAPSULE_ENTRY = Object.freeze({
  id: "local.hostile-oci.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const INVALID_NET_CAPSULE_ENTRY = Object.freeze({
  id: "local.invalid-net.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const WASM_CAPSULE_ENTRY = Object.freeze({
  id: "local.wasm.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const MISSING_WASM_CAPSULE_ENTRY = Object.freeze({
  id: "local.missing-wasm.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;
const OCI_CAPSULE_REGISTRY = Object.freeze([
  ON_DEVICE_CAPSULE_ENTRY,
  OCI_CAPSULE_ENTRY,
  MISSING_OCI_CAPSULE_ENTRY,
  HOSTILE_OCI_CAPSULE_ENTRY,
  WASM_CAPSULE_ENTRY,
  MISSING_WASM_CAPSULE_ENTRY,
]) satisfies readonly CapsuleEntry[];
const CAPSULE_NET_REGISTRY = Object.freeze([
  ON_DEVICE_CAPSULE_ENTRY,
  INVALID_NET_CAPSULE_ENTRY,
]) satisfies readonly CapsuleEntry[];
const STATE_JSON_HEADERS = Object.freeze({
  Accept: "application/json",
});
const APPLY_JSON_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});

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

const FORCED_REJECT_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "vita.invalid.capability",
      request: Object.freeze({
        desired: true,
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_INVALID_CAPSULE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "capsule.registry",
      request: Object.freeze({
        desired: Object.freeze({
          capsules: Object.freeze([
            Object.freeze({
              id: ON_DEVICE_CAPSULE_ENTRY.id,
              integrity: "sha256-AAAA",
              state: ON_DEVICE_CAPSULE_ENTRY.state,
              version: ON_DEVICE_CAPSULE_ENTRY.version,
            }),
          ]),
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: ON_DEVICE_CAPSULE_ENTRY.id,
          integrity: CAPSULE_BUNDLE_INTEGRITY,
          ref: CAPSULE_BUNDLE_REF,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_BAD_CAPSULE_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: ON_DEVICE_CAPSULE_ENTRY.id,
          integrity: BAD_CAPSULE_BUNDLE_INTEGRITY,
          ref: CAPSULE_BUNDLE_REF,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_OCI_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: OCI_FETCH_CAPSULE_ID,
          imageDigest: OCI_IMAGE_DIGEST,
          integrity: OCI_IMAGE_INTEGRITY,
          ref: OCI_IMAGE_REF,
          version: OCI_FETCH_CAPSULE_VERSION,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_TAMPERED_CAPSULE_OCI_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: OCI_FETCH_CAPSULE_ID,
          imageDigest: OCI_IMAGE_DIGEST,
          integrity: OCI_IMAGE_TAMPERED_INTEGRITY,
          ref: OCI_IMAGE_TAMPERED_REF,
          version: OCI_FETCH_CAPSULE_VERSION,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_OCI_ARCH_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: OCI_ARCH_FETCH_CAPSULE_ID,
          imageDigest: OCI_ARCH_IMAGE_INDEX_DIGEST,
          integrity: OCI_ARCH_IMAGE_INTEGRITY,
          ref: OCI_ARCH_IMAGE_REF,
          version: OCI_FETCH_CAPSULE_VERSION,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_ARM64_ONLY_CAPSULE_OCI_ARCH_FETCH_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_FETCH_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: OCI_ARCH_UNSUPPORTED_FETCH_CAPSULE_ID,
          imageDigest: OCI_ARCH_IMAGE_ARM64_ONLY_INDEX_DIGEST,
          integrity: OCI_ARCH_IMAGE_ARM64_ONLY_INTEGRITY,
          ref: OCI_ARCH_IMAGE_ARM64_ONLY_REF,
          version: OCI_FETCH_CAPSULE_VERSION,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: ON_DEVICE_CAPSULE_ENTRY.id,
          integrity: ON_DEVICE_CAPSULE_ENTRY.integrity,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_INVALID_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: "local.missing.capsule",
          integrity: ON_DEVICE_CAPSULE_ENTRY.integrity,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_NET_REGISTRY_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "capsule.registry",
      request: Object.freeze({
        desired: Object.freeze({
          capsules: CAPSULE_NET_REGISTRY,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_INVALID_CAPSULE_NET_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: INVALID_NET_CAPSULE_ENTRY.id,
          integrity: INVALID_NET_CAPSULE_ENTRY.integrity,
          version: INVALID_NET_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const OCI_CAPSULE_REGISTRY_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "capsule.registry",
      request: Object.freeze({
        desired: Object.freeze({
          capsules: OCI_CAPSULE_REGISTRY,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const OCI_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: OCI_CAPSULE_ENTRY.id,
          integrity: OCI_CAPSULE_ENTRY.integrity,
          version: OCI_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_MISSING_OCI_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: MISSING_OCI_CAPSULE_ENTRY.id,
          integrity: MISSING_OCI_CAPSULE_ENTRY.integrity,
          version: MISSING_OCI_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const HOSTILE_OCI_LIMITS_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: HOSTILE_OCI_CAPSULE_ENTRY.id,
          integrity: HOSTILE_OCI_CAPSULE_ENTRY.integrity,
          version: HOSTILE_OCI_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const WASM_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: WASM_CAPSULE_ENTRY.id,
          integrity: WASM_CAPSULE_ENTRY.integrity,
          version: WASM_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_MISSING_WASM_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: MISSING_WASM_CAPSULE_ENTRY.id,
          integrity: MISSING_WASM_CAPSULE_ENTRY.integrity,
          version: MISSING_WASM_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

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

  const explainLines = explainTransactionPlanChange(change);
  emit(`${EXPLAIN_MARKER}: lines=${explainLines.length} status=OK`);

  for (let index = 0; index < explainLines.length; index += 1) {
    const line = explainLines[index];

    if (line !== undefined) {
      emit(`${EXPLAIN_MARKER}| ${line}`);
    }
  }

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
  const transport = createDenoUnixSocketAgentTransport({
    socketPath: AGENTD_SOCKET_PATH,
  });
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport,
  });

  try {
    const health = await client.getHealth();

    if (!health.healthy || health.version.length === 0) {
      throw new Error("agentd healthz was not healthy");
    }

    emit(`${CONNECT_MARKER}: transport=unix peer=agentd healthz=OK status=OK`);
  } catch {
    emit(`${CONNECT_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${STATE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatPdsSyncStateReadMarker({ ok: false, reason: "agentd connect failed" }));
    emit(formatPdsSyncStateWriteMarker({ ok: false, reason: "agentd connect failed" }));
    emit(formatBackupArchiveMarker({ ok: false, reason: "agentd connect failed" }));
    emit(formatPdsRepoMarker({ ok: false, reason: "agentd connect failed" }));
    emit(`${CAPSULE_PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=agentd_connect_failed status=FAILSAFE`);
    emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatOCILimitsFailureMarker());
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${FILES_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  const agentTransport = createDenoUnixSocketApplyAgentTransport({
    socketPath: AGENTD_SOCKET_PATH,
  });
  const filesTransport = createDenoUnixSocketFilesAgentTransport({
    socketPath: AGENTD_SOCKET_PATH,
  });
  const state = await readAgentStateSummary(client);
  if (state.ok) {
    emit(formatAgentStateMarker(state.state));
    await emitApplyMarkers(state.state.hostname, agentTransport);
    if (await emitCapsulePreviewMarker(client)) {
      await emitCapsuleMarkers(agentTransport);
    } else {
      emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=capsule_preview_failed status=FAILSAFE`);
      emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(formatOCILimitsFailureMarker());
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    }
  } else {
    emit(`${STATE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
    emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatOCILimitsFailureMarker());
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
  }

  await emitPdsReadMarker(client);
  if (await emitPdsWriteMarkers(agentTransport)) {
    await emitPdsReadMarker(client);
    await emitPdsRepoMarkers(agentTransport, client);
  } else {
    emit(formatPdsRepoMarker({ ok: false, reason: "PDS sync-state write failed" }));
  }
  await emitFilesMarkers(filesTransport);
  await emitBackupArchiveMarkers(agentTransport);
}

async function emitApplyMarkers(
  currentHostname: string,
  agentTransport: AgentTransport,
): Promise<void> {
  const result = await applyNodeConfig(
    hostnameConfig(currentHostname),
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  emit(formatApplyConfigMarker(result));

  if (!result.ok && result.stage === "transport") {
    return;
  }

  await emitForcedRejectMarker(agentTransport);
}

async function emitCapsuleMarkers(agentTransport: AgentTransport): Promise<void> {
  const config = buildCapsuleRegistryConfig(ON_DEVICE_CAPSULE_REGISTRY);

  if (!config.ok) {
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=registry_config_invalid status=FAILSAFE`);
    emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatOCILimitsFailureMarker());
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  const result = await applyNodeConfig(
    config.config,
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  if (!result.ok) {
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=registry_apply_failed status=FAILSAFE`);
    emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatOCILimitsFailureMarker());
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  emit(formatCommittedCapsuleMarker(ON_DEVICE_CAPSULE_ENTRY, result.applyResult));
  if (await emitCapsuleFetchMarkers(agentTransport)) {
    await emitCapsuleExecuteMarkers(agentTransport);
  } else {
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=capsule_fetch_failed status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
  }
  await emitForcedCapsuleRejectMarker(agentTransport);
  await emitCapsuleOCIFetchMarkers(agentTransport);
  await emitOCICapsuleMarkers(agentTransport);
  await emitHostileOCILimitsMarker(agentTransport);
  await emitWasmCapsuleMarkers(agentTransport);
}

async function emitCapsulePreviewMarker(
  client: Pick<AgentClient, "getState">,
): Promise<boolean> {
  const result = await readCapsuleRegistryPreview(client);
  emit(formatCapsuleRegistryPreviewMarker(result));
  return result.ok;
}

function hostnameConfig(currentHostname: string): unknown {
  return {
    "hostname.set": {
      desired: currentHostname,
    },
  };
}

function createApplyNodeTransport(agentTransport: AgentTransport): ApplyNodeTransport {
  return async (method, path, body) => {
    const response = await agentTransport(new URL(path, AGENTD_BASE_URL).toString(), {
      body: JSON.stringify(body),
      headers: APPLY_JSON_HEADERS,
      method,
    });

    return {
      body: parseJsonOrText(await response.text()),
      status: response.status,
    };
  };
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApplyConfigMarker(result: ApplyNodeConfigResult): string {
  if (result.ok) {
    return formatCommittedApplyMarker(result.applyResult);
  }

  if (result.stage === "apply" && result.applyResult?.outcome === "rejected") {
    return `${APPLY_MARKER}: outcome=rejected reason=${applyResultReason(result.applyResult, result.reason)} status=OK`;
  }

  return `${APPLY_ERROR_MARKER}: status=FAILSAFE`;
}

function formatCommittedApplyMarker(result: ApplyNodeApplyResult): string {
  return (
    `${APPLY_MARKER}: ` +
    `outcome=${result.outcome} ` +
    `applied=${result.applied.length} ` +
    `rolledBack=${result.rolledBack.length} ` +
    `audit=${result.auditUnrecorded === true ? "unrecorded" : "recorded"} ` +
    "status=OK"
  );
}

function formatCommittedCapsuleMarker(
  entry: CapsuleEntry,
  result: ApplyNodeApplyResult,
): string {
  return (
    `${CAPSULE_MARKER}: ` +
    `id=${entry.id} ` +
    `ver=${entry.version} ` +
    `state=${entry.state} ` +
    `outcome=${result.outcome} ` +
    "status=OK"
  );
}

async function emitForcedRejectMarker(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(FORCED_REJECT_PLAN);

    if (result.outcome === "rejected") {
      emit(`${APPLY_MARKER}: outcome=rejected reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${APPLY_MARKER}: outcome=rejected reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitPdsReadMarker(client: Pick<AgentClient, "getState">): Promise<void> {
  emit(formatPdsSyncStateReadMarker(await readPdsSyncStateSummary(client)));
}

async function emitPdsWriteMarkers(agentTransport: AgentTransport): Promise<boolean> {
  const result = await applyPdsSyncStateWrite(
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  emit(formatPdsSyncStateWriteMarker(result));

  if (!result.ok || result.outcome !== "committed") {
    return false;
  }

  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });
  const rejected = await rejectInvalidPdsSyncStateWrite(client);
  emit(formatPdsSyncStateWriteMarker(rejected));
  return true;
}

async function emitFilesMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createFilesClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });
  const data = new TextEncoder().encode("vita files mediated roundtrip\n");

  try {
    const write = await client.write(FILES_RW_GRANT, FILES_ROUNDTRIP_PATH, data);
    const entries = await client.list(FILES_RW_GRANT, FILES_ROUNDTRIP_PATH);
    const read = await client.read(FILES_RW_GRANT, FILES_ROUNDTRIP_PATH);
    const stat = await client.stat(FILES_RW_GRANT, FILES_ROUNDTRIP_PATH);
    const listed = entries.length === 1 &&
      entries[0]?.name === FILES_ROUNDTRIP_PATH &&
      entries[0]?.kind === "file";

    if (
      write.size !== data.byteLength ||
      read.size !== data.byteLength ||
      stat.kind !== "file" ||
      stat.size !== data.byteLength ||
      !listed ||
      !bytesEqual(read.data, data)
    ) {
      emit(`${FILES_ERROR_MARKER}: status=FAILSAFE`);
      await emitFilesRejectMarkers(client);
      return;
    }

    emit(
      `${FILES_MARKER}: ` +
        `grant=${FILES_RW_GRANT} ` +
        "op=write+read+list+stat " +
        `bytes=${read.data.byteLength} ` +
        "roundtrip=OK " +
        "status=OK",
    );
  } catch {
    emit(`${FILES_ERROR_MARKER}: status=FAILSAFE`);
    await emitFilesRejectMarkers(client);
    return;
  }

  await emitFilesRejectMarkers(client);
}

async function emitFilesRejectMarkers(client: ReturnType<typeof createFilesClient>): Promise<void> {
  await emitFilesRejectMarker("path_traversal", async () => {
    await client.read(FILES_RW_GRANT, "../escape");
  });
  await emitFilesRejectMarker("read_only_grant", async () => {
    await client.write(FILES_RO_GRANT, "reject.txt", new TextEncoder().encode("blocked"));
  });
}

async function emitFilesRejectMarker(reason: string, attempt: () => Promise<void>): Promise<void> {
  try {
    await attempt();
  } catch (cause) {
    if (isFilesClientError(cause)) {
      const got = markerToken(cause.reason);
      if (got === reason) {
        emit(`${FILES_REJECT_MARKER}: reason=${reason} status=OK`);
      } else {
        emit(`${FILES_REJECT_MARKER}: reason=${got} status=FAILSAFE`);
      }
      return;
    }
  }

  emit(`${FILES_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitBackupArchiveMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  const result = await runBackupArchiveRoundTrip(client);
  emit(formatBackupArchiveMarker(result));

  if (!result.ok) {
    return;
  }

  emit(formatBackupArchiveRejectMarker(await rejectTamperedBackupArchive(client)));
}

async function emitPdsRepoMarkers(
  agentTransport: AgentTransport,
  client: Pick<AgentClient, "apply" | "getState">,
): Promise<void> {
  const result = await applyAndReadPdsRepoCreate(
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
    client,
  );

  emit(formatPdsRepoMarker(result));

  if (!result.ok || result.outcome !== "committed") {
    return;
  }

  const rejected = await rejectInvalidPdsRepoCreate(client);
  emit(formatPdsRepoMarker(rejected));
}

async function emitForcedCapsuleRejectMarker(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(FORCED_INVALID_CAPSULE_PLAN);

    if (result.outcome === "rejected") {
      emit(`${CAPSULE_MARKER}: outcome=rejected reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_MARKER}: outcome=rejected reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitCapsuleFetchMarkers(agentTransport: AgentTransport): Promise<boolean> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(CAPSULE_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleFetchRejectMarker(client);
      return false;
    }

    emit(formatCapsuleFetchedMarker());
  } catch {
    emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    return false;
  }

  await emitForcedCapsuleFetchRejectMarker(client);
  return true;
}

async function emitForcedCapsuleFetchRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_BAD_CAPSULE_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_FETCH_REJECT_MARKER}: reason=${capsuleFetchRejectReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_FETCH_REJECT_MARKER}: reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_FETCH_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitCapsuleOCIFetchMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(CAPSULE_OCI_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleOCIFetchRejectMarker(client);
      return;
    }

    emit(formatCapsuleOCIFetchedMarker());
  } catch {
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  await emitForcedCapsuleOCIFetchRejectMarker(client);
  await emitCapsuleOCIArchFetchMarker(client);
  await emitForcedCapsuleOCIArchUnsupportedRejectMarker(client);
}

async function emitForcedCapsuleOCIFetchRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_TAMPERED_CAPSULE_OCI_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_FETCH_REJECT_MARKER}: reason=${capsuleOCIFetchRejectReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_OCI_FETCH_REJECT_MARKER}: reason=${capsuleOCIErrorDetailReason(cause.agentError)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitCapsuleOCIArchFetchMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(CAPSULE_OCI_ARCH_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
      return;
    }

    emit(formatCapsuleOCIArchFetchedMarker());
  } catch {
    emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
  }
}

async function emitForcedCapsuleOCIArchUnsupportedRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_ARM64_ONLY_CAPSULE_OCI_ARCH_FETCH_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_FETCH_REJECT_MARKER}: reason=${capsuleOCIFetchRejectReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_OCI_FETCH_REJECT_MARKER}: reason=${capsuleOCIErrorDetailReason(cause.agentError)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_OCI_FETCH_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitCapsuleExecuteMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      const reason = agentApplyResultReason(result);
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleExecuteRejectMarker(client);
      return;
    }

    const state = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));

    if (!state.ok) {
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleExecuteRejectMarker(client);
      return;
    }

    emit(formatCapsuleExecutedMarker(state.status));
    emit(formatCapsuleNetworkParseMarker(state.status));
    const netnsState = await readCapsuleNetnsState(client, state.status.id);
    if (netnsState.ok) {
      emit(formatCapsuleNetnsMarker(netnsState.status));
      emit(formatCapsuleNetEgressMarker(netnsState.status));
      emit(formatCapsuleNetIngressMarker(netnsState.status));
    } else {
      emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=netns_unverified status=FAILSAFE`);
      emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=egress_unverified status=FAILSAFE`);
      emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=ingress_unverified status=FAILSAFE`);
    }
    const volume = capsuleVolumeStatus(state.status);
    if (volume === undefined) {
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: reason=volume_state_missing status=FAILSAFE`);
    } else {
      emit(formatCapsuleVolumeMarker(state.status, volume));
    }

    const health = await readCapsuleHealthState(agentTransport, state.status.id);
    if (health.ok && health.workload.status === "OK" && health.workload.health === "OK") {
      emit(formatCapsuleHealthMarker(health.workload));
    } else {
      emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    }
  } catch (cause) {
    const reason = agentClientErrorReason(cause, "transport_failed");
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    emit(`${CAPSULE_HEALTH_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  await emitForcedCapsuleNetworkRejectMarker(client);
  await emitForcedCapsuleExecuteRejectMarker(client);
}

async function emitForcedCapsuleNetworkRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const registryResult = await client.apply(CAPSULE_NET_REGISTRY_PLAN);

    if (registryResult.outcome !== "committed") {
      const reason = agentApplyResultReason(registryResult);
      emit(`${CAPSULE_NET_REJECT_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
      return;
    }

    const result = await client.apply(FORCED_INVALID_CAPSULE_NET_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      const reason = agentApplyResultReason(result);
      emit(`${CAPSULE_NET_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_NS_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_EGRESS_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_INGRESS_REJECT_MARKER}: reason=${reason} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      const reason = markerToken(cause.agentError.code);
      emit(`${CAPSULE_NET_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_NS_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_EGRESS_REJECT_MARKER}: reason=${reason} status=OK`);
      emit(`${CAPSULE_NET_INGRESS_REJECT_MARKER}: reason=${reason} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_NET_REJECT_MARKER}: reason=not_rejected status=FAILSAFE`);
  emit(`${CAPSULE_NET_NS_ERROR_MARKER}: reason=not_rejected status=FAILSAFE`);
  emit(`${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=not_rejected status=FAILSAFE`);
  emit(`${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=not_rejected status=FAILSAFE`);
}

async function emitForcedCapsuleExecuteRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_INVALID_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_EXECUTE_REJECT_MARKER}: reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_EXECUTE_REJECT_MARKER}: reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
  emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitOCICapsuleMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const registryResult = await client.apply(OCI_CAPSULE_REGISTRY_PLAN);

    if (registryResult.outcome !== "committed") {
      emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: reason=${agentApplyResultReason(registryResult)} status=FAILSAFE`);
      return;
    }

    const result = await client.apply(OCI_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_EXECUTE_REJECT_MARKER}: reason=${agentApplyResultReason(result)} status=OK`);
      await emitForcedOCICapsuleExecuteRejectMarker(client);
      return;
    }

    const state = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));

    if (!state.ok || state.status.id !== OCI_CAPSULE_ENTRY.id) {
      emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      await emitForcedOCICapsuleExecuteRejectMarker(client);
      return;
    }

    emit(formatOCICapsuleExecutedMarker(state.status));
  } catch (cause) {
    const reason = agentClientErrorReason(cause, "transport_failed");
    emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    return;
  }

  await emitForcedOCICapsuleExecuteRejectMarker(client);
}

async function emitHostileOCILimitsMarker(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const registryResult = await client.apply(OCI_CAPSULE_REGISTRY_PLAN);

    if (registryResult.outcome !== "committed") {
      emit(formatOCILimitsFailureMarker());
      return;
    }

    const result = await client.apply(HOSTILE_OCI_LIMITS_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(formatOCILimitsFailureMarker());
      return;
    }

    const state = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));

    if (
      state.ok &&
      state.status.id === HOSTILE_OCI_CAPSULE_ENTRY.id &&
      state.status.ociLimits !== undefined
    ) {
      emit(formatOCILimitsMarker(state.status.id, state.status.ociLimits));
      return;
    }

    emit(formatOCILimitsFailureMarker());
  } catch {
    emit(formatOCILimitsFailureMarker());
  }
}

async function emitForcedOCICapsuleExecuteRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_MISSING_OCI_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_OCI_EXECUTE_REJECT_MARKER}: reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_OCI_EXECUTE_REJECT_MARKER}: reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_OCI_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitWasmCapsuleMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const registryResult = await client.apply(OCI_CAPSULE_REGISTRY_PLAN);

    if (registryResult.outcome !== "committed") {
      emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: reason=${agentApplyResultReason(registryResult)} status=FAILSAFE`);
      return;
    }

    const result = await client.apply(WASM_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: reason=${agentApplyResultReason(result)} status=FAILSAFE`);
      await emitForcedWasmCapsuleExecuteRejectMarker(client);
      return;
    }

    const state = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));

    if (!state.ok || state.status.id !== WASM_CAPSULE_ENTRY.id) {
      emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: reason=state_unreadable status=FAILSAFE`);
      await emitForcedWasmCapsuleExecuteRejectMarker(client);
      return;
    }

    emit(formatWasmCapsuleExecutedMarker(state.status));
  } catch (cause) {
    const reason = agentClientErrorReason(cause, "transport_failed");
    emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: reason=${reason} status=FAILSAFE`);
    return;
  }

  await emitForcedWasmCapsuleExecuteRejectMarker(client);
}

async function emitForcedWasmCapsuleExecuteRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_MISSING_WASM_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_WASM_EXECUTE_REJECT_MARKER}: reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_WASM_EXECUTE_REJECT_MARKER}: reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_WASM_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
}

type CapsuleExecuteReadResult =
  | {
      readonly ok: true;
      readonly status: CapsuleExecuteStatus;
    }
  | {
      readonly ok: false;
    };

interface CapsuleExecuteStatus {
  readonly id: string;
  readonly unit: string;
  readonly dynamicUid: string;
  readonly health: "OK";
  readonly status: "OK";
  readonly volumes: readonly CapsuleVolumeStatus[];
  readonly network?: CapsuleNetworkStatus;
  readonly ociLimits?: CapsuleOCILimitsStatus;
}

interface CapsuleNetworkStatus {
  readonly ingress: number;
  readonly egress: number;
  readonly ingressDeniedPort?: number;
  readonly ingressDrop?: "enforced";
  readonly ingressPort?: number;
  readonly ingressReach?: "OK";
  readonly egressAllowed?: string;
  readonly egressDenied?: string;
  readonly egressDrop?: "enforced";
  readonly egressReach?: "OK";
  readonly isolation?: "enforced";
  readonly loopback?: "OK";
  readonly netns?: string;
}

interface CapsuleVolumeStatus {
  readonly name: string;
  readonly path: string;
  readonly stateDirectory: string;
  readonly access: string;
  readonly mounted: "OK";
  readonly status: "OK";
}

interface CapsuleOCILimitsStatus {
  readonly mem: string;
  readonly tasks: string;
  readonly cpu: string;
  readonly status: "OK" | "FAIL";
}

type CapsuleHealthReadResult =
  | {
      readonly ok: true;
      readonly workload: CapsuleWorkloadStatus;
    }
  | {
      readonly ok: false;
    };

interface CapsuleWorkloadStatus {
  readonly id: string;
  readonly unit: string;
  readonly status: string;
  readonly health: string;
  readonly restarts: number;
}

function parseCapsuleExecuteState(value: unknown): CapsuleExecuteReadResult {
  if (!isJsonObject(value)) {
    return { ok: false };
  }

  const last = value["last"];

  if (!isJsonObject(last)) {
    return { ok: false };
  }

  const id = readStringField(last, "id");
  const unit = readStringField(last, "unit");
  const dynamicUid = readStringField(last, "dynamicUid");
  const health = readStringField(last, "health");
  const status = readStringField(last, "status");
  const volumes = parseCapsuleVolumeStatuses(last["volumes"]);
  const network = parseCapsuleNetworkStatus(last["network"]);
  const ociLimits = parseCapsuleOCILimitsStatus(last["ociLimits"]);

  if (
    id === undefined ||
    unit === undefined ||
    dynamicUid === undefined ||
    health !== "OK" ||
    status !== "OK" ||
    volumes === undefined
  ) {
    return { ok: false };
  }

  const executeStatus = {
    dynamicUid,
    health,
    id,
    status,
    unit,
    volumes,
  } satisfies CapsuleExecuteStatus;

  const statusWithNetwork = network === undefined
    ? executeStatus
    : {
        ...executeStatus,
        network,
      } satisfies CapsuleExecuteStatus;

  if (ociLimits !== undefined) {
    return {
      ok: true,
      status: {
        ...statusWithNetwork,
        ociLimits,
      },
    };
  }

  return {
    ok: true,
    status: statusWithNetwork,
  };
}

function parseCapsuleNetworkStatus(value: unknown): CapsuleNetworkStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const ingress = readNonNegativeIntegerField(value, "ingress");
  const egress = readNonNegativeIntegerField(value, "egress");
  const netns = readOptionalStringField(value, "netns");
  const loopback = readOptionalStringField(value, "loopback");
  const isolation = readOptionalStringField(value, "isolation");
  const ingressPort = readOptionalNonNegativeIntegerField(value, "ingressPort");
  const ingressDeniedPort = readOptionalNonNegativeIntegerField(value, "ingressDeniedPort");
  const ingressReach = readOptionalStringField(value, "ingressReach");
  const ingressDrop = readOptionalStringField(value, "ingressDrop");
  const egressAllowed = readOptionalStringField(value, "egressAllowed");
  const egressReach = readOptionalStringField(value, "egressReach");
  const egressDenied = readOptionalStringField(value, "egressDenied");
  const egressDrop = readOptionalStringField(value, "egressDrop");

  if (ingress === undefined || egress === undefined) {
    return undefined;
  }

  const status = {
    egress,
    ingress,
  } satisfies CapsuleNetworkStatus;

  return {
    ...status,
    ...(isolation === "enforced" ? { isolation } : {}),
    ...(loopback === "OK" ? { loopback } : {}),
    ...(ingressPort === undefined ? {} : { ingressPort }),
    ...(ingressDeniedPort === undefined ? {} : { ingressDeniedPort }),
    ...(ingressDrop === "enforced" ? { ingressDrop } : {}),
    ...(ingressReach === "OK" ? { ingressReach } : {}),
    ...(egressAllowed === undefined ? {} : { egressAllowed }),
    ...(egressDenied === undefined ? {} : { egressDenied }),
    ...(egressDrop === "enforced" ? { egressDrop } : {}),
    ...(egressReach === "OK" ? { egressReach } : {}),
    ...(netns === undefined ? {} : { netns }),
  };
}

function parseCapsuleVolumeStatuses(value: unknown): readonly CapsuleVolumeStatus[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const volumes: CapsuleVolumeStatus[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const volume = value[index];

    if (!isJsonObject(volume)) {
      return undefined;
    }

    const parsed = parseCapsuleVolumeStatus(volume);

    if (parsed === undefined) {
      return undefined;
    }

    volumes[volumes.length] = parsed;
  }
  return Object.freeze(volumes);
}

function parseCapsuleVolumeStatus(
  value: Readonly<Record<string, unknown>>,
): CapsuleVolumeStatus | undefined {
  const name = readStringField(value, "name");
  const volumePath = readStringField(value, "path");
  const stateDirectory = readStringField(value, "stateDirectory");
  const access = readStringField(value, "access");
  const mounted = readStringField(value, "mounted");
  const status = readStringField(value, "status");

  if (
    name === undefined ||
    volumePath === undefined ||
    stateDirectory === undefined ||
    access === undefined ||
    mounted !== "OK" ||
    status !== "OK"
  ) {
    return undefined;
  }

  return {
    access,
    mounted,
    name,
    path: volumePath,
    stateDirectory,
    status,
  };
}

function parseCapsuleOCILimitsStatus(value: unknown): CapsuleOCILimitsStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  const mem = readStringField(value, "mem");
  const tasks = readStringField(value, "tasks");
  const cpu = readStringField(value, "cpu");
  const status = readStringField(value, "status");

  if (
    mem === undefined ||
    tasks === undefined ||
    cpu === undefined ||
    (status !== "OK" && status !== "FAIL")
  ) {
    return undefined;
  }

  return {
    cpu,
    mem,
    status,
    tasks,
  };
}

function formatCapsuleExecutedMarker(status: CapsuleExecuteStatus): string {
  return (
    `${CAPSULE_EXECUTED_MARKER}: ` +
    `id=${status.id} ` +
    `unit=${status.unit} ` +
    `uid=${status.dynamicUid} ` +
    `health=${status.health} ` +
    "status=OK"
  );
}

function formatCapsuleNetworkParseMarker(status: CapsuleExecuteStatus): string {
  if (status.network === undefined) {
    return (
      `${CAPSULE_NET_PARSE_MARKER}: ` +
      `id=${status.id} ` +
      "egress=0 " +
      "ingress=0 " +
      "status=FAILSAFE"
    );
  }

  return (
    `${CAPSULE_NET_PARSE_MARKER}: ` +
    `id=${status.id} ` +
    `egress=${status.network.egress} ` +
    `ingress=${status.network.ingress} ` +
    "status=OK"
  );
}

function formatCapsuleNetnsMarker(status: CapsuleExecuteStatus): string {
  const network = status.network;
  if (
    network === undefined ||
    network.netns === undefined ||
    network.loopback !== "OK" ||
    network.isolation !== "enforced"
  ) {
    return `${CAPSULE_NET_NS_ERROR_MARKER}: reason=netns_unverified status=FAILSAFE`;
  }

  return (
    `${CAPSULE_NET_NS_MARKER}: ` +
    `id=${status.id} ` +
    `netns=${markerToken(network.netns)} ` +
    `loopback=${network.loopback} ` +
    `isolation=${network.isolation} ` +
    "status=OK"
  );
}

function formatCapsuleNetEgressMarker(status: CapsuleExecuteStatus): string {
  const network = status.network;
  if (
    network === undefined ||
    network.egress <= 0 ||
    network.egressAllowed === undefined ||
    network.egressDenied === undefined ||
    network.egressReach !== "OK" ||
    network.egressDrop !== "enforced"
  ) {
    return `${CAPSULE_NET_EGRESS_ERROR_MARKER}: reason=egress_unverified status=FAILSAFE`;
  }

  return (
    `${CAPSULE_NET_EGRESS_MARKER}: ` +
    `id=${status.id} ` +
    `allowed=${network.egressAllowed} ` +
    `reach=${network.egressReach} ` +
    `denied=${network.egressDenied} ` +
    `drop=${network.egressDrop} ` +
    "status=OK"
  );
}

function formatCapsuleNetIngressMarker(status: CapsuleExecuteStatus): string {
  const network = status.network;
  if (
    network === undefined ||
    network.ingress <= 0 ||
    network.ingressPort === undefined ||
    network.ingressDeniedPort === undefined ||
    network.ingressReach !== "OK" ||
    network.ingressDrop !== "enforced"
  ) {
    return `${CAPSULE_NET_INGRESS_ERROR_MARKER}: reason=ingress_unverified status=FAILSAFE`;
  }

  return (
    `${CAPSULE_NET_INGRESS_MARKER}: ` +
    `id=${status.id} ` +
    `port=${network.ingressPort} ` +
    `reach=${network.ingressReach} ` +
    `denied_port=${network.ingressDeniedPort} ` +
    `drop=${network.ingressDrop} ` +
    "status=OK"
  );
}

function formatOCICapsuleExecutedMarker(status: CapsuleExecuteStatus): string {
  return (
    `${CAPSULE_OCI_EXECUTED_MARKER}: ` +
    `id=${status.id} ` +
    `unit=${status.unit} ` +
    `uid=${status.dynamicUid} ` +
    "root=ro " +
    `health=${status.health} ` +
    "status=OK"
  );
}

function formatWasmCapsuleExecutedMarker(status: CapsuleExecuteStatus): string {
  return (
    `${CAPSULE_WASM_EXECUTED_MARKER}: ` +
    `id=${status.id} ` +
    `unit=${status.unit} ` +
    `uid=${status.dynamicUid} ` +
    "runtime=wasmtime " +
    `health=${status.health} ` +
    "status=OK"
  );
}

function formatOCILimitsMarker(id: string, limits: CapsuleOCILimitsStatus): string {
  return (
    `${CAPSULE_OCI_LIMITS_MARKER}: ` +
    `id=${id} ` +
    `mem=${markerToken(limits.mem)} ` +
    `tasks=${markerToken(limits.tasks)} ` +
    `cpu=${markerToken(limits.cpu)} ` +
    `status=${markerToken(limits.status)}`
  );
}

function formatOCILimitsFailureMarker(): string {
  return (
    `${CAPSULE_OCI_LIMITS_MARKER}: ` +
    `id=${HOSTILE_OCI_CAPSULE_ENTRY.id} ` +
    "mem=unknown " +
    "tasks=unknown " +
    "cpu=unknown " +
    "status=FAIL"
  );
}

function capsuleVolumeStatus(status: CapsuleExecuteStatus): CapsuleVolumeStatus | undefined {
  for (let index = 0; index < status.volumes.length; index += 1) {
    const volume = status.volumes[index];

    if (
      volume !== undefined &&
      volume.name === CAPSULE_VOLUME_NAME &&
      volume.path === CAPSULE_VOLUME_PATH &&
      volume.mounted === "OK" &&
      volume.status === "OK"
    ) {
      return volume;
    }
  }

  return undefined;
}

function formatCapsuleVolumeMarker(
  status: CapsuleExecuteStatus,
  volume: CapsuleVolumeStatus,
): string {
  return (
    `${CAPSULE_VOLUME_MARKER}: ` +
    `id=${status.id} ` +
    `vol=${volume.name} ` +
    `path=${volume.path} ` +
    `mounted=${volume.mounted} ` +
    "status=OK"
  );
}

function formatCapsuleFetchedMarker(): string {
  return (
    `${CAPSULE_FETCH_MARKER}: ` +
    `id=${ON_DEVICE_CAPSULE_ENTRY.id} ` +
    `sri=${shortSRI(CAPSULE_BUNDLE_INTEGRITY)} ` +
    "verified=OK " +
    "status=OK"
  );
}

function formatCapsuleOCIFetchedMarker(): string {
  return (
    `${CAPSULE_OCI_FETCH_MARKER}: ` +
    `id=${OCI_FETCH_CAPSULE_ID} ` +
    `image-digest=${shortOCIDigest(OCI_IMAGE_DIGEST)} ` +
    "arch=linux/amd64 " +
    "layers=1 " +
    "verified=OK " +
    "status=OK"
  );
}

function formatCapsuleOCIArchFetchedMarker(): string {
  return (
    `${CAPSULE_OCI_FETCH_MARKER}: ` +
    `id=${OCI_ARCH_FETCH_CAPSULE_ID} ` +
    `image-digest=${shortOCIDigest(OCI_ARCH_IMAGE_AMD64_DIGEST)} ` +
    "arch=linux/amd64 " +
    "layers=1 " +
    "verified=OK " +
    "status=OK"
  );
}

function capsuleFetchRejectReason(result: AgentApplyResult): string {
  const message = result.error?.message.toLowerCase() ?? "";

  if (message.includes("sri mismatch")) {
    return "sri_mismatch";
  }

  return agentApplyResultReason(result);
}

function capsuleOCIFetchRejectReason(result: AgentApplyResult): string {
  return capsuleOCIMessageReason(result.error?.message ?? "", agentApplyResultReason(result));
}

function capsuleOCIErrorDetailReason(error: { readonly code: string; readonly message: string }): string {
  return capsuleOCIMessageReason(error.message, markerToken(error.code));
}

function capsuleOCIMessageReason(messageText: string, fallback: string): string {
  const message = messageText.toLowerCase();

  if (message.includes("sri mismatch")) {
    return "sri_mismatch";
  }
  if (message.includes("digest mismatch")) {
    return "digest_mismatch";
  }
  if (message.includes("arch unsupported") || message.includes("no compatible")) {
    return "arch_unsupported";
  }
  if (message.includes("whiteout")) {
    return "whiteout";
  }
  if (message.includes("bomb") || message.includes("entry limit") || message.includes("payload size limit")) {
    return "bomb";
  }
  if (message.includes("traversal") || message.includes("escapes capsule root")) {
    return "traversal";
  }

  return fallback;
}

async function readCapsuleHealthState(
  agentTransport: AgentTransport,
  id: string,
): Promise<CapsuleHealthReadResult> {
  try {
    const response = await agentTransport(new URL("/state", AGENTD_BASE_URL).toString(), {
      headers: STATE_JSON_HEADERS,
      method: "GET",
    });

    if (!response.ok) {
      return { ok: false };
    }

    return parseCapsuleHealthState(parseJsonOrText(await response.text()), id);
  } catch {
    return { ok: false };
  }
}

async function readCapsuleNetnsState(
  client: Pick<AgentClient, "getState">,
  id: string,
): Promise<CapsuleExecuteReadResult> {
  const deadline = Date.now() + 5000;
  let last: CapsuleExecuteReadResult = { ok: false };

  while (Date.now() <= deadline) {
    last = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));
    if (
      last.ok &&
      last.status.id === id &&
      last.status.network !== undefined &&
      last.status.network.netns !== undefined &&
      last.status.network.loopback === "OK" &&
      last.status.network.isolation === "enforced" &&
      (
        last.status.network.egress === 0 ||
        (
          last.status.network.egressReach === "OK" &&
          last.status.network.egressDrop === "enforced" &&
          last.status.network.egressAllowed !== undefined &&
          last.status.network.egressDenied !== undefined
        )
      ) &&
      (
        last.status.network.ingress === 0 ||
        (
          last.status.network.ingressReach === "OK" &&
          last.status.network.ingressDrop === "enforced" &&
          last.status.network.ingressPort !== undefined &&
          last.status.network.ingressDeniedPort !== undefined
        )
      )
    ) {
      return last;
    }
    await delay(250);
  }

  return last;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseCapsuleHealthState(value: unknown, id: string): CapsuleHealthReadResult {
  if (!isJsonObject(value)) {
    return { ok: false };
  }

  const workloads = value["capsuleWorkloads"];

  if (!Array.isArray(workloads)) {
    return { ok: false };
  }

  for (let index = 0; index < workloads.length; index += 1) {
    const workload = workloads[index];

    if (!isJsonObject(workload)) {
      continue;
    }

    const parsed = parseCapsuleWorkloadStatus(workload);

    if (parsed !== undefined && parsed.id === id) {
      return {
        ok: true,
        workload: parsed,
      };
    }
  }

  return { ok: false };
}

function parseCapsuleWorkloadStatus(
  value: Readonly<Record<string, unknown>>,
): CapsuleWorkloadStatus | undefined {
  const id = readStringField(value, "id");
  const unit = readStringField(value, "unit");
  const status = readStringField(value, "status");
  const health = readStringField(value, "health");
  const restarts = readNonNegativeIntegerField(value, "restarts");

  if (
    id === undefined ||
    unit === undefined ||
    status === undefined ||
    health === undefined ||
    restarts === undefined
  ) {
    return undefined;
  }

  return {
    health,
    id,
    restarts,
    status,
    unit,
  };
}

function formatCapsuleHealthMarker(workload: CapsuleWorkloadStatus): string {
  return (
    `${CAPSULE_HEALTH_MARKER}: ` +
    `id=${workload.id} ` +
    "check=lifecycle " +
    `status=${markerToken(workload.status)} ` +
    `health=${markerToken(workload.health)} ` +
    `restarts=${workload.restarts}`
  );
}

function readStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const child = value[key];

  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }

  return child;
}

function readOptionalStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const child = value[key];

  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }

  return child;
}

function readNonNegativeIntegerField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const child = value[key];

  if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0) {
    return undefined;
  }

  return child;
}

function readOptionalNonNegativeIntegerField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const child = value[key];

  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0) {
    return undefined;
  }

  return child;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function applyResultReason(result: ApplyNodeApplyResult, fallback: string): string {
  return markerToken(result.error?.code ?? fallback);
}

function agentApplyResultReason(result: AgentApplyResult): string {
  return markerToken(result.error?.code ?? "transaction_rejected");
}

function agentClientErrorReason(cause: unknown, fallback: string): string {
  if (isAgentClientError(cause) && cause.agentError !== undefined) {
    return markerToken(cause.agentError.code);
  }

  return markerToken(fallback);
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

function shortSRI(integrity: string): string {
  const separator = integrity.indexOf("-");

  if (separator <= 0) {
    return markerToken(integrity);
  }

  const algorithm = integrity.slice(0, separator);
  const token = integrity.slice(separator + 1, separator + 13);
  return `${algorithm}-${token}`;
}

function shortOCIDigest(digest: string): string {
  const separator = digest.indexOf(":");

  if (separator <= 0) {
    return markerToken(digest);
  }

  const algorithm = digest.slice(0, separator);
  const token = digest.slice(separator + 1, separator + 13);
  return `${algorithm}-${token}`;
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
}).catch((err) => {
  // Ported from S1 candidate B: a stray rejection must not fail the oneshot silently — fail-safe + exit nonzero.
  console.error("VITA-MAIN-ERROR: status=FAILSAFE", err);
  Deno.exit(1);
});

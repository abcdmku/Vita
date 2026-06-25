import {
  DESKTOP_PACKAGE_CLASS,
  DESKTOP_SUBSTRATE_VERSION,
  createDesktopSessionHeartbeat,
  formatDesktopHeartbeat,
  validateDesktopSessionHeartbeat,
  validateDesktopSessionRegistration,
} from "../../../sdk/typescript/src/desktop-substrate.ts";
import type {
  DesktopSessionHeartbeat,
  DesktopSessionRegistration,
} from "../../../sdk/typescript/src/desktop-substrate.ts";

export const DESKTOP_STUB_PACKAGE_ID = "com.vita.desktop.stub";
export const DESKTOP_STUB_SESSION_ID = "stub-session";
export const DESKTOP_STUB_HEARTBEAT_CHANNEL = Object.freeze({
  capability: "capsule.execute",
  kind: "agentd.capsule-health",
});

export interface DesktopStubSessionOptions {
  readonly emit?: (line: string) => void;
  readonly now?: () => string;
  readonly nonce?: () => string;
}

export interface DesktopStubSessionResult {
  readonly registration: DesktopSessionRegistration;
  readonly heartbeat: DesktopSessionHeartbeat;
  readonly heartbeatLine: string;
  readonly stopped: true;
}

export const DESKTOP_STUB_REGISTRATION: DesktopSessionRegistration = Object.freeze({
  capsule: Object.freeze({
    entrypoint: "main.ts",
    executionPackageClass: "ts-service",
    id: DESKTOP_STUB_PACKAGE_ID,
    integrity: "sha256-sPt3ZRLmh4AiIyy5GMMpd6DAPKE/vAP3KdOOr0kAb6w=",
    ref: "file:///usr/lib/vita/capsule-bundles/com.vita.desktop.stub.tar.zst",
    version: "1.0.0",
  }),
  heartbeatChannel: DESKTOP_STUB_HEARTBEAT_CHANNEL,
  heartbeatIntervalMs: 1000,
  packageClass: DESKTOP_PACKAGE_CLASS,
  packageId: DESKTOP_STUB_PACKAGE_ID,
  packageVersion: "1.0.0",
  sessionId: DESKTOP_STUB_SESSION_ID,
  substrateVersion: DESKTOP_SUBSTRATE_VERSION,
});

export function runDesktopStubSession(
  options: DesktopStubSessionOptions = Object.freeze({}),
): DesktopStubSessionResult {
  const registration = validateDesktopSessionRegistration(DESKTOP_STUB_REGISTRATION);

  if (!registration.ok) {
    throw new Error("desktop stub registration is invalid");
  }

  const timestamp = options.now === undefined ? new Date().toISOString() : options.now();
  const nonce = options.nonce === undefined ? createHeartbeatNonce() : options.nonce();
  const heartbeat = createDesktopSessionHeartbeat(registration.value, 1, timestamp, nonce);
  const heartbeatResult = validateDesktopSessionHeartbeat(heartbeat);

  if (!heartbeatResult.ok) {
    throw new Error("desktop stub heartbeat is invalid");
  }

  const heartbeatLine = formatDesktopHeartbeat(heartbeatResult.value);
  options.emit?.(heartbeatLine);

  return Object.freeze({
    heartbeat: heartbeatResult.value,
    heartbeatLine,
    registration: registration.value,
    stopped: true as const,
  });
}

function createHeartbeatNonce(): string {
  const time = Date.now().toString(36);
  const random = Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, "0");
  return `stub-${time}-${random}`;
}

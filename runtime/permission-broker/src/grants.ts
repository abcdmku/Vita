import type {
  DataClass,
  DataVolumeRequirement,
  NetworkPolicy,
  NetworkProtocol,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";

export type DataAccessMode = DataVolumeRequirement["access"];

export interface DataCapabilityGrant {
  readonly kind: "data";
  readonly class: DataClass;
  readonly access: DataAccessMode;
  readonly scope: string;
}

export interface NetworkIngressCapabilityGrant {
  readonly kind: "network";
  readonly direction: "ingress";
  readonly protocol: NetworkProtocol;
  readonly port: number;
  readonly public: boolean;
}

export interface NetworkEgressCapabilityGrant {
  readonly kind: "network";
  readonly direction: "egress";
  readonly protocol: NetworkProtocol;
  readonly destination: string;
  readonly port: number;
}

export interface UnknownCapabilityRequest {
  readonly kind: "unknown";
  readonly name: string;
}

export type CapabilityGrant =
  | DataCapabilityGrant
  | NetworkIngressCapabilityGrant
  | NetworkEgressCapabilityGrant;

export type RequestedCapability = CapabilityGrant | UnknownCapabilityRequest;

export interface CapabilityRequest {
  readonly packageContract: PackageContract;
  readonly capabilities: readonly RequestedCapability[];
}

export interface DataGrantPolicy {
  readonly class: DataClass;
  readonly access: DataAccessMode;
  readonly scope: string;
}

export interface BrokerPolicy {
  readonly data: readonly DataGrantPolicy[];
  readonly network: NetworkPolicy;
}

export type DenialCode =
  | "MALFORMED_REQUEST"
  | "MALFORMED_POLICY"
  | "INVALID_PACKAGE_CONTRACT"
  | "UNKNOWN_CAPABILITY"
  | "NOT_DECLARED"
  | "POLICY_DENIED";

export interface CapabilityDenial {
  readonly capability: RequestedCapability;
  readonly code: DenialCode;
  readonly reason: string;
}

export interface GrantDecision {
  readonly granted: readonly CapabilityGrant[];
  readonly denied: readonly CapabilityDenial[];
}

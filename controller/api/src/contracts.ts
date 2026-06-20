import type {
  DeviceArchitecture,
  ReadonlyAcceleratorCapability,
} from "../../../sdk/typescript/src/capabilities.ts";
import type { PlanDiff } from "../../../sdk/typescript/src/diff.ts";
import type { CanonicalPlan, DesiredState } from "../../../sdk/typescript/src/plan.ts";
import type { ValidationResult } from "../../../sdk/typescript/src/validate.ts";

export type EmptyParams = Readonly<Record<string, never>>;

export type NodeHealthStatus = "healthy" | "degraded" | "offline";

export interface HealthSummary {
  readonly healthy: number;
  readonly degraded: number;
  readonly offline: number;
}

export interface ProtectionSummary {
  readonly protected: number;
  readonly warnings: number;
  readonly unprotected: number;
}

export interface ExposureSummary {
  readonly publicServices: number;
  readonly privateServices: number;
  readonly blockedRequests24h: number;
}

export interface OverviewResponse {
  readonly nodeCount: number;
  readonly health: HealthSummary;
  readonly protection: ProtectionSummary;
  readonly exposure: ExposureSummary;
}

export type GetOverviewRequest = EmptyParams;

export interface NodeHealthRequest {
  readonly nodeId: string;
}

export interface NodeCapabilitySummary {
  readonly memoryGB: number;
  readonly architecture: DeviceArchitecture;
  readonly accelerators: readonly ReadonlyAcceleratorCapability[];
  readonly tpm: {
    readonly present: boolean;
    readonly version?: string;
    readonly sealedKeyUnlock?: boolean;
  };
  readonly virtualization: {
    readonly hardware: boolean;
    readonly nested?: boolean;
  };
}

export interface NodeHealthResponse {
  readonly nodeId: string;
  readonly status: NodeHealthStatus;
  readonly uptimeSeconds: number;
  readonly capabilities: NodeCapabilitySummary;
}

export interface PlanPreviewRequest {
  readonly desiredState: DesiredState;
  readonly currentPlan?: CanonicalPlan;
}

export type PlanValidationPass = Extract<ValidationResult, { readonly ok: true }>;
export type PlanValidationFailure = Extract<ValidationResult, { readonly ok: false }>;

export interface ControllerApiError {
  readonly code: "UNKNOWN_METHOD" | "INVALID_PARAMS" | "VALIDATION_FAILED";
  readonly message: string;
}

export type PlanPreviewResponse =
  | {
      readonly ok: true;
      readonly validation: PlanValidationPass;
      readonly diff: PlanDiff;
      readonly explanation: string;
    }
  | {
      readonly ok: false;
      readonly validation: PlanValidationFailure;
      readonly error: ControllerApiError;
    };

export interface ControllerApi {
  getOverview(): OverviewResponse;
  getNodeHealth(params: NodeHealthRequest): NodeHealthResponse;
  previewPlan(params: PlanPreviewRequest): PlanPreviewResponse;
}

export type ControllerApiMethod = "getOverview" | "getNodeHealth" | "previewPlan";

export type ControllerApiRequest =
  | {
      readonly method: "getOverview";
      readonly params?: GetOverviewRequest;
    }
  | {
      readonly method: "getNodeHealth";
      readonly params: NodeHealthRequest;
    }
  | {
      readonly method: "previewPlan";
      readonly params: PlanPreviewRequest;
    };

export interface ControllerApiDispatchRequest {
  readonly method: string;
  readonly params?: unknown;
}

export type ControllerApiDispatchResult =
  | {
      readonly ok: true;
      readonly method: "getOverview";
      readonly response: OverviewResponse;
    }
  | {
      readonly ok: true;
      readonly method: "getNodeHealth";
      readonly response: NodeHealthResponse;
    }
  | {
      readonly ok: true;
      readonly method: "previewPlan";
      readonly response: PlanPreviewResponse;
    }
  | {
      readonly ok: false;
      readonly error: ControllerApiError;
    };

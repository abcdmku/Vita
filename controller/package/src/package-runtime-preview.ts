import { resolveInstallPlan } from "../../../packages/install/src/resolve.ts";
import type {
  InstallPlan,
  ResolveInstallPlanError,
} from "../../../packages/install/src/resolve.ts";
import { denoSandboxPolicy } from "../../../packages/runtime/src/sandbox.ts";
import type {
  DenoSandboxPermissions,
  DenoSandboxPolicyError,
} from "../../../packages/runtime/src/sandbox.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";

export type PackageRuntimePreviewRejectionSource = "resolver" | "sandbox" | "preview";

export type PackageRuntimePreviewRejectionCode =
  | ResolveInstallPlanError["code"]
  | DenoSandboxPolicyError["code"]
  | "PREVIEW_FAILED";

export interface PackageRuntimePreviewRejection {
  readonly source: PackageRuntimePreviewRejectionSource;
  readonly code: PackageRuntimePreviewRejectionCode;
  readonly path: string;
  readonly message: string;
  readonly grantIndex?: number;
}

export type PackageRuntimePreview =
  | {
      readonly ok: true;
      readonly installPlan: InstallPlan;
      readonly grants: readonly CapabilityGrant[];
      readonly sandboxPolicy: DenoSandboxPermissions;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly PackageRuntimePreviewRejection[];
    };

export function previewPackageRuntime(entry: unknown, lockfile: unknown): PackageRuntimePreview {
  try {
    const resolved = resolveInstallPlan(entry, lockfile);

    if (!resolved.ok) {
      return rejected(resolverRejections(resolved.errors));
    }

    const installPlan = resolved.plan;
    const grants = installPlan.capabilityGrants;
    const sandbox = denoSandboxPolicy(grants);

    if (!sandbox.ok) {
      return rejected([sandboxRejection(sandbox.error)]);
    }

    return Object.freeze({
      grants,
      installPlan,
      ok: true,
      sandboxPolicy: sandbox.policy,
    });
  } catch {
    return rejected([
      {
        code: "PREVIEW_FAILED",
        message: "Package runtime preview failed closed.",
        path: "",
        source: "preview",
      },
    ]);
  }
}

function resolverRejections(
  errors: readonly ResolveInstallPlanError[],
): readonly PackageRuntimePreviewRejection[] {
  const rejections: PackageRuntimePreviewRejection[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) {
      rejections[rejections.length] = {
        code: error.code,
        message: error.message,
        path: error.path,
        source: "resolver",
      };
    }
  }

  if (rejections.length === 0) {
    rejections[0] = {
      code: "PREVIEW_FAILED",
      message: "Package install plan resolution rejected without details.",
      path: "",
      source: "preview",
    };
  }

  return Object.freeze(rejections);
}

function sandboxRejection(error: DenoSandboxPolicyError): PackageRuntimePreviewRejection {
  if (error.grantIndex === undefined) {
    return {
      code: error.code,
      message: error.reason,
      path: "grants",
      source: "sandbox",
    };
  }

  return {
    code: error.code,
    grantIndex: error.grantIndex,
    message: error.reason,
    path: `grants/${error.grantIndex}`,
    source: "sandbox",
  };
}

function rejected(
  rejections: readonly PackageRuntimePreviewRejection[],
): PackageRuntimePreview {
  return Object.freeze({
    ok: false,
    rejections: Object.freeze([...rejections]),
  });
}

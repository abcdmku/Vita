import {
  validatePlanAgainstConfig,
  validateUpdateConfig,
  validateUpdatePlan,
} from "../../../sdk/typescript/src/update-model.ts";
import type {
  SlotId,
  UpdateBundleRef,
  UpdateConfig,
  UpdatePlan,
  ValidationError,
} from "../../../sdk/typescript/src/update-model.ts";

export type UpdatePreviewRejectionCode =
  | "INVALID_CONFIG"
  | "INVALID_PLAN"
  | "UNSAFE_ACTIVE_SLOT"
  | "PREVIEW_FAILED";

export type UpdatePreviewRejectionSource = "config" | "plan" | "safety" | "preview";

export interface UpdatePreviewRejection {
  readonly code: UpdatePreviewRejectionCode;
  readonly source: UpdatePreviewRejectionSource;
  readonly path: string;
  readonly message: string;
}

export type UpdatePreview =
  | {
      readonly targetSlot: SlotId;
      readonly activeSlot: SlotId;
      readonly bundle: UpdateBundleRef;
      readonly safe: true;
      readonly rejections: readonly [];
    }
  | {
      readonly targetSlot: SlotId | null;
      readonly activeSlot: SlotId | null;
      readonly bundle: UpdateBundleRef | null;
      readonly safe: false;
      readonly rejections: readonly UpdatePreviewRejection[];
    };

const NO_REJECTIONS: readonly [] = Object.freeze([]);

export function previewUpdate(currentConfig: unknown, plan: unknown): UpdatePreview {
  try {
    const configResult = validateUpdateConfig(currentConfig);
    const planResult = validateUpdatePlan(plan);
    const rejections: UpdatePreviewRejection[] = [];

    let config: UpdateConfig | undefined;
    let updatePlan: UpdatePlan | undefined;

    if (configResult.ok) {
      config = configResult.config;
    } else {
      appendValidationRejections(rejections, "INVALID_CONFIG", "config", configResult.errors);
    }

    if (planResult.ok) {
      updatePlan = planResult.plan;
    } else {
      appendValidationRejections(rejections, "INVALID_PLAN", "plan", planResult.errors);
    }

    const activeSlot = config === undefined ? null : activeSlotFromConfig(config);
    const targetSlot = updatePlan?.targetSlot ?? null;
    const bundle = updatePlan?.bundle ?? null;

    if (config !== undefined && updatePlan !== undefined) {
      appendValidationRejections(
        rejections,
        "UNSAFE_ACTIVE_SLOT",
        "safety",
        validatePlanAgainstConfig(config, updatePlan),
      );
    }

    if (rejections.length > 0 || activeSlot === null || targetSlot === null || bundle === null) {
      return Object.freeze({
        activeSlot,
        bundle,
        rejections: Object.freeze(rejections),
        safe: false,
        targetSlot,
      });
    }

    return Object.freeze({
      activeSlot,
      bundle,
      rejections: NO_REJECTIONS,
      safe: true,
      targetSlot,
    });
  } catch {
    const rejection: UpdatePreviewRejection = {
      code: "PREVIEW_FAILED",
      message: "Update preview validation failed.",
      path: "",
      source: "preview",
    };

    return Object.freeze({
      activeSlot: null,
      bundle: null,
      rejections: Object.freeze([rejection]),
      safe: false,
      targetSlot: null,
    });
  }
}

function appendValidationRejections(
  rejections: UpdatePreviewRejection[],
  code: UpdatePreviewRejectionCode,
  source: UpdatePreviewRejectionSource,
  errors: readonly ValidationError[],
): void {
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      code,
      message: error.message,
      path: error.path,
      source,
    };
  }
}

function activeSlotFromConfig(config: UpdateConfig): SlotId | null {
  for (let index = 0; index < config.slots.length; index += 1) {
    const slot = config.slots[index];

    if (slot?.active === true) {
      return slot.id;
    }
  }

  return null;
}

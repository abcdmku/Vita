import { validateServicesConfig } from "../../../sdk/typescript/src/services-model.ts";
import type {
  ServiceEntry,
  ServicesConfig,
  ValidationError,
} from "../../../sdk/typescript/src/services-model.ts";

export type ServicesPreviewSide = "current" | "desired" | "preview";

export interface ServicesPreviewRejection {
  readonly side: ServicesPreviewSide;
  readonly path: string;
  readonly message: string;
}

export interface AddedServiceChange {
  readonly kind: "added";
  readonly name: string;
  readonly after: ServiceEntry;
}

export interface RemovedServiceChange {
  readonly kind: "removed";
  readonly name: string;
  readonly before: ServiceEntry;
}

export interface EnabledServiceChange {
  readonly kind: "enabled";
  readonly name: string;
  readonly before: ServiceEntry | null;
  readonly after: ServiceEntry;
}

export interface DisabledServiceChange {
  readonly kind: "disabled";
  readonly name: string;
  readonly before: ServiceEntry;
  readonly after: ServiceEntry;
}

export interface ServicesChangeDiff {
  readonly enabled: Readonly<Record<string, EnabledServiceChange>>;
  readonly disabled: Readonly<Record<string, DisabledServiceChange>>;
  readonly added: Readonly<Record<string, AddedServiceChange>>;
  readonly removed: Readonly<Record<string, RemovedServiceChange>>;
}

export type ServicesChangePreview =
  | {
      readonly valid: true;
      readonly diff: ServicesChangeDiff;
      readonly newlyEnabledCount: number;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: undefined;
      readonly newlyEnabledCount: 0;
      readonly rejections: readonly ServicesPreviewRejection[];
    };

type SideValidation =
  | {
      readonly ok: true;
      readonly config: ServicesConfig;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly ServicesPreviewRejection[];
    };

const NO_REJECTIONS: readonly [] = Object.freeze([]);
const VALIDATION_FAILED = "Services config validation failed.";

export function previewServicesChange(current: unknown, desired: unknown): ServicesChangePreview {
  try {
    const currentValidation = validateSide("current", current);
    const desiredValidation = validateSide("desired", desired);

    if (!currentValidation.ok || !desiredValidation.ok) {
      return rejectedPreview(collectRejections(currentValidation, desiredValidation));
    }

    const diff = diffServicesConfigs(currentValidation.config, desiredValidation.config);

    return Object.freeze({
      diff,
      newlyEnabledCount: Object.keys(diff.enabled).length,
      rejections: NO_REJECTIONS,
      valid: true,
    });
  } catch {
    return rejectedPreview([
      {
        message: "Services change preview failed.",
        path: "",
        side: "preview",
      },
    ]);
  }
}

function validateSide(
  side: Exclude<ServicesPreviewSide, "preview">,
  input: unknown,
): SideValidation {
  try {
    const result = validateServicesConfig(input);

    if (result.ok) {
      return {
        config: result.config,
        ok: true,
      };
    }

    return {
      ok: false,
      rejections: validationErrorsToRejections(side, result.errors),
    };
  } catch {
    return {
      ok: false,
      rejections: Object.freeze([
        {
          message: VALIDATION_FAILED,
          path: "",
          side,
        },
      ]),
    };
  }
}

function validationErrorsToRejections(
  side: Exclude<ServicesPreviewSide, "preview">,
  errors: readonly ValidationError[],
): readonly ServicesPreviewRejection[] {
  const rejections: ServicesPreviewRejection[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      message: error.message,
      path: error.path,
      side,
    };
  }

  if (rejections.length === 0) {
    rejections[0] = {
      message: VALIDATION_FAILED,
      path: "",
      side,
    };
  }

  return Object.freeze(rejections);
}

function collectRejections(
  currentValidation: SideValidation,
  desiredValidation: SideValidation,
): readonly ServicesPreviewRejection[] {
  const rejections: ServicesPreviewRejection[] = [];

  if (!currentValidation.ok) {
    appendRejections(rejections, currentValidation.rejections);
  }
  if (!desiredValidation.ok) {
    appendRejections(rejections, desiredValidation.rejections);
  }

  return Object.freeze(rejections);
}

function appendRejections(
  target: ServicesPreviewRejection[],
  source: readonly ServicesPreviewRejection[],
): void {
  for (let index = 0; index < source.length; index += 1) {
    const rejection = source[index];

    if (rejection !== undefined) {
      target[target.length] = rejection;
    }
  }
}

function rejectedPreview(rejections: readonly ServicesPreviewRejection[]): ServicesChangePreview {
  return Object.freeze({
    diff: undefined,
    newlyEnabledCount: 0,
    rejections: Object.freeze([...rejections]),
    valid: false,
  });
}

function diffServicesConfigs(current: ServicesConfig, desired: ServicesConfig): ServicesChangeDiff {
  const currentByName = indexServices(current.services);
  const desiredByName = indexServices(desired.services);
  const enabled: Record<string, EnabledServiceChange> = {};
  const disabled: Record<string, DisabledServiceChange> = {};
  const added: Record<string, AddedServiceChange> = {};
  const removed: Record<string, RemovedServiceChange> = {};
  const names = sortedUniqueNames(currentByName, desiredByName);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];

    if (name === undefined) {
      continue;
    }

    const before = currentByName.get(name);
    const after = desiredByName.get(name);

    if (before === undefined && after !== undefined) {
      added[name] = Object.freeze({
        after,
        kind: "added",
        name,
      });

      if (after.enabled) {
        enabled[name] = Object.freeze({
          after,
          before: null,
          kind: "enabled",
          name,
        });
      }
      continue;
    }

    if (before !== undefined && after === undefined) {
      removed[name] = Object.freeze({
        before,
        kind: "removed",
        name,
      });
      continue;
    }

    if (before !== undefined && after !== undefined) {
      if (!before.enabled && after.enabled) {
        enabled[name] = Object.freeze({
          after,
          before,
          kind: "enabled",
          name,
        });
      } else if (before.enabled && !after.enabled) {
        disabled[name] = Object.freeze({
          after,
          before,
          kind: "disabled",
          name,
        });
      }
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    disabled: Object.freeze(disabled),
    enabled: Object.freeze(enabled),
    removed: Object.freeze(removed),
  });
}

function indexServices(services: readonly ServiceEntry[]): ReadonlyMap<string, ServiceEntry> {
  const byName = new Map<string, ServiceEntry>();

  for (let index = 0; index < services.length; index += 1) {
    const service = services[index];

    if (service !== undefined) {
      byName.set(service.name, service);
    }
  }

  return byName;
}

function sortedUniqueNames(
  current: ReadonlyMap<string, ServiceEntry>,
  desired: ReadonlyMap<string, ServiceEntry>,
): readonly string[] {
  const names = new Set<string>();

  for (const name of current.keys()) {
    names.add(name);
  }

  for (const name of desired.keys()) {
    names.add(name);
  }

  return Object.freeze([...names].sort(compareStrings));
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

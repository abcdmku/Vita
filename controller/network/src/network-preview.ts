import { validateNetworkConfig } from "../../../sdk/typescript/src/network-model.ts";
import type {
  InboundRule,
  NetworkConfig,
  NetworkInterface,
  ValidationError,
} from "../../../sdk/typescript/src/network-model.ts";

export type NetworkPreviewSide = "current" | "desired";

export interface NetworkPreviewRejection {
  readonly side: NetworkPreviewSide;
  readonly path: string;
  readonly message: string;
}

export interface InterfaceChange {
  readonly name: string;
  readonly current: NetworkInterface;
  readonly desired: NetworkInterface;
}

export interface NetworkInterfaceDiff {
  readonly added: readonly NetworkInterface[];
  readonly removed: readonly NetworkInterface[];
  readonly modified: readonly InterfaceChange[];
}

export interface NetworkFirewallDiff {
  readonly added: readonly InboundRule[];
  readonly removed: readonly InboundRule[];
}

export interface NetworkChangeDiff {
  readonly interfaces: NetworkInterfaceDiff;
  readonly firewall: NetworkFirewallDiff;
}

export type NetworkChangePreview =
  | {
      readonly valid: true;
      readonly diff: NetworkChangeDiff;
      readonly wideningInbound: boolean;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: undefined;
      readonly wideningInbound: false;
      readonly rejections: readonly NetworkPreviewRejection[];
    };

type SideValidation =
  | {
      readonly ok: true;
      readonly config: NetworkConfig;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly NetworkPreviewRejection[];
    };

const NO_REJECTIONS: readonly [] = Object.freeze([]);
const VALIDATION_FAILED = "Network config validation failed.";

export function previewNetworkChange(current: unknown, desired: unknown): NetworkChangePreview {
  const currentValidation = validateSide("current", current);
  const desiredValidation = validateSide("desired", desired);

  if (!currentValidation.ok || !desiredValidation.ok) {
    return {
      diff: undefined,
      rejections: collectRejections(currentValidation, desiredValidation),
      valid: false,
      wideningInbound: false,
    };
  }

  const diff = diffNetworkConfigs(currentValidation.config, desiredValidation.config);

  return {
    diff,
    rejections: NO_REJECTIONS,
    valid: true,
    wideningInbound: diff.firewall.added.length > 0,
  };
}

function validateSide(side: NetworkPreviewSide, input: unknown): SideValidation {
  try {
    const result = validateNetworkConfig(input);

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
  side: NetworkPreviewSide,
  errors: readonly ValidationError[],
): readonly NetworkPreviewRejection[] {
  const rejections: NetworkPreviewRejection[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      rejections[rejections.length] = {
        message: VALIDATION_FAILED,
        path: "",
        side,
      };
    } else {
      rejections[rejections.length] = {
        message: error.message,
        path: error.path,
        side,
      };
    }
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
): readonly NetworkPreviewRejection[] {
  const rejections: NetworkPreviewRejection[] = [];

  if (!currentValidation.ok) {
    appendRejections(rejections, currentValidation.rejections);
  }
  if (!desiredValidation.ok) {
    appendRejections(rejections, desiredValidation.rejections);
  }

  return Object.freeze(rejections);
}

function appendRejections(
  target: NetworkPreviewRejection[],
  source: readonly NetworkPreviewRejection[],
): void {
  for (let index = 0; index < source.length; index += 1) {
    const rejection = source[index];

    if (rejection !== undefined) {
      target[target.length] = rejection;
    }
  }
}

function diffNetworkConfigs(current: NetworkConfig, desired: NetworkConfig): NetworkChangeDiff {
  return Object.freeze({
    firewall: diffFirewall(current.firewall.allow, desired.firewall.allow),
    interfaces: diffInterfaces(current.interfaces, desired.interfaces),
  });
}

function diffInterfaces(
  current: readonly NetworkInterface[],
  desired: readonly NetworkInterface[],
): NetworkInterfaceDiff {
  const currentByName = indexInterfaces(current);
  const desiredByName = indexInterfaces(desired);
  const added: NetworkInterface[] = [];
  const removed: NetworkInterface[] = [];
  const modified: InterfaceChange[] = [];

  for (let index = 0; index < desired.length; index += 1) {
    const desiredInterface = desired[index];

    if (desiredInterface === undefined) continue;

    const currentInterface = currentByName.get(desiredInterface.name);

    if (currentInterface === undefined) {
      added[added.length] = desiredInterface;
    } else if (currentInterface.kind !== desiredInterface.kind) {
      modified[modified.length] = Object.freeze({
        current: currentInterface,
        desired: desiredInterface,
        name: desiredInterface.name,
      });
    }
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentInterface = current[index];

    if (currentInterface !== undefined && !desiredByName.has(currentInterface.name)) {
      removed[removed.length] = currentInterface;
    }
  }

  return Object.freeze({
    added: freezeSortedInterfaces(added),
    modified: freezeSortedInterfaceChanges(modified),
    removed: freezeSortedInterfaces(removed),
  });
}

function diffFirewall(
  current: readonly InboundRule[],
  desired: readonly InboundRule[],
): NetworkFirewallDiff {
  const currentByKey = indexRules(current);
  const desiredByKey = indexRules(desired);
  const added: InboundRule[] = [];
  const removed: InboundRule[] = [];

  for (let index = 0; index < desired.length; index += 1) {
    const desiredRule = desired[index];

    if (desiredRule !== undefined && !currentByKey.has(ruleKey(desiredRule))) {
      added[added.length] = desiredRule;
    }
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentRule = current[index];

    if (currentRule !== undefined && !desiredByKey.has(ruleKey(currentRule))) {
      removed[removed.length] = currentRule;
    }
  }

  return Object.freeze({
    added: freezeSortedRules(added),
    removed: freezeSortedRules(removed),
  });
}

function indexInterfaces(interfaces: readonly NetworkInterface[]): ReadonlyMap<string, NetworkInterface> {
  const byName = new Map<string, NetworkInterface>();

  for (let index = 0; index < interfaces.length; index += 1) {
    const networkInterface = interfaces[index];

    if (networkInterface !== undefined) {
      byName.set(networkInterface.name, networkInterface);
    }
  }

  return byName;
}

function indexRules(rules: readonly InboundRule[]): ReadonlyMap<string, InboundRule> {
  const byKey = new Map<string, InboundRule>();

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule !== undefined) {
      byKey.set(ruleKey(rule), rule);
    }
  }

  return byKey;
}

function freezeSortedInterfaces(values: NetworkInterface[]): readonly NetworkInterface[] {
  values.sort(compareInterfaces);
  return Object.freeze(values);
}

function freezeSortedInterfaceChanges(values: InterfaceChange[]): readonly InterfaceChange[] {
  values.sort((left, right) => compareStrings(left.name, right.name));
  return Object.freeze(values);
}

function freezeSortedRules(values: InboundRule[]): readonly InboundRule[] {
  values.sort(compareRules);
  return Object.freeze(values);
}

function compareInterfaces(left: NetworkInterface, right: NetworkInterface): number {
  return compareStrings(left.name, right.name);
}

function compareRules(left: InboundRule, right: InboundRule): number {
  return compareStrings(ruleKey(left), ruleKey(right));
}

function ruleKey(rule: InboundRule): string {
  return `${rule.protocol}:${rule.port}:${rule.sourceCidr}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

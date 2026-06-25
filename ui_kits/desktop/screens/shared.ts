import type {
  DesktopCapability,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  ShellResult,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaElement,
  VitaListItem,
} from "../runtime/binder.ts";

export function datasetValue(element: VitaElement, keys: readonly string[]): string | undefined {
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : element.dataset[key];

      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function optionalHostPort<T>(
  host: DesktopHost,
  key: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const value = readOwnData(host, key);

  return guard(value) ? value : undefined;
}

export function firstCapabilityResource(
  host: DesktopHost,
  capabilities: readonly DesktopCapability[],
  fallback: string,
): string | undefined {
  try {
    const grants = host.package.capabilityGrants;

    for (let capabilityIndex = 0; capabilityIndex < capabilities.length; capabilityIndex += 1) {
      const capability = capabilities[capabilityIndex];

      if (capability === undefined) continue;

      for (let grantIndex = 0; grantIndex < grants.length; grantIndex += 1) {
        const grant = grants[grantIndex];

        if (grant !== undefined && grant.capability === capability) {
          return grant.resourceId ?? fallback;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return Object.freeze({
    error: hostError(code, message, path),
    ok: false,
  });
}

export function shellAccept<T>(value: T): ShellResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

export function shellReject<T>(code: string, message: string, path: string): ShellResult<T> {
  return Object.freeze({
    error: hostError(code, message, path),
    ok: false,
  });
}

export function hostError(code: string, message: string, path: string): DesktopHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

export function textListItem(input: {
  readonly key: string;
  readonly text: string;
  readonly action?: string;
  readonly classes?: readonly {
    readonly className: string;
    readonly enabled: boolean;
  }[];
  readonly data?: readonly {
    readonly name: string;
    readonly value: string | number | boolean;
  }[];
}): VitaListItem {
  const attrs: {
    readonly name: string;
    readonly value: string | number | boolean;
  }[] = [];

  if (input.action !== undefined) {
    attrs.push(Object.freeze({
      name: "data-vita-action",
      value: input.action,
    }));
  }

  if (input.data !== undefined) {
    for (let index = 0; index < input.data.length; index += 1) {
      const item = input.data[index];

      if (item !== undefined) attrs.push(item);
    }
  }

  const output: {
    key: string;
    text: string;
    attrs?: readonly {
      readonly name: string;
      readonly value: string | number | boolean;
    }[];
    classes?: readonly {
      readonly className: string;
      readonly enabled: boolean;
    }[];
  } = {
    key: input.key,
    text: input.text,
  };

  if (attrs.length > 0) output.attrs = Object.freeze(attrs);
  if (input.classes !== undefined) output.classes = input.classes;

  return Object.freeze(output);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";

  return `${Math.round(value)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1_073_741_824) return `${roundOne(bytes / 1_073_741_824)} GB`;
  if (bytes >= 1_048_576) return `${roundOne(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${roundOne(bytes / 1024)} KB`;

  return `${Math.round(bytes)} B`;
}

export function readOwnData(source: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function roundOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

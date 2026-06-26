import type {
  SurfaceShellHostPorts,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  ManagedShellConfigController,
  createShellComponentRegistry,
} from "./index.ts";
import type {
  ShellComponentRegistry,
  ShellCompositionPorts,
} from "./index.ts";

export type ShellBackend = Required<SurfaceShellHostPorts>;

export interface ShellBackendOptions {
  readonly registry?: ShellComponentRegistry;
  readonly ports?: ShellCompositionPorts;
}

const EMPTY_PORTS = Object.freeze({}) satisfies ShellCompositionPorts;

export function createShellBackend(options: ShellBackendOptions = Object.freeze({})): ShellBackend {
  const registry = options.registry ?? createEmptyRegistry();
  const controller = new ManagedShellConfigController(registry, options.ports ?? EMPTY_PORTS);

  return Object.freeze({
    applyShell(definition) {
      return controller.apply(definition);
    },
    currentShell() {
      return controller.current();
    },
    previewShell(definition) {
      return controller.preview(definition);
    },
    registerComponent(definition) {
      return registry.register(definition);
    },
    rollbackShell() {
      return controller.rollback();
    },
  }) satisfies ShellBackend;
}

function createEmptyRegistry(): ShellComponentRegistry {
  const registry = createShellComponentRegistry();

  if (registry.ok) return registry.value;

  throw new Error("empty shell component registry initialization failed");
}

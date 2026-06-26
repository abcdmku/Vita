import { summarizeAuditLog } from "../../audit/src/audit-viewer.ts";
import { previewBackupChange } from "../../backup/src/backup-preview.ts";
import { previewAccountsChange } from "../../accounts/src/accounts-preview.ts";
import { previewCapsuleChange } from "../../capsule/src/capsule-preview.ts";
import { previewNodeChangeSet } from "../../changeset/src/changeset-preview.ts";
import { buildNodeDashboard } from "../../dashboard/src/node-dashboard.ts";
import { previewNetworkChange } from "../../network/src/network-preview.ts";
import { previewNodeConfigChange } from "../../node-config/src/node-config-preview.ts";
import { buildNodeOverview } from "../../overview/src/node-overview.ts";
import { previewPackageRuntime } from "../../package/src/package-runtime-preview.ts";
import { previewPlan } from "../../plan/src/plan-preview.ts";
import { buildNodeOperationsReport } from "../../report/src/operations-report.ts";
import { previewServicesChange } from "../../services/src/services-preview.ts";
import { buildNodeState } from "../../state/src/node-state.ts";
import { previewStorageChange } from "../../storage/src/storage-preview.ts";
import { previewUpdate } from "../../update/src/update-preview.ts";
import type { AgentClient } from "../../agent-client/src/agent-client.ts";

export const APP_SHELL_VIEW_IDS = Object.freeze([
  "dashboard",
  "node",
  "storage",
  "identity",
  "app",
  "backup",
  "ai",
] as const);

export type AppShellViewId = (typeof APP_SHELL_VIEW_IDS)[number];

export type ControllerShellReadClient = Pick<
  AgentClient,
  "getHealth" | "getOperations" | "getState"
>;

export interface ControllerShellReadPort {
  readonly getHealth: ControllerShellReadClient["getHealth"];
  readonly getOperations: ControllerShellReadClient["getOperations"];
  readonly getState: ControllerShellReadClient["getState"];
}

export type AppShellDataClient = ControllerShellReadClient;
export type AppShellDataPort = ControllerShellReadPort;

export interface AppShellOptions {
  readonly data: ControllerShellReadPort;
}

export interface AppShell {
  readonly data: ControllerShellReadPort;
  readonly views: AppShellViewRegistry;
  resolveView(viewId: unknown): AppShellRouteResult;
}

export interface AppShellViewFactoryContext {
  readonly data: ControllerShellReadPort;
}

export type AppShellViewFactory<TViewId extends AppShellViewId = AppShellViewId> = (
  context: AppShellViewFactoryContext,
) => AppShellViewModelFor<TViewId>;

export interface AppShellViewRegistration<TViewId extends AppShellViewId = AppShellViewId> {
  readonly id: TViewId;
  readonly createViewModel: AppShellViewFactory<TViewId>;
}

export type AppShellViewRegistrationUnion = {
  readonly [TViewId in AppShellViewId]: AppShellViewRegistration<TViewId>;
}[AppShellViewId];

export type AppShellViewRegistry = {
  readonly [TViewId in AppShellViewId]: AppShellViewRegistration<TViewId>;
};

export type AppShellRouteErrorCode = "UNKNOWN_VIEW_ID";

export interface AppShellRouteError {
  readonly code: AppShellRouteErrorCode;
  readonly message: string;
  readonly receivedType: string;
  readonly viewId: string | null;
}

export type AppShellRouteResult =
  | {
      readonly ok: true;
      readonly view: AppShellViewRegistrationUnion;
    }
  | {
      readonly ok: false;
      readonly error: AppShellRouteError;
    };

export class AppShellRoutingError extends Error {
  readonly code: AppShellRouteErrorCode;
  readonly receivedType: string;
  readonly viewId: string | null;

  constructor(error: AppShellRouteError) {
    super(error.message);
    this.name = "AppShellRoutingError";
    this.code = error.code;
    this.receivedType = error.receivedType;
    this.viewId = error.viewId;
  }
}

export interface BaseAppShellViewModel<TViewId extends AppShellViewId> {
  readonly id: TViewId;
  readonly title: string;
  readonly data: ControllerShellReadPort;
}

export interface DashboardViewModel extends BaseAppShellViewModel<"dashboard"> {
  readonly headless: {
    readonly buildNodeDashboard: typeof buildNodeDashboard;
    readonly buildNodeOverview: typeof buildNodeOverview;
    readonly buildNodeOperationsReport: typeof buildNodeOperationsReport;
    readonly buildNodeState: typeof buildNodeState;
    readonly previewPlan: typeof previewPlan;
  };
}

export interface NodeViewModel extends BaseAppShellViewModel<"node"> {
  readonly headless: {
    readonly buildNodeOverview: typeof buildNodeOverview;
    readonly buildNodeState: typeof buildNodeState;
    readonly previewNetworkChange: typeof previewNetworkChange;
    readonly previewNodeConfigChange: typeof previewNodeConfigChange;
    readonly previewUpdate: typeof previewUpdate;
  };
}

export interface StorageViewModel extends BaseAppShellViewModel<"storage"> {
  readonly headless: {
    readonly previewNodeConfigChange: typeof previewNodeConfigChange;
    readonly previewStorageChange: typeof previewStorageChange;
  };
}

export interface IdentityViewModel extends BaseAppShellViewModel<"identity"> {
  readonly headless: {
    readonly previewAccountsChange: typeof previewAccountsChange;
    readonly previewNodeConfigChange: typeof previewNodeConfigChange;
    readonly summarizeAuditLog: typeof summarizeAuditLog;
  };
}

export interface AppViewModel extends BaseAppShellViewModel<"app"> {
  readonly headless: {
    readonly previewCapsuleChange: typeof previewCapsuleChange;
    readonly previewNodeChangeSet: typeof previewNodeChangeSet;
    readonly previewPackageRuntime: typeof previewPackageRuntime;
    readonly previewServicesChange: typeof previewServicesChange;
  };
}

export interface BackupViewModel extends BaseAppShellViewModel<"backup"> {
  readonly headless: {
    readonly previewBackupChange: typeof previewBackupChange;
    readonly previewNodeConfigChange: typeof previewNodeConfigChange;
  };
}

export interface AiViewModel extends BaseAppShellViewModel<"ai"> {
  readonly headless: {
    readonly buildNodeState: typeof buildNodeState;
    readonly previewPackageRuntime: typeof previewPackageRuntime;
    readonly previewPlan: typeof previewPlan;
  };
}

export type AppShellViewModel =
  | DashboardViewModel
  | NodeViewModel
  | StorageViewModel
  | IdentityViewModel
  | AppViewModel
  | BackupViewModel
  | AiViewModel;

export type AppShellViewModelFor<TViewId extends AppShellViewId> = Extract<
  AppShellViewModel,
  { readonly id: TViewId }
>;

export const APP_SHELL_VIEW_REGISTRY: AppShellViewRegistry = Object.freeze({
  dashboard: Object.freeze({
    createViewModel: createDashboardViewModel,
    id: "dashboard",
  }),
  node: Object.freeze({
    createViewModel: createNodeViewModel,
    id: "node",
  }),
  storage: Object.freeze({
    createViewModel: createStorageViewModel,
    id: "storage",
  }),
  identity: Object.freeze({
    createViewModel: createIdentityViewModel,
    id: "identity",
  }),
  app: Object.freeze({
    createViewModel: createAppViewModel,
    id: "app",
  }),
  backup: Object.freeze({
    createViewModel: createBackupViewModel,
    id: "backup",
  }),
  ai: Object.freeze({
    createViewModel: createAiViewModel,
    id: "ai",
  }),
});

export function createControllerShellReadPort(
  client: ControllerShellReadClient,
): ControllerShellReadPort {
  return Object.freeze({
    getHealth: () => client.getHealth(),
    getOperations: () => client.getOperations(),
    getState: (capability: string) => client.getState(capability),
  });
}

export const createAppShellDataPort = createControllerShellReadPort;

export function createAppShell(options: AppShellOptions): AppShell {
  return Object.freeze({
    data: options.data,
    resolveView: (viewId: unknown) => resolveAppShellView(viewId),
    views: APP_SHELL_VIEW_REGISTRY,
  });
}

export function resolveAppShellView(
  viewId: unknown,
  registry: AppShellViewRegistry = APP_SHELL_VIEW_REGISTRY,
): AppShellRouteResult {
  if (!isAppShellViewId(viewId)) {
    return Object.freeze({
      error: routeError(viewId),
      ok: false,
    });
  }

  return Object.freeze({
    ok: true,
    view: registry[viewId],
  });
}

export function requireAppShellView(
  viewId: unknown,
  registry: AppShellViewRegistry = APP_SHELL_VIEW_REGISTRY,
): AppShellViewRegistrationUnion {
  const route = resolveAppShellView(viewId, registry);

  if (!route.ok) {
    throw new AppShellRoutingError(route.error);
  }

  return route.view;
}

export function isAppShellViewId(value: unknown): value is AppShellViewId {
  if (typeof value !== "string") {
    return false;
  }

  for (let index = 0; index < APP_SHELL_VIEW_IDS.length; index += 1) {
    if (APP_SHELL_VIEW_IDS[index] === value) {
      return true;
    }
  }

  return false;
}

function createDashboardViewModel(context: AppShellViewFactoryContext): DashboardViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      buildNodeDashboard,
      buildNodeOperationsReport,
      buildNodeOverview,
      buildNodeState,
      previewPlan,
    }),
    id: "dashboard",
    title: "Dashboard",
  });
}

function createNodeViewModel(context: AppShellViewFactoryContext): NodeViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      buildNodeOverview,
      buildNodeState,
      previewNetworkChange,
      previewNodeConfigChange,
      previewUpdate,
    }),
    id: "node",
    title: "Node",
  });
}

function createStorageViewModel(context: AppShellViewFactoryContext): StorageViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      previewNodeConfigChange,
      previewStorageChange,
    }),
    id: "storage",
    title: "Storage",
  });
}

function createIdentityViewModel(context: AppShellViewFactoryContext): IdentityViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      previewAccountsChange,
      previewNodeConfigChange,
      summarizeAuditLog,
    }),
    id: "identity",
    title: "Identity",
  });
}

function createAppViewModel(context: AppShellViewFactoryContext): AppViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      previewCapsuleChange,
      previewNodeChangeSet,
      previewPackageRuntime,
      previewServicesChange,
    }),
    id: "app",
    title: "App",
  });
}

function createBackupViewModel(context: AppShellViewFactoryContext): BackupViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      previewBackupChange,
      previewNodeConfigChange,
    }),
    id: "backup",
    title: "Backup",
  });
}

function createAiViewModel(context: AppShellViewFactoryContext): AiViewModel {
  return Object.freeze({
    data: context.data,
    headless: Object.freeze({
      buildNodeState,
      previewPackageRuntime,
      previewPlan,
    }),
    id: "ai",
    title: "AI",
  });
}

function routeError(viewId: unknown): AppShellRouteError {
  const receivedType = typeof viewId;

  return Object.freeze({
    code: "UNKNOWN_VIEW_ID",
    message: "Unknown app shell view id.",
    receivedType,
    viewId: typeof viewId === "string" ? viewId : null,
  });
}

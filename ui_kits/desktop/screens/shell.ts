import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createShellViewModel,
} from "../viewmodels/Shell.ts";
import type {
  ShellOutputLine,
  ShellSessionPort,
  ShellTabState,
  ShellViewModel,
  ShellViewModelState,
} from "../viewmodels/Shell.ts";
import {
  datasetValue,
  optionalHostPort,
  textListItem,
} from "./shared.ts";

export interface ShellScreenPorts {
  readonly session?: ShellSessionPort;
}

export const shellScreen = Object.freeze({
  actions: new Map<string, (viewModel: ShellViewModel, context: VitaActionContext<ShellViewModelState>) => DesktopMaybePromise<void>>([
    ["shell.newTab", (viewModel) => {
      viewModel.newTab();
    }],
    ["shell.closeTab", (viewModel, context) => {
      viewModel.closeTab(datasetValue(context.target, Object.freeze(["vitaTabId"])) ?? viewModel.snapshot().activeTabId);
    }],
    ["shell.submit", async (viewModel, context) => {
      await viewModel.submit(datasetValue(context.target, Object.freeze(["vitaCommand"])) ?? "pwd");
    }],
    ["shell.historyPrev", (viewModel) => {
      viewModel.historyPrev();
    }],
    ["shell.historyNext", (viewModel) => {
      viewModel.historyNext();
    }],
    ["shell.clear", (viewModel) => {
      viewModel.clear();
    }],
  ]),
  binds: new Map<string, (snapshot: ShellViewModelState) => string | boolean | readonly VitaListItem[]>([
    ["shell.cwd", (snapshot) => snapshot.activeTab.cwd],
    ["shell.activeTitle", (snapshot) => snapshot.activeTab.title],
    ["shell.running", (snapshot) => snapshot.activeTab.running],
    ["shell.exitCode", (snapshot) => snapshot.activeTab.lastExitCode === null ? "" : `exit ${snapshot.activeTab.lastExitCode}`],
    ["shell.tabs", (snapshot) => snapshot.tabs.map((tab) => tabItem(snapshot.activeTabId, tab))],
    ["shell.output", (snapshot) => snapshot.activeTab.outputBuffer.map(outputItem)],
  ]),
  createViewModel(ports: ShellScreenPorts): ShellViewModel {
    const input: {
      session?: ShellSessionPort;
    } = {};

    if (ports.session !== undefined) input.session = ports.session;

    return createShellViewModel(input);
  },
  id: "desktop/shell",
  selectPorts(host: DesktopHost): ShellScreenPorts {
    const session = optionalHostPort(host, "shellSession", isShellSessionPort) ??
      optionalHostPort(host, "session", isShellSessionPort);
    const output: {
      session?: ShellSessionPort;
    } = {};

    if (session !== undefined) output.session = session;

    return Object.freeze(output);
  },
}) satisfies ScreenModule<ShellViewModelState, ShellScreenPorts, ShellViewModel>;

export default shellScreen;

function isShellSessionPort(value: unknown): value is ShellSessionPort {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "runCommand") === "function";
}

function tabItem(activeTabId: string, tab: ShellTabState): VitaListItem {
  return textListItem({
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: tab.id === activeTabId,
      }),
      Object.freeze({
        className: "is-running",
        enabled: tab.running,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-tab-id",
        value: tab.id,
      }),
    ]),
    key: `tab:${tab.id}`,
    text: tab.title,
  });
}

function outputItem(line: ShellOutputLine, index: number): VitaListItem {
  return textListItem({
    classes: Object.freeze([
      Object.freeze({
        className: "is-input",
        enabled: line.kind === "input",
      }),
      Object.freeze({
        className: "is-output",
        enabled: line.kind === "output",
      }),
    ]),
    key: `line:${index}`,
    text: line.kind === "input" ? `> ${line.text}` : `  ${line.text}`,
  });
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaBindValue,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
  ScreenViewModel,
} from "../runtime/screen.ts";
import {
  createSettingsViewModel,
} from "../viewmodels/Settings.ts";
import type {
  SettingsViewModel,
  SettingsViewModelPorts,
  SettingsViewModelState,
} from "../viewmodels/Settings.ts";

export const SETTINGS_SCREEN_ID = "desktop/settings";

export class SettingsScreenViewModel implements ScreenViewModel<SettingsViewModelState> {
  readonly #viewModel: SettingsViewModel;

  constructor(viewModel: SettingsViewModel) {
    this.#viewModel = viewModel;
  }

  snapshot(): SettingsViewModelState {
    return this.#viewModel.state;
  }

  async setTheme(theme: string): Promise<void> {
    await this.#viewModel.setTheme(theme);
  }

  async setAccent(accent: string): Promise<void> {
    await this.#viewModel.setAccent(accent);
  }

  async setLayout(layout: string): Promise<void> {
    await this.#viewModel.setLayout(layout);
  }
}

export const settingsScreenModule = Object.freeze({
  actions: Object.freeze({
    async setAccent(viewModel: SettingsScreenViewModel, context: VitaActionContext<SettingsViewModelState>): Promise<void> {
      const value = actionValue(context);

      if (value !== undefined) await viewModel.setAccent(value);
    },
    async setLayout(viewModel: SettingsScreenViewModel, context: VitaActionContext<SettingsViewModelState>): Promise<void> {
      const value = actionValue(context);

      if (value !== undefined) await viewModel.setLayout(value);
    },
    async setTheme(viewModel: SettingsScreenViewModel, context: VitaActionContext<SettingsViewModelState>): Promise<void> {
      const value = actionValue(context);

      if (value !== undefined) await viewModel.setTheme(value);
    },
  }),
  binds: Object.freeze({
    accentBlueSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.accent === "blue",
    accentGreenSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.accent === "green",
    accentOrangeSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.accent === "orange",
    accentStyle: (snapshot: SettingsViewModelState): string => `--accent: ${snapshot.appearance.accentColor};`,
    accentTealSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.accent === "teal",
    accentVioletSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.accent === "violet",
    dockLabelsOff: (): boolean => false,
    dockLabelsOn: (): boolean => true,
    layoutFloatingSelected: (snapshot: SettingsViewModelState): boolean => !snapshot.appearance.tiling,
    layoutTiling: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.tiling,
    layoutTilingSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.tiling,
    themeDark: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme !== "light",
    themeDarkSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme === "dark",
    themeGraphiteSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme === "graphite",
    themeLightSelected: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme === "light",
    themeWallDark: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme !== "light",
    themeWallLight: (snapshot: SettingsViewModelState): boolean => snapshot.appearance.theme === "light",
    transparencyOff: (): boolean => true,
    transparencyOn: (): boolean => false,
  }) satisfies Readonly<Record<string, (snapshot: SettingsViewModelState) => VitaBindValue>>,
  async createViewModel(ports: SettingsViewModelPorts): Promise<SettingsScreenViewModel> {
    const loaded = await createSettingsViewModel(ports);

    if (!loaded.ok) {
      throw new Error(loaded.error.message);
    }

    return new SettingsScreenViewModel(loaded.value);
  },
  id: SETTINGS_SCREEN_ID,
  selectPorts(host: DesktopHost): SettingsViewModelPorts {
    const applySetting = host.applySetting;
    const readSetting = host.readSetting;
    const ports: {
      applySetting?: NonNullable<DesktopHost["applySetting"]>;
      readSetting?: NonNullable<DesktopHost["readSetting"]>;
      readTheme: DesktopHost["readTheme"];
    } = {
      readTheme: host.readTheme,
    };

    if (applySetting !== undefined) ports.applySetting = applySetting;
    if (readSetting !== undefined) ports.readSetting = readSetting;

    return Object.freeze(ports);
  },
}) satisfies ScreenModule<SettingsViewModelState, SettingsViewModelPorts, SettingsScreenViewModel>;

export const settingsScreen = settingsScreenModule;

export default settingsScreenModule;

function actionValue(context: VitaActionContext<SettingsViewModelState>): string | undefined {
  try {
    const value = context.target.dataset.vitaValue ?? context.target.dataset.vitaActionValue;

    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export type ParsedArgs =
  | {
      readonly kind: "evaluate";
      readonly configPath: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "preview";
      readonly configPath: string;
      readonly socketPath: string | undefined;
    }
  | {
      readonly kind: "apply";
      readonly configPath: string;
      readonly commit: boolean;
      readonly socketPath: string | undefined;
    }
  | {
      readonly kind: "capsule";
      readonly action: "list";
      readonly socketPath: string | undefined;
    }
  | {
      readonly kind: "capsule";
      readonly action: "preview" | "install";
      readonly registryPath: string;
      readonly commit: boolean;
      readonly socketPath: string | undefined;
    }
  | {
      readonly kind: "state";
      readonly capability: string | undefined;
      readonly socketPath: string | undefined;
    };

export type ParseArgsResult =
  | {
      readonly ok: true;
      readonly command: ParsedArgs;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly usage: string;
    };

export const USAGE = [
  "Usage:",
  "  vita evaluate <config.json> [--json]",
  "  vita preview <config.json> [--socket <path>]",
  "  vita apply <config.json> [--commit] [--socket <path>]",
  "  vita capsule list [--socket <path>]",
  "  vita capsule preview <capsule.json> [--socket <path>]",
  "  vita capsule install <capsule.json> [--commit] [--socket <path>]",
  "  vita state [<capability>] [--socket <path>]",
].join("\n");

interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly commit: boolean;
  readonly json: boolean;
  readonly socketPath: string | undefined;
}

type ParseFlagsResult =
  | {
      readonly ok: true;
      readonly value: ParsedFlags;
    }
  | Extract<ParseArgsResult, { readonly ok: false }>;

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const command = argv[0];

  if (command === undefined) {
    return usageError("missing command");
  }

  if (command === "evaluate") {
    const flags = parseFlags(argv.slice(1), { allowJson: true });
    if (!flags.ok) return flags;
    if (flags.value.commit || flags.value.socketPath !== undefined) {
      return usageError("evaluate accepts only --json");
    }
    if (flags.value.positionals.length !== 1) {
      return usageError("evaluate requires exactly one config path");
    }

    const configPath = flags.value.positionals[0];
    if (configPath === undefined) return usageError("evaluate requires a config path");

    return accept({
      configPath,
      json: flags.value.json,
      kind: "evaluate",
    });
  }

  if (command === "preview") {
    const flags = parseFlags(argv.slice(1), { allowSocket: true });
    if (!flags.ok) return flags;
    if (flags.value.commit || flags.value.json) {
      return usageError("preview accepts only --socket");
    }
    if (flags.value.positionals.length !== 1) {
      return usageError("preview requires exactly one config path");
    }

    const configPath = flags.value.positionals[0];
    if (configPath === undefined) return usageError("preview requires a config path");

    return accept({
      configPath,
      kind: "preview",
      socketPath: flags.value.socketPath,
    });
  }

  if (command === "apply") {
    const flags = parseFlags(argv.slice(1), { allowCommit: true, allowSocket: true });
    if (!flags.ok) return flags;
    if (flags.value.json) {
      return usageError("apply accepts only --commit and --socket");
    }
    if (flags.value.positionals.length !== 1) {
      return usageError("apply requires exactly one config path");
    }

    const configPath = flags.value.positionals[0];
    if (configPath === undefined) return usageError("apply requires a config path");

    return accept({
      commit: flags.value.commit,
      configPath,
      kind: "apply",
      socketPath: flags.value.socketPath,
    });
  }

  if (command === "capsule") {
    return parseCapsuleArgs(argv.slice(1));
  }

  if (command === "state") {
    const flags = parseFlags(argv.slice(1), { allowSocket: true });
    if (!flags.ok) return flags;
    if (flags.value.commit || flags.value.json) {
      return usageError("state accepts only --socket");
    }
    if (flags.value.positionals.length > 1) {
      return usageError("state accepts at most one capability");
    }

    return accept({
      capability: flags.value.positionals[0],
      kind: "state",
      socketPath: flags.value.socketPath,
    });
  }

  return usageError(`unknown command "${command}"`);
}

function parseCapsuleArgs(argv: readonly string[]): ParseArgsResult {
  const action = argv[0];

  if (action === undefined) {
    return usageError("capsule requires an action");
  }

  if (action === "list") {
    const flags = parseFlags(argv.slice(1), { allowSocket: true });
    if (!flags.ok) return flags;
    if (flags.value.commit || flags.value.json || flags.value.positionals.length !== 0) {
      return usageError("capsule list accepts only --socket");
    }

    return accept({
      action: "list",
      kind: "capsule",
      socketPath: flags.value.socketPath,
    });
  }

  if (action === "preview" || action === "install") {
    const flags = parseFlags(argv.slice(1), {
      allowCommit: action === "install",
      allowSocket: true,
    });
    if (!flags.ok) return flags;
    if (flags.value.json) {
      return usageError(`capsule ${action} does not accept --json`);
    }
    if (flags.value.commit && action !== "install") {
      return usageError("capsule preview does not accept --commit");
    }
    if (flags.value.positionals.length !== 1) {
      return usageError(`capsule ${action} requires exactly one capsule registry path`);
    }

    const registryPath = flags.value.positionals[0];
    if (registryPath === undefined) {
      return usageError(`capsule ${action} requires a capsule registry path`);
    }

    return accept({
      action,
      commit: flags.value.commit,
      kind: "capsule",
      registryPath,
      socketPath: flags.value.socketPath,
    });
  }

  return usageError(`unknown capsule action "${action}"`);
}

function parseFlags(
  argv: readonly string[],
  options: {
    readonly allowCommit?: boolean;
    readonly allowJson?: boolean;
    readonly allowSocket?: boolean;
  },
): ParseFlagsResult {
  const positionals: string[] = [];
  let commit = false;
  let json = false;
  let socketPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      return usageError("argument is missing");
    }

    if (arg === "--commit") {
      if (!options.allowCommit) return usageError("unknown flag --commit");
      if (commit) return usageError("duplicate --commit flag");
      commit = true;
      continue;
    }

    if (arg === "--json") {
      if (!options.allowJson) return usageError("unknown flag --json");
      if (json) return usageError("duplicate --json flag");
      json = true;
      continue;
    }

    if (arg === "--socket") {
      if (!options.allowSocket) return usageError("unknown flag --socket");
      if (socketPath !== undefined) return usageError("duplicate --socket flag");

      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return usageError("--socket requires a path");
      }

      socketPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      return usageError(`unknown flag ${arg}`);
    }

    positionals[positionals.length] = arg;
  }

  return {
    ok: true,
    value: {
      commit,
      json,
      positionals,
      socketPath,
    },
  };
}

function accept(command: ParsedArgs): ParseArgsResult {
  return {
    command,
    ok: true,
  };
}

function usageError(message: string): Extract<ParseArgsResult, { readonly ok: false }> {
  return {
    message,
    ok: false,
    usage: USAGE,
  };
}

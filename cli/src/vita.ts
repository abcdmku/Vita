import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./args.ts";
import {
  createAgentdTransport,
  createApplyNodeTransport,
  createApplyTransport,
} from "./agentd-transport.ts";
import type { NodeUnixSocketTransportOptions } from "./agentd-transport.ts";
import { runApplyCommand } from "./commands/apply.ts";
import {
  runCapsuleInstallCommand,
  runCapsuleListCommand,
  runCapsulePreviewCommand,
} from "./commands/capsule.ts";
import { runEvaluateCommand } from "./commands/evaluate.ts";
import { createAgentClientForTransport, runPreviewCommand } from "./commands/preview.ts";
import { runStateCommand } from "./commands/state.ts";
import {
  commandFailure,
} from "./format.ts";
import type { CliCommandResult } from "./format.ts";

export async function runVita(argv: readonly string[]): Promise<CliCommandResult> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    return commandFailure(`${parsed.message}\n\n${parsed.usage}`);
  }

  if (parsed.command.kind === "evaluate") {
    const config = await readJsonInput(parsed.command.configPath);
    if (!config.ok) return config.result;

    return runEvaluateCommand(config.value, {
      json: parsed.command.json,
    });
  }

  if (parsed.command.kind === "preview") {
    const config = await readJsonInput(parsed.command.configPath);
    if (!config.ok) return config.result;

    const client = createReadClient(parsed.command.socketPath);
    return runPreviewCommand(config.value, { client });
  }

  if (parsed.command.kind === "apply") {
    const config = await readJsonInput(parsed.command.configPath);
    if (!config.ok) return config.result;

    const client = createReadClient(parsed.command.socketPath);
    const applyTransport = createApplyNodeTransport(
      createApplyTransport(socketOptions(parsed.command.socketPath)),
    );

    return runApplyCommand(config.value, {
      client,
      commit: parsed.command.commit,
      transport: applyTransport,
    });
  }

  if (parsed.command.kind === "capsule") {
    const client = createReadClient(parsed.command.socketPath);

    if (parsed.command.action === "list") {
      return runCapsuleListCommand({ client });
    }

    const registry = await readJsonInput(parsed.command.registryPath);
    if (!registry.ok) return registry.result;

    if (parsed.command.action === "preview") {
      return runCapsulePreviewCommand(registry.value, { client });
    }

    const applyTransport = createApplyNodeTransport(
      createApplyTransport(socketOptions(parsed.command.socketPath)),
    );
    return runCapsuleInstallCommand(registry.value, {
      client,
      commit: parsed.command.commit,
      transport: applyTransport,
    });
  }

  const client = createReadClient(parsed.command.socketPath);
  return parsed.command.capability === undefined
    ? runStateCommand({ client })
    : runStateCommand({
        capability: parsed.command.capability,
        client,
      });
}

function createReadClient(socketPath: string | undefined) {
  return createAgentClientForTransport(createAgentdTransport(socketOptions(socketPath)));
}

function socketOptions(socketPath: string | undefined): NodeUnixSocketTransportOptions {
  return socketPath === undefined ? {} : { socketPath };
}

async function readJsonInput(
  path: string,
): Promise<
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly result: CliCommandResult;
    }
> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      result: commandFailure(`Could not read ${path}: ${errorMessage(error)}`),
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text) as unknown,
    };
  } catch (error) {
    return {
      ok: false,
      result: commandFailure(`Invalid JSON in ${path}: ${errorMessage(error)}`),
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "unknown error";
}

async function main(): Promise<void> {
  const result = await runVita(process.argv.slice(2));

  if (result.stdout !== "") {
    process.stdout.write(`${result.stdout}\n`);
  }
  if (result.stderr !== "") {
    process.stderr.write(`${result.stderr}\n`);
  }

  process.exitCode = result.exitCode;
}

function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }

  return fileURLToPath(metaUrl) === resolve(argv1);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}

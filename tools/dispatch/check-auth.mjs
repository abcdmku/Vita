// Reports whether a GPT-5.5 worker can actually run (Codex auth present).
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export function workerAuth() {
  if (process.env.OPENAI_API_KEY) return { ok: true, via: "OPENAI_API_KEY" };
  const codexHome = process.env.CODEX_HOME || join(os.homedir(), ".codex");
  if (existsSync(join(codexHome, "auth.json"))) return { ok: true, via: "codex login" };
  return { ok: false };
}

export const AUTH_HELP = [
  "No worker credentials — GPT-5.5 cannot run. Set one of:",
  '  PowerShell:  $env:OPENAI_API_KEY = "sk-..."',
  '  bash:        export OPENAI_API_KEY=sk-...',
  "  or run:      codex login",
].join("\n");

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-auth.mjs")) {
  const a = workerAuth();
  if (a.ok) {
    console.log(`worker auth OK (via ${a.via})`);
    process.exit(0);
  }
  console.error(AUTH_HELP);
  process.exit(1);
}

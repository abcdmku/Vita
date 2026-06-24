# Vita Developer CLI

`vita` is the unprivileged host-side CLI for the Vita control plane. It evaluates JSON node-config documents locally and talks to `agentd` over the configured Unix socket for read, preview, and gated apply operations.

## Usage

```sh
vita evaluate <config.json> [--json]
vita preview <config.json> [--socket <path>]
vita apply <config.json> [--commit] [--socket <path>]
vita capsule list [--socket <path>]
vita capsule preview <capsule.json> [--socket <path>]
vita capsule install <capsule.json> [--commit] [--socket <path>]
vita state [<capability>] [--socket <path>]
```

The default socket path is `/run/vita-agent/agentd.sock`.

`evaluate` is pure and offline. `preview`, `capsule list`, `capsule preview`, and `state` are read-only. `apply` and `capsule install` only mutate when `--commit` is present; otherwise they perform a dry-run preview and make no `/apply` request.

Config input is JSON, not a TypeScript module. Capsule registry input is a JSON registry array; an object with a single `capsules` field is also accepted for convenience.

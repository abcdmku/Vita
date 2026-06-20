# Vita — TypeScript-First Personal Node OS (codename *Project Node*)

A TypeScript-first personal-data and self-hosting operating environment on a hardened Linux
substrate, delivered across x86-64 PCs, Raspberry Pi 5, and AI systems. See the full product and
build specification: [typescript_personal_node_os_build_spec.md](typescript_personal_node_os_build_spec.md).

## How this repo is built

This is an **AI-native** monorepo. Work flows through an *AI factory*: a human (you) approves
objectives; **Claude Code** acts as orchestrator/architect/reviewer; **GPT-5.5 (xhigh)** grunt
workers implement task contracts via the OpenAI Codex CLI. Read the governance docs before
contributing anything:

- [CLAUDE.md](CLAUDE.md) — orchestrator playbook (Claude Code's contract)
- [AGENTS.md](AGENTS.md) — worker playbook (read automatically by Codex / GPT-5.5)
- [ai-factory/README.md](ai-factory/README.md) — the build loop, task contracts, risk classes

## Quick start (factory operator)

```bash
# 1. Workers run on GPT-5.5 via Codex. Provide credentials once:
#    either an API key …
export OPENAI_API_KEY=sk-...           # PowerShell: $env:OPENAI_API_KEY="sk-..."
#    … or an interactive login:
codex login

# 2. See what's ready to build
npm run ready

# 3. Dispatch one task contract to a worker
npm run dispatch -- P0-001
```

## Layout

Top-level directories follow spec §19. The product code (`os/`, `agent/`, `runtime/`,
`controller/`, `sdk/`, …) is built incrementally by the loop. `ai-factory/` holds the governance,
task queue, and process that produces it. `tools/` holds the dispatch + loop machinery.

## Build environment

Portable-first. The SDK, controller, Go-agent source, schemas, governance, and tests build on any
host. Linux-only OS image work (UKI/RAUC/dm-verity/QEMU boot) is deferred until a Linux host is
available and runs via Docker. See [architecture/adr/0001-build-environment.md](architecture/adr).

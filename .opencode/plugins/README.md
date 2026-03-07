# OpenCode Plugins

This directory contains project-local OpenCode plugins loaded automatically at startup.

## `medsci-guardrails.ts`

Purpose:
- Blocks reading sensitive `.env` files through the `read` tool (allows `.env.example`).
- Logs tool execution telemetry (`tool`, `session_id`, `duration_ms`, `failed`) via `client.app.log()`.
- Tags ACE calls with `ace_tool` and `ace_learning_write` fields for adaptation audit trails.
- Triggers guarded automatic post-run learning by dispatching `/ace-learn` when session evidence is strong enough.

Hooks implemented:
- `tool.execute.before`
- `tool.execute.after`

## Notes

- Plugin runtime dependency is declared in `.opencode/package.json` (`@opencode-ai/plugin`).
- Keep plugin logic deterministic and lightweight to avoid adding latency to normal tool calls.

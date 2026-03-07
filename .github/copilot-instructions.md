# Project Guidelines

## Code Style

- **Biome defaults**: tabs, double quotes, semicolons, trailing commas — no config file, just `bun run lint:fix`
- **Named exports only** — no default exports anywhere. Barrel `index.ts` re-exports per `tools/` directory
- **File names**: `kebab-case.ts`. **Tool names**: `snake_case` strings (`"search_chembl"`). **Exports**: `camelCase` (`searchChembl`)
- **Type imports**: always use `import type { X }` for type-only imports
- **Zod schemas**: add `.describe()` on every field — MCP SDK passes these to the LLM as parameter documentation
- Exemplar tool: [packages/server-drug/src/tools/search-chembl.ts](packages/server-drug/src/tools/search-chembl.ts)

## Architecture

Bun monorepo — 6 MCP servers in `packages/server-*` sharing `@medsci/core` (`workspace:*`). No build step; Bun runs `.ts` directly. stdout is **reserved for MCP stdio JSON transport** — all logging goes to stderr via `ctx.log`.

**Adding a tool**: call `defineTool()` from `@medsci/core` ([packages/core/src/tool-factory.ts](packages/core/src/tool-factory.ts)) with `{ name, description, schema, execute }`. The wrapper provides Zod validation, structured errors, timing, and logging. Return `ToolResult<T>`: `{ success, data?, error?, duration_ms? }`.

**Adding a server**: 3-line `index.ts` — import tools, call `createMcpServer({ name, version, tools })` ([packages/core/src/server-factory.ts](packages/core/src/server-factory.ts)). Register the server in `opencode.json` and root `package.json` scripts.

**MedGemma interpretation**: call `interpretWithMedGemma(ctx, data, prompt)` ([packages/core/src/interpret.ts](packages/core/src/interpret.ts)). Always return raw data alongside — if LLM fails, tool still succeeds with `model_used: false`.

**Python sidecar**: `ctx.python.call("namespace.method", args)` sends JSON-RPC to a long-running Python process ([packages/core/python/sidecar.py](packages/core/python/sidecar.py)). Register new handlers with `@handler("namespace.method")` decorator.

**Critical constraint**: Ollama runs locally — tool calls must be sequential. Parallel MCP calls to the same Ollama instance cause timeouts.

## Build and Test

```bash
bun install                   # Install deps (workspaces auto-linked)
bun test --recursive          # All tests
bun test packages/core        # One package
bun run typecheck             # tsc --noEmit
bun run lint                  # biome check .
bun run lint:fix              # biome check --fix .
bun run server:drug           # Run a server (also: :omics, :protein, :imaging, :literature, :paperqa)
```

## Testing Conventions

Tests live in `packages/*/src/__tests__/*.test.ts`. Use `createMockContext()` from `@medsci/core` ([packages/core/src/__tests__/test-helpers.ts](packages/core/src/__tests__/test-helpers.ts)) — it provides mocked `ollama`, `python`, and `log`. Mock external HTTP with `globalThis.fetch = mock(...)` and restore in `afterEach`. Test both success paths and graceful degradation (LLM failure should not fail the tool).

## Project Conventions

- **Config is env-driven**: `MEDSCI_PROFILE` (`lite`/`standard`/`full`), `MEDSCI_OLLAMA_URL`, `MEDSCI_PYTHON` — see [packages/core/src/config.ts](packages/core/src/config.ts)
- **Structured errors from sidecar**: use `getSidecarErrorEnvelope()` / `mapSidecarError()` from [packages/core/src/sidecar-errors.ts](packages/core/src/sidecar-errors.ts)
- **HTTP calls**: use `fetch()` with `AbortSignal.timeout(15_000)` for external APIs
- **PaperQA** is special: separate Python sidecar with its own venv (`.venv-paperqa/`) and 600s timeout

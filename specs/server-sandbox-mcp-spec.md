# MCP Sandbox Server Spec (DockerSandboxBackend Only)

## 1) Purpose

Add a new MCP server (`@medsci/server-sandbox`) that enables isolated, heavyweight, exploratory code execution for tasks beyond existing domain tools.

This is an **extension** to the current architecture, not a replacement:
- Existing `packages/server-*` tools remain unchanged.
- Orchestrator still uses MCP as the single control plane.
- New sandbox capabilities are exposed as MCP tools.

## 2) Scope and Non-Goals

### In Scope
- New package: `packages/server-sandbox`.
- Single backend only: `DockerSandboxBackend`.
- Programmatic sandbox lifecycle + command execution via Docker Sandboxes CLI.
- Structured outputs for logs, status, and artifacts.
- Policy controls (timeouts, network policy, limits, safe paths).

### Out of Scope
- No cloud backend.
- No plain Docker fallback backend.
- No changes to existing domain server logic.
- No parallel Ollama orchestration changes.

## 3) Findings and Constraints

### Repository Patterns (must follow)
- Named exports only; no default exports.
- Tool factory pattern via `defineTool()` from `@medsci/core`.
- File naming: kebab-case.
- Tool name strings: snake_case.
- Zod fields must include `.describe()`.
- Server entrypoint is minimal `createMcpServer({ name, version, tools })`.

### Docker Sandboxes CLI (verified)
Available commands:
- `docker sandbox create`
- `docker sandbox exec`
- `docker sandbox ls --json`
- `docker sandbox stop`
- `docker sandbox rm`
- `docker sandbox network proxy`

Observed output shape:
- `docker sandbox ls --json` returns JSON object with `sandboxes` array (example: `{ "sandboxes": [] }`).

Network policy controls:
- `docker sandbox network proxy <sandbox> --policy allow|deny`
- Host allow/block via repeated `--allow-host`, `--block-host`

Important:
- `run` is agent/TUI oriented and not required for programmatic execution path.
- Use `create` + `exec` as the primary non-interactive flow.

## 4) Target Architecture

### New Package
`packages/server-sandbox/`

Planned structure:
- `src/index.ts`
- `src/tools/index.ts`
- `src/tools/sandbox-prepare.ts`
- `src/tools/sandbox-run-job.ts`
- `src/tools/sandbox-status.ts`
- `src/tools/sandbox-fetch-artifact.ts`
- `src/tools/sandbox-teardown.ts`
- `src/backend/docker-sandbox-backend.ts`
- `src/backend/types.ts`
- `src/backend/command.ts`
- `src/__tests__/tools.test.ts`
- `src/__tests__/backend.test.ts`

### Runtime Model
- MCP tool receives request.
- Tool calls backend adapter (`DockerSandboxBackend`).
- Backend issues Docker Sandbox CLI commands.
- Tool returns structured `ToolResult` with execution metadata.

### Sandbox Identity
- Deterministic default name: `medsci-{profile}-{workspaceHash}`.
- Optional explicit sandbox name in requests.
- Reuse existing sandbox if present; idempotent prepare.

## 5) MCP Tools Contract

All tools use `defineTool()` and return `ToolResult`.

---

### 5.1 `sandbox_prepare`

#### Description
Create or verify a sandbox for the workspace, optionally apply template and network policy.

#### Input
```ts
{
  workspace_path: string;               // absolute host path
  sandbox_name?: string;               // optional explicit name
  template?: string;                   // docker image template
  pull_template?: "missing" | "always" | "never";
  extra_workspaces?: Array<{
    path: string;
    read_only?: boolean;
  }>;
  network_policy?: "deny" | "allow";
  allow_hosts?: string[];              // only for allowlist policy
}
```

#### Output
```ts
{
  sandbox_name: string;
  created: boolean;                    // false when already exists
  workspace_path: string;
  status: "running" | "stopped" | "unknown";
  template?: string;
  network_policy?: "deny" | "allow";
}
```

#### Command Mapping
- Existence check: `docker sandbox ls --json`
- Create (if missing):
  - `docker sandbox create [--name NAME] [--pull-template POLICY] [-t TEMPLATE] opencode WORKSPACE [EXTRA_WORKSPACE...]`
- Network:
  - `docker sandbox network proxy NAME --policy deny|allow [--allow-host HOST ...]`

---

### 5.2 `sandbox_run_job`

#### Description
Execute generated code or command in an existing sandbox and capture runtime outputs.

#### Input
```ts
{
  sandbox_name: string;
  job_id?: string;
  command: string;                     // explicit command to run
  workdir?: string;                    // path inside sandbox
  env?: Record<string, string>;
  timeout_sec?: number;                // hard timeout at tool layer
  expected_artifacts?: string[];       // glob-like paths (tool-level metadata)
  artifact_root?: string;              // default: <workspace>/sandbox-artifacts
}
```

#### Output
```ts
{
  sandbox_name: string;
  job_id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  artifacts: Array<{
    path: string;
    exists: boolean;
    size_bytes?: number;
  }>;
}
```

#### Command Mapping
- Run command:
  - `docker sandbox exec [--workdir DIR] [-e K=V ...] SANDBOX /bin/sh -lc "<command>"`
- Collect outputs by backend wrapper command that writes:
  - `<artifact_root>/<job_id>/stdout.log`
  - `<artifact_root>/<job_id>/stderr.log`
  - `<artifact_root>/<job_id>/metadata.json`

#### Notes
- Use a backend wrapper so timeout and exit code are deterministic.
- No detached mode in initial version.
- Synchronous execution only in v1.

---

### 5.3 `sandbox_status`

#### Description
Return high-level sandbox state.

#### Input
```ts
{
  sandbox_name: string;
}
```

#### Output
```ts
{
  sandbox_name: string;
  exists: boolean;
  status: "running" | "stopped" | "unknown";
}
```

#### Command Mapping
- `docker sandbox ls --json` and parse by sandbox name.

---

### 5.4 `sandbox_fetch_artifact`

#### Description
Read a generated artifact/log from host-visible workspace path.

#### Input
```ts
{
  sandbox_name: string;
  artifact_path: string;               // absolute or workspace-relative
  encoding?: "utf8" | "base64";
  max_bytes?: number;                  // safety cap
}
```

#### Output
```ts
{
  sandbox_name: string;
  artifact_path: string;
  size_bytes: number;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
}
```

#### Behavior
- Validate artifact path is under allowed roots.
- Enforce `max_bytes` cap and mark `truncated`.

---

### 5.5 `sandbox_teardown`

#### Description
Stop or remove a sandbox.

#### Input
```ts
{
  sandbox_name: string;
  remove?: boolean;                    // false => stop only
}
```

#### Output
```ts
{
  sandbox_name: string;
  removed: boolean;
  stopped: boolean;
}
```

#### Command Mapping
- Stop: `docker sandbox stop SANDBOX`
- Remove: `docker sandbox rm SANDBOX`

## 6) Backend Interface (internal)

```ts
export interface SandboxBackend {
  prepare(input: PrepareInput): Promise<PrepareResult>;
  runJob(input: RunJobInput): Promise<RunJobResult>;
  status(input: StatusInput): Promise<StatusResult>;
  fetchArtifact(input: FetchArtifactInput): Promise<FetchArtifactResult>;
  teardown(input: TeardownInput): Promise<TeardownResult>;
}
```

`DockerSandboxBackend` is the only implementation in v1.

## 7) Policy and Safety Defaults

Defaults (v1):
- Network policy default: `deny`.
- `timeout_sec` default: `600`, max: `3600`.
- `stdout`/`stderr` max return size: 1 MB each (full logs saved to files).
- `max_bytes` for artifact fetch default: 1 MB, max: 10 MB.
- Artifact path allowlist: workspace root + configured artifact root only.
- Reject path traversal (`..`) after normalization.

## 8) Error Model

Tool errors must be explicit and actionable:
- `SANDBOX_NOT_FOUND`
- `SANDBOX_CREATE_FAILED`
- `SANDBOX_EXEC_FAILED`
- `SANDBOX_TIMEOUT`
- `SANDBOX_NETWORK_POLICY_FAILED`
- `ARTIFACT_NOT_FOUND`
- `ARTIFACT_PATH_FORBIDDEN`
- `ARTIFACT_TOO_LARGE`
- `CLI_UNAVAILABLE`

For each failure return:
```ts
{ success: false, error: string }
```
with user-readable message including command stage.

## 9) Observability

Each tool logs via `ctx.log` (stderr only):
- start + key parameters (redact env secrets)
- docker command executed (with safe redaction)
- completion status + duration
- failure stage + stderr snippet

All commands should include timing capture for postmortem.

## 10) Configuration

Introduce optional env vars (server-sandbox only):
- `MEDSCI_SANDBOX_DEFAULT_TEMPLATE`
- `MEDSCI_SANDBOX_PULL_TEMPLATE` (`missing` default)
- `MEDSCI_SANDBOX_ARTIFACT_ROOT` (default `sandbox-artifacts` under workspace)
- `MEDSCI_SANDBOX_DEFAULT_TIMEOUT_SEC` (default `600`)
- `MEDSCI_SANDBOX_MAX_TIMEOUT_SEC` (default `3600`)

If absent, use safe defaults.

## 11) Integration with Existing Repo

### Add package
- `packages/server-sandbox` with same package conventions as other servers.

### Update root `package.json`
- Add script:
  - `server:sandbox`: `bun run packages/server-sandbox/src/index.ts`

### Update `opencode.json`
- Add local MCP entry `medsci-sandbox`:
  - command: `bun run packages/server-sandbox/src/index.ts`
  - timeout: `300000` or `600000` (recommend 600000)
  - environment includes optional sandbox env vars

## 12) Testing Plan

### Unit Tests
- Backend command builder correctness:
  - create args with template/pull policy
  - network proxy args with allow hosts
  - exec args with env/workdir
- `ls --json` parser with empty and populated shapes
- timeout behavior in `runJob`
- artifact path normalization and traversal rejection

### Tool Tests
- Validation failures for all tools (missing required fields, invalid enums)
- Success path using mocked command runner
- Failure mapping to explicit error messages

### Optional Integration Test (local/dev)
- Guarded by env flag (e.g., `MEDSCI_SANDBOX_E2E=1`)
- Runs prepare → run_job (`echo ok`) → fetch_artifact → teardown

## 13) Implementation Sequence (Agent Task Plan)

1. Scaffold `packages/server-sandbox` package + tsconfig + index + tools barrel.
2. Implement backend types and command runner utility.
3. Implement `DockerSandboxBackend` with command mappings.
4. Implement all 5 MCP tools with Zod schemas and `.describe()` fields.
5. Add root wiring (`package.json`, `opencode.json`).
6. Add tests (backend + tools).
7. Run validation:
   - `bun run typecheck`
   - `bun test packages/server-sandbox`
   - optional `bun run lint`
8. Document quick usage example in server README (if requested).

## 14) Acceptance Criteria

- New MCP server starts successfully via `bun run packages/server-sandbox/src/index.ts`.
- All 5 tools are discoverable and executable.
- `sandbox_prepare` is idempotent.
- `sandbox_run_job` returns deterministic exit code, logs, and duration.
- `sandbox_fetch_artifact` enforces path and size constraints.
- `sandbox_teardown` supports stop and remove modes.
- Unit tests pass for new package.

## 15) Known Open Questions

1. JSON shape details from `docker sandbox ls --json` for non-empty state should be captured during implementation and parser updated accordingly.
2. Exact status semantics (`running` vs `stopped`) may require one additional CLI probe if `ls` fields are insufficient.
3. Whether to add async job mode (`--detach`) is deferred to v2.

## 16) Example Orchestrator Decision Rule (non-binding)

Escalate to sandbox when any are true:
- requested task cannot be served by available domain tools,
- task requires custom code synthesis + execution,
- task requires long-running/high-dependency experiments.

Otherwise prefer existing domain MCP tools first.

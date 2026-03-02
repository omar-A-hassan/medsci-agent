---
name: sandbox-execution
description: "Isolated exploratory code execution with medsci-sandbox tools. Use when analysis requires custom code beyond existing domain MCP tools."
---

# Sandbox Execution

## When to Use
- Domain MCP tools cannot directly perform the requested analysis
- Task requires generated/custom code execution
- Long-running exploratory workflows need isolation

## Standard Workflow (Sequential)

```
1. Prepare sandbox  → sandbox_prepare(workspace_path, network_policy="deny")
2. Run command      → sandbox_run_job(sandbox_name, command, timeout_sec)
3. Check status     → sandbox_status(sandbox_name) [optional]
4. Fetch outputs    → sandbox_fetch_artifact(sandbox_name, artifact_path)
5. Teardown         → sandbox_teardown(sandbox_name, remove=true|false)
```

## Defaults and Guardrails
- Default network policy: `deny`
- Use explicit `timeout_sec` on every run job
- Retrieve only required artifacts/logs
- Prefer removing sandbox after one-off jobs (`remove=true`)

## Failure Handling
- `SANDBOX_TIMEOUT`: reduce scope or increase timeout
- `CLI_UNAVAILABLE`: verify Docker + Docker Sandbox CLI installed
- `SANDBOX_CREATE_FAILED`: check Docker Desktop status and template availability
- `ARTIFACT_PATH_FORBIDDEN`: use safe paths under workspace/artifact roots only
- `ARTIFACT_NOT_FOUND`: verify command produced expected files before fetch

## Notes
- Keep tool calls sequential to avoid local contention.
- Return raw execution outputs even if interpretation models are unavailable.

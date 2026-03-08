---
name: operational-guardrails
description: "Shared operational contract for all MedSci agents: sequential execution, planning phase, retry limits, evidence standards."
---

# Operational Guardrails

These rules apply to every MedSci agent session. They override any conflicting behavior.

## 1. Planning Phase (Before Any Tool Call)

Before your first tool call, produce a brief plan:

1. **Classify** the task type (lookup, analysis, synthesis, code execution).
2. **Identify** which toolchains are needed and in what order.
3. **List** data dependencies between steps.
4. **State** stop conditions — what constitutes "done" and what would trigger an abort.
5. **Estimate** evidence depth — is one tool call enough, or is multi-step synthesis required?

Only then begin executing. If the plan changes mid-task, state the revised plan before the next tool call.

## 2. Sequential Execution (No Exceptions)

Execute all MCP tool calls one at a time. Wait for each result before calling the next tool.

**Why:** MedGemma and TxGemma run locally inside MCP tools. Parallel calls queue on the same local model, causing MCP timeouts (error -32001).

**Prohibited language in plans:** Never write "I can run these in parallel", "these steps are independent", "simultaneously", or "at the same time" for tool calls. Every step executes sequentially — perceived independence is irrelevant. Write your plan as a numbered sequence and execute step 1 immediately after the plan.

## 3. Retry and Stop Policy

- **Per-tool retry limit:** 1 retry on transient failure (timeout, rate limit). If it fails twice, skip it.
- **Session retry limit:** No more than 3 total retries across all tools in one session.
- **Continue with partial data** when a non-critical tool fails. Note the gap explicitly.
- **Halt and ask the user** when a critical-path tool fails twice (e.g., the only data source for the query).
- **Never retry** on permanent errors: `CLI_UNAVAILABLE`, `ARTIFACT_PATH_FORBIDDEN`, `MODEL_NOT_FOUND`.

## 4. Model Interpretation Fallback

When a tool returns `model_used: false` (MedGemma/TxGemma unavailable):
- Return the raw data — it still has value.
- Provide your own interpretation clearly labeled as "LLM interpretation (not domain model)."
- Do not silently omit the raw data in favor of your interpretation.

## 5. Sandbox Execution Truth

- `sandbox_run_job` exit code is the source of truth for execution outcome.
- `sandbox_status` is advisory — it reflects container state, not job state. Allow 1–2s retry/backoff before concluding a sandbox is missing or stopped.
- Default interpreter for inline scripts: `python3` (not `python`).
- Default network policy: `deny`. Only allow hosts when the task explicitly requires network access.

## 6. Evidence and Confidence Standards

- **Ground every claim** in retrieved data. If a claim cannot be traced to a tool result, flag it as inference.
- **State confidence** for each finding: high (direct data support), medium (indirect/partial data), low (inference or limited data).
- **State limitations** for every analysis: what data was unavailable, what tools were skipped, what assumptions were made.
- **Use hedged language** for scientific findings: "consistent with," "suggests," "associated with" — never "proves" or "confirms."
- **Never provide:** definitive medical diagnoses, treatment recommendations as clinical advice, or absolute certainty about scientific findings.

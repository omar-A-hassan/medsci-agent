---
description: Learn from the latest completed task using ACE post-run feedback (gated; used by auto-hook and manual fallback)
agent: ace
---

Use ACE MCP to perform controlled post-run learning for this completed task.

Task context (JSON-encoded):
$ARGUMENTS

Parse `$ARGUMENTS` as a JSON object. It contains exactly three fields:
- `question` — the user's task description
- `answer` — the medsci agent's final response
- `telemetry` — execution telemetry (tool_calls, failures, last_tool, etc.)

Example: `{"question":"Find KRAS inhibitors","answer":"Found 3 hits...","telemetry":"tool_calls=8 | failures=0 | ..."}`

Extract these three values before calling any tools.

Workflow (strictly sequential — wait for each result before the next step):

**Step 1 — Load prior skillbook**
Call `ace.skillbook.load` with:
- session_id: "medsci:multidomain"
- path: ".opencode/ace/skillbooks/medsci_multidomain.json"

If the file does not exist yet, the load will fail — that is expected on first run. Continue to Step 2.

**Step 2 — Assess evidence quality**
Before calling ace.learn.feedback, assess:
- Is there a real question and answer (not the "(unknown)" placeholder)?
- Were at least 2 domain tool calls made (from telemetry)?
- Is the outcome meaningful (partial success, failure, or clear success)?

If evidence is too weak (e.g. question is placeholder AND no failures), skip Steps 3–4 and explain why.

**Step 3 — Learn from feedback**
Call `ace.learn.feedback` with:
- session_id: "medsci:multidomain"
- question: <extracted question — the user's actual scientific task>
- answer: <extracted answer — what the medsci agent actually did and concluded>
- context: "MedSci multi-domain scientific research agent: drug discovery, protein structure, literature synthesis, omics analysis"
- feedback: <telemetry field — failures, tool outcomes, what succeeded or failed>

The Reflector will analyze what worked and what failed. The SkillManager will generate atomic imperative strategy updates (ADD/UPDATE/TAG/REMOVE). Skills must be concrete and actionable — e.g. "Use search_type='molecule' not 'target' for ChEMBL inhibitor queries."

**Step 4 — Persist**
Call `ace.skillbook.save` with:
- session_id: "medsci:multidomain"
- path: ".opencode/ace/skillbooks/medsci_multidomain.json"

**Step 5 — Report delta**
Call `ace.skillbook.get` with session_id: "medsci:multidomain", limit: 5.
Report:
- Skills before / after counts
- Top new or updated skills
- Any stale/harmful skills flagged for future removal

Rules:
- Do not invent outcomes or feedback.
- Skip Steps 3–4 if evidence quality is too weak; explain why.
- Keep feedback specific, testable, and tied to observed tool behavior.
- Strategies must be imperative commands under 15 words (e.g. "Retry ChEMBL with synonym if target search returns no compounds").

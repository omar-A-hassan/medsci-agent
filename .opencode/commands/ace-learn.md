---
description: Learn from the latest completed task using ACE post-run feedback (gated; used by auto-hook and manual fallback)
agent: medsci
---

Use ACE MCP to perform controlled post-run learning for this completed task:

Task context:
$ARGUMENTS

Workflow (sequential):
1. Summarize the final task outcome (success/failure, key limitations, confidence).
2. Extract one concrete strategy that improved results and one concrete failure mode to avoid.
3. Call `ace.learn.feedback` with high-signal feedback grounded in actual tool outputs.
4. Call `ace.skillbook.save` to `.opencode/ace/skillbooks/medsci_multidomain.json`.
5. Call `ace.skillbook.get` (limit 5) and report skillbook delta.

Rules:
- Do not invent outcomes or feedback.
- Skip learning if evidence quality is too weak; explain why.
- Keep feedback specific, testable, and tied to observed tool behavior.

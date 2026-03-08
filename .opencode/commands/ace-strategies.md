---
description: Inspect ACE skillbook strategies for a MedSci domain session
agent: ace
---

Inspect ACE strategies for this session/domain:
$ARGUMENTS

Workflow (sequential):
1. Determine session_id from argument (default `medsci:multidomain`).
2. Call `ace.skillbook.get` with `limit=20`.
3. Return:
   - skillbook stats
   - top strategies grouped by topic
   - any stale/low-signal patterns to prune in future updates

Do not call `ace.learn.*` in this command.

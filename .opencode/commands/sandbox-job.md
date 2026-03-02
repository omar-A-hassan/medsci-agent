---
description: Execute one isolated sandbox job with artifacts and teardown
agent: medsci
---

Run this through medsci-sandbox with sequential steps:

Command:
$ARGUMENTS

Command defaults:
- For inline scripts, prefer `python3 -c "..."` over `python -c "..."`.

Workflow:
1) sandbox_prepare with default network_policy=deny
2) sandbox_run_job with explicit timeout
3) sandbox_status only as advisory check (retry/backoff 1-2s before final conclusion)
4) sandbox_fetch_artifact for logs/output
5) sandbox_teardown remove=true unless user requested persistence

Return:
- command executed
- exit status
- key stdout/stderr summary
- artifact paths
- any safety/timeout issues

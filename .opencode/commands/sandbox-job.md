---
description: Execute one isolated sandbox job with artifacts and teardown
agent: medsci
---

Run this through medsci-sandbox with sequential steps:

Command:
$ARGUMENTS

Workflow:
1) sandbox_prepare with default network_policy=deny
2) sandbox_run_job with explicit timeout
3) sandbox_fetch_artifact for logs/output
4) sandbox_teardown remove=true unless user requested persistence

Return:
- command executed
- exit status
- key stdout/stderr summary
- artifact paths
- any safety/timeout issues

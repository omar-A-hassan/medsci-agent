---
description: Triage a biomedical request and select the minimal sequential MCP workflow
agent: medsci
---

Triage this request and produce:
1) Intent classification (omics, drug, protein, imaging, literature, paperqa, sandbox)
2) Minimal sequential tool plan (no parallel calls)
3) Required inputs/data dependencies
4) Route confidence (high/medium/low) with one-line justification
5) First tool call to execute now with explicit rationale

User request:
$ARGUMENTS

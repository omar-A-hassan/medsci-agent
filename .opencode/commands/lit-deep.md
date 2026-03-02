---
description: Run deep literature workflow (discovery then PaperQA synthesis)
agent: medsci
---

Execute a two-phase literature workflow for the question below.

Question:
$ARGUMENTS

Requirements:
- Phase 1 discovery using literature tools first.
- Use `needs_synthesized_summary=false` during discovery.
- Collect top candidate papers with DOI/PMID metadata.
- Phase 2 deep synthesis with PaperQA.
- Respect strict limit: never pass more than 10 papers per PaperQA call.
- If more than 10, batch sequentially and provide merged synthesis.

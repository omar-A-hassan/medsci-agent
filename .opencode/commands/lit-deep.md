---
description: Run deep literature workflow (discovery, acquisition, then PaperQA synthesis)
agent: medsci
---

Execute a three-phase literature workflow for the question below.

Question:
$ARGUMENTS

Requirements:
- Phase 1 discovery using literature tools first.
- Use `needs_synthesized_summary=false` during discovery.
- Collect top candidate papers with DOI/PMID metadata.
- Phase 2 acquisition via `medsci-acquisition` (`resolve_identifier_to_sources`, `acquire_documents`) and keep `content_level` metadata.
- Phase 3 deep synthesis with PaperQA using acquired `documents` when available; fall back to `papers` identifiers only when acquisition fails.
- Respect strict limit: never pass more than 10 papers per PaperQA call.
- If more than 10, batch sequentially and provide merged synthesis.

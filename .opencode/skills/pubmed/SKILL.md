---
name: pubmed
description: "PubMed biomedical literature search. Use for finding papers, clinical evidence, and research."
---

# PubMed — Biomedical Literature Search

## When to Use
- Finding research papers on a biomedical topic
- Retrieving abstracts for specific PMIDs
- Building evidence for target validation or drug repositioning
- Reviewing clinical evidence for a disease or treatment

## Available Tools
- `search_pubmed(query)` — Search with Boolean/MeSH support
- `fetch_abstract(pmid)` — Get full abstract and MeSH terms

## Search Tips
- Use MeSH terms for precise results: `"Breast Neoplasms"[MeSH]`
- Boolean operators: `cancer AND immunotherapy NOT review`
- Field tags: `[Title]`, `[Author]`, `[Journal]`
- Date ranges: `"2024/01/01"[Date - Publication] : "2024/12/31"[Date - Publication]`

## Search Strategies
- **Broad search**: Use general terms, sort by relevance
- **Focused search**: Combine MeSH terms with Boolean AND
- **Clinical evidence**: Add `randomized controlled trial[pt]` or `meta-analysis[pt]`
- **Recent advances**: Sort by date, limit to last 2 years

## Complementary Tools
- Use `search_openalex` for broader cross-disciplinary search
- Use `search_clinical_trials` for active/completed trials

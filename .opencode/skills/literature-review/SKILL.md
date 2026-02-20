---
name: literature-review
description: Systematic literature review methodology, search strategy, and PRISMA reporting
---

# Systematic Literature Review

## Overview
A systematic review follows a structured, reproducible methodology to identify, evaluate, and synthesize all relevant evidence on a research question. PRISMA (Preferred Reporting Items for Systematic Reviews and Meta-Analyses) provides the reporting standard.

## Search Strategy
1. **Define PICO**: Population, Intervention, Comparison, Outcome.
2. **Build search query**: Combine MeSH terms and free-text with Boolean operators.
3. **Select databases**: PubMed, Scopus, Web of Science, Cochrane, Embase.
4. **Document everything**: Record date, database, exact query, and result count.

### PubMed Query Example
```
("breast cancer"[MeSH] OR "breast neoplasms"[tiab])
AND ("immunotherapy"[MeSH] OR "checkpoint inhibitor"[tiab])
AND ("overall survival"[tiab] OR "progression-free survival"[tiab])
```

## Programmatic PubMed Access
```python
from Bio import Entrez
Entrez.email = "user@example.com"

handle = Entrez.esearch(db="pubmed", term="CRISPR AND cancer", retmax=100)
record = Entrez.read(handle)
pmids = record["IdList"]

handle = Entrez.efetch(db="pubmed", id=pmids[:10], rettype="xml")
records = Entrez.read(handle)
```

## PRISMA Flow
1. **Identification**: Total records from all databases.
2. **Screening**: Remove duplicates, screen titles/abstracts.
3. **Eligibility**: Full-text review against inclusion/exclusion criteria.
4. **Included**: Final studies for qualitative/quantitative synthesis.

## Key Details
- Register protocol on PROSPERO before starting.
- Use reference managers (Zotero, EndNote) for deduplication.
- Risk of bias: use Cochrane RoB 2 (RCTs) or ROBINS-I (observational).
- For meta-analysis, extract effect sizes (OR, HR, SMD) with confidence intervals.
- Report PRISMA 2020 checklist and flow diagram in final publication.
- Screening tools: Rayyan, ASReview (AI-assisted), Covidence.

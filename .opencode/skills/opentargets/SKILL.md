---
name: opentargets
description: Open Targets Platform for target-disease associations and genetic evidence
---

# Open Targets Platform

## Overview
Open Targets integrates genetics, genomics, transcriptomics, drugs, and literature to score target-disease associations. It uses evidence from GWAS, differential expression, pathways, drugs, and more.

## GraphQL API
```python
import requests
OT_URL = "https://api.platform.opentargets.org/api/v4/graphql"
query = """
query target($id: String!) {
  target(ensemblId: $id) {
    approvedSymbol
    approvedName
    associatedDiseases(page: {index: 0, size: 5}) {
      rows {
        disease { id name }
        score
        datatypeScores { componentId score }
      }
    }
  }
}
"""
r = requests.post(OT_URL, json={"query": query, "variables": {"id": "ENSG00000141510"}})
data = r.json()["data"]["target"]
```

## Search
```python
search_q = 'query search($q: String!) { search(queryString: $q, entityNames: ["target"], page: {index: 0, size: 5}) { hits { id name entity } } }'
r = requests.post(OT_URL, json={"query": search_q, "variables": {"q": "BRAF"}})
```

## Key Details
- **Association score**: 0-1 combining all evidence datatypes.
- **Datatypes**: genetic_association, somatic_mutation, known_drug, affected_pathway, literature, rna_expression, animal_model.
- **Target IDs**: Ensembl gene IDs (ENSG...). **Disease IDs**: EFO or MONDO IDs.
- No API key required; rate limit ~10 req/s.
- Use `associatedTargets` on disease nodes for reverse lookups.
- Genetics Portal provides variant-to-gene (V2G) and colocalisation data.

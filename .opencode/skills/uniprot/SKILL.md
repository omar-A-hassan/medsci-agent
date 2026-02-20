---
name: uniprot
description: UniProt protein database - accessions, annotations, and programmatic access
---

# UniProt Protein Database

## Overview
UniProt is the comprehensive resource for protein sequence and functional annotation. UniProtKB has two sections: Swiss-Prot (reviewed, curated) and TrEMBL (unreviewed, automated).

## REST API Access
```python
import requests

# Fetch a single entry
r = requests.get("https://rest.uniprot.org/uniprotkb/P04637.json")
entry = r.json()
print(entry["proteinDescription"]["recommendedName"]["fullName"]["value"])
```

## Search Queries
```python
params = {
    "query": "(gene:TP53) AND (organism_id:9606) AND (reviewed:true)",
    "format": "json",
    "size": 10,
    "fields": "accession,gene_names,protein_name,organism_name,length"
}
r = requests.get("https://rest.uniprot.org/uniprotkb/search", params=params)
results = r.json()["results"]
```

## Key Fields
- **accession**: Primary identifier (e.g., P04637 for human TP53).
- **gene_names**: Associated gene symbols.
- **features**: Domains, active sites, variants, PTMs.
- **cross-references**: Links to PDB, Pfam, GO, ChEMBL, etc.
- **sequence**: Full amino acid sequence.

## Common Query Syntax
- `gene:BRCA1` -- by gene name.
- `organism_id:9606` -- human.
- `reviewed:true` -- Swiss-Prot only.
- `ec:3.4.21.*` -- by enzyme classification.
- `keyword:kinase` -- by keyword annotation.

## Key Details
- Accession format: [OPQ][0-9][A-Z0-9]{3}[0-9] (e.g., P04637).
- Batch retrieval: POST to `/uniprotkb/accessions` with list of IDs.
- ID mapping: `https://rest.uniprot.org/idmapping/run` for cross-database mapping.

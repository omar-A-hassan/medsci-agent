---
name: pdb
description: RCSB PDB for 3D protein structures, resolution, and experimental methods
---

# RCSB Protein Data Bank (PDB)

## Overview
RCSB PDB hosts experimentally determined 3D structures of biological macromolecules solved by X-ray crystallography, cryo-EM, and NMR.

## Search API
```python
import requests

# Text search
url = "https://search.rcsb.org/rcsbsearch/v2/query"
query = {
    "query": {
        "type": "terminal",
        "service": "text",
        "parameters": {"attribute": "struct.title", "operator": "contains_words", "value": "kinase"}
    },
    "return_type": "entry"
}
r = requests.post(url, json=query)
pdb_ids = [hit["identifier"] for hit in r.json()["result_set"]]
```

## Data API
```python
# Fetch entry summary
r = requests.get("https://data.rcsb.org/rest/v1/core/entry/4HHB")
entry = r.json()

# Get polymer entities
r = requests.get("https://data.rcsb.org/rest/v1/core/polymer_entity/4HHB/1")
```

## GraphQL API
```python
query_gql = '{ entry(entry_id: "4HHB") { struct { title } rcsb_entry_info { resolution_combined } } }'
r = requests.post("https://data.rcsb.org/graphql", json={"query": query_gql})
```

## Key Details
- **resolution_combined**: In angstroms (lower is better; <2.0 is high-res).
- **experimental_method**: X-RAY DIFFRACTION, ELECTRON MICROSCOPY, SOLUTION NMR.
- PDB IDs are 4-character alphanumeric (e.g., 4HHB).
- Download: `https://files.rcsb.org/download/{PDB_ID}.cif` (or `.pdb`).
- Use Biopython `PDBParser` or `MMCIFParser` for local structure analysis.

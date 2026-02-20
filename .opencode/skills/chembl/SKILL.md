---
name: chembl
description: ChEMBL database access for bioactivity data and target search
---

# ChEMBL Database

## Overview
ChEMBL is a large-scale bioactivity database maintained by EMBL-EBI. It contains binding, functional, and ADMET data for drug-like molecules against biological targets.

## Python Client
```python
from chembl_webresource_client.new_client import new_client

molecule = new_client.molecule
activity = new_client.activity
target = new_client.target
```

### Search target by name
```python
results = target.search("cyclooxygenase-2")
for t in results:
    print(t["target_chembl_id"], t["pref_name"], t["organism"])
```

### Get bioactivity data for a target
```python
acts = activity.filter(target_chembl_id="CHEMBL220", standard_type="IC50", pchembl_value__isnull=False)
for a in acts:
    print(a["molecule_chembl_id"], a["pchembl_value"], a["canonical_smiles"])
```

### Retrieve molecule by SMILES or ChEMBL ID
```python
mol = molecule.get("CHEMBL25")  # aspirin
mol = molecule.filter(molecule_structures__canonical_smiles="CC(=O)Oc1ccccc1C(=O)O")
```

## Key Fields
- **pchembl_value**: Standardized -log10(IC50/Ki/EC50) in molar. Use this for comparisons.
- **standard_type**: IC50, Ki, EC50, Kd, etc.
- **assay_type**: B (binding), F (functional), A (ADMET).
- **target_type**: SINGLE PROTEIN, PROTEIN COMPLEX, ORGANISM, etc.

## Key Details
- Always filter on `pchembl_value__isnull=False` for comparable potency data.
- ChEMBL IDs: molecules (CHEMBL25), targets (CHEMBL220), assays (CHEMBL123456).
- Install: `pip install chembl-webresource-client`.

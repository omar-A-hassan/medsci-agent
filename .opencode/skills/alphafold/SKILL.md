---
name: alphafold
description: AlphaFold DB for predicted protein structures and pLDDT confidence scores
---

# AlphaFold Database

## Overview
AlphaFold DB (by DeepMind and EMBL-EBI) provides predicted 3D structures for over 200M proteins. Structures are predicted by AlphaFold2 and stored with per-residue confidence scores (pLDDT).

## API Access
```python
import requests

# Fetch prediction for a UniProt accession
uniprot_id = "P04637"
r = requests.get(f"https://alphafold.ebi.ac.uk/api/prediction/{uniprot_id}")
prediction = r.json()[0]

# Get model URLs
cif_url = prediction["cifUrl"]        # mmCIF format
pdb_url = prediction["pdbUrl"]        # PDB format
pae_url = prediction["paeImageUrl"]   # PAE plot image
```

## Download Structure
```python
# Direct download
pdb_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_id}-F1-model_v4.pdb"
cif_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_id}-F1-model_v4.cif"
pae_url = f"https://alphafold.ebi.ac.uk/files/AF-{uniprot_id}-F1-predicted_aligned_error_v4.json"
```

## pLDDT Confidence Score
- Stored in the B-factor column of PDB files.
- **>90**: High confidence (blue). Reliable backbone and side-chain.
- **70-90**: Confident (cyan). Good backbone prediction.
- **50-70**: Low confidence (yellow). Caution with interpretation.
- **<50**: Very low (orange). Likely disordered or uncertain.

## Predicted Aligned Error (PAE)
- Matrix of expected position error between all residue pairs.
- Low PAE between domains indicates confident relative orientation.
- High PAE between domains means they may be flexible or uncertain.

## Key Details
- One model per UniProt accession (longest isoform, up to 2700 residues).
- Structures lack ligands, cofactors, and post-translational modifications.
- Use pLDDT to filter reliable regions before docking or analysis.
- For custom sequences not in the DB, run AlphaFold2 or use ESMFold.

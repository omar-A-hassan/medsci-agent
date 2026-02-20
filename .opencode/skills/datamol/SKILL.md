---
name: datamol
description: Datamol for molecular manipulation, SMILES processing, and cheminformatics
---

# Datamol

## Overview
Datamol is a lightweight Python library built on top of RDKit that simplifies molecular manipulation. It provides a clean API for SMILES parsing, standardization, fingerprints, scaffolds, and visualization.

## Core Operations
```python
import datamol as dm

# Parse and standardize SMILES
mol = dm.to_mol("CC(=O)Oc1ccccc1C(=O)O")
std_mol = dm.standardize_mol(mol)
smiles = dm.to_smiles(std_mol, canonical=True)

# Fix and sanitize
mol = dm.to_mol("bad_smiles", ordered=True)  # returns None if invalid
fixed = dm.fix_mol(mol)
sanitized = dm.sanitize_mol(fixed)
```

## Descriptors and Fingerprints
```python
# Molecular properties
dm.descriptors.mw(mol)       # molecular weight
dm.descriptors.logp(mol)     # cLogP
dm.descriptors.tpsa(mol)     # topological polar surface area
dm.descriptors.n_hba(mol)    # H-bond acceptors
dm.descriptors.n_hbd(mol)    # H-bond donors

# Fingerprints
fp = dm.to_fp(mol, fp_type="ecfp", n_bits=2048)  # numpy array
```

## Key Details
- Scaffolds: `dm.to_scaffold_murcko(mol)`, `dm.fragment.brics(mol)`.
- All functions gracefully handle `None` inputs (return `None`).
- `dm.to_smiles` returns canonical SMILES by default.
- Batch: `dm.to_mol(["CCO", "c1ccccc1"])` accepts lists.
- Clustering: `dm.cluster.cluster_mols(mols, cutoff=0.7)`.
- Install: `pip install datamol`.

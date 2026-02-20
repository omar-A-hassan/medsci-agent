---
name: rdkit
description: "Cheminformatics with RDKit. Use for molecular analysis, drug-likeness, fingerprints, and similarity."
---

# RDKit — Cheminformatics

## When to Use
- Analyzing molecules from SMILES strings
- Computing physicochemical properties (MW, LogP, TPSA, etc.)
- Drug-likeness assessment (Lipinski, Veber, etc.)
- Molecular similarity (Tanimoto with Morgan fingerprints)
- Molecular fingerprint generation

## Available Tools
- `analyze_molecule(smiles)` — Full property profile
- `lipinski_filter(smiles)` — Rule of Five check
- `molecular_similarity(smiles1, smiles2)` — Tanimoto similarity

## SMILES Reference
SMILES (Simplified Molecular Input Line Entry System) is a line notation for molecular structures:
- `CC(=O)OC1=CC=CC=C1C(=O)O` — Aspirin
- `CC(C)CC1=CC=C(C=C1)C(C)C(=O)O` — Ibuprofen
- `CN1C=NC2=C1C(=O)N(C(=O)N2C)C` — Caffeine

## Drug-Likeness Rules
- **Lipinski's Rule of Five**: MW≤500, LogP≤5, HBD≤5, HBA≤10 (≤1 violation)
- **Veber**: RotBonds≤10, TPSA≤140
- **Lead-like**: MW 250-350, LogP -1 to 3, RotBonds≤7

## Similarity Interpretation
- Tanimoto > 0.85 — Very similar, likely same scaffold
- Tanimoto 0.7-0.85 — Similar, may share target activity
- Tanimoto 0.4-0.7 — Moderate, may share pharmacophore features
- Tanimoto < 0.4 — Dissimilar

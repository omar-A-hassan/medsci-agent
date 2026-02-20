---
name: esm
description: ESM protein language models for sequence embeddings and structure prediction
---

# ESM Protein Language Models

## Overview
ESM (Evolutionary Scale Modeling) is Meta AI's family of protein language models trained on millions of protein sequences. ESM-2 provides per-residue and per-sequence embeddings. ESMFold predicts 3D structure from sequence alone.

## Key Models
- **ESM-2**: Embedding model (8M to 15B params). Use `esm2_t33_650M_UR50D` as default.
- **ESMFold**: Single-sequence structure prediction (no MSA needed).

## Usage Patterns
```python
import torch, esm

model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
batch_converter = alphabet.get_batch_converter()
model.eval()

data = [("protein1", "MKTLLILAVL")]
batch_labels, batch_strs, batch_tokens = batch_converter(data)

with torch.no_grad():
    results = model(batch_tokens, repr_layers=[33], return_contacts=True)

embeddings = results["representations"][33]  # (batch, seq_len, 1280)
contact_map = results["contacts"]            # predicted contacts
```

## ESMFold Structure Prediction
```python
model = esm.pretrained.esmfold_v1()
model.eval()
with torch.no_grad():
    output = model.infer_pdb("MKTLLILAVL")
# output is a PDB-format string
```

## Key Details
- Input sequences use standard single-letter amino acid codes.
- Maximum sequence length ~1024 residues for ESMFold; ESM-2 handles longer.
- Embeddings from final layer are most informative for downstream tasks.
- Contact prediction uses attention maps; symmetric and valid for i-j where |i-j| >= 6.
- Install: `pip install fair-esm`.

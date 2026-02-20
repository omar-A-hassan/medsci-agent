---
name: pydeseq2
description: PyDESeq2 for differential gene expression analysis of RNA-seq count data
---

# PyDESeq2

## Overview
PyDESeq2 is a Python implementation of the DESeq2 method for differential expression analysis of RNA-seq count data. It uses negative binomial generalized linear models with shrinkage estimation.

## Typical Workflow
```python
import pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

# counts: genes x samples DataFrame of raw counts (integers, unnormalized)
# metadata: samples DataFrame with condition column
counts = pd.read_csv("counts.csv", index_col=0)
metadata = pd.read_csv("metadata.csv", index_col=0)

# Create dataset
dds = DeseqDataSet(counts=counts, metadata=metadata, design="~condition")

# Run DESeq2 pipeline (size factors, dispersion, GLM fitting)
dds.deseq2()

# Statistical testing
stat_res = DeseqStats(dds, contrast=["condition", "treated", "control"])
stat_res.summary()

# Results DataFrame
results_df = stat_res.results_df
sig = results_df[results_df["padj"] < 0.05].sort_values("log2FoldChange")
```

## Key Columns in Results
- **baseMean**: Mean normalized count across all samples.
- **log2FoldChange**: Effect size (positive = upregulated in numerator).
- **pvalue**: Raw p-value from Wald test.
- **padj**: Benjamini-Hochberg adjusted p-value.

## Key Details
- Input must be raw (unnormalized) integer counts. Do NOT use TPM/FPKM.
- Counts matrix: rows = genes, columns = samples.
- Metadata index must match counts columns.
- `contrast=["condition", "treated", "control"]` means treated vs control.
- Apply LFC shrinkage with `stat_res.lfc_shrink(coeff="condition_treated_vs_control")`.
- Filter low-count genes beforehand: keep genes with >= 10 counts in >= N samples.
- Install: `pip install pydeseq2`.

---
name: scanpy
description: "Single-cell RNA-seq analysis with Scanpy. Use when working with H5AD files, cell clustering, or differential expression."
---

# Scanpy — Single-Cell Analysis

## When to Use
- Loading and exploring .h5ad (AnnData) files
- QC, filtering, normalization of single-cell data
- Cell clustering (Leiden/Louvain)
- Differential expression between clusters or conditions
- UMAP/t-SNE dimensionality reduction

## Standard Pipeline

```
1. Read data    → read_h5ad(path)
2. QC filtering → preprocess_omics(path, min_genes=200, min_cells=3)
3. Normalize    → (included in preprocess step)
4. HVG select   → (included in preprocess step, n_top_genes=2000)
5. Cluster      → cluster_cells(path, method="leiden", resolution=1.0)
6. DE analysis  → differential_expression(path, groupby="leiden")
7. Enrichment   → gene_set_enrichment(genes=[...top DE genes])
```

## Key Parameters
- **resolution**: Controls granularity of clustering. 0.4-0.8 for broad clusters, 1.0-2.0 for fine-grained
- **min_genes**: Cells with fewer genes are likely empty droplets (default 200)
- **min_cells**: Genes in fewer cells are likely noise (default 3)
- **n_top_genes**: Highly variable genes for downstream analysis (default 2000)

## Interpreting Results
- Cluster sizes should be relatively balanced — very small clusters may be doublets
- DE genes with |log2FC| > 1 and padj < 0.05 are considered significant
- Check for batch effects before biological interpretation

#!/usr/bin/env python3
"""
MedSci Python Sidecar
=====================
Long-running process that pre-imports heavy scientific libraries and handles
JSON-RPC requests over stdin/stdout. Avoids 2-5s Python startup cost per call.

Protocol: one JSON object per line on stdin, one JSON response per line on stdout.
  Request:  {"id": "uuid", "method": "scanpy.read_h5ad", "args": {"path": "..."}}
  Response: {"id": "uuid", "result": ...} or {"id": "uuid", "error": "..."}

Special methods:
  __health__   → returns {"status": "ok"}
  __shutdown__ → graceful exit
  __list__     → returns list of available handlers
"""

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Dict

MAX_FILE_SIZE_MB = 500
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024


def _check_file_size(path: str) -> None:
    """Raise ValueError if file exceeds the size limit."""
    size = Path(path).stat().st_size
    if size > MAX_FILE_SIZE_BYTES:
        mb = size / (1024 * 1024)
        raise ValueError(f"File too large ({mb:.1f}MB). Maximum: {MAX_FILE_SIZE_MB}MB.")

# ---------------------------------------------------------------------------
# Handler registry
# ---------------------------------------------------------------------------

HANDLERS: Dict[str, Callable[..., Any]] = {}


def handler(name: str):
    """Decorator to register a sidecar handler."""
    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        HANDLERS[name] = fn
        return fn
    return decorator


# ---------------------------------------------------------------------------
# Built-in handlers
# ---------------------------------------------------------------------------

@handler("__health__")
def _health(**_: Any) -> dict:
    return {"status": "ok"}


@handler("__shutdown__")
def _shutdown(**_: Any) -> dict:
    return {"status": "shutting_down"}


@handler("__list__")
def _list(**_: Any) -> list:
    return sorted(HANDLERS.keys())


# ---------------------------------------------------------------------------
# Scanpy handlers
# ---------------------------------------------------------------------------

@handler("scanpy.read_h5ad")
def scanpy_read_h5ad(path: str, **_: Any) -> dict:
    import scanpy as sc
    _check_file_size(path)
    adata = sc.read_h5ad(path)
    return {
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "obs_columns": list(adata.obs.columns),
        "var_columns": list(adata.var.columns),
    }


@handler("scanpy.preprocess")
def scanpy_preprocess(path: str, min_genes: int = 200, min_cells: int = 3,
                      n_top_genes: int = 2000, **_: Any) -> dict:
    import scanpy as sc
    _check_file_size(path)
    adata = sc.read_h5ad(path)
    sc.pp.filter_cells(adata, min_genes=min_genes)
    sc.pp.filter_genes(adata, min_cells=min_cells)
    adata.var["mt"] = adata.var_names.str.startswith("MT-")
    sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.highly_variable_genes(adata, n_top_genes=n_top_genes)
    return {
        "n_obs_after": adata.n_obs,
        "n_vars_after": adata.n_vars,
        "n_highly_variable": int(adata.var["highly_variable"].sum()),
    }


@handler("scanpy.cluster")
def scanpy_cluster(path: str, resolution: float = 1.0,
                   method: str = "leiden", **_: Any) -> dict:
    import scanpy as sc
    _check_file_size(path)
    adata = sc.read_h5ad(path)
    sc.pp.neighbors(adata)
    sc.tl.umap(adata)
    if method == "leiden":
        sc.tl.leiden(adata, resolution=resolution)
    else:
        sc.tl.louvain(adata, resolution=resolution)
    clusters = adata.obs[method].value_counts().to_dict()
    return {
        "method": method,
        "n_clusters": len(clusters),
        "cluster_sizes": {str(k): int(v) for k, v in clusters.items()},
    }


@handler("scanpy.differential_expression")
def scanpy_de(path: str, groupby: str, method: str = "wilcoxon",
              n_genes: int = 50, **_: Any) -> dict:
    import scanpy as sc
    _check_file_size(path)
    adata = sc.read_h5ad(path)
    sc.tl.rank_genes_groups(adata, groupby=groupby, method=method, n_genes=n_genes)
    result = adata.uns["rank_genes_groups"]
    groups = list(result["names"].dtype.names)
    top_genes = {}
    for g in groups:
        top_genes[g] = [
            {
                "gene": str(result["names"][g][i]),
                "logfoldchange": float(result["logfoldchanges"][g][i]),
                "pval_adj": float(result["pvals_adj"][g][i]),
            }
            for i in range(min(10, n_genes))
        ]
    return {"groups": groups, "top_genes": top_genes}


# ---------------------------------------------------------------------------
# RDKit handlers
# ---------------------------------------------------------------------------

@handler("rdkit.mol_from_smiles")
def rdkit_mol_from_smiles(smiles: str, **_: Any) -> dict:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, rdMolDescriptors
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"valid": False, "error": "Invalid SMILES string"}
    return {
        "valid": True,
        "canonical_smiles": Chem.MolToSmiles(mol),
        "molecular_weight": round(Descriptors.MolWt(mol), 2),
        "logp": round(Descriptors.MolLogP(mol), 2),
        "hbd": Descriptors.NumHDonors(mol),
        "hba": Descriptors.NumHAcceptors(mol),
        "tpsa": round(Descriptors.TPSA(mol), 2),
        "rotatable_bonds": Descriptors.NumRotatableBonds(mol),
        "num_atoms": mol.GetNumAtoms(),
        "num_rings": rdMolDescriptors.CalcNumRings(mol),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
    }


@handler("rdkit.lipinski_filter")
def rdkit_lipinski(smiles: str, **_: Any) -> dict:
    from rdkit import Chem
    from rdkit.Chem import Descriptors
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"valid": False, "error": "Invalid SMILES"}
    mw = Descriptors.MolWt(mol)
    logp = Descriptors.MolLogP(mol)
    hbd = Descriptors.NumHDonors(mol)
    hba = Descriptors.NumHAcceptors(mol)
    violations = sum([mw > 500, logp > 5, hbd > 5, hba > 10])
    return {
        "valid": True,
        "passes": violations <= 1,
        "violations": violations,
        "mw": round(mw, 2),
        "logp": round(logp, 2),
        "hbd": hbd,
        "hba": hba,
    }


@handler("rdkit.similarity")
def rdkit_similarity(smiles1: str, smiles2: str, **_: Any) -> dict:
    from rdkit import Chem, DataStructs
    from rdkit.Chem import AllChem
    mol1 = Chem.MolFromSmiles(smiles1)
    mol2 = Chem.MolFromSmiles(smiles2)
    if mol1 is None or mol2 is None:
        return {"valid": False, "error": "One or both SMILES are invalid"}
    fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, 2, nBits=2048)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, 2, nBits=2048)
    tanimoto = DataStructs.TanimotoSimilarity(fp1, fp2)
    return {"tanimoto": round(tanimoto, 4)}


@handler("rdkit.generate_fingerprint")
def rdkit_fingerprint(smiles: str, fp_type: str = "morgan",
                      radius: int = 2, n_bits: int = 2048, **_: Any) -> dict:
    from rdkit import Chem
    from rdkit.Chem import AllChem, MACCSkeys
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"valid": False, "error": "Invalid SMILES"}
    if fp_type == "morgan":
        fp = AllChem.GetMorganFingerprintAsBitVect(mol, radius, nBits=n_bits)
    elif fp_type == "maccs":
        fp = MACCSkeys.GenMACCSKeys(mol)
    else:
        return {"error": f"Unknown fingerprint type: {fp_type}"}
    return {
        "fp_type": fp_type,
        "n_bits": fp.GetNumBits(),
        "n_on_bits": fp.GetNumOnBits(),
        "on_bits": list(fp.GetOnBits())[:50],  # truncate for transport
    }


# ---------------------------------------------------------------------------
# BioPython handlers
# ---------------------------------------------------------------------------

@handler("biopython.parse_fasta")
def biopython_parse_fasta(path: str, max_records: int = 100, **_: Any) -> dict:
    from Bio import SeqIO
    _check_file_size(path)
    records = []
    for i, record in enumerate(SeqIO.parse(path, "fasta")):
        if i >= max_records:
            break
        records.append({
            "id": record.id,
            "name": record.name,
            "description": record.description,
            "length": len(record.seq),
            "sequence_preview": str(record.seq[:100]),
        })
    return {"n_records": len(records), "records": records}


@handler("biopython.sequence_stats")
def biopython_seq_stats(sequence: str, seq_type: str = "protein", **_: Any) -> dict:
    from Bio.SeqUtils import molecular_weight
    from Bio.Seq import Seq
    from collections import Counter
    seq = Seq(sequence)
    composition = dict(Counter(str(seq)))
    result = {
        "length": len(seq),
        "composition": composition,
        "seq_type": seq_type,
    }
    try:
        mw = molecular_weight(seq, seq_type=seq_type)
        result["molecular_weight"] = round(mw, 2)
    except Exception:
        pass
    return result


@handler("biopython.translate")
def biopython_translate(sequence: str, **_: Any) -> dict:
    from Bio.Seq import Seq
    seq = Seq(sequence)
    protein = str(seq.translate())
    return {
        "dna_length": len(seq),
        "protein_length": len(protein),
        "protein_sequence": protein,
    }


# ---------------------------------------------------------------------------
# PyDESeq2 handlers
# ---------------------------------------------------------------------------

@handler("pydeseq2.run")
def pydeseq2_run(counts_path: str, metadata_path: str, design_factor: str,
                 **_: Any) -> dict:
    _check_file_size(counts_path)
    _check_file_size(metadata_path)
    import pandas as pd
    from pydeseq2.dds import DeseqDataSet
    from pydeseq2.ds import DeseqStats
    counts = pd.read_csv(counts_path, index_col=0)
    metadata = pd.read_csv(metadata_path, index_col=0)
    dds = DeseqDataSet(counts=counts, metadata=metadata,
                       design_factors=design_factor)
    dds.deseq2()
    stat_res = DeseqStats(dds)
    stat_res.summary()
    results = stat_res.results_df
    sig = results[results["padj"] < 0.05].sort_values("log2FoldChange", ascending=False)
    return {
        "n_genes_tested": len(results),
        "n_significant": len(sig),
        "top_upregulated": sig.head(20).reset_index().to_dict(orient="records"),
        "top_downregulated": sig.tail(20).reset_index().to_dict(orient="records"),
    }


# ---------------------------------------------------------------------------
# DeepChem handlers
# ---------------------------------------------------------------------------

@handler("deepchem.featurize")
def deepchem_featurize(smiles_list: list, featurizer: str = "ECFP", **_: Any) -> dict:
    import deepchem as dc
    if featurizer == "ECFP":
        feat = dc.feat.CircularFingerprint(size=2048)
    elif featurizer == "GraphConv":
        feat = dc.feat.ConvMolFeaturizer()
    else:
        return {"error": f"Unknown featurizer: {featurizer}"}
    features = feat.featurize(smiles_list)
    return {
        "n_molecules": len(smiles_list),
        "featurizer": featurizer,
        "feature_shape": list(features.shape) if hasattr(features, "shape") else len(features),
    }


# ---------------------------------------------------------------------------
# ESM (protein language model) handlers
# ---------------------------------------------------------------------------

@handler("esm.embed_sequence")
def esm_embed(sequence: str, model_name: str = "esm2_t6_8M_UR50D", **_: Any) -> dict:
    import torch
    import esm
    model, alphabet = getattr(esm, "pretrained").__dict__[model_name]()
    batch_converter = alphabet.get_batch_converter()
    model.eval()
    data = [("protein", sequence)]
    _, _, batch_tokens = batch_converter(data)
    with torch.no_grad():
        results = model(batch_tokens, repr_layers=[6])
    embedding = results["representations"][6][0, 1:len(sequence)+1].mean(0)
    return {
        "model": model_name,
        "sequence_length": len(sequence),
        "embedding_dim": embedding.shape[0],
        "embedding_preview": embedding[:10].tolist(),
    }


# ---------------------------------------------------------------------------
# Generic / utility handlers
# ---------------------------------------------------------------------------

@handler("pandas.read_csv_info")
def pandas_read_csv_info(path: str, **_: Any) -> dict:
    import pandas as pd
    _check_file_size(path)
    df = pd.read_csv(path)
    return {
        "n_rows": len(df),
        "n_columns": len(df.columns),
        "columns": list(df.columns),
        "dtypes": {c: str(d) for c, d in df.dtypes.items()},
        "preview": df.head(5).to_dict(orient="records"),
    }


@handler("numpy.load_info")
def numpy_load_info(path: str, **_: Any) -> dict:
    import numpy as np
    _check_file_size(path)
    arr = np.load(path, allow_pickle=False)
    if isinstance(arr, np.lib.npyio.NpzFile):
        return {
            "type": "npz",
            "files": list(arr.files),
            "shapes": {k: list(arr[k].shape) for k in arr.files},
        }
    return {
        "type": "npy",
        "shape": list(arr.shape),
        "dtype": str(arr.dtype),
    }


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    # Pre-import libraries specified by environment
    preload_raw = os.environ.get("MEDSCI_PRELOAD", "[]")
    try:
        preload_libs = json.loads(preload_raw)
    except json.JSONDecodeError:
        preload_libs = []

    for lib in preload_libs:
        try:
            __import__(lib)
            sys.stderr.write(f"[sidecar] preloaded {lib}\n")
        except ImportError:
            sys.stderr.write(f"[sidecar] WARNING: could not preload {lib}\n")

    sys.stderr.write(f"[sidecar] ready with {len(HANDLERS)} handlers\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({"id": "?", "error": f"Invalid JSON: {e}"}) + "\n")
            sys.stdout.flush()
            continue

        req_id = req.get("id", "?")
        method = req.get("method", "")
        args = req.get("args", {})

        if method == "__shutdown__":
            sys.stdout.write(json.dumps({"id": req_id, "result": {"status": "shutting_down"}}) + "\n")
            sys.stdout.flush()
            break

        handler_fn = HANDLERS.get(method)
        if handler_fn is None:
            sys.stdout.write(json.dumps({
                "id": req_id,
                "error": f"Unknown method: {method}. Available: {sorted(HANDLERS.keys())}",
            }) + "\n")
            sys.stdout.flush()
            continue

        try:
            result = handler_fn(**args)
            sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(f"[sidecar] error in {method}: {tb}\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({"id": req_id, "error": str(e)}) + "\n")

        sys.stdout.flush()


if __name__ == "__main__":
    main()

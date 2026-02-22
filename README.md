<p align="center">
  <img src="docs/logo.png" alt="MedSci Agent" width="400" />
</p>

<p align="center">The open source biomedical research agent.</p>

<p align="center">
  <a href="https://modelcontextprotocol.io"><img alt="MCP Server" src="https://badge.mcpx.dev?type=server&features=tools" /></a>
  <a href="https://huggingface.co/google/medgemma-4b-it"><img alt="MedGemma" src="https://img.shields.io/badge/MedGemma-4B-4285F4?style=flat&logo=google&logoColor=white" /></a>
  <a href="https://huggingface.co/google/txgemma-2b-predict"><img alt="TxGemma" src="https://img.shields.io/badge/TxGemma-2B--predict-4285F4?style=flat&logo=google&logoColor=white" /></a>
  <a href="https://ollama.com"><img alt="Ollama" src="https://img.shields.io/badge/Ollama-local%20inference-ffffff?style=flat&logo=ollama&logoColor=000000" /></a>
  <a href="https://opencode.ai"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-compatible-000000?style=flat" /></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/Bun-%3E%3D1.1-fbf0df?style=flat&logo=bun&logoColor=000000" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow?style=flat" /></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-107%20passing-brightgreen?style=flat" />
</p>

[![MedSci Agent running a single-cell RNA-seq pipeline in OpenCode](docs/demo.png)](https://www.kaggle.com/competitions/med-gemma-impact-challenge)

MedSci Agent gives any coding LLM access to 20 biomedical research tools — drug ADMET prediction, protein structure search, single-cell RNA-seq analysis, medical image interpretation, and literature search — all powered by [MedGemma](https://huggingface.co/google/medgemma-4b-it), [TxGemma](https://huggingface.co/google/txgemma-2b-predict) and [OpenCode](https://opencode.ai) running locally via Ollama. No data leaves your machine.

Built for the [MedGemma Impact Challenge](https://www.kaggle.com/competitions/med-gemma-impact-challenge).

---

## Quick Start

Once [setup](#setup) is complete and Ollama is running, open the project in [OpenCode](https://opencode.ai) and try:

**Drug discovery:**
> Analyze the drug-likeness of ibuprofen (CC(C)Cc1ccc(cc1)C(C)C(=O)O) and predict its ADMET properties.

**Single-cell omics:**
> Read my H5AD file, preprocess it, cluster with Leiden at resolution 0.5, and run differential expression.

**Literature search:**
> Search PubMed for recent papers on CRISPR-Cas9 gene therapy for sickle cell disease.

The Agent automatically selects the right tools, calls MedGemma for interpretation, and returns a synthesized answer.

---

## Architecture

You bring your own LLM. Configure any model in OpenCode (via `/model`) and it becomes the orchestrator — it reads your query, selects the right tools, calls them through MCP, and synthesizes the results. The 5 MCP servers handle the domain logic underneath.

```
Cloud LLM (user's choice via OpenCode)
    |
    | tool calls via MCP
    v
+--- MCP Servers (Bun / TypeScript) ---+
|                                       |
|  server-drug        5 tools           |
|  server-protein     5 tools           |
|  server-literature  4 tools           |
|  server-imaging     1 tool            |
|  server-omics       5 tools           |
|                                       |
+-------+-------------------+-----------+
        |                   |
        v                   v
   Ollama (local)     Python Sidecar
   - MedGemma 4B      - RDKit
   - TxGemma 2B       - BioPython
                       - Scanpy
```

**MedGemma** interprets tool outputs — it reads raw data from APIs and computational tools, then provides clinically relevant summaries. Every tool that calls MedGemma returns a `model_used` flag and degrades gracefully if the model is unavailable.

**TxGemma** predicts ADMET properties (absorption, distribution, metabolism, excretion, toxicity). It runs exact prompt templates from the [Therapeutics Data Commons](https://tdcommons.ai) and outputs binary classifications for six safety endpoints.

The **Python sidecar** is a long-running process that pre-imports scientific libraries and handles requests over stdin/stdout via JSON-RPC. This avoids the 2–5 second startup cost of importing RDKit or Scanpy on every call.

---

## Tools

### Drug Discovery (server-drug)

| Tool | Description | Backend |
|------|-------------|---------|
| `analyze_molecule` | Physicochemical properties from SMILES (MW, LogP, TPSA, HBD/HBA, rings, formula) | RDKit + MedGemma |
| `lipinski_filter` | Lipinski Rule of Five drug-likeness check | RDKit |
| `molecular_similarity` | Tanimoto similarity between two molecules using Morgan fingerprints | RDKit |
| `predict_admet` | BBB penetration, intestinal absorption, hERG blocking, CYP3A4 inhibition, Ames mutagenicity, DILI risk | TxGemma + RDKit + MedGemma |
| `search_chembl` | Search ChEMBL for bioactive molecules and targets | ChEMBL API + MedGemma |

### Protein Analysis (server-protein)

| Tool | Description | Backend |
|------|-------------|---------|
| `parse_fasta` | Parse FASTA files, return sequence metadata | BioPython |
| `analyze_sequence` | Sequence length, composition, molecular weight | BioPython + MedGemma |
| `search_uniprot` | Search UniProt by gene, protein name, or accession | UniProt API + MedGemma |
| `search_pdb` | Search PDB for 3D structures by protein or PDB ID | RCSB PDB API + MedGemma |
| `predict_structure` | Retrieve AlphaFold predicted structure and confidence scores | AlphaFold DB API + MedGemma |

### Literature (server-literature)

| Tool | Description | Backend |
|------|-------------|---------|
| `search_pubmed` | Search PubMed with Boolean and MeSH queries | NCBI E-utilities + MedGemma |
| `fetch_abstract` | Fetch full abstract and metadata by PMID | NCBI E-utilities + MedGemma |
| `search_openalex` | Search OpenAlex for scholarly works, citations, open access status | OpenAlex API + MedGemma |
| `search_clinical_trials` | Search ClinicalTrials.gov by condition, drug, or intervention | ClinicalTrials.gov API + MedGemma |

### Medical Imaging (server-imaging)

| Tool | Description | Backend |
|------|-------------|---------|
| `analyze_medical_image` | Analyze X-ray, CT, pathology, or dermatology images (PNG/JPEG, max 50 MB) | MedGemma (multimodal) |

### Omics (server-omics)

| Tool | Description | Backend |
|------|-------------|---------|
| `read_h5ad` | Load H5AD file, return observation and variable metadata | Scanpy |
| `preprocess_omics` | Filter, normalize, log-transform, find highly variable genes | Scanpy |
| `cluster_cells` | Leiden or Louvain clustering with UMAP coordinates | Scanpy |
| `differential_expression` | Differential expression between groups (Wilcoxon, t-test, logreg) | Scanpy + MedGemma |
| `gene_set_enrichment` | Pathway enrichment against MSigDB, GO, KEGG via Enrichr | Enrichr API + MedGemma |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.1
- Python 3.10+ with a virtual environment
- [Ollama](https://ollama.com)
- [OpenCode](https://opencode.ai)

### 1. Clone and install

```bash
git clone https://github.com/omar-A-hassan/medsci-agent.git
cd medsci-agent
bun install
```

### 2. Python environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install rdkit-pypi biopython scanpy leidenalg igraph pynndescent
```

> **Important:** Set `MEDSCI_PYTHON` to `.venv/bin/python3` in your `opencode.json` server environment blocks. Without this, the Python sidecar will use your system Python, which won't have the scientific libraries installed.

### 3. Pull Ollama models

```bash
ollama pull medgemma:latest
ollama pull hf.co/matrixportalx/txgemma-2b-predict-GGUF:Q4_K_M
```

If `medgemma:latest` is not available directly, pull the GGUF from HuggingFace and alias it:

```bash
ollama pull hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M
cp ~/.ollama/models/manifests/hf.co/unsloth/medgemma-4b-it-GGUF/Q4_K_M \
   ~/.ollama/models/manifests/registry.ollama.ai/library/medgemma/latest
```

> **Note:** The `cp` command creates an alias so the code can reference the model as `medgemma:latest` regardless of how it was downloaded.

### 4. Configure OpenCode

The included `opencode.json` is pre-configured. Set the `model` field to your preferred cloud LLM:

```json
{
  "model": "openai/gpt-4o"
}
```

Update the `MEDSCI_PYTHON` path in each server's environment block if your virtual environment is in a different location.

### 5. Run tests

```bash
bun test
```

### 6. Start

Make sure Ollama is running, then open the project directory in OpenCode. The MCP servers start automatically.

---

## Configuration

Environment variables (set in `opencode.json` under each server's `environment`):

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDSCI_PROFILE` | `standard` | Hardware profile: `lite`, `standard`, or `full` |
| `MEDSCI_PYTHON` | `python3` | Path to Python binary (use `.venv/bin/python3` for the virtual environment) |
| `MEDSCI_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `MEDSCI_OLLAMA_MODEL` | `medgemma:latest` | Default Ollama model for interpretation |
| `MEDSCI_OLLAMA_TIMEOUT` | `120000` | Ollama request timeout in milliseconds |
| `MEDSCI_PYTHON_TIMEOUT` | `60000` | Python sidecar request timeout in milliseconds |

The `MEDSCI_PROFILE` setting controls which Python libraries are pre-imported when the sidecar starts. All tools work regardless of profile — the sidecar imports libraries lazily on first use — but pre-importing avoids a cold-start delay on the first call.

| Profile | Pre-imported | Use case |
|---------|--------------|----------|
| `lite` | RDKit | Drug discovery tools only, lower memory usage |
| `standard` | RDKit, Scanpy, BioPython, leidenalg, igraph, pynndescent | Most workflows |
| `full` | All available | Fastest first-call latency across all tools |

---

## Project Structure

```
medsci-agent/
  packages/
    core/               Shared library (Ollama client, Python sidecar, config, types)
      python/
        sidecar.py      Long-running Python process with scientific library handlers
    server-drug/        Drug discovery MCP server
    server-protein/     Protein analysis MCP server
    server-literature/  Literature search MCP server
    server-imaging/     Medical imaging MCP server
    server-omics/       Single-cell and omics MCP server
  .opencode/
    agents/             Agent definitions (orchestrator + 4 domain specialists)
    skills/             Skill definitions for OpenCode
  opencode.json         OpenCode configuration (model, MCP servers)
```

---

## License

MIT

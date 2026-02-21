# MedSci Agent

[![MCP Server](https://badge.mcpx.dev?type=server&features=tools)](https://modelcontextprotocol.io)
[![MedGemma](https://img.shields.io/badge/MedGemma-4B-4285F4?style=flat&logo=google&logoColor=white)](https://huggingface.co/google/medgemma-4b-it)
[![TxGemma](https://img.shields.io/badge/TxGemma-2B--predict-4285F4?style=flat&logo=google&logoColor=white)](https://huggingface.co/google/txgemma-2b-predict)
[![OpenCode](https://img.shields.io/badge/OpenCode-compatible-000000?style=flat)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-fbf0df?style=flat&logo=bun&logoColor=000000)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-103%20passing-brightgreen?style=flat)]()

A biomedical research agent built as a collection of MCP servers for [OpenCode](https://opencode.ai). It provides 20 tools across drug discovery, protein analysis, literature search, medical imaging, and single-cell omics. Tools use [MedGemma](https://huggingface.co/google/medgemma-4b-it) and [TxGemma](https://huggingface.co/google/txgemma-2b-predict) running locally via Ollama for medical reasoning and drug property prediction.

Built for the [MedGemma Impact Challenge](https://kaggle.com/competitions/medgemma-impact-challenge).

## Architecture

You bring your own LLM. Configure any model in OpenCode (via `/model`) and it becomes the orchestrator -- it reads your query, selects the right tools, calls them through MCP, and synthesizes the results into a coherent answer. The 5 MCP servers handle the domain logic underneath: running local models, querying external databases, and executing scientific computations.

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

**MedGemma** interprets tool outputs -- it reads raw data from APIs and computational tools, then provides clinically relevant summaries. Every tool that calls MedGemma returns a `model_used` flag and degrades gracefully if the model is unavailable.

**TxGemma** predicts ADMET properties (absorption, distribution, metabolism, excretion, toxicity). It runs exact prompt templates from the [Therapeutics Data Commons](https://tdcommons.ai) that it was trained on and outputs binary classifications for six safety endpoints.

The **Python sidecar** is a long-running process that pre-imports scientific libraries and handles requests over stdin/stdout via JSON-RPC. This avoids the 2-5 second startup cost of importing RDKit or Scanpy on every call.

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

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.1
- Python 3.10+ with a virtual environment
- [Ollama](https://ollama.com)
- [OpenCode](https://opencode.ai)

### 1. Clone and install

```bash
git clone <repo-url> medsci-agent
cd medsci-agent
bun install
```

### 2. Python environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install rdkit-pypi biopython scanpy
```

### 3. Pull Ollama models

```bash
ollama pull medgemma:latest
ollama run hf.co/matrixportalx/txgemma-2b-predict-GGUF:Q4_K_M
```

### 4. Configure OpenCode

Copy `opencode.json` to your project root (already included). Set the `model` field to whatever cloud LLM you want to use as the router:

```json
{
  "model": "openai/gpt-4o"
}
```

The MCP server entries in `opencode.json` point to each server's entry file. Update the `command` paths and `MEDSCI_PYTHON` environment variable if your Bun binary or Python virtual environment are in different locations.

### 5. Run tests

```bash
bun test
```

### 6. Start

Open the project directory in OpenCode. The MCP servers start automatically.

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

The `MEDSCI_PROFILE` setting controls which Python libraries are pre-imported when the sidecar starts. All tools work regardless of profile -- the sidecar imports libraries lazily on first use -- but pre-importing avoids a cold-start delay on the first call to each library.

| Profile | Pre-imported | Use case |
|---------|--------------|----------|
| `lite` | RDKit | Drug discovery tools only, lower memory usage |
| `standard` | RDKit, Scanpy, BioPython | Most workflows |
| `full` | All available | Fastest first-call latency across all tools |

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

## License

MIT

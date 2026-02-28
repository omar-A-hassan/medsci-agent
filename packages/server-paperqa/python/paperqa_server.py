#!/usr/bin/env python3
"""
PaperQA2 Sidecar Server
========================
Long-running JSON-RPC server for the MedSci PaperQA MCP server.
Communicates with the TypeScript PythonSidecar over stdin/stdout.

Protocol (same as core sidecar.py):
  Request:  {"id": "uuid", "method": "analyze_papers", "args": {"query": "...", "papers": [...]}}
  Response: {"id": "uuid", "result": ...} or {"id": "uuid", "error": "..."}

Special methods:
  __health__   → returns {"status": "ok"}
  __shutdown__ → graceful exit
"""

import asyncio
import json
import logging
import os
import sys
import tempfile
import traceback
from typing import Any, Dict, List

# Basic logging to stderr so it doesn't pollute stdout JSON IPC
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger("paperqa-sidecar")


def build_settings(workspace_dir: str):
    """
    Build a PaperQA2 Settings object configured for local Ollama inference
    with proper index and cache placement.
    """
    from paperqa import Settings

    # Where to store downloaded PDFs for indexing
    paper_dir = os.path.join(workspace_dir, ".opencode", "pqa_papers")
    os.makedirs(paper_dir, exist_ok=True)

    # Where PaperQA stores its search indexes
    index_dir = os.path.join(workspace_dir, ".opencode", "pqa_index")
    os.makedirs(index_dir, exist_ok=True)

    # Ollama LLM config for litellm
    # Uses medgemma if available, falls back to whatever Ollama model is running
    ollama_model = os.environ.get("PQA_LLM_MODEL", "ollama/medgemma:latest")
    ollama_base = os.environ.get("PQA_OLLAMA_URL", "http://localhost:11434")
    embedding_model = os.environ.get("PQA_EMBEDDING_MODEL", "ollama/mxbai-embed-large")

    ollama_config = {
        "model_list": [
            {
                "model_name": ollama_model,
                "litellm_params": {
                    "model": ollama_model,
                    "api_base": ollama_base,
                },
            }
        ]
    }

    settings = Settings(
        llm=ollama_model,
        llm_config=ollama_config,
        summary_llm=ollama_model,
        summary_llm_config=ollama_config,
        embedding=embedding_model,
        temperature=0.1,
        agent={
            "agent_type": "fake",  # Use deterministic search→gather→answer path (no agent LLM needed)
            "index": {
                "paper_directory": paper_dir,
                "index_directory": index_dir,
            },
        },
        answer={
            "answer_max_sources": 5,
            "evidence_k": 10,
        },
    )

    return settings, paper_dir


async def download_paper(identifier: str, paper_dir: str) -> str | None:
    """
    Download a paper PDF by DOI or PMID into the paper directory.
    Returns the local file path if successful, None otherwise.
    """
    import httpx

    # Try DOI-based download via Unpaywall / DOI redirect
    if identifier.startswith("10."):
        # Try Unpaywall first (free PDFs)
        try:
            email = os.environ.get("PQA_EMAIL", "medsci-agent@localhost")
            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(
                    f"https://api.unpaywall.org/v2/{identifier}?email={email}"
                )
                if resp.status_code == 200:
                    data = resp.json()
                    pdf_url = None
                    oa = data.get("best_oa_location")
                    if oa:
                        pdf_url = oa.get("url_for_pdf") or oa.get("url")
                    if pdf_url:
                        pdf_resp = await client.get(pdf_url)
                        if pdf_resp.status_code == 200:
                            safe_name = identifier.replace("/", "_") + ".pdf"
                            filepath = os.path.join(paper_dir, safe_name)
                            with open(filepath, "wb") as f:
                                f.write(pdf_resp.content)
                            logger.info(f"Downloaded {identifier} -> {filepath}")
                            return filepath
        except Exception as e:
            logger.warning(f"Unpaywall download failed for {identifier}: {e}")

    # PMID-based: try PubMed Central
    if identifier.isdigit():
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                # Convert PMID to PMCID
                resp = await client.get(
                    f"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids={identifier}&format=json"
                )
                if resp.status_code == 200:
                    records = resp.json().get("records", [])
                    if records and records[0].get("pmcid"):
                        pmcid = records[0]["pmcid"]
                        pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/"
                        pdf_resp = await client.get(pdf_url)
                        if pdf_resp.status_code == 200 and len(pdf_resp.content) > 1000:
                            filepath = os.path.join(paper_dir, f"{identifier}.pdf")
                            with open(filepath, "wb") as f:
                                f.write(pdf_resp.content)
                            logger.info(f"Downloaded PMID:{identifier} -> {filepath}")
                            return filepath
        except Exception as e:
            logger.warning(f"PMC download failed for PMID {identifier}: {e}")

    logger.warning(f"Could not download paper: {identifier}")
    return None


async def handle_analyze_papers(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main handler: downloads papers, indexes them with PaperQA2, runs query.
    """
    query = payload.get("query")
    papers = payload.get("papers", [])
    workspace_dir = payload.get("workspace_dir", os.getcwd())

    if not query:
        raise ValueError("Missing query parameter")
    if not papers:
        raise ValueError("Missing papers list")

    try:
        from paperqa import Docs, Settings
    except ImportError:
        raise ImportError(
            "paper-qa library is not installed. "
            "Activate .venv-paperqa and run: pip install -r requirements.txt"
        )

    # 1. Build settings
    settings, paper_dir = build_settings(workspace_dir)

    # 2. Download papers
    downloaded_files = []
    failed_downloads = []
    for p in papers:
        identifier = p.get("identifier", "")
        if not identifier:
            continue
        filepath = await download_paper(identifier, paper_dir)
        if filepath:
            downloaded_files.append({
                "path": filepath,
                "identifier": identifier,
                "title": p.get("title"),
                "authors": p.get("authors", []),
            })
        else:
            failed_downloads.append(identifier)

    if not downloaded_files:
        return {
            "answer": "Could not download any of the requested papers. They may be behind paywalls.",
            "references": [],
            "context": "",
            "failed_downloads": failed_downloads,
        }

    # 3. Create Docs object and add papers manually
    docs = Docs()
    for paper in downloaded_files:
        try:
            # Build citation string from metadata
            authors_str = ", ".join(paper["authors"][:3]) if paper["authors"] else "Unknown"
            title = paper["title"] or paper["identifier"]
            citation = f"{authors_str}. {title}."

            await docs.aadd(
                paper["path"],
                citation=citation,
                docname=paper["identifier"].replace("/", "_"),
                settings=settings,
            )
            logger.info(f"Indexed: {paper['identifier']}")
        except Exception as e:
            logger.warning(f"Failed to index {paper['identifier']}: {e}")
            failed_downloads.append(paper["identifier"])

    # 4. Query the indexed documents
    session = await docs.aquery(query, settings=settings)

    return {
        "answer": session.formatted_answer if hasattr(session, "formatted_answer") else str(session),
        "references": session.references if hasattr(session, "references") else [],
        "context": session.context if hasattr(session, "context") else "",
        "papers_indexed": len(downloaded_files),
        "failed_downloads": failed_downloads,
    }


def main():
    """
    Standard JSON-RPC over stdin/stdout.
    Matches the protocol used by PythonSidecar in @medsci/core.
    """
    for line in sys.stdin:
        if not line.strip():
            continue

        req = {}
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            args = req.get("args", {})

            if method == "__health__":
                sys.stdout.write(json.dumps({"id": req_id, "result": {"status": "ok"}}) + "\n")
            elif method == "__shutdown__":
                sys.stdout.write(json.dumps({"id": req_id, "result": {"status": "shutting_down"}}) + "\n")
                sys.stdout.flush()
                sys.exit(0)
            elif method == "analyze_papers":
                # PaperQA2 is async-first, so we run the handler in an event loop
                result = asyncio.run(handle_analyze_papers(args))
                sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
            else:
                sys.stdout.write(json.dumps({"id": req_id, "error": f"Unknown method: {method}"}) + "\n")

        except Exception as e:
            # Send raw traceback so the IPC Error Mapper in TypeScript
            # can translate Tantivy/RateLimit errors into agent-safe instructions.
            error_data = {
                "id": req.get("id", None),
                "error": str(e),
                "traceback": traceback.format_exc(),
            }
            sys.stdout.write(json.dumps(error_data) + "\n")

        sys.stdout.flush()


if __name__ == "__main__":
    main()

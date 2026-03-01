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
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

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


class AcquireResult(NamedTuple):
    filepath: Optional[str]
    source: str  # "full_text" | "abstract" | "cached" | "failed"
    pmcid: Optional[str]


async def _resolve_to_pmcid(
    identifier: str, client, email: str
) -> Tuple[Optional[str], Optional[str]]:
    """
    Use NCBI ID Converter to resolve a DOI, PMID, or PMCID into a (pmcid, pmid) tuple.
    """
    if identifier.upper().startswith("PMC"):
        return (identifier.upper(), None)

    url = (
        f"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/"
        f"?ids={identifier}&format=json&tool=medsci-agent&email={email}"
    )
    try:
        resp = await client.get(url)
        if resp.status_code == 200:
            records = resp.json().get("records", [])
            if records:
                rec = records[0]
                pmcid = rec.get("pmcid")
                pmid = rec.get("pmid")
                return (pmcid, pmid)
    except Exception as e:
        logger.warning(f"NCBI ID conversion failed for {identifier}: {e}")

    # If identifier is purely digits, treat it as a PMID even if converter failed
    if identifier.isdigit():
        return (None, identifier)

    return (None, None)


async def _fetch_bioc_fulltext(pmcid: str, client) -> Optional[str]:
    """
    Fetch full-text article from NCBI BioC PMC Open Access API.
    Returns joined passage text or None.
    """
    url = (
        f"https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/"
        f"pmcoa.cgi/BioC_json/{pmcid}/unicode"
    )
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return None
        data = resp.json()
        passages = data[0]["documents"][0]["passages"]
        texts = [p["text"] for p in passages if p.get("text")]
        if not texts:
            return None
        return "\n\n".join(texts)
    except Exception as e:
        logger.warning(f"BioC full-text fetch failed for {pmcid}: {e}")
        return None


async def _fetch_bioc_abstract(pmid: str, client) -> Optional[str]:
    """
    Fetch abstract-only text from NCBI BioC PubMed API.
    Returns abstract text with a notice, or None.
    """
    url = (
        f"https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/"
        f"pubmed.cgi/BioC_json/{pmid}/unicode"
    )
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return None
        data = resp.json()
        passages = data[0]["documents"][0]["passages"]
        texts = [p["text"] for p in passages if p.get("text")]
        if not texts:
            return None
        body = "\n\n".join(texts)
        return (
            "[ABSTRACT ONLY — Full text not available in PMC Open Access]\n\n"
            + body
        )
    except Exception as e:
        logger.warning(f"BioC abstract fetch failed for PMID {pmid}: {e}")
        return None


async def acquire_paper_text(
    identifier: str, paper_dir: str, paper_meta: Optional[Dict] = None
) -> AcquireResult:
    """
    Acquire paper text via NCBI BioC API (full text or abstract fallback).
    Writes a .txt file into paper_dir and returns an AcquireResult.
    """
    import httpx

    if paper_meta is None:
        paper_meta = {}

    safe_id = identifier.replace("/", "_")
    cached_path = os.path.join(paper_dir, f"{safe_id}.txt")

    # 1. Cache check
    if os.path.exists(cached_path):
        logger.info(f"Cache hit for {identifier}")
        return AcquireResult(filepath=cached_path, source="cached", pmcid=None)

    email = os.environ.get("PQA_EMAIL", "medsci-agent@localhost")

    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        # 2. Resolve identifier to PMCID + PMID
        pmcid, pmid = await _resolve_to_pmcid(identifier, client, email)

        body = None
        source = "failed"

        # 3. Try full text via BioC PMC OA
        if pmcid:
            body = await _fetch_bioc_fulltext(pmcid, client)
            if body:
                source = "full_text"

        # 4. Abstract fallback via BioC PubMed
        if not body and pmid:
            body = await _fetch_bioc_abstract(pmid, client)
            if body:
                source = "abstract"

        if not body:
            logger.warning(f"Could not acquire text for {identifier}")
            return AcquireResult(filepath=None, source="failed", pmcid=pmcid)

        # 5. Write .txt with metadata header
        title = paper_meta.get("title") or identifier
        authors = paper_meta.get("authors", [])
        authors_str = ", ".join(authors[:5]) if authors else "Unknown"
        doi = identifier if identifier.startswith("10.") else ""

        header = (
            f"Title: {title}\n"
            f"Authors: {authors_str}\n"
            f"DOI: {doi}\n"
            f"PMCID: {pmcid or 'N/A'}\n"
            f"Source: {source}\n"
            f"\n---\n\n"
        )

        with open(cached_path, "w", encoding="utf-8") as f:
            f.write(header + body)

        logger.info(f"Acquired {identifier} ({source}) -> {cached_path}")
        return AcquireResult(filepath=cached_path, source=source, pmcid=pmcid)


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

    # 2. Acquire paper texts via NCBI BioC API
    acquired_files = []
    failed_downloads = []
    abstract_only = []
    full_text_ids = []

    for p in papers:
        identifier = p.get("identifier", "")
        if not identifier:
            continue
        result = await acquire_paper_text(
            identifier, paper_dir, paper_meta=p
        )
        if result.source == "failed":
            failed_downloads.append(identifier)
        else:
            acquired_files.append({
                "path": result.filepath,
                "identifier": identifier,
                "title": p.get("title"),
                "authors": p.get("authors", []),
            })
            if result.source == "abstract":
                abstract_only.append(identifier)
            elif result.source in ("full_text", "cached"):
                full_text_ids.append(identifier)

    if not acquired_files:
        return {
            "answer": (
                "Could not acquire text for any of the requested papers. "
                "They may not be available in PMC Open Access or PubMed."
            ),
            "references": [],
            "context": "",
            "failed_downloads": failed_downloads,
        }

    # 3. Create Docs object and add papers manually
    docs = Docs()
    for paper in acquired_files:
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
        "papers_indexed": len(acquired_files),
        "failed_downloads": failed_downloads,
        "acquisition_summary": {
            "full_text": full_text_ids,
            "abstract_only": abstract_only,
        },
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

#!/usr/bin/env python3
import sys
import json
import logging
import os
import traceback
from typing import Any, Dict, List

# Basic logging to stderr so it doesn't pollute stdout JSON IPC
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger("paperqa-sidecar")

def setup_paperqa_environment(workspace_dir: str):
    """
    Configures the PaperQA2 Settings object to enforce caching and proper index placement.
    """
    try:
        from paperqa import Settings
    except ImportError:
        logger.error("paper-qa package not found. Is the .venv-paperqa activated?")
        sys.exit(1)

    index_dir = os.path.join(workspace_dir, ".opencode", "pqa_index")
    os.makedirs(index_dir, exist_ok=True)
    
    cache_dir = os.path.join(workspace_dir, ".opencode", "pqa_cache")
    os.makedirs(cache_dir, exist_ok=True)
    
    # Configure PaperQA settings
    # Enable caching in litellm natively to speed up re-evaluating unmodified chunks
    # Note: paperqa 5 uses the `litellm` namespace for model kwargs
    settings = Settings()
    settings.agent.index.index_name = index_dir
    # Configure LiteLLM caching explicitly via litellm kwargs (assuming default Ollama MedGemma)
    settings.get_llm("summary").config = {"cache": True}
    
    # Explicitly ensure we use the local ollama by default if available, 
    # but the Settings() object will read normal litellm ENV vars if overriden.
    
    return settings

def pre_seed_docs(docs: Any, papers_data: List[Dict[str, Any]]):
    """
    Manually injects metadata into the PaperQA Docs object to avoid N+1 API calls 
    to Crossref/Semantic Scholar if OpenAlex already provided the citation counts/authors.
    """
    for p in papers_data:
        doi_or_pmid = p.get("identifier")
        if not doi_or_pmid:
            continue
            
        title = p.get("title")
        authors = p.get("authors", [])
        citation_count = p.get("citation_count")
        
        # In PaperQA >= 5, Docs.add() or manual doc state manipulation is required
        # For simplicity and strict adherence, if we just pass the DOI paperqa will fetch it.
        # But to pre-seed, we create the doc record manually if the fields exist.
        if title and authors:
            try:
                # This explicitly adds the record to bypass Crossref
                # Implementation depends slightly on paperqa v5 exact minor version,
                # but adding to docs.docs dictionary directly is the standard workaround.
                docs.docs[doi_or_pmid] = dict(
                    title=title,
                    authors=authors,
                    citation_count=citation_count or 0,
                    docname=doi_or_pmid.replace("/", "_"),
                    dockey=doi_or_pmid
                )
            except AttributeError:
                pass # Fail silently if internal undocumented API changes, fallback to network
                
    return docs

def handle_analyze_papers(payload: Dict[str, Any]) -> Dict[str, Any]:
    query = payload.get("query")
    papers = payload.get("papers", [])
    workspace_dir = payload.get("workspace_dir", os.getcwd())
    
    if not query:
        raise ValueError("Missing query parameter")
    if not papers:
        raise ValueError("Missing papers list")
        
    try:
        from paperqa import Docs
    except ImportError:
        raise ImportError("paper-qa library is not installed in the current environment.")

    # 1. Initialize strictly configured Settings
    settings = setup_paperqa_environment(workspace_dir)
    
    # 2. Extract identifiers
    identifiers = [p["identifier"] for p in papers if "identifier" in p]
    
    # 3. Create the Docs environment
    docs = Docs()
    
    # 4. Pre-seed metadata to bypass N+1 network lookups
    docs = pre_seed_docs(docs, papers)
    
    # 5. Add/Download the PDFs and build Tantivy Index
    # This process will raise expected errors (like TantivyLockError) which we map upstream
    for doc_id in identifiers:
        docs.add(doc_id, settings=settings)

    # 6. Execute RAG Synthesis
    answer = docs.query(query, settings=settings)
    
    return {
        "answer": answer.formatted_answer,
        "references": answer.references,
        "context": answer.context,
    }

def main():
    """
    Standard JSON-RPC over stdin/stdout.
    """
    for line in sys.stdin:
        if not line.strip():
            continue
            
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
                result = handle_analyze_papers(args)
                sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
            else:
                sys.stdout.write(json.dumps({"id": req_id, "error": f"Unknown method: {method}"}) + "\n")
                
        except Exception as e:
            # Send standard raw traceback up so the IPC Error Mapper 
            # in TypeScript can translate Tantivy/RateLimit errors safely.
            error_data = {"id": req.get("id", None), "error": str(e), "traceback": traceback.format_exc()}
            sys.stdout.write(json.dumps(error_data) + "\n")
            
        sys.stdout.flush()

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
PaperQA2 Sidecar Server
========================
Long-running JSON-RPC server for the MedSci PaperQA MCP server.
Communicates with the TypeScript PythonSidecar over stdin/stdout.

Protocol:
  Request:  {"id": "uuid", "method": "analyze_papers", "args": {"query": "...", "papers": [...]}}
  Response: {"id": "uuid", "result": ...} or {"id": "uuid", "error": "...", ...typed_fields}

Special methods:
  __health__   → returns {"status": "ok"}
  __shutdown__ → graceful exit
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

# Basic logging to stderr so it doesn't pollute stdout JSON IPC
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger("paperqa-sidecar")

DOCSET_CACHE: Dict[str, Dict[str, Dict[str, Any]]] = {}
DOI_REGEX = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Error code constants (single registry for Python side)
# ---------------------------------------------------------------------------
EC_INVALID_IDENTIFIER = "INVALID_IDENTIFIER"
EC_INVALID_REQUEST = "INVALID_REQUEST"
EC_DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
EC_OLLAMA_UNREACHABLE = "OLLAMA_UNREACHABLE"
EC_MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
EC_EMBEDDING_BAD_REQUEST = "EMBEDDING_BAD_REQUEST"
EC_INDEXING_FAILED = "INDEXING_FAILED"
EC_ACQUIRE_NONE_SUCCESS = "ACQUIRE_NONE_SUCCESS"
EC_ACQUIRE_NOT_FOUND = "ACQUIRE_NOT_FOUND"
EC_INDEX_ZERO_SUCCESS = "INDEX_ZERO_SUCCESS"
EC_QUERY_FAILED = "QUERY_FAILED"
EC_QUERY_TIMEOUT = "QUERY_TIMEOUT"
EC_QUERY_RATE_LIMIT = "QUERY_RATE_LIMIT"
EC_TEXT_TOO_LARGE = "TEXT_TOO_LARGE"
EC_NEGATIVE_CACHE_HIT = "NEGATIVE_CACHE_HIT"
EC_UNHANDLED_ERROR = "UNHANDLED_ERROR"
EC_UNKNOWN_METHOD = "UNKNOWN_METHOD"


class SidecarEnvelopeError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        stage: str,
        retryable: bool,
        detail: Optional[str] = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.stage = stage
        self.retryable = retryable
        self.detail = detail


class NormalizedIdentifier(NamedTuple):
    raw_identifier: str
    canonical_id: str
    lookup_id: str
    kind: str  # doi | pmid | pmcid
    doi_for_header: Optional[str]


class AcquireResult(NamedTuple):
    canonical_id: str
    raw_identifier: str
    filepath: Optional[str]
    source: str  # full_text | abstract | cached | failed
    pmcid: Optional[str]
    source_hash: Optional[str]
    error_code: Optional[str]
    error_detail: Optional[str]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _parse_iso_time(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def _load_json_file(path: str, default: Dict[str, Any]) -> Dict[str, Any]:
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("Failed to read JSON file %s: %s", path, exc)
        return default


def _save_json_file(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp_path, path)


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _safe_docname(canonical_id: str) -> str:
    return _hash_text(canonical_id)[:24]


def _strip_doi_resolver(identifier: str) -> str:
    value = identifier.strip()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value, flags=re.IGNORECASE)
    return value.strip()


def normalize_identifier(identifier: str) -> NormalizedIdentifier:
    raw = (identifier or "").strip()
    if not raw:
        raise SidecarEnvelopeError(
            code=EC_INVALID_IDENTIFIER,
            message="Identifier is empty.",
            stage="acquire",
            retryable=False,
        )

    # PMCID
    if raw.upper().startswith("PMC"):
        canonical = raw.upper()
        return NormalizedIdentifier(raw, canonical, canonical, "pmcid", None)

    # PMID
    if raw.isdigit():
        return NormalizedIdentifier(raw, raw, raw, "pmid", None)

    # DOI (accept bare DOI or DOI resolver URL)
    maybe_doi = _strip_doi_resolver(raw)
    if DOI_REGEX.match(maybe_doi):
        prefix, suffix = maybe_doi.split("/", 1)
        canonical = f"{prefix.lower()}/{suffix}"
        return NormalizedIdentifier(raw, canonical, canonical, "doi", canonical)

    raise SidecarEnvelopeError(
        code=EC_INVALID_IDENTIFIER,
        message=(
            f"Unsupported identifier format: {identifier}. "
            "Expected DOI, PMID, or PMCID."
        ),
        stage="acquire",
        retryable=False,
    )


def _manifest_paths(workspace_dir: str) -> Tuple[str, str]:
    papers_manifest = os.path.join(workspace_dir, ".opencode", "pqa_papers", "manifest.json")
    index_manifest = os.path.join(workspace_dir, ".opencode", "pqa_index", "manifest.json")
    return papers_manifest, index_manifest


def _load_manifests(workspace_dir: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    papers_manifest_path, index_manifest_path = _manifest_paths(workspace_dir)

    papers_manifest = _load_json_file(
        papers_manifest_path,
        {
            "version": 1,
            "entries": {},
            "negative_cache": {},
        },
    )
    index_manifest = _load_json_file(
        index_manifest_path,
        {
            "version": 1,
            "entries": {},
            "query_cache": {},
        },
    )

    papers_manifest.setdefault("version", 1)
    papers_manifest.setdefault("entries", {})
    papers_manifest.setdefault("negative_cache", {})

    index_manifest.setdefault("version", 1)
    index_manifest.setdefault("entries", {})
    index_manifest.setdefault("query_cache", {})

    return papers_manifest, index_manifest


def _save_manifests(
    workspace_dir: str,
    papers_manifest: Dict[str, Any],
    index_manifest: Dict[str, Any],
) -> None:
    papers_manifest_path, index_manifest_path = _manifest_paths(workspace_dir)
    _save_json_file(papers_manifest_path, papers_manifest)
    _save_json_file(index_manifest_path, index_manifest)


def _negative_cache_is_active(entry: Dict[str, Any]) -> bool:
    expires_at = entry.get("expires_at")
    if not expires_at:
        return False
    parsed = _parse_iso_time(expires_at)
    if parsed is None:
        return False
    return parsed > _utc_now()


def _upsert_negative_cache(
    papers_manifest: Dict[str, Any],
    canonical_id: str,
    code: str,
    detail: str,
    ttl_hours: int,
) -> None:
    expires_at = (_utc_now() + timedelta(hours=ttl_hours)).isoformat()
    papers_manifest["negative_cache"][canonical_id] = {
        "code": code,
        "detail": detail,
        "updated_at": _utc_now_iso(),
        "expires_at": expires_at,
    }


def _clear_negative_cache(papers_manifest: Dict[str, Any], canonical_id: str) -> None:
    papers_manifest["negative_cache"].pop(canonical_id, None)


def _resolve_file_key(canonical_id: str) -> str:
    return _hash_text(canonical_id)[:24]


def _parse_env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_env_int(name: str, default: int, min_value: Optional[int] = None) -> int:
    raw = os.environ.get(name)
    if raw is None:
        value = default
    else:
        try:
            value = int(raw)
        except ValueError:
            value = default
    if min_value is not None:
        return max(min_value, value)
    return value


@dataclass(frozen=True)
class PaperQaRuntimeConfig:
    """Single source of truth for all PQA_* runtime configuration."""

    ollama_model: str
    ollama_base: str
    embedding_model: str
    email: str
    use_doc_details: bool
    skip_preflight: bool
    chunk_chars: int
    chunk_overlap: int
    min_chunk_chars: int
    chunk_backoff_retries: int
    max_text_chars: int
    acquire_concurrency: int
    negative_cache_ttl_hours: int
    llm_timeout_seconds: int
    answer_max_sources: int
    evidence_k: int
    docset_cache_max_entries: int
    docset_cache_max_bytes: int

    @classmethod
    def from_env(cls) -> "PaperQaRuntimeConfig":
        return cls(
            ollama_model=os.environ.get("PQA_LLM_MODEL", "ollama/medgemma:latest"),
            ollama_base=os.environ.get("PQA_OLLAMA_URL", "http://localhost:11434"),
            embedding_model=os.environ.get("PQA_EMBEDDING_MODEL", "ollama/mxbai-embed-large"),
            email=os.environ.get("PQA_EMAIL", "medsci-agent@localhost"),
            use_doc_details=_parse_env_bool("PQA_USE_DOC_DETAILS", False),
            skip_preflight=_parse_env_bool("PQA_SKIP_PREFLIGHT", False),
            chunk_chars=_parse_env_int("PQA_CHUNK_CHARS", 1200, min_value=200),
            chunk_overlap=_parse_env_int("PQA_CHUNK_OVERLAP", 100, min_value=0),
            min_chunk_chars=_parse_env_int("PQA_CHUNK_MIN_CHARS", 400, min_value=200),
            chunk_backoff_retries=_parse_env_int("PQA_CHUNK_BACKOFF_RETRIES", 3, min_value=0),
            max_text_chars=_parse_env_int("PQA_MAX_TEXT_CHARS", 1_500_000, min_value=1000),
            acquire_concurrency=_parse_env_int("PQA_ACQUIRE_CONCURRENCY", 3, min_value=1),
            negative_cache_ttl_hours=_parse_env_int("PQA_NEGATIVE_CACHE_TTL_HOURS", 24, min_value=1),
            llm_timeout_seconds=_parse_env_int("PQA_LLM_TIMEOUT_SECONDS", 180, min_value=30),
            answer_max_sources=_parse_env_int("PQA_ANSWER_MAX_SOURCES", 5, min_value=1),
            evidence_k=_parse_env_int("PQA_EVIDENCE_K", 10, min_value=1),
            docset_cache_max_entries=_parse_env_int("PQA_DOCSET_CACHE_MAX_ENTRIES", 8, min_value=1),
            docset_cache_max_bytes=_parse_env_int(
                "PQA_DOCSET_CACHE_MAX_BYTES", 200 * 1024 * 1024, min_value=1024 * 1024
            ),
        )


def build_settings(workspace_dir: str, cfg: PaperQaRuntimeConfig):
    """
    Build a PaperQA2 Settings object configured for local Ollama inference
    with proper index and cache placement.
    """
    from paperqa import Settings

    paper_dir = os.path.join(workspace_dir, ".opencode", "pqa_papers")
    os.makedirs(paper_dir, exist_ok=True)

    index_dir = os.path.join(workspace_dir, ".opencode", "pqa_index")
    os.makedirs(index_dir, exist_ok=True)

    ollama_config = {
        "model_list": [
            {
                "model_name": cfg.ollama_model,
                "litellm_params": {
                    "model": cfg.ollama_model,
                    "api_base": cfg.ollama_base,
                    "timeout": cfg.llm_timeout_seconds,
                },
            }
        ]
    }

    embedding_config = {
        "kwargs": {
            "api_base": cfg.ollama_base,
        },
    }

    settings = Settings(
        llm=cfg.ollama_model,
        llm_config=ollama_config,
        summary_llm=cfg.ollama_model,
        summary_llm_config=ollama_config,
        embedding=cfg.embedding_model,
        embedding_config=embedding_config,
        temperature=0.1,
        parsing={
            "use_doc_details": cfg.use_doc_details,
            "reader_config": {
                "chunk_chars": cfg.chunk_chars,
                "overlap": min(cfg.chunk_overlap, max(0, cfg.chunk_chars - 1)),
            },
        },
        agent={
            "agent_type": "fake",
            "index": {
                "paper_directory": paper_dir,
                "index_directory": index_dir,
            },
        },
        answer={
            "answer_max_sources": cfg.answer_max_sources,
            "evidence_k": cfg.evidence_k,
        },
    )

    return settings, paper_dir, index_dir


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
            body = resp.json()
            records = body.get("records", []) if isinstance(body, dict) else []
            if records:
                rec = records[0]
                pmcid = rec.get("pmcid")
                pmid = rec.get("pmid")
                return (pmcid, pmid)
    except Exception as e:
        logger.warning("NCBI ID conversion failed for %s: %s", identifier, e)

    if identifier.isdigit():
        return (None, identifier)

    return (None, None)


async def _fetch_bioc_passages(url: str, client) -> Optional[str]:
    """
    Fetch and join passage text from any NCBI BioC JSON endpoint.
    Shared parser for both full-text (pmcoa) and abstract (pubmed) APIs.
    Returns joined passage text or None.
    """
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return None

        data = resp.json()
        if not isinstance(data, list) or not data:
            logger.warning("BioC payload has unexpected top-level schema for %s", url)
            return None

        documents = data[0].get("documents", [])
        if not documents:
            return None

        passages = documents[0].get("passages", [])
        texts = [p.get("text") for p in passages if isinstance(p, dict) and p.get("text")]
        if not texts:
            return None

        return "\n\n".join(texts)
    except Exception as e:
        logger.warning("BioC fetch failed for %s: %s", url, e)
        return None


async def _fetch_bioc_fulltext(pmcid: str, client) -> Optional[str]:
    url = (
        f"https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/"
        f"pmcoa.cgi/BioC_json/{pmcid}/unicode"
    )
    return await _fetch_bioc_passages(url, client)


async def _fetch_bioc_abstract(pmid: str, client) -> Optional[str]:
    url = (
        f"https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/"
        f"pubmed.cgi/BioC_json/{pmid}/unicode"
    )
    body = await _fetch_bioc_passages(url, client)
    if body is None:
        return None
    return "[ABSTRACT ONLY — Full text not available in PMC Open Access]\n\n" + body


async def preflight_models(settings, ollama_base: str) -> None:
    import httpx

    if _parse_env_bool("PQA_SKIP_PREFLIGHT", False):
        return

    timeout_seconds = 5
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            resp = await client.get(f"{ollama_base.rstrip('/')}/api/tags")
            if resp.status_code != 200:
                raise SidecarEnvelopeError(
                    code=EC_OLLAMA_UNREACHABLE,
                    message=(
                        f"Ollama preflight failed with status {resp.status_code} at {ollama_base}."
                    ),
                    stage="startup",
                    retryable=True,
                )
            tags = resp.json().get("models", [])
            available = {m.get("name") for m in tags if isinstance(m, dict) and m.get("name")}
    except SidecarEnvelopeError:
        raise
    except Exception as exc:
        raise SidecarEnvelopeError(
            code=EC_OLLAMA_UNREACHABLE,
            message=f"Could not reach Ollama at {ollama_base}: {exc}",
            stage="startup",
            retryable=True,
        ) from exc

    def _normalize_model_name(value: str) -> str:
        return value.split("/", 1)[1] if value.startswith("ollama/") else value

    def _aliases(value: str) -> set[str]:
        base = _normalize_model_name(value)
        out = {base}
        if ":" not in base:
            out.add(f"{base}:latest")
        if base.endswith(":latest"):
            out.add(base[: -len(":latest")])
        return out

    required = [
        _normalize_model_name(settings.llm),
        _normalize_model_name(settings.embedding),
    ]

    missing = []
    for req in required:
        if not any(alias in available for alias in _aliases(req)):
            missing.append(req)

    if missing:
        raise SidecarEnvelopeError(
            code=EC_MODEL_NOT_FOUND,
            message=f"Missing required local models in Ollama: {', '.join(missing)}",
            stage="startup",
            retryable=False,
        )


async def acquire_paper_text(
    normalized: NormalizedIdentifier,
    paper_dir: str,
    papers_manifest: Dict[str, Any],
    paper_meta: Optional[Dict] = None,
    client=None,
    max_text_chars: int = 1_500_000,
    negative_cache_ttl_hours: int = 24,
) -> AcquireResult:
    """
    Acquire paper text via NCBI BioC API (full text or abstract fallback).
    Writes a .txt file into paper_dir and returns an AcquireResult.
    """
    import httpx

    if paper_meta is None:
        paper_meta = {}

    canonical_id = normalized.canonical_id
    file_key = _resolve_file_key(canonical_id)
    cached_path = os.path.join(paper_dir, f"{file_key}.txt")

    neg_entry = papers_manifest.get("negative_cache", {}).get(canonical_id)
    if isinstance(neg_entry, dict) and _negative_cache_is_active(neg_entry):
        detail = neg_entry.get("detail") or "Negative cache active"
        return AcquireResult(
            canonical_id=canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=None,
            source="failed",
            pmcid=None,
            source_hash=None,
            error_code=neg_entry.get("code", EC_NEGATIVE_CACHE_HIT),
            error_detail=detail,
        )

    # 1. Cache check by file existence
    if os.path.exists(cached_path):
        source_hash = _hash_file(cached_path)
        papers_manifest["entries"][canonical_id] = {
            "canonical_id": canonical_id,
            "file_key": file_key,
            "path": cached_path,
            "updated_at": _utc_now_iso(),
            "raw_identifiers": sorted(
                set(
                    list(
                        papers_manifest["entries"].get(canonical_id, {}).get(
                            "raw_identifiers", []
                        )
                    )
                    + [normalized.raw_identifier]
                )
            ),
        }
        _clear_negative_cache(papers_manifest, canonical_id)
        logger.info("Cache hit for %s", canonical_id)
        return AcquireResult(
            canonical_id=canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=cached_path,
            source="cached",
            pmcid=papers_manifest["entries"].get(canonical_id, {}).get("pmcid"),
            source_hash=source_hash,
            error_code=None,
            error_detail=None,
        )

    email = os.environ.get("PQA_EMAIL", "medsci-agent@localhost")

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(follow_redirects=True, timeout=30)

    try:
        pmcid, pmid = await _resolve_to_pmcid(normalized.lookup_id, client, email)

        body = None
        source = "failed"

        if pmcid:
            body = await _fetch_bioc_fulltext(pmcid, client)
            if body:
                source = "full_text"

        if not body and pmid:
            body = await _fetch_bioc_abstract(pmid, client)
            if body:
                source = "abstract"

        if not body:
            detail = (
                "Text unavailable from PMC Open Access and PubMed BioC for identifier "
                f"{normalized.lookup_id}."
            )
            _upsert_negative_cache(
                papers_manifest,
                canonical_id,
                code=EC_ACQUIRE_NOT_FOUND,
                detail=detail,
                ttl_hours=negative_cache_ttl_hours,
            )
            return AcquireResult(
                canonical_id=canonical_id,
                raw_identifier=normalized.raw_identifier,
                filepath=None,
                source="failed",
                pmcid=pmcid,
                source_hash=None,
                error_code=EC_ACQUIRE_NOT_FOUND,
                error_detail=detail,
            )

        if len(body) > max_text_chars:
            detail = (
                f"Acquired text exceeded max threshold ({len(body)} chars > {max_text_chars})."
            )
            _upsert_negative_cache(
                papers_manifest,
                canonical_id,
                code=EC_TEXT_TOO_LARGE,
                detail=detail,
                ttl_hours=negative_cache_ttl_hours,
            )
            return AcquireResult(
                canonical_id=canonical_id,
                raw_identifier=normalized.raw_identifier,
                filepath=None,
                source="failed",
                pmcid=pmcid,
                source_hash=None,
                error_code=EC_TEXT_TOO_LARGE,
                error_detail=detail,
            )

        title = paper_meta.get("title") or canonical_id
        authors = paper_meta.get("authors", [])
        authors_str = ", ".join(authors[:5]) if authors else "Unknown"

        header = (
            f"Title: {title}\n"
            f"Authors: {authors_str}\n"
            f"DOI: {normalized.doi_for_header or ''}\n"
            f"PMCID: {pmcid or 'N/A'}\n"
            f"Source: {source}\n"
            "\n---\n\n"
        )

        with open(cached_path, "w", encoding="utf-8") as f:
            f.write(header + body)

        source_hash = _hash_file(cached_path)
        papers_manifest["entries"][canonical_id] = {
            "canonical_id": canonical_id,
            "file_key": file_key,
            "path": cached_path,
            "pmcid": pmcid,
            "source": source,
            "source_hash": source_hash,
            "updated_at": _utc_now_iso(),
            "raw_identifiers": sorted(
                set(
                    list(
                        papers_manifest["entries"].get(canonical_id, {}).get(
                            "raw_identifiers", []
                        )
                    )
                    + [normalized.raw_identifier]
                )
            ),
        }
        _clear_negative_cache(papers_manifest, canonical_id)

        logger.info("Acquired %s (%s) -> %s", canonical_id, source, cached_path)
        return AcquireResult(
            canonical_id=canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=cached_path,
            source=source,
            pmcid=pmcid,
            source_hash=source_hash,
            error_code=None,
            error_detail=None,
        )
    finally:
        if owns_client:
            await client.aclose()


def _make_docset_cache_key(entries: List[Dict[str, Any]]) -> str:
    fingerprint = [
        {
            "canonical_id": e["canonical_id"],
            "source_hash": e["source_hash"],
        }
        for e in entries
    ]
    fingerprint.sort(key=lambda x: x["canonical_id"])
    return _hash_text(json.dumps(fingerprint, separators=(",", ":"), sort_keys=True))


def _get_workspace_doc_cache(workspace_dir: str) -> Dict[str, Dict[str, Any]]:
    if workspace_dir not in DOCSET_CACHE:
        DOCSET_CACHE[workspace_dir] = {}
    return DOCSET_CACHE[workspace_dir]


def _estimate_cache_entry_bytes(entry: Dict[str, Any]) -> int:
    """Rough byte estimate for a cached docset entry based on source file sizes."""
    return entry.get("_approx_bytes", 0)


def _cache_docs_for_workspace(
    workspace_dir: str,
    cache_key: str,
    docs_obj: Any,
    metadata: Dict[str, Any],
    cfg: PaperQaRuntimeConfig,
) -> None:
    ws_cache = _get_workspace_doc_cache(workspace_dir)

    # Estimate bytes from source file sizes
    approx_bytes = 0
    for cid, shash in metadata.get("source_hashes", {}).items():
        for entry in ws_cache.values():
            src = entry.get("metadata", {}).get("source_hashes", {})
            if cid in src:
                break
        # Estimate ~50KB per indexed doc as fallback (conservative)
        approx_bytes += 50 * 1024

    ws_cache[cache_key] = {
        "docs": docs_obj,
        "metadata": metadata,
        "updated_at": _utc_now_iso(),
        "_approx_bytes": approx_bytes,
    }

    # Evict oldest entries until both count and byte limits are satisfied
    while len(ws_cache) > cfg.docset_cache_max_entries or _total_cache_bytes(ws_cache) > cfg.docset_cache_max_bytes:
        if len(ws_cache) <= 1:
            break
        oldest_key = sorted(
            ws_cache.keys(),
            key=lambda k: ws_cache[k].get("updated_at", ""),
        )[0]
        ws_cache.pop(oldest_key, None)


def _total_cache_bytes(ws_cache: Dict[str, Dict[str, Any]]) -> int:
    return sum(_estimate_cache_entry_bytes(v) for v in ws_cache.values())


def _classify_indexing_error(exc: Exception) -> Tuple[str, str, bool]:
    msg = str(exc)
    lowered = msg.lower()
    if _is_embedding_context_length_error(exc):
        return (
            EC_EMBEDDING_BAD_REQUEST,
            (
                "Embedding request exceeded model context length during indexing. "
                "Reduce chunk size (PQA_CHUNK_CHARS) or use a larger-context embedding model."
            ),
            False,
        )
    if (
        "badrequesterror" in lowered
        or "invalid input" in lowered
        or ("400 bad request" in lowered and "api/embed" in lowered)
    ):
        return (
            EC_EMBEDDING_BAD_REQUEST,
            "Embedding/LLM request was rejected by the local model endpoint.",
            False,
        )
    if (
        "all connection attempts failed" in lowered
        or "connection refused" in lowered
        or "timed out" in lowered
        or "connect" in lowered
    ):
        return (
            EC_OLLAMA_UNREACHABLE,
            "Unable to reach the local model endpoint during indexing.",
            True,
        )
    return (
        EC_INDEXING_FAILED,
        msg,
        False,
    )


def _is_embedding_context_length_error(exc: Exception) -> bool:
    lowered = str(exc).lower()
    return (
        "input length exceeds the context length" in lowered
        or ("api/embed" in lowered and "400 bad request" in lowered)
        or ("context length" in lowered and "embed" in lowered)
    )


def _apply_reader_chunk_config(settings: Any, chunk_chars: int, chunk_overlap: int) -> None:
    # Keep overlap strictly below chunk size to avoid invalid splitter configs.
    safe_overlap = min(max(0, chunk_overlap), max(0, chunk_chars - 1))
    settings.parsing.reader_config["chunk_chars"] = chunk_chars
    settings.parsing.reader_config["overlap"] = safe_overlap


async def _aadd_with_chunk_backoff(
    docs: Any,
    paper: Dict[str, Any],
    settings: Any,
    citation: str,
    title: str,
    authors: List[str],
    initial_chunk_chars: int,
    chunk_overlap: int,
    min_chunk_chars: int,
    max_backoff_retries: int,
) -> Tuple[int, int]:
    chunk_chars = initial_chunk_chars
    retries = 0

    while True:
        _apply_reader_chunk_config(settings, chunk_chars, chunk_overlap)
        try:
            await docs.aadd(
                paper["path"],
                citation=citation,
                docname=_safe_docname(paper["canonical_id"]),
                title=title,
                doi=paper.get("doi"),
                authors=authors,
                dockey=paper["canonical_id"],
                settings=settings,
            )
            return (chunk_chars, retries)
        except Exception as exc:
            if (
                retries >= max_backoff_retries
                or not _is_embedding_context_length_error(exc)
                or chunk_chars <= min_chunk_chars
            ):
                raise

            next_chunk = max(min_chunk_chars, chunk_chars // 2)
            if next_chunk >= chunk_chars:
                raise

            retries += 1
            logger.warning(
                "Embedding context limit for %s at chunk_chars=%s; retrying with %s",
                paper["identifier"],
                chunk_chars,
                next_chunk,
            )
            chunk_chars = next_chunk


def _classify_query_error(exc: Exception) -> Tuple[str, str, bool]:
    """Classify query-stage exceptions into typed error codes."""
    lowered = str(exc).lower()
    if (
        "timed out" in lowered
        or "readtimeout" in lowered
        or "timeout passed=" in lowered
        or "asyncio.timeouterror" in lowered
    ):
        return (
            EC_QUERY_TIMEOUT,
            "LLM query timed out. Consider increasing PQA_LLM_TIMEOUT_SECONDS or reducing PQA_EVIDENCE_K/PQA_ANSWER_MAX_SOURCES.",
            True,
        )
    if "429" in lowered or "rate limit" in lowered or "rate_limit" in lowered:
        return (
            EC_QUERY_RATE_LIMIT,
            "LLM endpoint returned a rate-limit response. Retry after a short delay.",
            True,
        )
    return (
        EC_QUERY_FAILED,
        str(exc),
        False,
    )


async def handle_analyze_papers(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main handler: acquire text via NCBI BioC, index with PaperQA2, run query.
    """
    query = payload.get("query")
    papers = payload.get("papers", [])
    workspace_dir = payload.get("workspace_dir", os.getcwd())

    if not query:
        raise SidecarEnvelopeError(
            code=EC_INVALID_REQUEST,
            message="Missing query parameter",
            stage="ipc",
            retryable=False,
        )
    if not papers:
        raise SidecarEnvelopeError(
            code=EC_INVALID_REQUEST,
            message="Missing papers list",
            stage="ipc",
            retryable=False,
        )

    try:
        from paperqa import Docs
    except ImportError as exc:
        raise SidecarEnvelopeError(
            code=EC_DEPENDENCY_MISSING,
            message=(
                "paper-qa library is not installed. Activate .venv-paperqa and "
                "run: pip install -r requirements.txt"
            ),
            stage="startup",
            retryable=False,
        ) from exc

    cfg = PaperQaRuntimeConfig.from_env()
    settings, paper_dir, index_dir = build_settings(workspace_dir, cfg)
    papers_manifest, index_manifest = _load_manifests(workspace_dir)

    await preflight_models(settings, cfg.ollama_base)

    stage_status = {
        "acquire": "pending",
        "index": "pending",
        "query": "pending",
    }
    warnings: List[str] = []

    normalized_inputs: List[Tuple[NormalizedIdentifier, Dict[str, Any]]] = []
    validation_errors: List[Dict[str, str]] = []
    dedupe_map: Dict[str, Tuple[NormalizedIdentifier, Dict[str, Any]]] = {}

    for p in papers:
        raw_identifier = (p.get("identifier") or "").strip()
        try:
            normalized = normalize_identifier(raw_identifier)
        except SidecarEnvelopeError as exc:
            validation_errors.append(
                {
                    "identifier": raw_identifier,
                    "code": exc.code,
                    "detail": exc.message,
                }
            )
            continue

        if normalized.canonical_id in dedupe_map:
            warnings.append(
                f"Duplicate identifier deduped: {raw_identifier} -> {normalized.canonical_id}"
            )
            continue

        dedupe_map[normalized.canonical_id] = (normalized, p)

    normalized_inputs = list(dedupe_map.values())

    # 1) Acquire stage (bounded concurrency)
    acquired_files: List[Dict[str, Any]] = []
    failed_downloads: List[str] = []
    failed_acquisitions: List[Dict[str, str]] = []
    abstract_only: List[str] = []
    full_text_ids: List[str] = []
    cached_ids: List[str] = []
    negative_cache_hits: List[str] = []

    if normalized_inputs:
        import httpx

        semaphore = asyncio.Semaphore(cfg.acquire_concurrency)

        async def _acquire_one(
            normalized: NormalizedIdentifier,
            meta: Dict[str, Any],
            client,
        ) -> AcquireResult:
            async with semaphore:
                return await acquire_paper_text(
                    normalized=normalized,
                    paper_dir=paper_dir,
                    papers_manifest=papers_manifest,
                    paper_meta=meta,
                    client=client,
                    max_text_chars=cfg.max_text_chars,
                    negative_cache_ttl_hours=cfg.negative_cache_ttl_hours,
                )

        async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
            tasks = [
                asyncio.create_task(_acquire_one(normalized, meta, client))
                for normalized, meta in normalized_inputs
            ]
            acquire_results = await asyncio.gather(*tasks)

        for result in acquire_results:
            if result.source == "failed":
                failed_downloads.append(result.raw_identifier)
                failed_acquisitions.append(
                    {
                        "identifier": result.raw_identifier,
                        "canonical_id": result.canonical_id,
                        "code": result.error_code or EC_ACQUIRE_NOT_FOUND,
                        "detail": result.error_detail or "Unknown acquisition failure",
                    }
                )
                if result.error_code == EC_NEGATIVE_CACHE_HIT:
                    negative_cache_hits.append(result.canonical_id)
                continue

            acquired_files.append(
                {
                    "path": result.filepath,
                    "identifier": result.raw_identifier,
                    "canonical_id": result.canonical_id,
                    "title": dedupe_map[result.canonical_id][1].get("title"),
                    "authors": dedupe_map[result.canonical_id][1].get("authors", []),
                    "doi": dedupe_map[result.canonical_id][0].doi_for_header,
                    "source": result.source,
                    "source_hash": result.source_hash,
                }
            )
            if result.source == "abstract":
                abstract_only.append(result.raw_identifier)
            elif result.source == "cached":
                cached_ids.append(result.raw_identifier)
            elif result.source == "full_text":
                full_text_ids.append(result.raw_identifier)

    if acquired_files:
        stage_status["acquire"] = "success" if not failed_acquisitions else "partial"
    else:
        stage_status["acquire"] = "failed"
        stage_status["index"] = "skipped"
        stage_status["query"] = "skipped"

        result = {
            "answer": (
                "Could not acquire text for any of the requested papers. "
                "They may not be available in PMC Open Access or PubMed."
            ),
            "references": [],
            "context": "",
            "papers_indexed": 0,
            "failed_downloads": failed_downloads,
            "failed_indexing": [],
            "failed_acquisitions": failed_acquisitions,
            "validation_errors": validation_errors,
            "stage_status": stage_status,
            "warnings": warnings,
            "acquisition_summary": {
                "full_text": full_text_ids,
                "abstract_only": abstract_only,
                "cached": cached_ids,
                "negative_cache_hits": negative_cache_hits,
            },
            "error_code": EC_ACQUIRE_NONE_SUCCESS,
            "error_detail": "No paper texts could be acquired from configured sources.",
            "retryable": False,
        }

        _save_manifests(workspace_dir, papers_manifest, index_manifest)
        return result

    # 2) Index stage (manifest + in-memory docset cache)
    docs = None
    failed_indexing: List[Dict[str, str]] = []
    indexed_count = 0
    indexed_docs: List[Dict[str, Any]] = []

    requested_docset_key = _make_docset_cache_key(acquired_files)
    ws_cache = _get_workspace_doc_cache(workspace_dir)
    cached_docset = ws_cache.get(requested_docset_key)

    if cached_docset:
        docs = cached_docset["docs"]
        indexed_count = len(acquired_files)
        indexed_docs = acquired_files.copy()
        stage_status["index"] = "success"
        warnings.append("Skipped indexing via in-memory docset cache hit.")
    else:
        docs = Docs()
        for paper in acquired_files:
            try:
                authors = paper.get("authors") or []
                authors_str = ", ".join(authors[:3]) if authors else "Unknown"
                title = paper.get("title") or paper["identifier"]
                citation = f"{authors_str}. {title}."
                used_chunk_chars, used_backoff_retries = await _aadd_with_chunk_backoff(
                    docs=docs,
                    paper=paper,
                    settings=settings,
                    citation=citation,
                    title=title,
                    authors=authors,
                    initial_chunk_chars=cfg.chunk_chars,
                    chunk_overlap=cfg.chunk_overlap,
                    min_chunk_chars=cfg.min_chunk_chars,
                    max_backoff_retries=cfg.chunk_backoff_retries,
                )
                if used_backoff_retries > 0:
                    warnings.append(
                        (
                            f"Reduced chunk size to {used_chunk_chars} for {paper['identifier']} "
                            f"after embedding context-limit errors."
                        )
                    )
                indexed_count += 1
                indexed_docs.append(paper)

                index_manifest["entries"][paper["canonical_id"]] = {
                    "canonical_id": paper["canonical_id"],
                    "source_path": paper["path"],
                    "source_hash": paper["source_hash"],
                    "indexed_hash": paper["source_hash"],
                    "last_indexed_at": _utc_now_iso(),
                }
            except Exception as exc:
                code, detail, retryable = _classify_indexing_error(exc)
                failed_indexing.append(
                    {
                        "identifier": paper["identifier"],
                        "canonical_id": paper["canonical_id"],
                        "code": code,
                        "detail": detail,
                        "retryable": retryable,
                    }
                )
                logger.warning("Failed to index %s: %s", paper["identifier"], exc)

        if indexed_count > 0:
            cache_key = _make_docset_cache_key(indexed_docs)
            _cache_docs_for_workspace(
                workspace_dir,
                cache_key,
                docs,
                {
                    "canonical_ids": [p["canonical_id"] for p in indexed_docs],
                    "source_hashes": {
                        p["canonical_id"]: p["source_hash"] for p in indexed_docs
                    },
                },
                cfg=cfg,
            )

        if indexed_count == len(acquired_files):
            stage_status["index"] = "success"
        elif indexed_count == 0:
            stage_status["index"] = "failed"
        else:
            stage_status["index"] = "partial"

    if indexed_count == 0:
        stage_status["query"] = "skipped"
        result = {
            "answer": (
                "Paper text acquisition succeeded, but none of the papers could be indexed "
                "for retrieval."
            ),
            "references": [],
            "context": "",
            "papers_indexed": 0,
            "failed_downloads": failed_downloads,
            "failed_indexing": failed_indexing,
            "failed_acquisitions": failed_acquisitions,
            "validation_errors": validation_errors,
            "stage_status": stage_status,
            "warnings": warnings,
            "acquisition_summary": {
                "full_text": full_text_ids,
                "abstract_only": abstract_only,
                "cached": cached_ids,
                "negative_cache_hits": negative_cache_hits,
            },
            "error_code": EC_INDEX_ZERO_SUCCESS,
            "error_detail": "All indexing attempts failed for acquired papers.",
            "retryable": False,
        }
        _save_manifests(workspace_dir, papers_manifest, index_manifest)
        return result

    # 3) Query stage
    try:
        session = await docs.aquery(query, settings=settings)
        stage_status["query"] = "success"

        result = {
            "answer": session.formatted_answer if hasattr(session, "formatted_answer") else str(session),
            "references": session.references if hasattr(session, "references") else [],
            "context": session.context if hasattr(session, "context") else "",
            "papers_indexed": indexed_count,
            "failed_downloads": failed_downloads,
            "failed_indexing": failed_indexing,
            "failed_acquisitions": failed_acquisitions,
            "validation_errors": validation_errors,
            "stage_status": stage_status,
            "warnings": warnings,
            "acquisition_summary": {
                "full_text": full_text_ids,
                "abstract_only": abstract_only,
                "cached": cached_ids,
                "negative_cache_hits": negative_cache_hits,
            },
            "error_code": None,
            "error_detail": None,
            "retryable": False,
        }
        _save_manifests(workspace_dir, papers_manifest, index_manifest)
        return result
    except Exception as exc:
        stage_status["query"] = "failed"
        code, detail, retryable = _classify_query_error(exc)
        raise SidecarEnvelopeError(
            code=code,
            message=f"Query execution failed: {exc}",
            stage="query",
            retryable=retryable,
            detail=detail,
        ) from exc


def _error_response(
    req_id: Optional[str],
    code: str,
    message: str,
    stage: str,
    retryable: bool,
    traceback_text: Optional[str] = None,
    detail: Optional[str] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "id": req_id,
        "error": message,
        "error_code": code,
        "error_message": message,
        "error_stage": stage,
        "retryable": retryable,
    }
    if traceback_text:
        payload["traceback"] = traceback_text
    if detail:
        payload["error_detail"] = detail
    return payload


def main():
    for line in sys.stdin:
        if not line.strip():
            continue

        req: Dict[str, Any] = {}
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            args = req.get("args", {})

            if method == "__health__":
                sys.stdout.write(json.dumps({"id": req_id, "result": {"status": "ok"}}) + "\n")
            elif method == "__shutdown__":
                sys.stdout.write(
                    json.dumps({"id": req_id, "result": {"status": "shutting_down"}}) + "\n"
                )
                sys.stdout.flush()
                sys.exit(0)
            elif method == "analyze_papers":
                result = asyncio.run(handle_analyze_papers(args))
                sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
            else:
                sys.stdout.write(
                    json.dumps(
                        _error_response(
                            req_id=req_id,
                            code=EC_UNKNOWN_METHOD,
                            message=f"Unknown method: {method}",
                            stage="ipc",
                            retryable=False,
                        )
                    )
                    + "\n"
                )

        except SidecarEnvelopeError as exc:
            sys.stdout.write(
                json.dumps(
                    _error_response(
                        req_id=req.get("id"),
                        code=exc.code,
                        message=exc.message,
                        stage=exc.stage,
                        retryable=exc.retryable,
                        traceback_text=traceback.format_exc(),
                        detail=exc.detail,
                    )
                )
                + "\n"
            )
        except Exception as exc:
            sys.stdout.write(
                json.dumps(
                    _error_response(
                        req_id=req.get("id"),
                        code=EC_UNHANDLED_ERROR,
                        message=str(exc),
                        stage="ipc",
                        retryable=False,
                        traceback_text=traceback.format_exc(),
                    )
                )
                + "\n"
            )

        sys.stdout.flush()


if __name__ == "__main__":
    main()

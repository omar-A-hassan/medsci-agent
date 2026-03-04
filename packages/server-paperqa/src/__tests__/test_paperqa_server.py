"""Tests for PaperQA sidecar acquisition + staged pipeline behavior."""

import asyncio
import hashlib
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

# Add the python directory to the path
sys.path.insert(
    0,
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "python")),
)

import paperqa_server
from paperqa_server import (
    AcquireResult,
    PaperQaRuntimeConfig,
    SidecarEnvelopeError,
    _classify_indexing_error,
    _classify_query_error,
    _fetch_bioc_abstract,
    _fetch_bioc_fulltext,
    _resolve_many_to_pmcid,
    _resolve_to_pmcid,
    acquire_paper_text,
    handle_analyze_papers,
    normalize_identifier,
    preflight_models,
)


def _mock_response(status_code: int, json_data=None):
    resp = MagicMock()
    resp.status_code = status_code
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


def _file_key(canonical_id: str) -> str:
    return hashlib.sha256(canonical_id.encode("utf-8")).hexdigest()[:24]


# --- PaperQaRuntimeConfig ---

def test_config_defaults_from_env():
    with patch.dict(os.environ, {}, clear=True):
        cfg = PaperQaRuntimeConfig.from_env()
    assert cfg.ollama_model == "ollama/medgemma:latest"
    assert cfg.ollama_base == "http://localhost:11434"
    assert cfg.embedding_model == "ollama/mxbai-embed-large"
    assert cfg.llm_timeout_seconds == 180
    assert cfg.answer_max_sources == 5
    assert cfg.evidence_k == 10
    assert cfg.docset_cache_max_entries == 8
    assert cfg.docset_cache_max_bytes == 200 * 1024 * 1024
    assert cfg.preflight_cache_ttl_seconds == 300
    assert cfg.chunk_chars == 1200
    assert cfg.chunk_overlap == 100
    assert cfg.min_chunk_chars == 400
    assert cfg.chunk_backoff_retries == 3
    assert cfg.acquire_concurrency == 3
    assert cfg.negative_cache_ttl_hours == 24
    assert cfg.max_text_chars == 1_500_000
    assert cfg.use_doc_details is False
    assert cfg.skip_preflight is False


def test_config_reads_env_overrides():
    env = {
        "PQA_LLM_MODEL": "ollama/test:latest",
        "PQA_LLM_TIMEOUT_SECONDS": "300",
        "PQA_ANSWER_MAX_SOURCES": "3",
        "PQA_EVIDENCE_K": "5",
        "PQA_DOCSET_CACHE_MAX_ENTRIES": "4",
        "PQA_CHUNK_CHARS": "800",
        "PQA_PREFLIGHT_CACHE_TTL_SECONDS": "30",
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()
    assert cfg.ollama_model == "ollama/test:latest"
    assert cfg.llm_timeout_seconds == 300
    assert cfg.answer_max_sources == 3
    assert cfg.evidence_k == 5
    assert cfg.docset_cache_max_entries == 4
    assert cfg.chunk_chars == 800
    assert cfg.preflight_cache_ttl_seconds == 30


def test_config_invalid_env_falls_back_to_default():
    env = {
        "PQA_LLM_TIMEOUT_SECONDS": "not_a_number",
        "PQA_CHUNK_CHARS": "abc",
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()
    assert cfg.llm_timeout_seconds == 180
    assert cfg.chunk_chars == 1200


def test_config_min_bound_clamping():
    env = {
        "PQA_LLM_TIMEOUT_SECONDS": "5",     # min is 30
        "PQA_CHUNK_CHARS": "10",              # min is 200
        "PQA_ACQUIRE_CONCURRENCY": "0",       # min is 1
        "PQA_EVIDENCE_K": "0",                # min is 1
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()
    assert cfg.llm_timeout_seconds == 30
    assert cfg.chunk_chars == 200
    assert cfg.acquire_concurrency == 1
    assert cfg.evidence_k == 1


# --- build_settings timeout injection ---

def test_build_settings_injects_llm_timeout():
    cfg = PaperQaRuntimeConfig.from_env()
    with tempfile.TemporaryDirectory() as tmpdir:
        settings, _, _ = paperqa_server.build_settings(tmpdir, cfg)
    # The llm_config should have timeout in litellm_params
    model_list = settings.llm_config.get("model_list", [])
    assert len(model_list) == 1
    assert model_list[0]["litellm_params"]["timeout"] == cfg.llm_timeout_seconds


def test_build_settings_uses_cfg_answer_and_evidence():
    env = {"PQA_ANSWER_MAX_SOURCES": "3", "PQA_EVIDENCE_K": "7"}
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()
    with tempfile.TemporaryDirectory() as tmpdir:
        settings, _, _ = paperqa_server.build_settings(tmpdir, cfg)
    assert settings.answer.answer_max_sources == 3
    assert settings.answer.evidence_k == 7


# --- Identifier normalization ---

def test_normalize_doi_url_resolver():
    normalized = normalize_identifier("https://doi.org/10.1056/NEJMoa1603827")
    assert normalized.kind == "doi"
    assert normalized.canonical_id == "10.1056/NEJMoa1603827"
    assert normalized.lookup_id == "10.1056/NEJMoa1603827"


def test_normalize_pmcid_uppercases():
    normalized = normalize_identifier("pmc10410527")
    assert normalized.kind == "pmcid"
    assert normalized.canonical_id == "PMC10410527"


def test_normalize_invalid_identifier_raises():
    try:
        normalize_identifier("not-an-id")
    except SidecarEnvelopeError as exc:
        assert exc.code == "INVALID_IDENTIFIER"
    else:
        raise AssertionError("Expected SidecarEnvelopeError for invalid identifier")


def test_preflight_accepts_latest_alias_for_embedding_model():
    settings = SimpleNamespace(
        llm="ollama/medgemma:latest",
        embedding="ollama/mxbai-embed-large",
    )

    mock_client = AsyncMock()
    mock_client.get.return_value = _mock_response(
        200,
        {
            "models": [
                {"name": "medgemma:latest"},
                {"name": "mxbai-embed-large:latest"},
            ]
        },
    )
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("httpx.AsyncClient", return_value=mock_client):
        asyncio.run(preflight_models(settings, "http://localhost:11434"))


def test_preflight_cache_ttl_reuses_recent_success():
    paperqa_server.PREFLIGHT_CACHE.clear()
    settings = SimpleNamespace(
        llm="ollama/medgemma:latest",
        embedding="ollama/mxbai-embed-large",
    )
    mock_client = AsyncMock()
    mock_client.get.return_value = _mock_response(
        200,
        {
            "models": [
                {"name": "medgemma:latest"},
                {"name": "mxbai-embed-large:latest"},
            ]
        },
    )
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("httpx.AsyncClient", return_value=mock_client):
        asyncio.run(preflight_models(settings, "http://localhost:11434", ttl_seconds=60))
        asyncio.run(preflight_models(settings, "http://localhost:11434", ttl_seconds=60))

    assert mock_client.get.call_count == 1


# --- _classify_indexing_error ---

def test_classify_indexing_error_context_embed_400_as_bad_request():
    exc = RuntimeError(
        "litellm.APIConnectionError: OllamaException - Client error "
        "'400 Bad Request' for url 'http://localhost:11434/api/embed'"
    )
    code, detail, retryable = _classify_indexing_error(exc)
    assert code == "EMBEDDING_BAD_REQUEST"
    assert "context length" in detail.lower()
    assert retryable is False


# --- _classify_query_error ---

def test_classify_query_error_timeout():
    exc = RuntimeError("Request timed out after 180s")
    code, detail, retryable = _classify_query_error(exc)
    assert code == "QUERY_TIMEOUT"
    assert retryable is True


def test_classify_query_error_readtimeout():
    exc = RuntimeError("ReadTimeout: connection read timed out")
    code, detail, retryable = _classify_query_error(exc)
    assert code == "QUERY_TIMEOUT"
    assert retryable is True


def test_classify_query_error_rate_limit_429():
    exc = RuntimeError("Error: 429 Too Many Requests")
    code, detail, retryable = _classify_query_error(exc)
    assert code == "QUERY_RATE_LIMIT"
    assert retryable is True


def test_classify_query_error_rate_limit_text():
    exc = RuntimeError("rate limit exceeded for model")
    code, detail, retryable = _classify_query_error(exc)
    assert code == "QUERY_RATE_LIMIT"
    assert retryable is True


def test_classify_query_error_unknown_falls_to_query_failed():
    exc = RuntimeError("some unknown error happened")
    code, detail, retryable = _classify_query_error(exc)
    assert code == "QUERY_FAILED"
    assert retryable is False


# --- _resolve_to_pmcid ---

def test_resolve_pmcid_passthrough():
    client = AsyncMock()
    result = asyncio.run(_resolve_to_pmcid("PMC10410527", client, "test@test.com"))
    assert result == ("PMC10410527", None)
    client.get.assert_not_called()


def test_resolve_doi_to_pmcid():
    client = AsyncMock()
    client.get.return_value = _mock_response(
        200, {"records": [{"pmcid": "PMC10410527", "pmid": "36856617"}]}
    )
    result = asyncio.run(_resolve_to_pmcid("10.1234/test", client, "test@test.com"))
    assert result == ("PMC10410527", "36856617")


def test_resolve_pmid_fallback_on_converter_failure():
    client = AsyncMock()
    client.get.return_value = _mock_response(500)
    result = asyncio.run(_resolve_to_pmcid("36856617", client, "test@test.com"))
    assert result == (None, "36856617")


def test_resolve_many_to_pmcid_batched():
    client = AsyncMock()
    client.get.return_value = _mock_response(
        200,
        {
            "records": [
                {
                    "requested-id": "10.1234/test",
                    "pmcid": "PMC1",
                    "pmid": "111",
                },
                {
                    "requested-id": "36856617",
                    "pmid": "36856617",
                },
            ]
        },
    )

    result = asyncio.run(
        _resolve_many_to_pmcid(
            identifiers=["10.1234/test", "36856617"],
            client=client,
            email="test@test.com",
            batch_size=10,
        )
    )

    assert result["10.1234/test"] == ("PMC1", "111")
    assert result["36856617"] == (None, "36856617")


# --- BioC parsing ---

def test_fetch_fulltext_success():
    client = AsyncMock()
    client.get.return_value = _mock_response(
        200,
        [
            {
                "documents": [
                    {
                        "passages": [
                            {"text": "Intro."},
                            {"text": "Methods."},
                            {"text": "Results."},
                        ]
                    }
                ]
            }
        ],
    )
    result = asyncio.run(_fetch_bioc_fulltext("PMC10410527", client))
    assert result == "Intro.\n\nMethods.\n\nResults."


def test_fetch_fulltext_malformed_payload_returns_none():
    client = AsyncMock()
    client.get.return_value = _mock_response(200, {"documents": []})
    result = asyncio.run(_fetch_bioc_fulltext("PMC10410527", client))
    assert result is None


def test_fetch_abstract_success():
    client = AsyncMock()
    client.get.return_value = _mock_response(
        200,
        [
            {
                "documents": [
                    {
                        "passages": [
                            {"text": "Background"},
                            {"text": "Conclusion"},
                        ]
                    }
                ]
            }
        ],
    )
    result = asyncio.run(_fetch_bioc_abstract("36856617", client))
    assert result.startswith("[ABSTRACT ONLY")
    assert "Background" in result


# --- acquire_paper_text ---

def test_acquire_negative_cache_hit_short_circuits():
    normalized = normalize_identifier("10.1056/NEJMoa1603827")
    papers_manifest = {
        "version": 1,
        "entries": {},
        "negative_cache": {
            normalized.canonical_id: {
                "code": "NEGATIVE_CACHE_HIT",
                "detail": "cached failure",
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            }
        },
    }
    client = AsyncMock()

    with tempfile.TemporaryDirectory() as tmpdir:
        result = asyncio.run(
            acquire_paper_text(
                normalized=normalized,
                paper_dir=tmpdir,
                papers_manifest=papers_manifest,
                paper_meta={},
                client=client,
            )
        )

    assert result.source == "failed"
    assert result.error_code == "NEGATIVE_CACHE_HIT"
    client.get.assert_not_called()


def test_acquire_full_text_written_with_header_and_manifest_entry():
    normalized = normalize_identifier("36856617")
    papers_manifest = {"version": 1, "entries": {}, "negative_cache": {}}

    async def mock_get(url, **kwargs):
        if "idconv" in url:
            return _mock_response(
                200, {"records": [{"pmcid": "PMC10410527", "pmid": "36856617"}]}
            )
        if "pmcoa.cgi" in url:
            return _mock_response(
                200,
                [{"documents": [{"passages": [{"text": "Full text paragraph."}]}]}],
            )
        return _mock_response(404)

    client = AsyncMock()
    client.get.side_effect = mock_get

    with tempfile.TemporaryDirectory() as tmpdir:
        result = asyncio.run(
            acquire_paper_text(
                normalized=normalized,
                paper_dir=tmpdir,
                papers_manifest=papers_manifest,
                paper_meta={"title": "Test Paper", "authors": ["A", "B"]},
                client=client,
            )
        )

        assert result.source == "full_text"
        assert result.filepath is not None

        content = open(result.filepath).read()
        assert "Title: Test Paper" in content
        assert "Full text paragraph." in content

        entry = papers_manifest["entries"][normalized.canonical_id]
        assert entry["file_key"] == _file_key(normalized.canonical_id)
        assert entry["source_hash"]


def test_acquire_rejects_text_over_size_limit():
    normalized = normalize_identifier("36856617")
    papers_manifest = {"version": 1, "entries": {}, "negative_cache": {}}

    async def mock_get(url, **kwargs):
        if "idconv" in url:
            return _mock_response(
                200, {"records": [{"pmcid": "PMC10410527", "pmid": "36856617"}]}
            )
        if "pmcoa.cgi" in url:
            return _mock_response(
                200,
                [{"documents": [{"passages": [{"text": "X" * 2000}]}]}],
            )
        return _mock_response(404)

    client = AsyncMock()
    client.get.side_effect = mock_get

    with tempfile.TemporaryDirectory() as tmpdir:
        result = asyncio.run(
            acquire_paper_text(
                normalized=normalized,
                paper_dir=tmpdir,
                papers_manifest=papers_manifest,
                paper_meta={},
                client=client,
                max_text_chars=100,
            )
        )

    assert result.source == "failed"
    assert result.error_code == "TEXT_TOO_LARGE"
    assert normalized.canonical_id in papers_manifest["negative_cache"]


# --- handle_analyze_papers staged behavior ---

def test_handle_analyze_returns_acquire_none_fail_soft():
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=None,
            source="failed",
            pmcid=None,
            source_hash=None,
            error_code="ACQUIRE_NOT_FOUND",
            error_detail="not found",
        )

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827"}],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] == "ACQUIRE_NONE_SUCCESS"
    assert result["stage_status"]["acquire"] == "failed"
    assert result["stage_status"]["index"] == "skipped"
    assert result["stage_status"]["query"] == "skipped"
    assert result["references"] == []
    assert result["context"] == ""


def test_handle_analyze_returns_index_zero_fail_soft():
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\n\n---\n\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="full_text",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(side_effect=RuntimeError("embedding failed"))

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827", "title": "LEADER"}],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] == "INDEX_ZERO_SUCCESS"
    assert result["stage_status"]["acquire"] in {"success", "partial"}
    assert result["stage_status"]["index"] == "failed"
    assert result["stage_status"]["query"] == "skipped"
    assert result["papers_indexed"] == 0


def test_handle_analyze_failed_indexing_retryable_is_boolean():
    """Ensure failed_indexing entries have boolean retryable, not string."""
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\n\n---\n\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="full_text",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(side_effect=RuntimeError("connection refused"))

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827", "title": "LEADER"}],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert len(result["failed_indexing"]) == 1
    assert isinstance(result["failed_indexing"][0]["retryable"], bool)


def test_handle_analyze_success_contract_invariants_and_deduping():
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\n\n---\n\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="cached",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    session = SimpleNamespace(
        formatted_answer="Answer body",
        references=["Ref1"],
        context="ctx",
    )
    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(return_value="doc")
    docs_instance.aquery = AsyncMock(return_value=session)

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ):
        payload = {
            "query": "test query",
            "papers": [
                {"identifier": "https://doi.org/10.1056/NEJMoa1603827", "title": "LEADER"},
                {"identifier": "10.1056/NEJMoa1603827", "title": "LEADER duplicate"},
                {"identifier": "invalid-id"},
            ],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] is None
    assert result["stage_status"] == {
        "acquire": "success",
        "index": "success",
        "query": "success",
    }
    assert result["papers_indexed"] == 1
    assert isinstance(result["warnings"], list)
    assert any("Duplicate identifier deduped" in w for w in result["warnings"])
    assert result["validation_errors"][0]["code"] == "INVALID_IDENTIFIER"
    assert result["acquisition_summary"]["cached"]
    assert result["references"] == ["Ref1"]
    assert result["context"] == "ctx"


def test_handle_analyze_stub_query_mode_skips_aquery():
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\\n\\n---\\n\\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="full_text",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(return_value="doc")
    docs_instance.aquery = AsyncMock(return_value=SimpleNamespace())

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ), patch.dict(os.environ, {"PQA_TEST_MODE": "stub_query"}, clear=False):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827", "title": "LEADER"}],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] is None
    assert result["stage_status"]["query"] == "success"
    assert result["answer"].startswith("[stub_query]")
    docs_instance.aquery.assert_not_called()


def test_handle_analyze_documents_take_precedence_over_papers():
    paperqa_server.DOCSET_CACHE.clear()

    session = SimpleNamespace(
        formatted_answer="Answer body",
        references=["Ref1"],
        context="ctx",
    )
    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(return_value="doc")
    docs_instance.aquery = AsyncMock(return_value=session)

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock()) as mocked_acquire, patch(
        "paperqa.Docs", return_value=docs_instance
    ):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827"}],
            "documents": [
                {
                    "source_id": "doc-1",
                    "source_type": "url",
                    "provenance_url": "https://example.org/paper",
                    "retrieval_method": "scrapling_html",
                    "license_hint": "unknown",
                    "text": "Full imported text body",
                    "text_hash": "abc123",
                    "metadata": {"title": "Imported Paper", "authors": ["A", "B"]},
                    "extraction_confidence": 0.8,
                    "policy": {"allowed": True, "blocked": False},
                    "content_level": "full_text",
                }
            ],
            "prefer_documents": True,
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    mocked_acquire.assert_not_called()
    assert result["error_code"] is None
    assert result["papers_indexed"] == 1
    assert result["stage_status"]["query"] == "success"
    assert any("documents input took precedence" in w for w in result["warnings"])


def test_handle_analyze_invalid_document_input_surfaces_validation():
    paperqa_server.DOCSET_CACHE.clear()
    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ):
        payload = {
            "query": "test query",
            "documents": [
                {
                    # missing source_id
                    "source_type": "url",
                    "provenance_url": "https://example.org/paper",
                    "text": "Body",
                }
            ],
            "prefer_documents": True,
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] == "ACQUIRE_NONE_SUCCESS"
    assert result["stage_status"]["acquire"] == "failed"
    assert any(v["code"] == "INVALID_DOCUMENT_INPUT" for v in result["validation_errors"])


def test_handle_analyze_retries_indexing_with_smaller_chunks():
    paperqa_server.DOCSET_CACHE.clear()
    observed_chunks: list[int] = []

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\n\n---\n\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="cached",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    async def flaky_aadd(*args, **kwargs):
        settings = kwargs["settings"]
        observed_chunks.append(settings.parsing.reader_config["chunk_chars"])
        if len(observed_chunks) == 1:
            raise RuntimeError(
                "Client error '400 Bad Request' for url 'http://localhost:11434/api/embed'"
            )
        return "doc"

    session = SimpleNamespace(
        formatted_answer="Answer body",
        references=["Ref1"],
        context="ctx",
    )
    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(side_effect=flaky_aadd)
    docs_instance.aquery = AsyncMock(return_value=session)

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ), patch.dict(
        os.environ,
        {
            "PQA_CHUNK_CHARS": "1200",
            "PQA_CHUNK_MIN_CHARS": "400",
            "PQA_CHUNK_BACKOFF_RETRIES": "2",
            "PQA_CHUNK_OVERLAP": "100",
        },
        clear=False,
    ):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827", "title": "LEADER"}],
            "workspace_dir": tmpdir,
        }
        result = asyncio.run(handle_analyze_papers(payload))

    assert result["error_code"] is None
    assert result["stage_status"]["index"] == "success"
    assert result["stage_status"]["query"] == "success"
    assert result["papers_indexed"] == 1
    assert observed_chunks[0] == 1200
    assert observed_chunks[1] == 600
    assert any("Reduced chunk size to 600" in w for w in result["warnings"])


def test_handle_analyze_query_timeout_raises_retryable():
    """Query-stage timeout produces QUERY_TIMEOUT with retryable=true."""
    paperqa_server.DOCSET_CACHE.clear()

    async def fake_acquire(*args, **kwargs):
        normalized = kwargs["normalized"]
        paper_dir = kwargs["paper_dir"]
        path = os.path.join(paper_dir, f"{_file_key(normalized.canonical_id)}.txt")
        os.makedirs(paper_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Title: X\n\n---\n\nBody")
        return AcquireResult(
            canonical_id=normalized.canonical_id,
            raw_identifier=normalized.raw_identifier,
            filepath=path,
            source="full_text",
            pmcid="PMC1",
            source_hash=hashlib.sha256(open(path, "rb").read()).hexdigest(),
            error_code=None,
            error_detail=None,
        )

    docs_instance = MagicMock()
    docs_instance.aadd = AsyncMock(return_value="doc")
    docs_instance.aquery = AsyncMock(
        side_effect=RuntimeError("Request timed out after 180s")
    )

    with tempfile.TemporaryDirectory() as tmpdir, patch(
        "paperqa_server.preflight_models", AsyncMock()
    ), patch("paperqa_server.acquire_paper_text", AsyncMock(side_effect=fake_acquire)), patch(
        "paperqa.Docs", return_value=docs_instance
    ):
        payload = {
            "query": "test query",
            "papers": [{"identifier": "10.1056/NEJMoa1603827", "title": "LEADER"}],
            "workspace_dir": tmpdir,
        }
        try:
            asyncio.run(handle_analyze_papers(payload))
            raise AssertionError("Expected SidecarEnvelopeError")
        except SidecarEnvelopeError as exc:
            assert exc.code == "QUERY_TIMEOUT"
            assert exc.retryable is True
            assert exc.stage == "query"


# --- Cache eviction ---

def test_cache_eviction_by_entry_count():
    """Docset cache evicts oldest when exceeding max_entries."""
    from paperqa_server import _cache_docs_for_workspace, _get_workspace_doc_cache

    paperqa_server.DOCSET_CACHE.clear()
    paperqa_server.DOCSET_CACHE_BYTES.clear()
    env = {"PQA_DOCSET_CACHE_MAX_ENTRIES": "2"}
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()

    ws = "/test/workspace"
    for i in range(3):
        _cache_docs_for_workspace(
            ws,
            f"key_{i}",
            MagicMock(),
            {"source_hashes": {}},
            cfg=cfg,
        )

    ws_cache = _get_workspace_doc_cache(ws)
    assert len(ws_cache) <= 2
    # Oldest key (key_0) should have been evicted
    assert "key_0" not in ws_cache
    paperqa_server.DOCSET_CACHE.clear()
    paperqa_server.DOCSET_CACHE_BYTES.clear()


def test_cache_eviction_by_byte_limit_uses_source_paths():
    from paperqa_server import _cache_docs_for_workspace, _get_workspace_doc_cache

    paperqa_server.DOCSET_CACHE.clear()
    paperqa_server.DOCSET_CACHE_BYTES.clear()
    env = {
        "PQA_DOCSET_CACHE_MAX_ENTRIES": "10",
        "PQA_DOCSET_CACHE_MAX_BYTES": "1048576",
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = PaperQaRuntimeConfig.from_env()

    ws = "/test/workspace-bytes"
    with tempfile.TemporaryDirectory() as tmpdir:
        p1 = os.path.join(tmpdir, "a.txt")
        p2 = os.path.join(tmpdir, "b.txt")
        with open(p1, "w", encoding="utf-8") as f:
            f.write("A" * 700_000)
        with open(p2, "w", encoding="utf-8") as f:
            f.write("B" * 700_000)

        _cache_docs_for_workspace(
            ws,
            "key_1",
            MagicMock(),
            {"source_hashes": {"doc-1": "h1"}, "source_paths": {"doc-1": p1}},
            cfg=cfg,
        )
        _cache_docs_for_workspace(
            ws,
            "key_2",
            MagicMock(),
            {"source_hashes": {"doc-2": "h2"}, "source_paths": {"doc-2": p2}},
            cfg=cfg,
        )

    ws_cache = _get_workspace_doc_cache(ws)
    assert len(ws_cache) <= 1
    paperqa_server.DOCSET_CACHE.clear()
    paperqa_server.DOCSET_CACHE_BYTES.clear()

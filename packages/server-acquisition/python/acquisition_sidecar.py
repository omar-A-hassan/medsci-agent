#!/usr/bin/env python3
"""
Acquisition sidecar for Scrapling-backed extraction.

Protocol:
  Request:  {"id":"...","method":"extract_html","args":{"html":"...","url":"..."}}
  Response: {"id":"...","result":...} or {"id":"...","error":"..."}
"""

import json
import os
import re
import sys
import traceback
from typing import Any, Dict, Optional, Tuple

try:
    from bs4 import BeautifulSoup  # type: ignore
except Exception:  # pragma: no cover
    BeautifulSoup = None


def _env_truthy(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _load_scrapling() -> Tuple[Optional[Any], Optional[str]]:
    try:
        import scrapling  # type: ignore

        return scrapling, str(getattr(scrapling, "__version__", "unknown"))
    except Exception:
        return None, None


def _extract_with_scrapling(
    html: str, url: str
) -> Optional[Tuple[str, Optional[str], float, Optional[str]]]:
    """
    Best-effort Scrapling integration.
    API variations are handled defensively because Scrapling versions can differ.
    """
    scrapling, scrapling_version = _load_scrapling()
    if scrapling is None:
        return None

    adaptor = None

    constructors = []
    if hasattr(scrapling, "Selector"):
        constructors.append(lambda: scrapling.Selector(content=html, url=url))
        constructors.append(lambda: scrapling.Selector(html, url=url))
    if hasattr(scrapling, "Adaptor"):
        constructors.append(lambda: scrapling.Adaptor(html, url=url))
        constructors.append(lambda: scrapling.Adaptor(html=html, url=url))
        constructors.append(lambda: scrapling.Adaptor(text=html, url=url))
    if hasattr(scrapling, "Scraper"):
        constructors.append(lambda: scrapling.Scraper(html=html, url=url))

    for ctor in constructors:
        try:
            adaptor = ctor()
            if adaptor is not None:
                break
        except Exception:
            continue

    if adaptor is None:
        return None

    title = None
    text = None

    for title_attr in ("title", "page_title"):
        value = getattr(adaptor, title_attr, None)
        if isinstance(value, str) and value.strip():
            title = value.strip()
            break
    if not title:
        css_fn = getattr(adaptor, "css", None)
        if callable(css_fn):
            try:
                title_candidate = css_fn("title::text").get()
                if isinstance(title_candidate, str) and title_candidate.strip():
                    title = title_candidate.strip()
            except Exception:
                pass

    for method in ("get_all_text", "get_text", "text", "to_text", "markdown", "to_markdown"):
        fn = getattr(adaptor, method, None)
        if callable(fn):
            try:
                value = fn()
                if isinstance(value, str) and value.strip():
                    text = value
                    break
            except Exception:
                continue

    if not text:
        for attr in ("text", "markdown", "content"):
            value = getattr(adaptor, attr, None)
            if isinstance(value, str) and value.strip():
                text = value
                break

    if not text:
        return None

    normalized = re.sub(r"\s+", " ", text).strip()
    return normalized, title, 0.85, scrapling_version


def _extract_fallback(html: str) -> Tuple[str, Optional[str], float, str]:
    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.extract()
        text = re.sub(r"\s+", " ", soup.get_text(" ")).strip()
        title = soup.title.get_text(" ").strip() if soup.title else None
        return text, title, 0.45, "beautifulsoup"

    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else None
    return text, title, 0.35, "regex"


def _handle_extract_html(args: Dict[str, Any]) -> Dict[str, Any]:
    html = str(args.get("html", ""))
    url = str(args.get("url", ""))
    require_scrapling = bool(args.get("require_scrapling", True))
    if not html:
        raise ValueError("html is required")
    if not url:
        raise ValueError("url is required")

    extracted = _extract_with_scrapling(html, url)
    if extracted is not None:
        text, title, confidence, scrapling_version = extracted
        if not text:
            raise ValueError("extraction produced empty text")
        return {
            "text": text,
            "title": title,
            "extraction_confidence": confidence,
            "extraction_backend": "scrapling",
            "fallback_used": False,
            "scrapling_version": scrapling_version,
        }

    if require_scrapling:
        raise RuntimeError(
            "SCRAPLING_REQUIRED: Scrapling backend required but unavailable for HTML extraction"
        )

    text, title, confidence, backend = _extract_fallback(html)
    if not text:
        raise ValueError("extraction produced empty text")
    return {
        "text": text,
        "title": title,
        "extraction_confidence": confidence,
        "extraction_backend": backend,
        "fallback_used": True,
        "scrapling_version": None,
    }


def _health_status() -> Dict[str, Any]:
    require_scrapling = _env_truthy("ACQ_REQUIRE_SCRAPLING", True)
    scrapling, scrapling_version = _load_scrapling()
    has_scrapling = scrapling is not None
    has_bs4 = BeautifulSoup is not None
    if require_scrapling and not has_scrapling:
        raise RuntimeError(
            "SCRAPLING_REQUIRED: Startup check failed because ACQ_REQUIRE_SCRAPLING=true and scrapling is missing"
        )
    return {
        "status": "ok",
        "has_scrapling": has_scrapling,
        "has_bs4": has_bs4,
        "scrapling_version": scrapling_version,
        "require_scrapling": require_scrapling,
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req_id = "?"
        try:
            req = json.loads(line)
            req_id = req.get("id", "?")
            method = req.get("method", "")
            args = req.get("args", {})

            if method == "__health__":
                sys.stdout.write(json.dumps({"id": req_id, "result": _health_status()}) + "\n")
            elif method == "__shutdown__":
                sys.stdout.write(
                    json.dumps({"id": req_id, "result": {"status": "shutting_down"}}) + "\n"
                )
                sys.stdout.flush()
                break
            elif method == "extract_html":
                result = _handle_extract_html(args)
                sys.stdout.write(json.dumps({"id": req_id, "result": result}) + "\n")
            else:
                sys.stdout.write(
                    json.dumps({"id": req_id, "error": f"Unknown method: {method}"}) + "\n"
                )
        except Exception as exc:
            tb = traceback.format_exc()
            sys.stderr.write(f"[acquisition-sidecar] error: {tb}\n")
            sys.stderr.flush()
            sys.stdout.write(json.dumps({"id": req_id, "error": str(exc)}) + "\n")

        sys.stdout.flush()


if __name__ == "__main__":
    main()

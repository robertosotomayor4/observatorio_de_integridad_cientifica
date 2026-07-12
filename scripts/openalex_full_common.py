#!/usr/bin/env python3
"""Funciones compartidas para la integración OpenAlex del universo completo."""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable

BASE = "https://api.openalex.org"
USER_AGENT = "ObservatorioIntegridadCientifica/1.0 (+https://github.com/robertosotomayor4/observatorio_de_integridad_cientifica)"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_issn(value: str | None) -> str:
    raw = re.sub(r"[^0-9Xx]", "", value or "").upper()
    return f"{raw[:4]}-{raw[4:]}" if len(raw) == 8 else ""


def split_issns(value: str | None) -> list[str]:
    output: list[str] = []
    for token in re.split(r"[;,|\s]+", value or ""):
        issn = normalize_issn(token)
        if issn and issn not in output:
            output.append(issn)
    return output


def normalized_title(value: str | None) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).split())


def title_similarity(left: str | None, right: str | None) -> float:
    a, b = normalized_title(left), normalized_title(right)
    if not a or not b:
        return 0.0
    return round(SequenceMatcher(None, a, b).ratio(), 4)


def source_key(source_id: str | None) -> str:
    return (source_id or "").rstrip("/").split("/")[-1]


def chunked(values: list[Any], size: int) -> Iterable[list[Any]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def load_catalog(path: str | Path) -> tuple[list[str], list[list[Any]]]:
    target = Path(path)
    if target.suffix == ".gz":
        with gzip.open(target, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.loads(target.read_text(encoding="utf-8"))
    return payload["fields"], payload["rows"]


def catalog_records(path: str | Path) -> list[dict[str, Any]]:
    fields, rows = load_catalog(path)
    output: list[dict[str, Any]] = []
    for values in rows:
        record = {field: values[idx] if idx < len(values) else "" for idx, field in enumerate(fields)}
        record["_issns"] = split_issns(record.get("issns"))
        output.append(record)
    return output


def read_overrides(path: str | Path) -> dict[str, dict[str, str]]:
    target = Path(path)
    if not target.exists():
        return {}
    with target.open(encoding="utf-8-sig", newline="") as handle:
        return {
            row["journal_id"]: row
            for row in csv.DictReader(handle)
            if row.get("journal_id") and row.get("openalex_source_id")
        }


def write_json(path: str | Path, payload: Any, *, gzip_copy: bool = False) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(target)
    if gzip_copy:
        gz = Path(str(target) + ".gz")
        gz_temp = Path(str(gz) + ".tmp")
        with gzip.open(gz_temp, "wb", compresslevel=9) as handle:
            handle.write(text.encode("utf-8"))
        gz_temp.replace(gz)


def load_json(path: str | Path, default: Any = None) -> Any:
    target = Path(path)
    if not target.exists():
        return default
    return json.loads(target.read_text(encoding="utf-8"))


def write_csv_gz(path: str | Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(target, "wt", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def request_json(
    endpoint: str,
    params: dict[str, Any],
    *,
    max_attempts: int = 7,
    timeout: int = 90,
) -> tuple[dict[str, Any], dict[str, str]]:
    url = endpoint + "?" + urllib.parse.urlencode(params, doseq=True)
    last_error: Exception | None = None
    for attempt in range(max_attempts):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
                headers = {key.lower(): value for key, value in response.headers.items()}
                return payload, headers
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code == 429 or 500 <= exc.code < 600:
                retry_after = exc.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else min(60.0, (2 ** attempt) + random.random())
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(min(30.0, (2 ** attempt) + random.random()))
    raise RuntimeError(f"OpenAlex no respondió después de {max_attempts} intentos: {last_error}")


def rate_limit(api_key: str) -> dict[str, Any]:
    payload, _ = request_json(f"{BASE}/rate-limit", {"api_key": api_key})
    return payload.get("rate_limit") or {}


def detail_chunk(record: dict[str, Any]) -> str:
    value = str(record.get("detail_chunk") or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{2}", value):
        return value
    digest = hashlib.sha256(str(record.get("journal_id") or "").encode("utf-8")).hexdigest()
    return digest[:2]


def compact_source(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": source.get("id") or "",
        "display_name": source.get("display_name") or "",
        "type": source.get("type") or "",
        "issn_l": source.get("issn_l") or "",
        "issn": source.get("issn") or [],
        "homepage_url": source.get("homepage_url") or "",
        "country_code": source.get("country_code") or "",
        "host_organization": source.get("host_organization") or "",
        "host_organization_name": source.get("host_organization_name") or "",
        "works_count": source.get("works_count", 0),
        "cited_by_count": source.get("cited_by_count", 0),
        "is_oa": source.get("is_oa"),
        "is_in_doaj": source.get("is_in_doaj"),
        "apc_usd": source.get("apc_usd"),
        "summary_stats": source.get("summary_stats") or {},
        "counts_by_year": source.get("counts_by_year") or [],
        "updated_date": source.get("updated_date") or "",
    }


def quality_flags(source: dict[str, Any], similarity: float) -> list[dict[str, Any]]:
    flags: list[dict[str, Any]] = []
    if similarity < 0.60:
        flags.append({
            "code": "low_title_similarity",
            "message": "El ISSN coincide, pero el título de OpenAlex difiere significativamente; requiere revisión humana.",
            "value": similarity,
        })
    counts = sorted(source.get("counts_by_year") or [], key=lambda item: int(item.get("year") or 0))
    stable_start = None
    for index, item in enumerate(counts):
        if int(item.get("works_count") or 0) < 5:
            continue
        window = counts[index:index + 3]
        if sum(int(candidate.get("works_count") or 0) >= 5 for candidate in window) >= 2:
            stable_start = int(item.get("year") or 0)
            break
    if stable_start:
        early = [
            {"year": item.get("year"), "works_count": item.get("works_count", 0)}
            for item in counts
            if int(item.get("year") or 0) < stable_start - 2 and int(item.get("works_count") or 0) > 0
        ]
        if early:
            flags.append({
                "code": "isolated_early_records",
                "message": "OpenAlex contiene registros aislados anteriores al inicio de la serie sostenida; se excluyen de la gráfica pública.",
                "stable_series_start": stable_start,
                "records": early,
            })
    return flags


def compact_core_openalex(source: dict[str, Any], match: dict[str, Any], status: str) -> dict[str, Any]:
    flags = quality_flags(source, float(match.get("title_similarity") or 0.0))
    stable_start = next(
        (int(flag["stable_series_start"]) for flag in flags if flag.get("code") == "isolated_early_records" and flag.get("stable_series_start")),
        None,
    )
    production: list[dict[str, Any]] = []
    for item in source.get("counts_by_year") or []:
        year = int(item.get("year") or 0)
        if stable_start and year < stable_start:
            continue
        production.append({
            "year": year,
            "works_count": int(item.get("works_count") or 0),
            "cited_by_count": int(item.get("cited_by_count") or 0),
            "oa_works_count": int(item.get("oa_works_count") or 0),
        })
    production.sort(key=lambda item: item["year"])
    total_works = sum(item["works_count"] for item in production)
    total_oa = sum(item["oa_works_count"] for item in production)
    oa_share = round((total_oa / total_works) * 100, 1) if total_works else None
    return {
        "status": status,
        "match_status": match.get("match_status") or "",
        "match_confidence": match.get("match_confidence") or "",
        "match_note": match.get("override_reason") or "",
        "title_similarity": match.get("title_similarity"),
        "source": compact_source(source),
        "production_by_year": production,
        "stable_series_start": stable_start,
        "oa_share": oa_share,
        "top": {"topics": [], "countries": [], "institutions": []},
        "quality_flags": [
            {
                "code": flag.get("code"),
                "message": flag.get("message") or "",
                "stable_series_start": flag.get("stable_series_start"),
            }
            for flag in flags
        ],
        "retracted_works": [],
    }

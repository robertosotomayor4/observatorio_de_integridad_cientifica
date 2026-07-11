#!/usr/bin/env python3
"""Construye un JSON compacto para integrar OpenAlex y evidencias en la web."""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OA_PATH = ROOT / "data/openalex/pilot_openalex.json"
CR_PATH = ROOT / "data/evidencias/crossref_events_clean.json"
WEB_PATH = ROOT / "data/evidencias/web_scraping_pilot.json"
OUT_PATH = ROOT / "data/complementary/pilot_integrated.json"


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pick_top(items: list[dict[str, Any]] | None, limit: int = 5) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in items or []:
        name = item.get("name")
        if not name:
            continue
        output.append({"name": name, "count": item.get("count", 0)})
        if len(output) >= limit:
            break
    return output


def compact_openalex(record: dict[str, Any]) -> dict[str, Any]:
    source = record.get("source") or {}
    match = record.get("match") or {}
    flags = record.get("quality_flags") or []
    production = record.get("production_by_year") or []

    stable_start = None
    for flag in flags:
        if flag.get("code") == "isolated_early_records" and flag.get("stable_series_start"):
            stable_start = int(flag["stable_series_start"])
            break

    filtered = []
    for item in production:
        year = item.get("year")
        if stable_start and isinstance(year, int) and year < stable_start:
            continue
        filtered.append({
            "year": year,
            "works_count": item.get("works_count", 0),
            "cited_by_count": item.get("cited_by_count", 0),
            "oa_works_count": item.get("oa_works_count", 0),
        })
    filtered.sort(key=lambda x: int(x.get("year") or 0))

    total_works = sum(int(x.get("works_count") or 0) for x in filtered)
    total_oa = sum(int(x.get("oa_works_count") or 0) for x in filtered)
    oa_share = round((total_oa / total_works) * 100, 1) if total_works else None

    top = record.get("top") or {}
    retracted = []
    for item in record.get("retracted_works") or []:
        retracted.append({
            "title": item.get("display_name") or "Obra marcada como retractada",
            "doi": item.get("doi") or "",
            "year": item.get("publication_year"),
            "cited_by_count": item.get("cited_by_count", 0),
        })

    return {
        "status": record.get("status"),
        "match_status": match.get("match_status"),
        "match_confidence": match.get("match_confidence"),
        "match_note": match.get("override_reason") or "",
        "title_similarity": match.get("title_similarity"),
        "source": {
            "id": source.get("id") or "",
            "display_name": source.get("display_name") or "",
            "homepage_url": source.get("homepage_url") or "",
            "host_organization_name": source.get("host_organization_name") or "",
            "country_code": source.get("country_code") or "",
            "works_count": source.get("works_count", 0),
            "cited_by_count": source.get("cited_by_count", 0),
            "is_oa": source.get("is_oa"),
            "is_in_doaj": source.get("is_in_doaj"),
            "apc_usd": source.get("apc_usd"),
            "summary_stats": source.get("summary_stats") or {},
            "updated_date": source.get("updated_date") or "",
        },
        "production_by_year": filtered,
        "stable_series_start": stable_start,
        "oa_share": oa_share,
        "top": {
            "topics": pick_top(top.get("topics"), 5),
            "countries": pick_top(top.get("countries"), 5),
            "institutions": pick_top(top.get("institutions"), 5),
        },
        "quality_flags": [
            {
                "code": flag.get("code"),
                "message": flag.get("message") or "",
                "stable_series_start": flag.get("stable_series_start"),
            }
            for flag in flags
        ],
        "retracted_works": retracted,
    }


def compact_crossref(record: dict[str, Any]) -> dict[str, Any]:
    events = []
    for event in record.get("events") or []:
        events.append({
            "event_type": event.get("event_type") or "",
            "severity": event.get("severity") or "",
            "notice_doi": event.get("notice_doi") or "",
            "notice_title": event.get("notice_title") or "",
            "notice_url": event.get("notice_url") or "",
            "notice_date": event.get("notice_date") or "",
            "work_doi": event.get("work_doi") or "",
            "metadata_source": event.get("metadata_source") or "",
            "review_status": event.get("review_status") or "pending_human_review",
        })
    return {
        "status": record.get("status"),
        "event_counts": record.get("event_counts") or {},
        "high_signal_count": record.get("high_signal_count", 0),
        "informational_count": record.get("informational_count", 0),
        "events": events,
    }


def compact_web(record: dict[str, Any]) -> dict[str, Any]:
    pages = []
    for page in record.get("pages") or []:
        if not page.get("usable"):
            continue
        categories = sorted((page.get("categories_found") or {}).keys())
        pages.append({
            "url": page.get("url") or "",
            "title": page.get("title") or "Página editorial",
            "categories": categories,
        })
    return {
        "status": record.get("status"),
        "homepage_url": record.get("homepage_url") or "",
        "pages": pages,
        "review_status": record.get("review_status") or "pending_human_review",
    }


def main() -> None:
    oa = load(OA_PATH)
    cr = load(CR_PATH)
    web = load(WEB_PATH)

    records: dict[str, dict[str, Any]] = {}
    for item in oa.get("records", []):
        jid = item.get("journal_id")
        if jid:
            records.setdefault(jid, {})["openalex"] = compact_openalex(item)
    for item in cr.get("records", []):
        jid = item.get("journal_id")
        if jid:
            records.setdefault(jid, {})["crossref"] = compact_crossref(item)
    for item in web.get("records", []):
        jid = item.get("journal_id")
        if jid:
            records.setdefault(jid, {})["web"] = compact_web(item)

    payload = {
        "version": "1.0",
        "generated_at": oa.get("generated_at") or cr.get("generated_at") or web.get("generated_at"),
        "scope": "pilot",
        "journal_count": len(records),
        "interpretation": "Información complementaria automatizada, pendiente de revisión humana cuando corresponde.",
        "records": records,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT_PATH.write_text(text, encoding="utf-8")
    with gzip.open(str(OUT_PATH) + ".gz", "wb", compresslevel=9) as handle:
        handle.write(text.encode("utf-8"))
    print(f"Generado {OUT_PATH} con {len(records)} revistas")


if __name__ == "__main__":
    main()

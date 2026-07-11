#!/usr/bin/env python3
"""Cruce piloto de revistas con OpenAlex por ISSN/eISSN."""
from __future__ import annotations

import argparse
import os
import urllib.error
from pathlib import Path

from common import http_json, normalize_issn, read_pilot_csv, utc_now, write_csv, write_json

BASE = "https://api.openalex.org"
GROUP_FIELDS = {
    "topics": "primary_topic.id",
    "countries": "authorships.countries",
    "institutions": "authorships.institutions.id",
    "authors": "authorships.author.id",
    "oa_status": "open_access.oa_status",
}


def source_key(source_id: str) -> str:
    return (source_id or "").rstrip("/").split("/")[-1]


def resolve_source(row: dict[str, str], api_key: str) -> tuple[dict | None, dict]:
    attempted = []
    candidates: dict[str, dict] = {}
    for raw in (row.get("issn", ""), row.get("eissn", "")):
        issn = normalize_issn(raw)
        if not issn or issn in attempted:
            continue
        attempted.append(issn)
        try:
            source = http_json(f"{BASE}/sources/issn:{issn}", {"api_key": api_key})
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue
            raise
        candidates[source_key(source.get("id", ""))] = source
    audit = {
        "attempted_issns": attempted,
        "candidate_source_ids": sorted(candidates),
        "match_status": "not_found" if not candidates else ("exact_unique" if len(candidates) == 1 else "ambiguous"),
    }
    if len(candidates) != 1:
        return None, audit
    source = next(iter(candidates.values()))
    source_issns = {normalize_issn(x) for x in source.get("issn", []) if normalize_issn(x)}
    audit["matched_issns"] = sorted(source_issns.intersection(attempted))
    audit["match_confidence"] = "high" if audit["matched_issns"] else "review"
    return source, audit


def group_works(source_id: str, field: str, api_key: str, limit: int = 10) -> list[dict]:
    payload = http_json(
        f"{BASE}/works",
        {
            "api_key": api_key,
            "filter": f"primary_location.source.id:{source_key(source_id)}",
            "group_by": field,
            "per_page": limit,
        },
    )
    groups = payload.get("group_by") or []
    return [
        {
            "id": item.get("key"),
            "name": item.get("key_display_name"),
            "count": item.get("count", 0),
        }
        for item in groups[:limit]
    ]


def retracted_works(source_id: str, api_key: str) -> list[dict]:
    payload = http_json(
        f"{BASE}/works",
        {
            "api_key": api_key,
            "filter": f"primary_location.source.id:{source_key(source_id)},is_retracted:true",
            "select": "id,display_name,doi,publication_year,cited_by_count",
            "per_page": 100,
        },
    )
    return payload.get("results") or []


def compact_source(source: dict) -> dict:
    return {
        "id": source.get("id"),
        "display_name": source.get("display_name"),
        "type": source.get("type"),
        "issn_l": source.get("issn_l"),
        "issn": source.get("issn") or [],
        "homepage_url": source.get("homepage_url"),
        "country_code": source.get("country_code"),
        "host_organization": source.get("host_organization"),
        "host_organization_name": source.get("host_organization_name"),
        "works_count": source.get("works_count"),
        "cited_by_count": source.get("cited_by_count"),
        "is_oa": source.get("is_oa"),
        "is_in_doaj": source.get("is_in_doaj"),
        "apc_usd": source.get("apc_usd"),
        "summary_stats": source.get("summary_stats") or {},
        "counts_by_year": source.get("counts_by_year") or [],
        "updated_date": source.get("updated_date"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/pilot_journals.csv")
    parser.add_argument("--output", default="data/openalex/pilot_openalex.json")
    parser.add_argument("--audit", default="data/openalex/pilot_openalex_audit.csv")
    parser.add_argument("--max-journals", type=int, default=30)
    args = parser.parse_args()

    api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Falta el secreto OPENALEX_API_KEY.")

    journals = read_pilot_csv(args.config, args.max_journals)
    records = []
    audit_rows = []
    for index, row in enumerate(journals, start=1):
        print(f"[{index}/{len(journals)}] OpenAlex: {row['title']}")
        record = {
            "journal_id": row["journal_id"],
            "title": row["title"],
            "input_issn": row.get("issn", ""),
            "input_eissn": row.get("eissn", ""),
            "selection_reason": row.get("selection_reason", ""),
            "priority": row.get("priority", ""),
        }
        try:
            source, audit = resolve_source(row, api_key)
            record["match"] = audit
            if source:
                sid = source.get("id", "")
                record["source"] = compact_source(source)
                record["production_by_year"] = [
                    {
                        "year": item.get("year"),
                        "works_count": item.get("works_count", 0),
                        "cited_by_count": item.get("cited_by_count", 0),
                        "oa_works_count": item.get("oa_works_count", 0),
                    }
                    for item in (source.get("counts_by_year") or [])
                ]
                record["top"] = {
                    name: group_works(sid, field, api_key)
                    for name, field in GROUP_FIELDS.items()
                }
                record["retracted_works"] = retracted_works(sid, api_key)
                record["status"] = "matched"
            else:
                record["status"] = audit["match_status"]
        except Exception as exc:
            record["status"] = "error"
            record["error"] = f"{type(exc).__name__}: {exc}"
        records.append(record)
        audit_rows.append({
            "journal_id": row["journal_id"],
            "title": row["title"],
            "issn": row.get("issn", ""),
            "eissn": row.get("eissn", ""),
            "status": record.get("status", ""),
            "openalex_source_id": (record.get("source") or {}).get("id", ""),
            "openalex_title": (record.get("source") or {}).get("display_name", ""),
            "match_confidence": (record.get("match") or {}).get("match_confidence", ""),
            "error": record.get("error", ""),
        })

    write_json(args.output, {
        "version": "1.0",
        "generated_at": utc_now(),
        "source": "OpenAlex API",
        "scope": "pilot",
        "journal_count": len(records),
        "records": records,
    })
    write_csv(args.audit, audit_rows, [
        "journal_id", "title", "issn", "eissn", "status",
        "openalex_source_id", "openalex_title", "match_confidence", "error",
    ])


if __name__ == "__main__":
    main()

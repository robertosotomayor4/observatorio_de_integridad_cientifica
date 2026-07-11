#!/usr/bin/env python3
"""Cruce piloto de revistas con OpenAlex por ISSN/eISSN."""
from __future__ import annotations

import argparse
import os
import urllib.error
import re
from difflib import SequenceMatcher
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


def normalized_title(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).split())


def title_similarity(left: str, right: str) -> float:
    a, b = normalized_title(left), normalized_title(right)
    if not a or not b:
        return 0.0
    return round(SequenceMatcher(None, a, b).ratio(), 4)


def read_overrides(path: str | Path) -> dict[str, dict[str, str]]:
    target = Path(path)
    if not target.exists():
        return {}
    import csv
    with target.open(encoding="utf-8-sig", newline="") as handle:
        return {row["journal_id"]: row for row in csv.DictReader(handle) if row.get("journal_id") and row.get("openalex_source_id")}


def source_by_id(source_id: str, api_key: str) -> dict:
    sid = source_key(source_id)
    return http_json(f"{BASE}/sources/{sid}", {"api_key": api_key})


def production_quality_flags(source: dict, title_score: float) -> list[dict]:
    flags: list[dict] = []
    if title_score < 0.6:
        flags.append({
            "code": "low_title_similarity",
            "message": "El ISSN coincide, pero el título de OpenAlex difiere significativamente; requiere revisión humana.",
            "value": title_score,
        })
    counts = sorted((source.get("counts_by_year") or []), key=lambda x: x.get("year") or 0)
    stable_start = None
    for idx, item in enumerate(counts):
        if (item.get("works_count") or 0) < 5:
            continue
        future = counts[idx:idx + 3]
        if sum((x.get("works_count") or 0) >= 5 for x in future) >= 2:
            stable_start = item.get("year")
            break
    if stable_start:
        early = [
            {"year": x.get("year"), "works_count": x.get("works_count", 0)}
            for x in counts
            if (x.get("year") or 0) < stable_start - 2 and (x.get("works_count") or 0) > 0
        ]
        if early:
            flags.append({
                "code": "isolated_early_records",
                "message": "OpenAlex contiene registros aislados anteriores al inicio de la serie sostenida; no deben graficarse sin validación.",
                "stable_series_start": stable_start,
                "records": early,
            })
    return flags


def resolve_source(row: dict[str, str], api_key: str, override: dict[str, str] | None = None) -> tuple[dict | None, dict]:
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
        "candidate_sources": [
            {
                "id": source.get("id"),
                "display_name": source.get("display_name"),
                "issn": source.get("issn") or [],
                "works_count": source.get("works_count"),
                "title_similarity": title_similarity(row.get("title", ""), source.get("display_name", "")),
            }
            for source in candidates.values()
        ],
        "match_status": "not_found" if not candidates else ("exact_unique" if len(candidates) == 1 else "ambiguous"),
    }
    if len(candidates) != 1:
        if override:
            override_id = source_key(override.get("openalex_source_id", ""))
            if override_id:
                source = candidates.get(override_id) or source_by_id(override_id, api_key)
                audit["match_status"] = "manual_override"
                audit["override_source_id"] = source.get("id")
                audit["override_reason"] = override.get("reason", "")
                audit["match_confidence"] = "reviewed_override"
                audit["title_similarity"] = title_similarity(row.get("title", ""), source.get("display_name", ""))
                return source, audit
        return None, audit
    source = next(iter(candidates.values()))
    source_issns = {normalize_issn(x) for x in source.get("issn", []) if normalize_issn(x)}
    audit["matched_issns"] = sorted(source_issns.intersection(attempted))
    audit["title_similarity"] = title_similarity(row.get("title", ""), source.get("display_name", ""))
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
    parser.add_argument("--overrides", default="config/openalex_overrides.csv")
    parser.add_argument("--max-journals", type=int, default=30)
    args = parser.parse_args()

    api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Falta el secreto OPENALEX_API_KEY.")

    journals = read_pilot_csv(args.config, args.max_journals)
    overrides = read_overrides(args.overrides)
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
            source, audit = resolve_source(row, api_key, overrides.get(row["journal_id"]))
            record["match"] = audit
            if source:
                sid = source.get("id", "")
                record["source"] = compact_source(source)
                record["quality_flags"] = production_quality_flags(source, audit.get("title_similarity", 0.0))
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
                record["status"] = "matched_manual_override" if audit.get("match_status") == "manual_override" else "matched"
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
            "title_similarity": (record.get("match") or {}).get("title_similarity", ""),
            "candidate_sources": str((record.get("match") or {}).get("candidate_sources", "")),
            "override_reason": (record.get("match") or {}).get("override_reason", ""),
            "quality_flags": str(record.get("quality_flags") or []),
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
        "openalex_source_id", "openalex_title", "match_confidence", "title_similarity", "candidate_sources", "override_reason", "quality_flags", "error",
    ])


if __name__ == "__main__":
    main()

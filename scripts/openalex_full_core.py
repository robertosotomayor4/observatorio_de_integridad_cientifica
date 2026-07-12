#!/usr/bin/env python3
"""Cruza todo el catálogo del Observatorio con OpenAlex y genera datos básicos fragmentados."""
from __future__ import annotations

import argparse
import os
import urllib.error
from collections import defaultdict
from pathlib import Path
from typing import Any

from openalex_full_common import (
    BASE,
    catalog_records,
    compact_core_openalex,
    detail_chunk,
    normalize_issn,
    read_overrides,
    request_json,
    source_key,
    split_issns,
    title_similarity,
    utc_now,
    write_csv_gz,
    write_json,
)

SELECT_FIELDS = ",".join([
    "id", "display_name", "type", "issn_l", "issn", "homepage_url", "country_code",
    "host_organization", "host_organization_name", "works_count", "cited_by_count",
    "is_oa", "is_in_doaj", "apc_usd", "summary_stats", "counts_by_year", "updated_date",
])


def query_sources(issns: list[str], api_key: str, counters: dict[str, int]) -> list[dict[str, Any]]:
    """Consulta fuentes en lotes y divide el lote si devuelve más de 100 resultados."""
    if not issns:
        return []
    params = {
        "api_key": api_key,
        "filter": "issn:" + "|".join(issns),
        "per_page": 100,
        "select": SELECT_FIELDS,
    }
    try:
        payload, _ = request_json(f"{BASE}/sources", params)
    except urllib.error.HTTPError as exc:
        # Algunos cambios de esquema pueden volver inválido select; reintenta sin select.
        if exc.code == 400:
            params.pop("select", None)
            payload, _ = request_json(f"{BASE}/sources", params)
        else:
            raise
    counters["api_calls"] += 1
    count = int((payload.get("meta") or {}).get("count") or 0)
    if count > 100 and len(issns) > 1:
        midpoint = len(issns) // 2
        return query_sources(issns[:midpoint], api_key, counters) + query_sources(issns[midpoint:], api_key, counters)
    return payload.get("results") or []


def candidate_score(journal: dict[str, Any], source: dict[str, Any]) -> tuple[int, float, int]:
    input_issns = set(journal.get("_issns") or [])
    source_issns = {normalize_issn(value) for value in source.get("issn") or [] if normalize_issn(value)}
    matched_count = len(input_issns.intersection(source_issns))
    similarity = title_similarity(journal.get("preferred_title"), source.get("display_name"))
    works_count = int(source.get("works_count") or 0)
    return matched_count, similarity, works_count


def resolve_source(
    journal: dict[str, Any],
    candidates: list[dict[str, Any]],
    override: dict[str, str] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    unique = {source_key(item.get("id")): item for item in candidates if source_key(item.get("id"))}
    ranked = sorted(
        unique.values(),
        key=lambda source: candidate_score(journal, source),
        reverse=True,
    )
    audit_candidates = [
        {
            "id": item.get("id") or "",
            "display_name": item.get("display_name") or "",
            "issn": item.get("issn") or [],
            "matched_issn_count": candidate_score(journal, item)[0],
            "title_similarity": candidate_score(journal, item)[1],
            "works_count": candidate_score(journal, item)[2],
        }
        for item in ranked
    ]
    match: dict[str, Any] = {
        "attempted_issns": journal.get("_issns") or [],
        "candidate_source_ids": [source_key(item.get("id")) for item in ranked],
        "candidate_sources": audit_candidates,
        "match_status": "not_found" if not ranked else ("exact_unique" if len(ranked) == 1 else "ambiguous"),
    }
    if override:
        wanted = source_key(override.get("openalex_source_id"))
        selected = unique.get(wanted)
        if selected:
            match.update({
                "match_status": "manual_override",
                "match_confidence": "reviewed_override",
                "override_source_id": selected.get("id"),
                "override_reason": override.get("reason") or "",
                "title_similarity": title_similarity(journal.get("preferred_title"), selected.get("display_name")),
            })
            return selected, match
    if not ranked:
        return None, match
    if len(ranked) == 1:
        selected = ranked[0]
        score = candidate_score(journal, selected)
        match.update({
            "match_confidence": "high" if score[0] else "review",
            "title_similarity": score[1],
            "matched_issns": sorted(set(journal.get("_issns") or []).intersection({normalize_issn(value) for value in selected.get("issn") or [] if normalize_issn(value)})),
        })
        return selected, match

    top, second = ranked[0], ranked[1]
    top_score = candidate_score(journal, top)
    second_score = candidate_score(journal, second)
    # Selección automática conservadora: más ISSN coincidentes o título claramente superior.
    safe = top_score[0] > second_score[0] or (top_score[1] >= 0.82 and top_score[1] - second_score[1] >= 0.12)
    if safe:
        match.update({
            "match_status": "resolved_multiple",
            "match_confidence": "high",
            "resolution_rule": "issn_count_or_title_margin",
            "title_similarity": top_score[1],
        })
        return top, match
    return None, match


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog.json")
    parser.add_argument("--overrides", default="config/openalex_overrides.csv")
    parser.add_argument("--output-dir", default="data/openalex_full/core")
    parser.add_argument("--manifest", default="data/openalex_full/manifest.json")
    parser.add_argument("--audit", default="data/openalex_full/audit/openalex_core_audit.csv.gz")
    parser.add_argument("--batch-size", type=int, default=50)
    args = parser.parse_args()

    api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Falta el secreto OPENALEX_API_KEY.")

    journals = catalog_records(args.catalog)
    overrides = read_overrides(args.overrides)
    all_issns = sorted({issn for journal in journals for issn in journal.get("_issns") or []})
    counters = defaultdict(int)
    by_issn: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)

    print(f"Catálogo: {len(journals):,} revistas; {len(all_issns):,} ISSN únicos.")
    for start in range(0, len(all_issns), args.batch_size):
        batch = all_issns[start:start + args.batch_size]
        sources = query_sources(batch, api_key, counters)
        for source in sources:
            sid = source_key(source.get("id"))
            for raw in source.get("issn") or []:
                issn = normalize_issn(raw)
                if issn:
                    by_issn[issn][sid] = source
        if start % (args.batch_size * 20) == 0:
            print(f"ISSN consultados: {min(start + args.batch_size, len(all_issns)):,}/{len(all_issns):,}")

    generated_at = utc_now()
    shards: dict[str, dict[str, Any]] = defaultdict(dict)
    audit_rows: list[dict[str, Any]] = []
    status_counts = defaultdict(int)

    for index, journal in enumerate(journals, start=1):
        candidate_map: dict[str, dict[str, Any]] = {}
        for issn in journal.get("_issns") or []:
            candidate_map.update(by_issn.get(issn) or {})
        selected, match = resolve_source(journal, list(candidate_map.values()), overrides.get(str(journal.get("journal_id"))))
        if selected:
            status = "matched_manual_override" if match.get("match_status") == "manual_override" else "matched"
            openalex = compact_core_openalex(selected, match, status)
        else:
            status = str(match.get("match_status") or "not_found")
            openalex = {
                "status": status,
                "match_status": status,
                "match_confidence": "review" if status == "ambiguous" else "",
                "match_note": "",
                "title_similarity": None,
                "source": {},
                "production_by_year": [],
                "stable_series_start": None,
                "oa_share": None,
                "top": {"topics": [], "countries": [], "institutions": []},
                "quality_flags": [],
                "retracted_works": [],
            }
        status_counts[status] += 1
        jid = str(journal.get("journal_id") or "")
        shards[detail_chunk(journal)][jid] = openalex
        audit_rows.append({
            "journal_id": jid,
            "title": journal.get("preferred_title") or "",
            "issns": "; ".join(journal.get("_issns") or []),
            "status": status,
            "openalex_source_id": (openalex.get("source") or {}).get("id") or "",
            "openalex_title": (openalex.get("source") or {}).get("display_name") or "",
            "match_confidence": openalex.get("match_confidence") or "",
            "title_similarity": openalex.get("title_similarity"),
            "candidate_count": len(match.get("candidate_sources") or []),
            "candidate_sources": str(match.get("candidate_sources") or []),
            "resolution_rule": match.get("resolution_rule") or "",
            "override_reason": match.get("override_reason") or "",
        })
        if index % 5000 == 0:
            print(f"Revistas resueltas: {index:,}/{len(journals):,}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for chunk, records in sorted(shards.items()):
        write_json(output_dir / f"{chunk}.json", {
            "version": "1.0",
            "generated_at": generated_at,
            "scope": "full_catalog_core",
            "chunk": chunk,
            "records": records,
        }, gzip_copy=True)

    manifest = {
        "version": "1.0",
        "generated_at": generated_at,
        "scope": "full_catalog",
        "catalog_journals": len(journals),
        "unique_issns": len(all_issns),
        "api_calls": counters["api_calls"],
        "status_counts": dict(sorted(status_counts.items())),
        "core_complete": True,
        "enrichment_complete": False,
        "core_chunks": sorted(shards),
        "interpretation": "Cobertura básica de OpenAlex para todo el catálogo; los datos enriquecidos se completan progresivamente.",
    }
    write_json(args.manifest, manifest, gzip_copy=True)
    write_csv_gz(args.audit, audit_rows, [
        "journal_id", "title", "issns", "status", "openalex_source_id", "openalex_title",
        "match_confidence", "title_similarity", "candidate_count", "candidate_sources",
        "resolution_rule", "override_reason",
    ])
    print("Resumen:", manifest["status_counts"])
    print(f"Llamadas facturables aproximadas: {counters['api_calls']:,} (list+filter).")


if __name__ == "__main__":
    main()

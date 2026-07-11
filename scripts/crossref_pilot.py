#!/usr/bin/env python3
"""Busca y depura correcciones, retractaciones y otras actualizaciones en Crossref por ISSN."""
from __future__ import annotations

import argparse
import collections
import urllib.error
from typing import Any

from common import http_json, normalize_issn, read_pilot_csv, utc_now, write_json

BASE = "https://api.crossref.org/v1/works"
SELECT = "DOI,title,container-title,ISSN,published,created,URL,update-to,relation,type"
RECOGNIZED_EVENTS = {
    "retraction", "expression_of_concern", "withdrawal", "removal",
    "correction", "erratum", "corrigendum", "addendum",
}
HIGH_SIGNAL_EVENTS = {"retraction", "expression_of_concern", "withdrawal", "removal"}


def crossref_items(issn: str, relation_filter: str, max_items: int = 500) -> list[dict]:
    cursor = "*"
    items: list[dict] = []
    while cursor and len(items) < max_items:
        payload = http_json(
            BASE,
            {
                "filter": f"issn:{issn},{relation_filter}",
                "select": SELECT,
                "rows": min(100, max_items - len(items)),
                "cursor": cursor,
            },
            headers={"User-Agent": "ObservatorioIntegridadCientifica/1.0 (+https://github.com/robertosotomayor4/observatorio_de_integridad_cientifica)"},
        )
        message = payload.get("message") or {}
        batch = message.get("items") or []
        items.extend(batch)
        next_cursor = message.get("next-cursor")
        if not batch or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    return items[:max_items]


def first_valid_issn(row: dict[str, str]) -> str:
    return normalize_issn(row.get("issn", "")) or normalize_issn(row.get("eissn", ""))


def compact(item: dict, evidence_role: str) -> dict:
    return {
        "evidence_role": evidence_role,
        "doi": item.get("DOI"),
        "title": (item.get("title") or [""])[0],
        "container_title": (item.get("container-title") or [""])[0],
        "issn": item.get("ISSN") or [],
        "type": item.get("type"),
        "published": item.get("published"),
        "created": item.get("created"),
        "url": item.get("URL"),
        "update_to": item.get("update-to") or [],
        "relation": item.get("relation") or {},
        "review_status": "pending_human_review",
    }


def iso_date(value: Any) -> str:
    try:
        parts = value["date-parts"][0]
        return "-".join(str(part).zfill(2) for part in parts)
    except Exception:
        return ""


def normalized_events(item: dict) -> list[dict]:
    """Convierte un registro Crossref en eventos explícitos y auditables."""
    events: list[dict] = []
    item_doi = (item.get("doi") or "").lower()
    item_title = item.get("title") or ""
    item_url = item.get("url") or ""
    item_date = iso_date(item.get("published")) or iso_date(item.get("created"))
    role = item.get("evidence_role") or ""

    # Un aviso de actualización apunta a la obra afectada mediante update-to.
    for update in item.get("update_to") or []:
        event_type = str(update.get("type") or "").lower()
        if event_type not in RECOGNIZED_EVENTS:
            continue
        events.append({
            "event_type": event_type,
            "severity": "high_signal" if event_type in HIGH_SIGNAL_EVENTS else "informational",
            "notice_doi": item_doi,
            "notice_title": item_title,
            "notice_url": item_url,
            "notice_date": item_date,
            "work_doi": str(update.get("DOI") or update.get("doi") or "").lower(),
            "metadata_source": update.get("source") or "crossref",
            "record_id": update.get("record-id"),
            "evidence_roles": [role] if role else [],
            "review_status": "pending_human_review",
        })

    # En una obra actualizada, relation suele apuntar al aviso; se invierte para
    # mantener siempre work_doi = obra afectada y notice_doi = aviso.
    relation = item.get("relation") or {}
    for relation_type, relations in relation.items():
        event_type = str(relation_type or "").lower()
        if event_type not in RECOGNIZED_EVENTS:
            continue
        if not isinstance(relations, list):
            relations = [relations]
        for rel in relations:
            related_doi = str((rel or {}).get("id") or "").lower()
            if role == "work_updated":
                notice_doi, work_doi = related_doi, item_doi
                notice_title, notice_url, notice_date = "", "", ""
            else:
                notice_doi, work_doi = item_doi, related_doi
                notice_title, notice_url, notice_date = item_title, item_url, item_date
            events.append({
                "event_type": event_type,
                "severity": "high_signal" if event_type in HIGH_SIGNAL_EVENTS else "informational",
                "notice_doi": notice_doi,
                "notice_title": notice_title,
                "notice_url": notice_url,
                "notice_date": notice_date,
                "work_doi": work_doi,
                "metadata_source": "crossref_relation",
                "record_id": None,
                "evidence_roles": [role] if role else [],
                "review_status": "pending_human_review",
            })

    # La consulta específica puede devolver un aviso sin relación explícita.
    if role == "retraction_notice" and not any(e["event_type"] == "retraction" for e in events):
        events.append({
            "event_type": "retraction",
            "severity": "high_signal",
            "notice_doi": item_doi,
            "notice_title": item_title,
            "notice_url": item_url,
            "notice_date": item_date,
            "work_doi": "",
            "metadata_source": "crossref_filter",
            "record_id": None,
            "evidence_roles": [role],
            "review_status": "pending_human_review",
        })
    return events


def deduplicate_events(raw_records: list[dict]) -> dict:
    clean_records = []
    totals = collections.Counter()
    for rec in raw_records:
        merged: dict[tuple, dict] = {}
        dropped_without_event = 0
        for item in rec.get("evidence") or []:
            events = normalized_events(item)
            if not events:
                dropped_without_event += 1
            for event in events:
                doi_pair = tuple(sorted(doi for doi in (event["notice_doi"], event["work_doi"]) if doi))
                key = (event["event_type"], doi_pair or (event["notice_url"],))
                if key in merged:
                    merged[key]["evidence_roles"] = sorted(set(merged[key]["evidence_roles"] + event["evidence_roles"]))
                    if merged[key]["metadata_source"] == "crossref_filter" and event["metadata_source"] != "crossref_filter":
                        merged[key]["metadata_source"] = event["metadata_source"]
                else:
                    merged[key] = event
        events = sorted(merged.values(), key=lambda x: (x["severity"] != "high_signal", x["event_type"], x["notice_date"], x["notice_doi"]))
        counts = collections.Counter(event["event_type"] for event in events)
        for key, value in counts.items():
            totals[key] += value
        clean_records.append({
            "journal_id": rec.get("journal_id"),
            "title": rec.get("title"),
            "issn_used": rec.get("issn_used"),
            "events": events,
            "event_counts": dict(sorted(counts.items())),
            "high_signal_count": sum(event["severity"] == "high_signal" for event in events),
            "informational_count": sum(event["severity"] == "informational" for event in events),
            "raw_evidence_count": len(rec.get("evidence") or []),
            "dropped_without_explicit_event": dropped_without_event,
            "query_errors": rec.get("query_errors") or [],
            "status": rec.get("status"),
        })
    return {
        "version": "1.2",
        "generated_at": utc_now(),
        "source": "Crossref REST API; eventos normalizados y deduplicados",
        "scope": "pilot",
        "interpretation": "Las correcciones y erratas son informativas. Retracciones, expresiones de preocupación, retiros y removals requieren revisión humana prioritaria.",
        "totals_by_event_type": dict(sorted(totals.items())),
        "high_signal_total": sum(totals[t] for t in HIGH_SIGNAL_EVENTS),
        "records": clean_records,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/pilot_journals.csv")
    parser.add_argument("--output", default="data/evidencias/crossref_updates.json")
    parser.add_argument("--clean-output", default="data/evidencias/crossref_events_clean.json")
    parser.add_argument("--max-journals", type=int, default=30)
    args = parser.parse_args()

    records = []
    for index, row in enumerate(read_pilot_csv(args.config, args.max_journals), start=1):
        print(f"[{index}] Crossref: {row['title']}")
        issn = first_valid_issn(row)
        rec = {"journal_id": row["journal_id"], "title": row["title"], "issn_used": issn, "evidence": []}
        if not issn:
            rec["status"] = "no_issn"
            records.append(rec)
            continue
        seen = set()
        rec["query_errors"] = []
        queries = (
            ("has-update:true", "work_updated"),
            ("is-update:true", "update_notice"),
            ("update-type:retraction", "retraction_notice"),
        )
        for filter_name, role in queries:
            try:
                for item in crossref_items(issn, filter_name):
                    key = (item.get("DOI") or item.get("URL"), role)
                    if key in seen:
                        continue
                    seen.add(key)
                    rec["evidence"].append(compact(item, role))
            except urllib.error.HTTPError as exc:
                rec["query_errors"].append({"filter": filter_name, "error": f"HTTP {exc.code}"})
            except Exception as exc:
                rec["query_errors"].append({"filter": filter_name, "error": f"{type(exc).__name__}: {exc}"})
        if rec["query_errors"] and not rec["evidence"]:
            rec["status"] = "partial_error"
        elif rec["query_errors"]:
            rec["status"] = "ok_with_warnings"
        else:
            rec["status"] = "ok"
        records.append(rec)

    raw_payload = {
        "version": "1.2",
        "generated_at": utc_now(),
        "source": "Crossref REST API (incluye metadatos de fuentes confiables como Retraction Watch cuando están disponibles)",
        "scope": "pilot",
        "records": records,
    }
    write_json(args.output, raw_payload)
    write_json(args.clean_output, deduplicate_events(records))


if __name__ == "__main__":
    main()

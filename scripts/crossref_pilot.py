#!/usr/bin/env python3
"""Busca correcciones, retractaciones y otras actualizaciones en Crossref por ISSN."""
from __future__ import annotations

import argparse
import urllib.error

from common import http_json, normalize_issn, read_pilot_csv, utc_now, write_json

BASE = "https://api.crossref.org/v1/works"
SELECT = "DOI,title,container-title,ISSN,published,created,URL,update-to,relation,type,subtype"


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
        "subtype": item.get("subtype"),
        "published": item.get("published"),
        "created": item.get("created"),
        "url": item.get("URL"),
        "update_to": item.get("update-to") or [],
        "relation": item.get("relation") or {},
        "review_status": "pending_human_review",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/pilot_journals.csv")
    parser.add_argument("--output", default="data/evidencias/crossref_updates.json")
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
        try:
            seen = set()
            for filter_name, role in (("has-update:true", "work_updated"), ("is-update:true", "update_notice")):
                for item in crossref_items(issn, filter_name):
                    key = (item.get("DOI"), role)
                    if key in seen:
                        continue
                    seen.add(key)
                    rec["evidence"].append(compact(item, role))
            rec["status"] = "ok"
        except urllib.error.HTTPError as exc:
            rec["status"] = "error"
            rec["error"] = f"HTTP {exc.code}"
        except Exception as exc:
            rec["status"] = "error"
            rec["error"] = f"{type(exc).__name__}: {exc}"
        records.append(rec)

    write_json(args.output, {
        "version": "1.0",
        "generated_at": utc_now(),
        "source": "Crossref REST API (incluye metadatos de fuentes confiables como Retraction Watch cuando están disponibles)",
        "scope": "pilot",
        "records": records,
    })


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Enriquece progresivamente todo el catálogo con temas, países e instituciones de OpenAlex."""
from __future__ import annotations

import argparse
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from openalex_full_common import BASE, load_json, rate_limit, request_json, source_key, utc_now, write_json

GROUP_FIELDS = {
    "topics": "primary_topic.id",
    "countries": "authorships.countries",
    "institutions": "authorships.institutions.id",
}


def load_core_records(core_dir: Path) -> list[tuple[str, str, dict[str, Any]]]:
    output: list[tuple[str, str, dict[str, Any]]] = []
    for path in sorted(core_dir.glob("[0-9a-f][0-9a-f].json")):
        payload = load_json(path, {}) or {}
        for journal_id, record in (payload.get("records") or {}).items():
            source = record.get("source") or {}
            if record.get("status", "").startswith("matched") and source.get("id"):
                output.append((path.stem, journal_id, record))
    return output


def load_existing(enriched_dir: Path) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for path in sorted(enriched_dir.glob("[0-9a-f][0-9a-f].json")):
        payload = load_json(path, {}) or {}
        output.update(payload.get("records") or {})
    return output


def group_works(source_id: str, field: str, api_key: str, limit: int = 5) -> list[dict[str, Any]]:
    payload, _ = request_json(
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
            "id": item.get("key") or "",
            "name": item.get("key_display_name") or "",
            "count": int(item.get("count") or 0),
        }
        for item in groups[:limit]
        if item.get("key_display_name")
    ]


def enrich_one(item: tuple[str, str, dict[str, Any]], api_key: str) -> tuple[str, str, dict[str, Any]]:
    chunk, journal_id, core = item
    source = core.get("source") or {}
    source_id = source.get("id") or ""
    top: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    for name, field in GROUP_FIELDS.items():
        try:
            top[name] = group_works(source_id, field, api_key)
        except Exception as exc:  # se registra por categoría y se continúa
            top[name] = []
            errors[name] = f"{type(exc).__name__}: {exc}"
    return chunk, journal_id, {
        "source_id": source_id,
        "source_updated_date": source.get("updated_date") or "",
        "top": top,
        "enriched_at": utc_now(),
        "errors": errors,
        "complete": not errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core-dir", default="data/openalex_full/core")
    parser.add_argument("--enriched-dir", default="data/openalex_full/enriched")
    parser.add_argument("--manifest", default="data/openalex_full/manifest.json")
    parser.add_argument("--max-journals", type=int, default=2500)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--minimum-budget-usd", type=float, default=0.08)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Falta el secreto OPENALEX_API_KEY.")

    core_dir = Path(args.core_dir)
    enriched_dir = Path(args.enriched_dir)
    enriched_dir.mkdir(parents=True, exist_ok=True)
    manifest = load_json(args.manifest, {}) or {}
    core_records = load_core_records(core_dir)
    existing = load_existing(enriched_dir)

    queue: list[tuple[str, str, dict[str, Any]]] = []
    for item in core_records:
        _, journal_id, core = item
        previous = existing.get(journal_id)
        source = core.get("source") or {}
        stale = previous and previous.get("source_updated_date") != (source.get("updated_date") or "")
        if args.refresh or not previous or stale or not previous.get("complete"):
            queue.append(item)

    budget = rate_limit(api_key)
    remaining = float(budget.get("daily_remaining_usd") or 0.0) + float(budget.get("prepaid_remaining_usd") or 0.0)
    # Cada revista consume tres llamadas list+filter, aproximadamente USD 0.0003.
    budget_capacity = max(0, int((remaining - args.minimum_budget_usd) / 0.0003))
    limit = min(args.max_journals, budget_capacity, len(queue))
    selected = queue[:limit]

    print(f"Fuentes OpenAlex con núcleo: {len(core_records):,}")
    print(f"Ya enriquecidas: {len(existing):,}; pendientes: {len(queue):,}")
    print(f"Presupuesto restante: USD {remaining:.4f}; se procesarán {len(selected):,} revistas.")
    if not selected:
        print("No hay revistas para procesar o el presupuesto diario disponible es insuficiente.")
        changed = False
        if manifest.get("enrichment_remaining") != len(queue):
            manifest["enrichment_remaining"] = len(queue)
            changed = True
        complete = len(queue) == 0
        if manifest.get("enrichment_complete") != complete:
            manifest["enrichment_complete"] = complete
            changed = True
        if changed:
            manifest["last_enrichment_run"] = utc_now()
            write_json(args.manifest, manifest, gzip_copy=True)
        return

    results: list[tuple[str, str, dict[str, Any]]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 16))) as executor:
        futures = {executor.submit(enrich_one, item, api_key): item[1] for item in selected}
        for index, future in enumerate(as_completed(futures), start=1):
            journal_id = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                chunk, _, core = next(item for item in selected if item[1] == journal_id)
                results.append((chunk, journal_id, {
                    "source_id": (core.get("source") or {}).get("id") or "",
                    "source_updated_date": (core.get("source") or {}).get("updated_date") or "",
                    "top": {"topics": [], "countries": [], "institutions": []},
                    "enriched_at": utc_now(),
                    "errors": {"general": f"{type(exc).__name__}: {exc}"},
                    "complete": False,
                }))
            if index % 100 == 0 or index == len(selected):
                print(f"Enriquecidas: {index:,}/{len(selected):,}")

    by_chunk: dict[str, dict[str, Any]] = {}
    # Carga por shard para conservar registros previos.
    for chunk in {item[0] for item in results}:
        current = load_json(enriched_dir / f"{chunk}.json", {}) or {}
        by_chunk[chunk] = dict(current.get("records") or {})
    for chunk, journal_id, record in results:
        by_chunk.setdefault(chunk, {})[journal_id] = record

    generated_at = utc_now()
    for chunk, records in sorted(by_chunk.items()):
        write_json(enriched_dir / f"{chunk}.json", {
            "version": "1.0",
            "generated_at": generated_at,
            "scope": "full_catalog_enrichment",
            "chunk": chunk,
            "records": records,
        }, gzip_copy=True)

    accumulated = load_existing(enriched_dir)
    completed_total = sum(1 for record in accumulated.values() if record.get("complete"))
    remaining_total = max(0, len(core_records) - completed_total)
    manifest["last_enrichment_run"] = generated_at
    manifest["enriched_journals"] = completed_total
    manifest["enrichment_remaining"] = remaining_total
    manifest["enrichment_complete"] = remaining_total == 0
    manifest["enrichment_batch_size"] = len(selected)
    manifest["enrichment_strategy"] = "Temas, países e instituciones por lotes diarios, respetando el presupuesto de OpenAlex."
    write_json(args.manifest, manifest, gzip_copy=True)
    print(f"Cobertura enriquecida acumulada: {completed_total:,}/{len(core_records):,}")


if __name__ == "__main__":
    main()

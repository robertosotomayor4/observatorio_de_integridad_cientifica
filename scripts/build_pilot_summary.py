#!/usr/bin/env python3
"""Genera un resumen legible y crítico del piloto."""
from __future__ import annotations

import json
from pathlib import Path

from common import utc_now


def load(path: str):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> None:
    oa = load("data/openalex/pilot_openalex.json")
    cr = load("data/evidencias/crossref_updates.json")
    ws = load("data/evidencias/web_scraping_pilot.json")
    oa_records = oa.get("records", [])
    cr_records = cr.get("records", [])
    ws_records = ws.get("records", [])
    matched = sum(r.get("status") == "matched" for r in oa_records)
    ambiguous = sum(r.get("status") == "ambiguous" for r in oa_records)
    errors = sum(r.get("status") == "error" for r in oa_records)
    retracted_by_journal = [(r.get("title"), len(r.get("retracted_works") or [])) for r in oa_records if r.get("retracted_works")]
    retracted = sum(count for _, count in retracted_by_journal)
    crossref_items = sum(len(r.get("evidence") or []) for r in cr_records)
    crossref_errors = sum(r.get("status") in {"partial_error", "error"} for r in cr_records)
    scraped_ok = sum(r.get("status") == "ok" for r in ws_records)
    challenge = sum(r.get("status") == "challenge_or_invalid_page" for r in ws_records)
    blocked = sum(r.get("status") == "blocked_by_robots" for r in ws_records)
    http_errors = sum(r.get("status") == "http_error" for r in ws_records)
    technical_errors = sum(r.get("status") == "error" for r in ws_records)
    no_homepage = sum(r.get("status") == "no_safe_homepage" for r in ws_records)
    lines = [
        "# Resumen del piloto OpenAlex y evidencias",
        "",
        f"Generado: {utc_now()}",
        "",
        "## OpenAlex",
        f"- Revistas procesadas: {len(oa_records)}",
        f"- Cruces únicos por ISSN/eISSN: {matched}",
        f"- Cruces ambiguos: {ambiguous}",
        f"- Errores técnicos: {errors}",
        f"- Obras marcadas como retractadas en OpenAlex: {retracted}",
    ]
    if retracted_by_journal:
        lines += [f"  - {title}: {count}" for title, count in retracted_by_journal]
    lines += [
        "",
        "## Crossref",
        f"- Registros de actualización, corrección o retractación recuperados: {crossref_items}",
        f"- Revistas con errores de consulta: {crossref_errors}",
        "",
        "## Sitios editoriales",
        f"- Sitios con páginas utilizables: {scraped_ok}",
        f"- Páginas de desafío, bloqueo o 404 detectadas: {challenge}",
        f"- Sitios bloqueados por robots.txt: {blocked}",
        f"- Respuestas HTTP de acceso denegado: {http_errors}",
        f"- Otros errores técnicos: {technical_errors}",
        f"- Sin página segura disponible: {no_homepage}",
        "",
        "## Regla de interpretación",
        "Los resultados son evidencia preliminar y quedan pendientes de revisión humana. La ausencia de información no se interpreta automáticamente como incumplimiento. Las obras marcadas como retractadas deben deduplicarse y verificarse antes de asociarlas a una señal editorial.",
        "",
    ]
    Path("data/piloto/resumen_piloto.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()

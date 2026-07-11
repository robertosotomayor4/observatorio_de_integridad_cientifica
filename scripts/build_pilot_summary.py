#!/usr/bin/env python3
"""Genera un resumen legible del piloto."""
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
    matched = sum(r.get("status") == "matched" for r in oa_records)
    errors = sum(r.get("status") == "error" for r in oa_records)
    retracted = sum(len(r.get("retracted_works") or []) for r in oa_records)
    crossref_items = sum(len(r.get("evidence") or []) for r in cr.get("records", []))
    scraped_ok = sum(r.get("status") == "ok" for r in ws.get("records", []))
    blocked = sum(r.get("status") == "blocked_by_robots" for r in ws.get("records", []))
    lines = [
        "# Resumen del piloto OpenAlex y evidencias",
        "",
        f"Generado: {utc_now()}",
        "",
        "## OpenAlex",
        f"- Revistas procesadas: {len(oa_records)}",
        f"- Cruces únicos por ISSN/eISSN: {matched}",
        f"- Errores técnicos: {errors}",
        f"- Obras marcadas como retractadas en OpenAlex: {retracted}",
        "",
        "## Crossref",
        f"- Registros de actualización, corrección o retractación recuperados: {crossref_items}",
        "",
        "## Sitios editoriales",
        f"- Sitios procesados: {scraped_ok}",
        f"- Sitios bloqueados por robots.txt: {blocked}",
        "",
        "## Regla de interpretación",
        "Los resultados son evidencia preliminar y quedan pendientes de revisión humana. La ausencia de información no se interpreta automáticamente como incumplimiento.",
        "",
    ]
    Path("data/piloto/resumen_piloto.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()

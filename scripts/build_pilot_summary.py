#!/usr/bin/env python3
"""Genera un resumen legible y crítico del piloto v1.2."""
from __future__ import annotations

import json
from pathlib import Path
from collections import Counter

from common import utc_now


def load(path: str):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> None:
    oa = load("data/openalex/pilot_openalex.json")
    cr_raw = load("data/evidencias/crossref_updates.json")
    cr_clean = load("data/evidencias/crossref_events_clean.json")
    ws = load("data/evidencias/web_scraping_pilot.json")
    oa_records = oa.get("records", [])
    cr_records = cr_raw.get("records", [])
    ws_records = ws.get("records", [])

    matched = sum(r.get("status") == "matched" for r in oa_records)
    overridden = sum(r.get("status") == "matched_manual_override" for r in oa_records)
    ambiguous = sum(r.get("status") == "ambiguous" for r in oa_records)
    errors = sum(r.get("status") == "error" for r in oa_records)
    quality_flagged = [(r.get("title"), r.get("quality_flags") or []) for r in oa_records if r.get("quality_flags")]
    retracted_by_journal = [(r.get("title"), len(r.get("retracted_works") or [])) for r in oa_records if r.get("retracted_works")]
    retracted = sum(count for _, count in retracted_by_journal)

    raw_crossref = sum(len(r.get("evidence") or []) for r in cr_records)
    clean_events = sum(len(r.get("events") or []) for r in cr_clean.get("records", []))
    high_signal = cr_clean.get("high_signal_total", 0)
    event_counts = cr_clean.get("totals_by_event_type") or {}
    crossref_errors = sum(r.get("status") in {"partial_error", "error"} for r in cr_records)

    scraped_ok = sum(r.get("status") == "ok" for r in ws_records)
    challenge = sum(r.get("status") == "challenge_or_invalid_page" for r in ws_records)
    blocked = sum(r.get("status") == "blocked_by_robots" for r in ws_records)
    http_errors = sum(r.get("status") == "http_error" for r in ws_records)
    technical_errors = sum(r.get("status") == "error" for r in ws_records)
    no_homepage = sum(r.get("status") == "no_safe_homepage" for r in ws_records)
    categories = Counter()
    for record in ws_records:
        for page in record.get("pages") or []:
            if not page.get("usable"):
                continue
            for category in (page.get("categories_found") or {}).keys():
                categories[category] += 1

    lines = [
        "# Resumen del piloto OpenAlex y evidencias v1.2",
        "",
        f"Generado: {utc_now()}",
        "",
        "## OpenAlex",
        f"- Revistas procesadas: {len(oa_records)}",
        f"- Cruces únicos automáticos por ISSN/eISSN: {matched}",
        f"- Cruces resueltos mediante anulación manual documentada: {overridden}",
        f"- Cruces ambiguos pendientes: {ambiguous}",
        f"- Errores técnicos: {errors}",
        f"- Revistas con banderas de control de calidad: {len(quality_flagged)}",
        f"- Obras marcadas como retractadas en OpenAlex: {retracted}",
    ]
    if retracted_by_journal:
        lines += [f"  - {title}: {count}" for title, count in retracted_by_journal]
    if quality_flagged:
        lines += ["", "### Controles de calidad OpenAlex"]
        for title, flags in quality_flagged:
            codes = ", ".join(flag.get("code", "") for flag in flags)
            lines.append(f"- {title}: {codes}")

    lines += [
        "",
        "## Crossref",
        f"- Registros brutos recuperados: {raw_crossref}",
        f"- Eventos explícitos y deduplicados: {clean_events}",
        f"- Eventos de señal prioritaria: {high_signal}",
        f"- Revistas con errores de consulta: {crossref_errors}",
    ]
    for event_type, count in sorted(event_counts.items()):
        lines.append(f"  - {event_type}: {count}")

    lines += [
        "",
        "## Sitios editoriales",
        f"- Sitios con páginas utilizables: {scraped_ok}",
        f"- Páginas de desafío, bloqueo o 404 detectadas: {challenge}",
        f"- Sitios bloqueados por robots.txt: {blocked}",
        f"- Respuestas HTTP de acceso denegado: {http_errors}",
        f"- Otros errores técnicos: {technical_errors}",
        f"- Sin página segura disponible: {no_homepage}",
    ]
    if categories:
        lines += ["", "### Categorías localizadas en páginas utilizables"]
        for category, count in sorted(categories.items()):
            lines.append(f"- {category}: {count} página(s)")

    lines += [
        "",
        "## Regla de interpretación",
        "Los resultados son evidencia preliminar y quedan pendientes de revisión humana. Las correcciones y erratas se presentan como información editorial, no como señales adversas por sí solas. Las retractaciones, expresiones de preocupación, retiros y removals requieren revisión prioritaria y deben contrastarse con OpenAlex y la fuente editorial.",
        "",
    ]
    Path("data/piloto/resumen_piloto.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()

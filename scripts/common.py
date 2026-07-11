#!/usr/bin/env python3
"""Utilidades comunes para el piloto OpenAlex y evidencias."""
from __future__ import annotations

import csv
import ipaddress
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

USER_AGENT = (
    "ObservatorioIntegridadCientifica/1.0 "
    "(+https://github.com/robertosotomayor4/observatorio_de_integridad_cientifica)"
)


def utc_now() -> str:
    import datetime as _dt
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def normalize_issn(value: str) -> str:
    value = (value or "").upper().replace(" ", "").replace("-", "")
    if len(value) != 8:
        return ""
    return f"{value[:4]}-{value[4:]}"


def read_pilot_csv(path: str | Path, max_journals: int | None = None) -> list[dict[str, str]]:
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if max_journals and max_journals > 0:
        rows = rows[:max_journals]
    return rows


def ensure_parent(path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write_json(path: str | Path, payload: Any) -> None:
    target = ensure_parent(path)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_csv(path: str | Path, rows: Iterable[dict[str, Any]], fieldnames: list[str]) -> None:
    target = ensure_parent(path)
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def http_json(
    url: str,
    params: dict[str, Any] | None = None,
    *,
    timeout: int = 45,
    retries: int = 5,
    headers: dict[str, str] | None = None,
) -> Any:
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    full_url = f"{url}{'&' if '?' in url else '?'}{query}" if query else url
    request_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    request_headers.update(headers or {})
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full_url, headers=request_headers)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise
            last_error = exc
            if exc.code not in {429, 500, 502, 503, 504}:
                raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"No se pudo consultar {urllib.parse.urlsplit(url).netloc}: {last_error}")


def safe_public_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        host = parsed.hostname.lower()
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
            return False
        for info in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80)):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:
        return False

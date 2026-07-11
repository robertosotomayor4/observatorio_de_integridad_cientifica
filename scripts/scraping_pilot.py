#!/usr/bin/env python3
"""Scraping piloto, respetuoso y auditable de sitios editoriales públicos."""
from __future__ import annotations

import argparse
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from pathlib import Path

from common import USER_AGENT, safe_public_url, utc_now, write_json


BLOCK_PAGE_PATTERNS = [
    "client challenge",
    "access denied",
    "page not found",
    "404 not found",
    "just a moment",
    "enable javascript",
    "security check",
    "captcha",
    "bot detection",
]

def block_page_reason(title: str, text: str) -> str:
    sample = f"{title} {text[:5000]}".lower()
    for pattern in BLOCK_PAGE_PATTERNS:
        if pattern in sample:
            return pattern
    return ""

KEYWORDS = {
    "ethics": ["publication ethics", "publishing ethics", "malpractice", "research integrity", "misconduct", "ética editorial", "buenas prácticas"],
    "peer_review": ["peer review", "review process", "arbitraje", "revisión por pares"],
    "fees_apc": ["article processing charge", "publication fee", "apc", "processing fee", "cargos de publicación"],
    "editorial_board": ["editorial board", "editors", "comité editorial", "equipo editorial"],
    "corrections_retractions": ["retraction", "correction", "expression of concern", "retractación", "corrección"],
    "preservation": ["clockss", "lockss", "portico", "preservation", "archiving", "preservación"],
    "contact": ["contact", "contacto"],
}


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self._in_title = False
        self.links: list[dict[str, str]] = []
        self.text_parts: list[str] = []
        self.meta_description = ""

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag == "a" and attr.get("href"):
            self.links.append({"href": attr["href"], "text": ""})
        elif tag == "meta" and attr.get("name", "").lower() == "description":
            self.meta_description = attr.get("content", "")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        clean = " ".join(data.split())
        if not clean:
            return
        self.text_parts.append(clean)
        if self._in_title:
            self.title += (" " if self.title else "") + clean
        if self.links:
            self.links[-1]["text"] = (self.links[-1]["text"] + " " + clean).strip()


def robots_allowed(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    robots_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/robots.txt", "", ""))
    rp = urllib.robotparser.RobotFileParser()
    rp.set_url(robots_url)
    try:
        rp.read()
        return rp.can_fetch(USER_AGENT, url)
    except Exception:
        return True


def fetch_html(url: str, max_bytes: int = 1_500_000) -> tuple[int, str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(req, timeout=30) as response:
        content_type = response.headers.get("Content-Type", "")
        if "html" not in content_type.lower():
            return response.status, content_type, ""
        raw = response.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
        charset = response.headers.get_content_charset() or "utf-8"
        return response.status, content_type, raw.decode(charset, errors="replace")


def classify(text: str) -> dict[str, list[str]]:
    lower = text.lower()
    found = {}
    for category, words in KEYWORDS.items():
        matches = [word for word in words if word in lower]
        if matches:
            found[category] = matches
    return found


def candidate_links(base_url: str, links: list[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    seen = set()
    for link in links:
        href = urllib.parse.urljoin(base_url, html.unescape(link.get("href", "")))
        label = link.get("text", "")[:250]
        combined = f"{href} {label}"
        cats = classify(combined)
        if not cats or href in seen or not safe_public_url(href):
            continue
        seen.add(href)
        out.append({"url": href, "label": label, "categories": sorted(cats)})
    return out[:30]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openalex", default="data/openalex/pilot_openalex.json")
    parser.add_argument("--output", default="data/evidencias/web_scraping_pilot.json")
    parser.add_argument("--max-pages-per-journal", type=int, default=4)
    args = parser.parse_args()

    payload = json.loads(Path(args.openalex).read_text(encoding="utf-8"))
    records = []
    for index, rec in enumerate(payload.get("records", []), start=1):
        source = rec.get("source") or {}
        homepage = source.get("homepage_url") or ""
        result = {
            "journal_id": rec.get("journal_id"),
            "title": rec.get("title"),
            "openalex_source_id": source.get("id"),
            "homepage_url": homepage,
            "pages": [],
            "review_status": "pending_human_review",
        }
        print(f"[{index}] Scraping: {rec.get('title')}")
        if not homepage or not safe_public_url(homepage):
            result["status"] = "no_safe_homepage"
            records.append(result)
            continue
        if not robots_allowed(homepage):
            result["status"] = "blocked_by_robots"
            records.append(result)
            continue
        queue = [homepage]
        visited = set()
        try:
            while queue and len(result["pages"]) < args.max_pages_per_journal:
                url = queue.pop(0)
                if url in visited or not safe_public_url(url) or not robots_allowed(url):
                    continue
                visited.add(url)
                status, content_type, document = fetch_html(url)
                parser_obj = PageParser()
                parser_obj.feed(document)
                text = " ".join(parser_obj.text_parts)
                blocked_reason = block_page_reason(parser_obj.title, text)
                if blocked_reason:
                    result["pages"].append({
                        "url": url,
                        "http_status": status,
                        "content_type": content_type,
                        "title": parser_obj.title[:300],
                        "meta_description": parser_obj.meta_description[:500],
                        "categories_found": {},
                        "candidate_links": [],
                        "usable": False,
                        "blocked_reason": blocked_reason,
                        "review_status": "pending_human_review",
                    })
                    result["status"] = "challenge_or_invalid_page"
                    break
                categories = classify(text)
                links = candidate_links(url, parser_obj.links)
                result["pages"].append({
                    "url": url,
                    "http_status": status,
                    "content_type": content_type,
                    "title": parser_obj.title[:300],
                    "meta_description": parser_obj.meta_description[:500],
                    "categories_found": categories,
                    "candidate_links": links,
                    "usable": True,
                    "review_status": "pending_human_review",
                })
                for item in links:
                    if item["url"] not in visited and len(queue) < 12:
                        queue.append(item["url"])
                time.sleep(1.0)
            if "status" not in result:
                usable = sum(1 for page in result["pages"] if page.get("usable", True))
                result["status"] = "ok" if usable else "no_usable_page"
        except urllib.error.HTTPError as exc:
            result["status"] = "http_error"
            result["error"] = f"HTTP {exc.code}"
        except Exception as exc:
            result["status"] = "error"
            result["error"] = f"{type(exc).__name__}: {exc}"
        records.append(result)

    write_json(args.output, {
        "version": "1.0",
        "generated_at": utc_now(),
        "scope": "pilot",
        "method": "Scraping limitado de páginas públicas; respeta robots.txt; no produce conclusiones automáticas",
        "records": records,
    })


if __name__ == "__main__":
    main()

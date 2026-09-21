#!/usr/bin/env python3
"""serp.py — live Google SERP access for the SEO agent team.

Providers are real SERP APIs, not scrapers. Direct scraping of google.com is
against Google's ToS, gets CAPTCHA-blocked within a few queries, and produces
unreliable data. These APIs exist for exactly this purpose.

Usage:
    python tools/serp.py providers
    python tools/serp.py search "best crm for agencies" --location "United States"
    python tools/serp.py batch keywords.txt --out output/data/serp/
    python tools/serp.py compare --domain you.com --vs a.com,b.com --keywords kw.txt
    python tools/serp.py aeo-check queries.txt --provider serpapi

Config (.env or environment):
    SERP_PROVIDER          serper | serpapi | valueserp | auto   (default: auto)
    SERPER_API_KEY | SERPAPI_API_KEY | VALUESERP_API_KEY
    SERP_CACHE_TTL_HOURS   default 24
    SERP_DEFAULT_LOCATION  default "United States"

Requires: requests (see requirements.txt). Everything else is stdlib.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    print("serp.py needs `requests`. Install with:  pip install -r requirements.txt",
          file=sys.stderr)
    sys.exit(1)

CACHE_DIR = Path(".cache/serp")


def load_dotenv() -> None:
    """Load .env, letting a later non-empty value beat an earlier empty one.

    This matters: the usual setup is `cp .env.example .env` followed by appending
    the real key, which leaves the file with `SERPER_API_KEY=` (empty, from the
    template) ABOVE `SERPER_API_KEY=<real>`. A naive first-wins loader takes the
    empty one and reports no provider configured.
    """
    for name in (".env", ".env.local"):
        p = Path(name)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if not m:
                continue
            key, val = m.group(1), m.group(2).strip().strip("\"'")
            if not val:
                continue                      # never let a blank overwrite or claim the slot
            if not os.environ.get(key):       # real environment still wins over .env
                os.environ[key] = val


load_dotenv()
TTL_HOURS = float(os.environ.get("SERP_CACHE_TTL_HOURS", 24))
DEFAULT_LOCATION = os.environ.get("SERP_DEFAULT_LOCATION", "United States")

# What each provider's endpoint actually returns. This matters more than it
# looks: a provider that never reports AI Overviews will make every SERP look
# AI-Overview-free, and the AEO track would silently draw the wrong conclusion.
# Anything listed under cannot_detect is reported as "not checked", never absent.
CAPABILITIES = {
    "serper": {
        "detects": ["organic", "peopleAlsoAsk", "relatedSearches", "knowledgeGraph",
                    "localPack", "featuredSnippet"],
        "cannot_detect": ["aiOverview", "topAds", "bottomAds", "shopping", "videos", "images"],
        "note": ("The standard /search endpoint returns organic, PAA and related searches. It "
                 "does not report AI Overviews or ad load. For AI Overview source tracking, use "
                 "SerpApi or verify manually."),
        "env": "SERPER_API_KEY",
        "docs": "https://serper.dev — 2,500 free queries, then ~$0.30/1k. Fastest. No AI Overview or ad data.",
    },
    "serpapi": {
        "detects": ["organic", "aiOverview", "featuredSnippet", "peopleAlsoAsk", "relatedSearches",
                    "knowledgeGraph", "localPack", "videos", "images", "shopping", "topAds", "bottomAds"],
        "cannot_detect": [],
        "note": "Fullest feature coverage of the three, including AI Overview references.",
        "env": "SERPAPI_API_KEY",
        "docs": "https://serpapi.com — 100 free/mo, then ~$50/5k. Only one returning AI Overview sources.",
    },
    "valueserp": {
        "detects": ["organic", "aiOverview", "featuredSnippet", "peopleAlsoAsk", "relatedSearches",
                    "knowledgeGraph", "localPack", "videos"],
        "cannot_detect": ["topAds", "bottomAds", "shopping", "images"],
        "note": "Reports AI Overviews but not ad load.",
        "env": "VALUESERP_API_KEY",
        "docs": "https://valueserp.com — 100 free/mo, then ~$25/5k.",
    },
}


def host(url: str | None) -> str | None:
    try:
        return urlparse(url).hostname.replace("www.", "", 1)
    except (AttributeError, ValueError):
        return None


def pick_provider(override: str | None = None) -> str | None:
    want = override or os.environ.get("SERP_PROVIDER") or "auto"
    if want != "auto":
        if want not in CAPABILITIES:
            raise SystemExit(f'unknown SERP_PROVIDER "{want}"')
        if not os.environ.get(CAPABILITIES[want]["env"]):
            raise SystemExit(f'{want} selected but {CAPABILITIES[want]["env"]} is not set')
        return want
    for name, cap in CAPABILITIES.items():
        if os.environ.get(cap["env"]):
            return name
    return None


# ------------------------------------------------------------------ normalizer

def empty_result(query: str | None) -> dict:
    return {"query": query, "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "provider": None, "location": None, "organic": [], "aiOverview": None,
            "featuredSnippet": None, "peopleAlsoAsk": [], "relatedSearches": [],
            "knowledgeGraph": None, "localPack": [], "videos": [], "images": 0,
            "shopping": [], "topAds": 0, "bottomAds": 0, "totalResults": None, "notChecked": []}


def apply_capabilities(r: dict) -> dict:
    """Mark the features this provider structurally cannot see."""
    cap = CAPABILITIES.get(r.get("provider"), {})
    r["notChecked"] = list(cap.get("cannot_detect", []))
    r["providerNote"] = cap.get("note")
    # None means unknown; 0 or [] would falsely read as "checked and absent".
    for f in r["notChecked"]:
        r[f] = None
    return r


def normalize_serper(d: dict) -> dict:
    r = empty_result((d.get("searchParameters") or {}).get("q"))
    r["provider"] = "serper"
    r["location"] = (d.get("searchParameters") or {}).get("location")
    r["organic"] = [{"position": o.get("position", i + 1), "title": o.get("title"),
                     "url": o.get("link"), "snippet": o.get("snippet"), "domain": host(o.get("link")),
                     "sitelinks": len(o.get("sitelinks") or []), "date": o.get("date")}
                    for i, o in enumerate(d.get("organic") or [])]
    ab = d.get("answerBox")
    if ab:
        r["featuredSnippet"] = {"type": "paragraph" if ab.get("snippet") else
                                ("list" if ab.get("list") else "other"),
                                "url": ab.get("link"), "domain": host(ab.get("link")),
                                "content": ab.get("snippet") or ab.get("answer")}
    aio = d.get("aiOverview")
    if aio:
        srcs = aio.get("references") or aio.get("sources") or []
        r["aiOverview"] = {"present": True, "text": aio.get("text"),
                           "sources": [{"url": s.get("link") or s.get("url"),
                                        "domain": host(s.get("link") or s.get("url")),
                                        "title": s.get("title")} for s in srcs]}
    r["peopleAlsoAsk"] = [{"question": p.get("question"), "url": p.get("link"),
                           "domain": host(p.get("link"))} for p in (d.get("peopleAlsoAsk") or [])]
    r["relatedSearches"] = [s.get("query", s) if isinstance(s, dict) else s
                            for s in (d.get("relatedSearches") or [])]
    kg = d.get("knowledgeGraph")
    if kg:
        r["knowledgeGraph"] = {"title": kg.get("title"), "type": kg.get("type"),
                               "website": kg.get("website")}
    r["localPack"] = [{"name": p.get("title"), "rating": p.get("rating"),
                       "reviews": p.get("ratingCount")} for p in (d.get("places") or [])]
    r["videos"] = [{"title": v.get("title"), "url": v.get("link"), "domain": host(v.get("link"))}
                   for v in (d.get("videos") or [])]
    r["images"] = len(d.get("images") or [])
    r["topAds"] = len(d.get("ads") or [])
    r["totalResults"] = (d.get("searchInformation") or {}).get("totalResults")
    return r


def normalize_serpapi(d: dict) -> dict:
    r = empty_result((d.get("search_parameters") or {}).get("q"))
    r["provider"] = "serpapi"
    r["location"] = (d.get("search_parameters") or {}).get("location_requested")
    r["organic"] = [{"position": o.get("position", i + 1), "title": o.get("title"),
                     "url": o.get("link"), "snippet": o.get("snippet"), "domain": host(o.get("link")),
                     "sitelinks": len((o.get("sitelinks") or {}).get("inline") or []),
                     "date": o.get("date")}
                    for i, o in enumerate(d.get("organic_results") or [])]
    ab = d.get("answer_box")
    if ab:
        r["featuredSnippet"] = {"type": ab.get("type", "unknown"), "url": ab.get("link"),
                                "domain": host(ab.get("link")),
                                "content": ab.get("snippet") or ab.get("answer")}
    aio = d.get("ai_overview")
    if aio:
        text = " ".join(b.get("snippet", "") for b in (aio.get("text_blocks") or []) if b.get("snippet"))
        r["aiOverview"] = {"present": True, "text": text or None,
                           "sources": [{"url": s.get("link"), "domain": host(s.get("link")),
                                        "title": s.get("title")} for s in (aio.get("references") or [])]}
    r["peopleAlsoAsk"] = [{"question": p.get("question"), "url": p.get("link"),
                           "domain": host(p.get("link"))} for p in (d.get("related_questions") or [])]
    r["relatedSearches"] = [s.get("query") for s in (d.get("related_searches") or [])]
    kg = d.get("knowledge_graph")
    if kg:
        r["knowledgeGraph"] = {"title": kg.get("title"), "type": kg.get("type"),
                               "website": kg.get("website")}
    ads = d.get("ads") or []
    r["topAds"] = len([a for a in ads if a.get("block_position") == "top"])
    r["bottomAds"] = len([a for a in ads if a.get("block_position") == "bottom"])
    r["totalResults"] = (d.get("search_information") or {}).get("total_results")
    return r


def normalize_valueserp(d: dict) -> dict:
    r = empty_result((d.get("search_parameters") or {}).get("q"))
    r["provider"] = "valueserp"
    r["location"] = (d.get("search_parameters") or {}).get("location")
    r["organic"] = [{"position": o.get("position", i + 1), "title": o.get("title"),
                     "url": o.get("link"), "snippet": o.get("snippet"), "domain": host(o.get("link")),
                     "sitelinks": len(o.get("sitelinks") or []), "date": o.get("date")}
                    for i, o in enumerate(d.get("organic_results") or [])]
    aio = d.get("ai_overview")
    if aio:
        r["aiOverview"] = {"present": True, "text": aio.get("text"),
                           "sources": [{"url": s.get("link"), "domain": host(s.get("link")),
                                        "title": s.get("title")} for s in (aio.get("sources") or [])]}
    r["peopleAlsoAsk"] = [{"question": p.get("question"), "url": p.get("link"),
                           "domain": host(p.get("link"))} for p in (d.get("related_questions") or [])]
    r["relatedSearches"] = [s.get("query") for s in (d.get("related_searches") or [])]
    return r


# --------------------------------------------------------------------- caching

def cache_key(q: str, opts: dict) -> str:
    provider = opts.get("provider") or os.environ.get("SERP_PROVIDER") or "auto"
    raw = json.dumps([q, opts.get("location"), opts.get("gl"), opts.get("hl"),
                      opts.get("device"), opts.get("num"), provider])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def read_cache(key: str) -> dict | None:
    f = CACHE_DIR / f"{key}.json"
    if not f.exists():
        return None
    age_h = (time.time() - f.stat().st_mtime) / 3600
    if age_h > TTL_HOURS:
        return None
    d = json.loads(f.read_text(encoding="utf-8"))
    d["_cached"] = True
    d["_cacheAgeHours"] = round(age_h, 1)
    return d


def write_cache(key: str, d: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(d, indent=2, ensure_ascii=False),
                                           encoding="utf-8")


# ------------------------------------------------------------------ public api

def serp_search(query: str, opts: dict | None = None) -> dict:
    opts = {"location": DEFAULT_LOCATION, "gl": "us", "hl": "en", "num": 20, **(opts or {})}
    key = cache_key(query, opts)
    if not opts.get("no_cache"):
        cached = read_cache(key)
        if cached:
            return cached

    name = pick_provider(opts.get("provider"))
    if not name:
        raise SystemExit(
            "NO_SERP_PROVIDER\n\nNo SERP API key found. Set SERPER_API_KEY, SERPAPI_API_KEY or "
            "VALUESERP_API_KEY in .env.\nRun `python tools/serp.py providers` for options. Agents "
            "must fall back to the WebSearch tool and label results as lower-fidelity.")

    if name == "serper":
        body = {"q": query, "gl": opts["gl"], "hl": opts["hl"],
                "location": opts["location"], "num": opts["num"]}
        if opts.get("device") == "mobile":
            body["device"] = "mobile"
        resp = requests.post("https://google.serper.dev/search", json=body, timeout=45,
                             headers={"X-API-KEY": os.environ["SERPER_API_KEY"],
                                      "Content-Type": "application/json"})
        resp.raise_for_status()
        data = normalize_serper(resp.json())
    elif name == "serpapi":
        params = {"q": query, "engine": "google", "api_key": os.environ["SERPAPI_API_KEY"],
                  "gl": opts["gl"], "hl": opts["hl"], "num": opts["num"],
                  "location": opts["location"]}
        resp = requests.get("https://serpapi.com/search.json", params=params, timeout=45)
        resp.raise_for_status()
        data = normalize_serpapi(resp.json())
    else:
        params = {"q": query, "api_key": os.environ["VALUESERP_API_KEY"],
                  "gl": opts["gl"], "hl": opts["hl"], "num": opts["num"],
                  "location": opts["location"]}
        resp = requests.get("https://api.valueserp.com/search", params=params, timeout=45)
        resp.raise_for_status()
        data = normalize_valueserp(resp.json())

    data = apply_capabilities(data)
    data["_cached"] = False
    write_cache(key, data)
    return data


# -------------------------------------------------------------------- analysis

def infer_format(r: dict) -> dict:
    titles = [(o.get("title") or "").lower() for o in (r.get("organic") or [])[:10]]
    domains = [(o.get("domain") or "") for o in (r.get("organic") or [])[:10]]

    def hits(arr, pattern):
        rx = re.compile(pattern)
        return sum(1 for x in arr if rx.search(x))

    scores = {
        "listicle": hits(titles, r"\b\d+\s+(of\s+the\s+)?(best|top|free|cheap|great|leading|popular)\b|\b(best|top)\s+\d+\b|\bthe\s+best\b|\btop\s+\d+\b"),
        "comparison": hits(titles, r"\bvs\.?\b|\bversus\b|\balternatives?\b|\bcompar(e|ison)\b"),
        "howto": hits(titles, r"\bhow to\b|step[- ]by[- ]step|\bguide\b|\btutorial\b"),
        "definition": hits(titles, r"\bwhat is\b|\bwhat are\b|\bmeaning\b|\bdefinition\b|\bexplained\b"),
        "tool": hits(titles, r"\bcalculator\b|\bgenerator\b|\bchecker\b|\btemplate\b"),
        "review": hits(titles, r"\breviews?\b|\brating\b|\bhonest\b"),
        "forum": hits(domains, r"reddit|quora|stackexchange|stackoverflow|forum"),
    }
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top_name, top_n = ranked[0]
    second_n = ranked[1][1] if len(ranked) > 1 else 0
    n = max(len(titles), 1)
    dominant = top_name if top_n >= max(3, -(-n // 3)) and top_n > second_n else "mixed"
    return {"dominant": dominant, "scores": scores,
            "forumDominated": scores["forum"] >= 3,
            "confidence": "none" if top_n == 0 else ("high" if top_n > second_n * 2 else "low")}


def analyze_serp(r: dict) -> dict:
    unchecked = set(r.get("notChecked") or [])
    n = lambda v: len(v) if isinstance(v, list) else 0

    feature_count = (sum(1 for x in (r.get("aiOverview"), r.get("featuredSnippet"),
                                     r.get("knowledgeGraph")) if x)
                     + (1 if n(r.get("peopleAlsoAsk")) else 0)
                     + (1 if n(r.get("localPack")) else 0)
                     + (1 if n(r.get("videos")) else 0)
                     + (1 if n(r.get("shopping")) else 0)
                     + (1 if r.get("images") else 0))

    # Directional heuristic from SERP composition — never a measured CTR.
    avail = 100
    if r.get("aiOverview"): avail -= 35
    if r.get("featuredSnippet"): avail -= 15
    if n(r.get("peopleAlsoAsk")): avail -= 5
    if n(r.get("localPack")): avail -= 15
    if n(r.get("shopping")): avail -= 10
    if n(r.get("videos")): avail -= 5
    avail -= min(20, (r.get("topAds") or 0) * 5)

    domains: dict[str, int] = {}
    for o in (r.get("organic") or []):
        if o.get("domain"):
            domains[o["domain"]] = domains.get(o["domain"], 0) + 1

    aio_present = None if "aiOverview" in unchecked else bool(r.get("aiOverview"))
    caveat = (f'Understated risk: {", ".join(sorted(unchecked))} not visible to '
              f'{r.get("provider")}, so real click availability is likely LOWER than this estimate.'
              if unchecked else None)

    return {
        "featureCount": feature_count,
        "clickAvailabilityEstimate": max(5, avail),
        "clickAvailabilityBasis": "heuristic from SERP composition — directional only, not measured CTR",
        "clickAvailabilityCaveat": caveat,
        "aiOverviewPresent": aio_present,
        "aiOverviewSources": [s.get("domain") for s in ((r.get("aiOverview") or {}).get("sources") or [])
                              if s.get("domain")],
        "notChecked": sorted(unchecked),
        "snippetHolder": (r.get("featuredSnippet") or {}).get("domain"),
        "snippetType": (r.get("featuredSnippet") or {}).get("type"),
        "dominantDomains": [{"domain": d, "results": c} for d, c in
                            sorted(domains.items(), key=lambda kv: -kv[1])[:5]],
        "paaQuestions": [p.get("question") for p in (r.get("peopleAlsoAsk") or [])],
        "formatSignal": infer_format(r),
    }


def to_markdown(r: dict, a: dict) -> str:
    L = [f'## {r.get("query")}']
    cached = f' · cached {r.get("_cacheAgeHours")}h' if r.get("_cached") else ""
    L.append(f'*{r.get("provider")} · {r.get("location") or "default location"} · '
             f'{r.get("fetchedAt")}{cached}*\n')
    fmt = a["formatSignal"]["dominant"]
    if a["formatSignal"]["forumDominated"]:
        fmt += " (forum-dominated — no publisher owns this)"
    L.append(f'**Features:** {a["featureCount"]} · **Click availability (est):** '
             f'~{a["clickAvailabilityEstimate"]}% · **Format:** {fmt}')

    if a["aiOverviewPresent"] is None:
        L.append(f'\n> **AI Overview: NOT CHECKED** — `{r.get("provider")}` does not report it. '
                 f'Do not record this SERP as AI-Overview-free.')
    elif r.get("aiOverview"):
        L.append(f'\n**AI Overview present.** Cites: '
                 f'{", ".join(a["aiOverviewSources"]) or "unattributed"}')
    else:
        L.append("\n**AI Overview:** none detected")
    if a["clickAvailabilityCaveat"]:
        L.append(f'\n> {a["clickAvailabilityCaveat"]}')

    if r.get("featuredSnippet"):
        L.append(f'\n**Featured snippet** ({a["snippetType"]}) held by `{a["snippetHolder"]}`')
    L.append("\n| # | Domain | Title |")
    L.append("|---|---|---|")
    for o in (r.get("organic") or [])[:10]:
        title = (o.get("title") or "").replace("|", "\\|")[:70]
        L.append(f'| {o.get("position")} | {o.get("domain")} | {title} |')
    if a["paaQuestions"]:
        L.append("\n**People Also Ask**")
        L += [f"- {q}" for q in a["paaQuestions"]]
    if r.get("relatedSearches"):
        L.append(f'\n**Related:** {" · ".join(str(x) for x in r["relatedSearches"])}')
    return "\n".join(L)


def compare_domains(results: list, target: str, competitors: list) -> dict:
    rows = []
    for r in results:
        a = analyze_serp(r)

        def pos(d):
            m = next((o for o in (r.get("organic") or [])
                      if o.get("domain") == d or (o.get("domain") or "").endswith("." + d)), None)
            return m.get("position") if m else None

        rows.append({
            "query": r.get("query"), "target": pos(target),
            "competitors": {c: pos(c) for c in competitors},
            "aiOverview": a["aiOverviewPresent"],
            "aiOverviewCitesTarget": (None if a["aiOverviewPresent"] is None
                                      else target in a["aiOverviewSources"]),
            "snippetHolder": a["snippetHolder"],
            "clickAvailabilityEstimate": a["clickAvailabilityEstimate"],
            "format": a["formatSignal"]["dominant"],
        })
    ranked = len([r for r in rows if r["target"]])
    checked = len([r for r in rows if r["aiOverview"] is not None])

    def avg(c):
        ps = [r["competitors"][c] for r in rows if r["competitors"][c]]
        return round(sum(ps) / len(ps), 1) if ps else None

    return {"summary": {
        "keywords": len(rows), "targetRanksIn": ranked,
        "targetVisibilityRate": round(ranked / len(rows) * 100, 1) if rows else 0,
        "aiOverviewChecked": checked,
        "aiOverviewCoverage": len([r for r in rows if r["aiOverview"] is True]),
        "targetCitedInAio": len([r for r in rows if r["aiOverviewCitesTarget"] is True]),
        "competitorAvgPositions": {c: avg(c) for c in competitors}},
        "rows": rows}


# ------------------------------------------------------------------------- cli

def read_keywords(path: str) -> list[str]:
    return [l.strip() for l in Path(path).read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.startswith("#")]


def main() -> int:
    ap = argparse.ArgumentParser(prog="serp.py", description="Live Google SERP access.")
    ap.add_argument("command", choices=["providers", "search", "batch", "compare", "aeo-check"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--location", default=DEFAULT_LOCATION)
    ap.add_argument("--gl", default="us"); ap.add_argument("--hl", default="en")
    ap.add_argument("--device"); ap.add_argument("--num", type=int, default=20)
    ap.add_argument("--no-cache", action="store_true", dest="no_cache")
    ap.add_argument("--provider", choices=list(CAPABILITIES))
    ap.add_argument("--out", default="output/data/serp")
    ap.add_argument("--domain"); ap.add_argument("--vs", default="")
    ap.add_argument("--keywords"); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    opts = {"location": a.location, "gl": a.gl, "hl": a.hl, "device": a.device,
            "num": a.num, "no_cache": a.no_cache, "provider": a.provider}

    if a.command == "providers":
        print("SERP providers (set one key in .env):\n")
        for name, cap in CAPABILITIES.items():
            state = "CONFIGURED" if os.environ.get(cap["env"]) else "not set"
            print(f'  {name:<10} {cap["env"]:<20} {state}')
            print(f'  {"":<10} {cap["docs"]}\n')
        active = pick_provider()
        if not active:
            print("Active: none — agents fall back to the WebSearch tool and must label "
                  "results as lower-fidelity.")
            return 0
        print(f"Active: {active}")
        cap = CAPABILITIES[active]
        if cap["cannot_detect"]:
            print(f'\n  Detects:      {", ".join(cap["detects"])}')
            print(f'  NOT detected: {", ".join(cap["cannot_detect"])}')
            print(f'\n  {cap["note"]}')
            print('\n  These are reported as "not checked", never as absent.')
        return 0

    if a.command == "search":
        if not a.arg:
            raise SystemExit('usage: serp.py search "<query>"')
        r = serp_search(a.arg, opts)
        an = analyze_serp(r)
        print(json.dumps({**r, "analysis": an}, indent=2, ensure_ascii=False)
              if a.json else to_markdown(r, an))
        return 0

    if a.command == "batch":
        if not a.arg:
            raise SystemExit("usage: serp.py batch <keywords.txt>")
        kws = read_keywords(a.arg)
        out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
        md = [f"# SERP batch — {len(kws)} keywords",
              f'*{datetime.now(timezone.utc).isoformat(timespec="seconds")} · location: {a.location}*\n']
        allr = []
        for k in kws:
            print(f"  {k}", file=sys.stderr)
            try:
                r = serp_search(k, opts)
                allr.append(r)
                md += [to_markdown(r, analyze_serp(r)), "\n---\n"]
                if not r.get("_cached"):
                    time.sleep(0.25)
            except Exception as e:
                md.append(f"## {k}\n\n**FETCH FAILED:** {e}\n")
        (out / "serp-batch.json").write_text(json.dumps(allr, indent=2, ensure_ascii=False), encoding="utf-8")
        (out / "serp-batch.md").write_text("\n".join(md), encoding="utf-8")
        print(f"Wrote {out}/serp-batch.{{json,md}} — {len(allr)}/{len(kws)} succeeded")
        return 0

    if a.command == "aeo-check":
        f = a.arg or a.keywords
        if not f:
            raise SystemExit("usage: serp.py aeo-check <queries.txt> [--provider serpapi]")
        name = pick_provider(a.provider)
        cap = CAPABILITIES.get(name, {})
        if "aiOverview" in cap.get("cannot_detect", []):
            print(f'\nCANNOT RUN: "{name}" does not report AI Overviews.\n', file=sys.stderr)
            print(f'{cap["note"]}\n', file=sys.stderr)
            print("Options:", file=sys.stderr)
            print("  1. Set SERPAPI_API_KEY (100 free/month) and re-run with --provider serpapi",
                  file=sys.stderr)
            print("  2. Set VALUESERP_API_KEY and re-run with --provider valueserp", file=sys.stderr)
            print("  3. Check the queries manually in a browser and record what you see.",
                  file=sys.stderr)
            print('\nRefusing to run rather than reporting "no AI Overview" for queries nobody '
                  'checked.', file=sys.stderr)
            return 2
        rows = []
        for q in read_keywords(f):
            print(f"  {q}", file=sys.stderr)
            try:
                r = serp_search(q, opts); an = analyze_serp(r)
                rows.append({"query": q, "present": an["aiOverviewPresent"],
                             "sources": an["aiOverviewSources"], "snippet": an["snippetHolder"]})
            except Exception as e:
                rows.append({"query": q, "error": str(e)})
        with_aio = [r for r in rows if r.get("present")]
        cited: dict[str, int] = {}
        for r in with_aio:
            for d in r["sources"]:
                cited[d] = cited.get(d, 0) + 1
        L = ["# AI Overview check",
             f'*{len(rows)} queries · {name} · {a.location}*\n',
             f"AI Overview present on **{len(with_aio)}/{len(rows)}** queries.\n"]
        if cited:
            L += ["## Most-cited domains\n", "| Domain | Cited on |", "|---|---|"]
            L += [f"| {d} | {n} |" for d, n in sorted(cited.items(), key=lambda kv: -kv[1])]
            L.append("")
        L += ["| Query | AI Overview | Cited sources |", "|---|---|---|"]
        for r in rows:
            state = "ERROR" if r.get("error") else ("yes" if r.get("present") else "none")
            L.append(f'| {r["query"]} | {state} | {", ".join(r.get("sources") or []) or "—"} |')
        out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
        (out / "ai-overview-check.md").write_text("\n".join(L), encoding="utf-8")
        (out / "ai-overview-check.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        print("\n".join(L))
        return 0

    if a.command == "compare":
        if not a.domain or not a.keywords:
            raise SystemExit("usage: serp.py compare --domain <d> --vs a.com,b.com --keywords <file>")
        vs = [x.strip() for x in a.vs.split(",") if x.strip()]
        results = []
        for k in read_keywords(a.keywords):
            print(f"  {k}", file=sys.stderr)
            try:
                results.append(serp_search(k, opts))
            except Exception as e:
                print(f"  !! {k}: {e}", file=sys.stderr)
        target = re.sub(r"^www\.", "", a.domain)
        cmp = compare_domains(results, target, vs)
        out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
        (out / "competitive-position.json").write_text(json.dumps(cmp, indent=2), encoding="utf-8")

        s = cmp["summary"]
        L = [f"# Competitive SERP position — {a.domain}",
             f'*{len(results)} keywords · {a.location}*\n',
             f'- Ranks in top {a.num} for **{s["targetRanksIn"]}/{s["keywords"]}** '
             f'keywords ({s["targetVisibilityRate"]}%)']
        if s["aiOverviewChecked"] == 0:
            prov = results[0].get("provider") if results else "provider"
            L.append(f'- **AI Overview: not checked.** `{prov}` does not report AI Overviews, so '
                     f'this run says nothing about AI Overview presence or citation.')
        else:
            L.append(f'- AI Overview appears on **{s["aiOverviewCoverage"]}** of '
                     f'{s["aiOverviewChecked"]} checked; cites {a.domain} on '
                     f'**{s["targetCitedInAio"]}**')
        L.append("- Competitor average positions: " +
                 " · ".join(f'{d}: {p if p is not None else "n/a"}'
                            for d, p in s["competitorAvgPositions"].items()) + "\n")
        L.append(f'| Query | {a.domain} | ' + " | ".join(vs) +
                 " | AIO | Snippet | Click avail (est) | Format |")
        L.append("|---|" + "---|" * (len(vs) + 5))
        for r in cmp["rows"]:
            aio = ("not checked" if r["aiOverview"] is None else
                   ("cites us" if r["aiOverviewCitesTarget"] else "yes") if r["aiOverview"] else "none")
            L.append(f'| {r["query"]} | {r["target"] or "—"} | ' +
                     " | ".join(str(r["competitors"][c] or "—") for c in vs) +
                     f' | {aio} | {r["snippetHolder"] or "—"} | '
                     f'~{r["clickAvailabilityEstimate"]}% | {r["format"]} |')
        (out / "competitive-position.md").write_text("\n".join(L), encoding="utf-8")
        print("\n".join(L))
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())

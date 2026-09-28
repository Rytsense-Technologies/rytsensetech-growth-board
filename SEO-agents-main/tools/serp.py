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
    SERP_MAX_ATTEMPTS      bounded retries on 429/5xx, default 3, max 5
    SERP_RETRY_BASE_SECONDS  backoff base, default 0.5
    SERP_MAX_SLEEP_SECONDS   per-sleep cap, default 8

.env is read first, then .env.local, and the LATER file wins. The real process
environment beats both.

Honesty contract — the one error this module exists to stop is an agent reporting
"not ranking" when the truth is "not measured":
  * Every query asked gets a row, with status: measured | error | unmeasured.
    A query that failed is never deleted from the JSON.
  * Every rate states its own denominator and says what was excluded.
  * Depth claims use the number of organic results actually retrieved, never --num.
  * A feature the provider's normalizer does not parse is "not checked", never absent.
  * Every row records provider, device, gl, hl, num, location, cache age and TTL.

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


# `.env` first, `.env.local` second — LAST file wins, which is the universal
# convention everywhere else (.local is the operator's override of the checked-in
# template). It was inverted here, so an operator who put a working key in
# .env.local to override a stale .env key kept getting the stale one. Every SERP
# call then 401s, every 401 used to become a dropped row, and a dropped row reads
# downstream as "not ranking" — the one error this module exists to prevent.
DOTENV_FILES = (".env", ".env.local")

# `export KEY=value` is how half the world writes a .env; the old regex demanded a
# bare KEY= and silently skipped the line, reporting "no provider configured" for
# a file that plainly had the key in it.
_ENV_LINE = re.compile(r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$""")


def _unquote(raw: str) -> str:
    """Strip quotes, and strip an unquoted trailing ` # comment`.

    `KEY=value # note` used to keep the comment inside the value and send
    "value # note" to the API as the key — a 401 that looked like a bad key.
    A `#` inside quotes is part of the value and is kept; real API keys do
    contain `#` on occasion.
    """
    if len(raw) >= 2 and raw[0] in "\"'" and raw[-1] == raw[0]:
        return raw[1:-1]
    if len(raw) >= 2 and raw[0] in "\"'":                 # opening quote, no close on this line
        closed = raw.find(raw[0], 1)
        if closed > 0:
            return raw[1:closed]
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def load_dotenv(files: tuple[str, ...] = DOTENV_FILES) -> None:
    """Load .env then .env.local, letting a later non-empty value beat an earlier one.

    Empty-value handling matters: the usual setup is `cp .env.example .env`
    followed by appending the real key, which leaves the file with
    `SERPER_API_KEY=` (empty, from the template) ABOVE `SERPER_API_KEY=<real>`.
    A naive first-wins loader takes the empty one and reports no provider
    configured.

    The real process environment still beats both files. That is decided against a
    snapshot taken before anything is applied, so that a value this function took
    from `.env` cannot masquerade as "already in the environment" and block the
    `.env.local` override.
    """
    preexisting = set(os.environ)
    merged: dict[str, str] = {}
    for name in files:
        p = Path(name)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            m = _ENV_LINE.match(line)
            if not m:
                continue
            key, val = m.group(1), _unquote(m.group(2))
            if not val:
                continue                      # never let a blank overwrite or claim the slot
            merged[key] = val                 # later file, and later line, wins
    for key, val in merged.items():
        if key not in preexisting or not os.environ.get(key):
            os.environ[key] = val


def _env_float(name: str, default: float) -> float:
    """A malformed number must not take the whole tool down.

    `TTL_HOURS = float(os.environ[...])` at import meant one typo in .env raised
    ValueError before argparse ran, so even `serp.py providers` — the command an
    operator runs to diagnose exactly that — died with a traceback.
    """
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"{name}={raw!r} is not a number — falling back to {default}", file=sys.stderr)
        return default


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(float(os.environ.get(name) or default))))
    except ValueError:
        print(f"{name} is not a number — falling back to {default}", file=sys.stderr)
        return default


load_dotenv()
TTL_HOURS = _env_float("SERP_CACHE_TTL_HOURS", 24)
DEFAULT_LOCATION = os.environ.get("SERP_DEFAULT_LOCATION", "United States")

# Bounded retry. The repo's guard hook blocks unbounded waits in shell commands
# after a poll loop held a task slot for 42 minutes (commit cbe727b); the same
# discipline applies here. Attempts and per-sleep are capped, and the whole run
# has a total delay budget, so a provider having a bad day costs seconds, not a
# wedged batch.
MAX_ATTEMPTS = _env_int("SERP_MAX_ATTEMPTS", 3, 1, 5)
RETRY_BASE_SECONDS = min(4.0, _env_float("SERP_RETRY_BASE_SECONDS", 0.5))
MAX_SLEEP_SECONDS = min(20.0, _env_float("SERP_MAX_SLEEP_SECONDS", 8))
# Transient only. A 401/403 is a bad key and will still be a bad key in 4 seconds;
# retrying it wastes the operator's time and, on some plans, their quota.
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

# Every feature the result dict can carry a verdict on. `organic` is deliberately
# absent: it is the spine of the result, not an optional SERP feature, and must
# never be marked "not checked".
FEATURES = frozenset({"aiOverview", "featuredSnippet", "peopleAlsoAsk", "relatedSearches",
                      "knowledgeGraph", "localPack", "videos", "images", "shopping",
                      "topAds", "bottomAds"})

# What each normalizer below ACTUALLY reads out of the payload, with the payload
# key beside it. This is the source of truth for capability; CAPABILITIES is
# reconciled against it at import.
#
# Why: CAPABILITIES used to be hand-declared and had drifted. valueserp declared
# featuredSnippet/knowledgeGraph/localPack/videos and serpapi declared
# localPack/videos/images/shopping, while neither normalizer read those keys. The
# fields therefore came back [] / None / 0 from empty_result, apply_capabilities
# left them out of notChecked because they were "detected", and analyze_serp
# counted them as checked-and-absent. The tool would have reported "0 featured
# snippets, 0 knowledge graphs, 0 local packs" for SERPs where it never looked —
# the exact "not measured read as not present" failure this module exists to stop.
# It stayed latent only because serper happened to be the configured provider.
PARSES = {
    "serper": {
        "organic",          # organic[]
        "featuredSnippet",  # answerBox
        "aiOverview",       # aiOverview
        "peopleAlsoAsk",    # peopleAlsoAsk[]
        "relatedSearches",  # relatedSearches[]
        "knowledgeGraph",   # knowledgeGraph
        "localPack",        # places[]
        "videos",           # videos[]
        "images",           # images[]
        "topAds",           # ads[]
    },
    "serpapi": {
        "organic",          # organic_results[]
        "featuredSnippet",  # answer_box
        "aiOverview",       # ai_overview
        "peopleAlsoAsk",    # related_questions[]
        "relatedSearches",  # related_searches[]
        "knowledgeGraph",   # knowledge_graph
        "localPack",        # local_results{.places[]}
        "videos",           # inline_videos[]
        "images",           # inline_images[]
        "shopping",         # shopping_results[]
        "topAds",           # ads[] where block_position == top
        "bottomAds",        # ads[] where block_position == bottom
    },
    "valueserp": {
        "organic",          # organic_results[]
        "featuredSnippet",  # answer_box
        "aiOverview",       # ai_overview
        "peopleAlsoAsk",    # related_questions[]
        "relatedSearches",  # related_searches[]
        "knowledgeGraph",   # knowledge_graph
        "localPack",        # local_results[]
        "videos",           # inline_videos[]
    },
}

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


def reconcile_capabilities() -> None:
    """Make a declared-but-unparsed capability impossible.

    Two rules, both enforced at import:
      1. Anything in `detects` that the normalizer does not parse is a hard error.
         Failing loudly at import beats shipping a run that reports a feature as
         absent when nothing ever looked for it.
      2. Anything the normalizer does not parse is force-added to `cannot_detect`,
         so it degrades to "not checked" rather than to "absent".

    Rule 2 never removes a hand-declared `cannot_detect`. serper parses
    aiOverview, videos, images and ads but is declared blind to AI Overviews and
    ad load, and that stays: the /search endpoint does not report them reliably,
    and the conservative verdict is the safe one.
    """
    for name, cap in CAPABILITIES.items():
        parsed = PARSES.get(name, set())
        drift = sorted(set(cap["detects"]) - parsed)
        if drift:
            raise AssertionError(
                f"{name}: CAPABILITIES declares {drift} but normalize_{name}() does not parse "
                f"it. Either parse it or move it to cannot_detect — a declared feature the "
                f"normalizer cannot deliver is reported as ABSENT, never as NOT CHECKED.")
        cap["cannot_detect"] = sorted(set(cap["cannot_detect"]) | (FEATURES - parsed))


reconcile_capabilities()


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

MEASURED, ERROR, UNMEASURED = "measured", "error", "unmeasured"


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def now_local() -> str:
    """Local time WITH its offset. The memory store's dates are UTC-only, which
    made every IST-evening observation read as the previous day. Record both and
    nobody has to guess which clock a timestamp is on."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def empty_result(query: str | None) -> dict:
    return {"query": query, "fetchedAt": now_utc(), "fetchedAtLocal": now_local(),
            "status": MEASURED, "measured": True, "error": None,
            "provider": None, "location": None, "organic": [], "aiOverview": None,
            "featuredSnippet": None, "peopleAlsoAsk": [], "relatedSearches": [],
            "knowledgeGraph": None, "localPack": [], "videos": [], "images": 0,
            "shopping": [], "topAds": 0, "bottomAds": 0, "totalResults": None, "notChecked": [],
            "depth": 0, "cached": False, "cacheAgeHours": None, "cacheTtlHours": TTL_HOURS,
            "request": None}


def error_result(query: str, err: object, opts: dict | None = None,
                 status: str = ERROR, attempts: int | None = None) -> dict:
    """A query that failed is still a query that was ASKED.

    It used to be written to the .md and dropped from serp-batch.json — the file
    agents actually cite. 27 rows out of a 30-keyword run then read as
    "0 of 30 not ranking" instead of "0 of 27 measured, 3 never checked", and the
    denominator shrank with nothing saying so. Every asked query gets a row.
    """
    r = empty_result(query)
    r.update({"status": status, "measured": False, "error": str(err), "errorAt": now_utc(),
              "attempts": attempts,
              "request": request_record(opts or {}, resolve_provider(opts or {}))})
    return r


def request_record(opts: dict, provider: str | None) -> dict:
    """Exactly what was asked, so a reader can reconstruct the request.

    --device was accepted and then never sent to serpapi or valueserp, so
    `--device mobile` quietly measured desktop; and nothing in the saved row
    recorded device, gl, hl or num at all, which made it unrecoverable after the
    fact. Record the ask next to the answer.
    """
    return {"provider": provider, "location": opts.get("location"), "gl": opts.get("gl"),
            "hl": opts.get("hl"), "device": opts.get("device") or "desktop",
            "num": opts.get("num"), "requestedAt": now_utc(), "requestedAtLocal": now_local()}


def apply_capabilities(r: dict) -> dict:
    """Mark the features this provider structurally cannot see."""
    cap = CAPABILITIES.get(r.get("provider"), {})
    r["notChecked"] = list(cap.get("cannot_detect", []))
    r["providerNote"] = cap.get("note")
    # None means unknown; 0 or [] would falsely read as "checked and absent".
    for f in r["notChecked"]:
        if r.get(f):
            # The table says this provider is blind here and the payload disagrees.
            # Still discard the value — the conservative verdict wins — but say so,
            # because a table that can never be corrected by observation is a table
            # that stays wrong.
            print(f'note: {r.get("provider")} returned {f} although CAPABILITIES says it '
                  f'cannot detect it — discarded as "not checked"; re-check the table.',
                  file=sys.stderr)
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


def _local_pack(raw: object) -> list:
    """Local packs arrive as a bare list on some providers and as
    `{"places": [...]}` on others. Accept both — guessing wrong here means a
    pack that was returned is reported as absent."""
    places = raw.get("places") if isinstance(raw, dict) else raw
    return [{"name": p.get("title") or p.get("name"), "rating": p.get("rating"),
             "reviews": p.get("reviews") or p.get("ratingCount") or p.get("reviews_original")}
            for p in (places or []) if isinstance(p, dict)]


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
    # Declared in CAPABILITIES["serpapi"]["detects"] and previously never read, so
    # a local pack or a shopping carousel was reported as absent without looking.
    r["localPack"] = _local_pack(d.get("local_results"))
    r["videos"] = [{"title": v.get("title"), "url": v.get("link"), "domain": host(v.get("link"))}
                   for v in (d.get("inline_videos") or [])]
    r["images"] = len(d.get("inline_images") or [])
    r["shopping"] = [{"title": s.get("title"), "url": s.get("link"),
                      "domain": host(s.get("link")), "price": s.get("price")}
                     for s in (d.get("shopping_results") or [])]
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
    # All four declared in CAPABILITIES["valueserp"]["detects"] and previously
    # never read — so every valueserp run reported "0 featured snippets, 0
    # knowledge graphs, 0 local packs" without ever having looked at one.
    ab = d.get("answer_box")
    if ab:
        r["featuredSnippet"] = {"type": ab.get("type", "unknown"), "url": ab.get("link"),
                                "domain": host(ab.get("link")),
                                "content": ab.get("snippet") or ab.get("answer")}
    kg = d.get("knowledge_graph")
    if kg:
        r["knowledgeGraph"] = {"title": kg.get("title"), "type": kg.get("type"),
                               "website": kg.get("website")}
    r["localPack"] = _local_pack(d.get("local_results"))
    r["videos"] = [{"title": v.get("title"), "url": v.get("link"), "domain": host(v.get("link"))}
                   for v in (d.get("inline_videos") or [])]
    return r


# --------------------------------------------------------------------- caching

def resolve_provider(opts: dict | None = None) -> str | None:
    """The provider that WILL be used, never the literal string "auto"."""
    want = (opts or {}).get("provider") or os.environ.get("SERP_PROVIDER")
    try:
        return pick_provider(want)
    except SystemExit:
        return None


def cache_key(q: str, opts: dict) -> str:
    # Resolve the provider BEFORE keying. The key used to record "auto" whenever
    # neither --provider nor SERP_PROVIDER was set, so every provider shared one
    # slot: a serper entry — which carries notChecked: [aiOverview, ...] — could
    # be served to a later run that had switched to serpapi and would actually
    # have checked AI Overviews. The run reports "not checked" for a SERP it could
    # have measured, or worse, inherits serper's blind spots unlabelled.
    provider = opts.get("provider") or os.environ.get("SERP_PROVIDER")
    if not provider or provider == "auto":
        provider = resolve_provider(opts) or "none"
    raw = json.dumps([q, opts.get("location"), opts.get("gl"), opts.get("hl"),
                      opts.get("device"), opts.get("num"), provider])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def legacy_cache_key(q: str, opts: dict) -> str:
    """The pre-fix key, which recorded "auto" instead of the resolved provider.
    Read-only: nothing writes this shape any more."""
    raw = json.dumps([q, opts.get("location"), opts.get("gl"), opts.get("hl"),
                      opts.get("device"), opts.get("num"),
                      opts.get("provider") or os.environ.get("SERP_PROVIDER") or "auto"])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def read_cache(key: str) -> dict | None:
    f = CACHE_DIR / f"{key}.json"
    if not f.exists():
        return None
    age_h = (time.time() - f.stat().st_mtime) / 3600
    if age_h > TTL_HOURS:
        return None
    d = json.loads(f.read_text(encoding="utf-8"))
    d["_cached"] = True                       # kept: older agent prompts read these
    d["_cacheAgeHours"] = round(age_h, 1)
    d["cached"] = True
    d["cacheAgeHours"] = round(age_h, 1)
    d["cacheTtlHours"] = TTL_HOURS
    return d


def write_cache(key: str, d: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(d, indent=2, ensure_ascii=False),
                                           encoding="utf-8")


# ------------------------------------------------------------------ public api

def _retry_after_seconds(resp: "requests.Response") -> float | None:
    """Honour Retry-After when the provider sends one. Seconds form only — the
    HTTP-date form is rare here and a bad parse would be worse than the default
    backoff. Always clamped, never trusted to be small."""
    raw = (resp.headers.get("Retry-After") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, min(MAX_SLEEP_SECONDS, float(raw)))
    except ValueError:
        return None


def request_with_retry(send, *, attempts: int = 0, sleeper=time.sleep) -> "requests.Response":
    """Bounded retry with exponential backoff for transient failures only.

    There was no retry, no backoff and no Retry-After handling anywhere:
    raise_for_status turned a single 429 into a bare exception, which turned into
    a dropped row, which read downstream as "not ranking". Retries cover 429 and
    5xx; a 401/403 is a bad key and is raised immediately.

    The delay is capped per sleep and by a total budget so this can never become
    the kind of open-ended wait the guard hook exists to stop.
    """
    attempts = attempts or MAX_ATTEMPTS
    budget = MAX_SLEEP_SECONDS * 2
    last_status = None
    for attempt in range(1, attempts + 1):
        try:
            resp = send()
        except requests.RequestException as e:                 # timeout / connection reset
            if attempt == attempts or budget <= 0:
                raise
            delay = min(MAX_SLEEP_SECONDS, budget, RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
            print(f"  .. {type(e).__name__}, retry {attempt}/{attempts - 1} in {delay:.1f}s",
                  file=sys.stderr)
            budget -= delay
            sleeper(delay)
            continue
        if resp.status_code not in RETRY_STATUSES or attempt == attempts or budget <= 0:
            resp.raise_for_status()
            return resp
        last_status = resp.status_code
        delay = _retry_after_seconds(resp)
        if delay is None:
            delay = RETRY_BASE_SECONDS * (2 ** (attempt - 1))
        delay = min(MAX_SLEEP_SECONDS, budget, delay)
        print(f"  .. HTTP {last_status}, retry {attempt}/{attempts - 1} in {delay:.1f}s",
              file=sys.stderr)
        budget -= delay
        sleeper(delay)
    raise RuntimeError(f"giving up after {attempts} attempts (last status {last_status})")


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

    if not opts.get("no_cache"):
        # Entries written before the provider was resolved into the key sit under
        # the literal "auto" slot and are otherwise unreachable, so fixing the key
        # would silently re-buy every cached query. Reuse one ONLY when the entry
        # says it came from the provider now resolved — that equality check is the
        # whole of the cross-provider bleed the fix was for. It is not rewritten
        # under the new key: that would reset the file mtime and make a stale
        # entry read as fresh.
        legacy = read_cache(legacy_cache_key(query, opts))
        if legacy and legacy.get("provider") == name:
            return legacy

    device = opts.get("device")
    if name == "serper":
        body = {"q": query, "gl": opts["gl"], "hl": opts["hl"],
                "location": opts["location"], "num": opts["num"]}
        if device:
            body["device"] = device
        resp = request_with_retry(lambda: requests.post(
            "https://google.serper.dev/search", json=body, timeout=45,
            headers={"X-API-KEY": os.environ["SERPER_API_KEY"],
                     "Content-Type": "application/json"}))
        data = normalize_serper(resp.json())
    elif name == "serpapi":
        params = {"q": query, "engine": "google", "api_key": os.environ["SERPAPI_API_KEY"],
                  "gl": opts["gl"], "hl": opts["hl"], "num": opts["num"],
                  "location": opts["location"]}
        if device:
            params["device"] = device     # was dropped: --device mobile measured desktop
        resp = request_with_retry(lambda: requests.get(
            "https://serpapi.com/search.json", params=params, timeout=45))
        data = normalize_serpapi(resp.json())
    else:
        params = {"q": query, "api_key": os.environ["VALUESERP_API_KEY"],
                  "gl": opts["gl"], "hl": opts["hl"], "num": opts["num"],
                  "location": opts["location"]}
        if device:
            params["device"] = device     # same drop as serpapi
        resp = request_with_retry(lambda: requests.get(
            "https://api.valueserp.com/search", params=params, timeout=45))
        data = normalize_valueserp(resp.json())

    data = apply_capabilities(data)
    data["request"] = request_record(opts, name)
    data["request"]["query"] = query
    # The row is keyed by the query that was ASKED, not by the provider's echo.
    # The echo is what the provider says it searched for — it can be absent, or
    # spelling-corrected — and a row labelled with it cannot be joined back to the
    # keyword list, which is how a measured query turns into a missing one.
    data["queryEcho"] = data.get("query")
    data["query"] = query
    # The provider's echo is the better record when it exists, but its absence used
    # to leave location=None, which to_markdown printed as "default location" — a
    # US-targeted query and an untargeted one became indistinguishable in the file.
    data["locationEcho"] = data.get("location")
    data["locationRequested"] = opts["location"]
    data["location"] = data.get("location") or opts["location"]
    data["device"] = device or "desktop"
    data["gl"], data["hl"], data["num"] = opts["gl"], opts["hl"], opts["num"]
    data["depth"] = len(data.get("organic") or [])
    data["status"], data["measured"] = MEASURED, True
    data["_cached"] = data["cached"] = False
    data["cacheAgeHours"] = 0.0
    data["cacheTtlHours"] = TTL_HOURS
    if data["depth"] < (opts["num"] or 0):
        # The provider returning fewer results than asked is the whole of defect 3:
        # "top 20" was printed from ten-result data.
        print(f'  .. requested num={opts["num"]}, provider returned {data["depth"]} organic '
              f'results — depth claims must use {data["depth"]}', file=sys.stderr)
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
    if not r.get("measured", True):
        L.append(f'*{r.get("status")} · {r.get("provider") or "no provider"} · '
                 f'{r.get("errorAt") or r.get("fetchedAt")}*\n')
        L.append(f'> **NOT MEASURED — {r.get("status")}:** {r.get("error")}\n'
                 f'> This query was asked and produced no measurement. It is not evidence '
                 f'that the target does not rank.')
        return "\n".join(L)
    age = r.get("cacheAgeHours", r.get("_cacheAgeHours"))
    cached = (f' · **cached {age}h** (TTL {r.get("cacheTtlHours", TTL_HOURS)}h)'
              if (r.get("cached") or r.get("_cached")) else " · live")
    req = r.get("request") or {}
    loc = r.get("location") or "default location"
    if not r.get("locationEcho") and r.get("locationRequested"):
        loc = f'{r.get("locationRequested")} (requested; provider did not echo it)'
    depth = len(r.get("organic") or [])
    asked = req.get("num") or r.get("num")
    depth_note = f' · depth {depth} retrieved' + (f' of {asked} requested' if asked else "")
    L.append(f'*{r.get("provider")} · {loc} · {req.get("device") or r.get("device") or "desktop"}'
             f'{depth_note} · {r.get("fetchedAt")}{cached}*\n')
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
    L.append(f'\n*A domain absent from this SERP is absent from the top {depth} retrieved — '
             f'positions beyond {depth} were never fetched.*')
    if a["paaQuestions"]:
        L.append("\n**People Also Ask**")
        L += [f"- {q}" for q in a["paaQuestions"]]
    if r.get("relatedSearches"):
        L.append(f'\n**Related:** {" · ".join(str(x) for x in r["relatedSearches"])}')
    return "\n".join(L)


def compare_domains(results: list, target: str, competitors: list) -> dict:
    rows = []
    for r in results:
        if not r.get("measured", True):
            # An unmeasured query is NOT a query where the target failed to rank.
            # It keeps its row so the reader can see it, and it is kept out of both
            # sides of the visibility rate below.
            rows.append({"query": r.get("query"), "status": r.get("status", ERROR),
                         "error": r.get("error"), "target": None,
                         "competitors": {c: None for c in competitors},
                         "depthRetrieved": 0, "aiOverview": None,
                         "aiOverviewCitesTarget": None, "snippetHolder": None,
                         "clickAvailabilityEstimate": None, "format": None,
                         "cached": False, "cacheAgeHours": None})
            continue
        a = analyze_serp(r)

        def pos(d):
            m = next((o for o in (r.get("organic") or [])
                      if o.get("domain") == d or (o.get("domain") or "").endswith("." + d)), None)
            return m.get("position") if m else None

        rows.append({
            "query": r.get("query"), "status": MEASURED, "error": None,
            "target": pos(target),
            "competitors": {c: pos(c) for c in competitors},
            # The depth actually retrieved for THIS query. Absence below position
            # `depthRetrieved` was not measured and must never be reported as a rank.
            "depthRetrieved": len(r.get("organic") or []),
            "aiOverview": a["aiOverviewPresent"],
            "aiOverviewCitesTarget": (None if a["aiOverviewPresent"] is None
                                      else target in a["aiOverviewSources"]),
            "snippetHolder": a["snippetHolder"],
            "clickAvailabilityEstimate": a["clickAvailabilityEstimate"],
            "format": a["formatSignal"]["dominant"],
            "cached": bool(r.get("cached") or r.get("_cached")),
            "cacheAgeHours": r.get("cacheAgeHours", r.get("_cacheAgeHours")),
        })
    done = [r for r in rows if r["status"] == MEASURED]
    failed = [r for r in rows if r["status"] != MEASURED]
    ranked = len([r for r in done if r["target"]])
    checked = len([r for r in done if r["aiOverview"] is not None])
    depths = [r["depthRetrieved"] for r in done] or [0]
    cached_rows = [r for r in done if r["cached"]]
    ages = [r["cacheAgeHours"] for r in cached_rows if r["cacheAgeHours"] is not None]

    def avg(c):
        ps = [r["competitors"][c] for r in done if r["competitors"][c]]
        return round(sum(ps) / len(ps), 1) if ps else None

    return {"summary": {
        # `keywords` keeps its old meaning (rows that produced a measurement) so
        # existing readers do not silently change denominator. The requested and
        # errored counts sit beside it, and the rate states its own basis, so
        # nobody can read a rate over a shrunken denominator without being told.
        "keywords": len(done), "targetRanksIn": ranked,
        "keywordsRequested": len(rows), "keywordsMeasured": len(done),
        "keywordsErrored": len(failed),
        "erroredQueries": [r["query"] for r in failed],
        "targetVisibilityRate": round(ranked / len(done) * 100, 1) if done else 0,
        "targetVisibilityRateBasis": (
            f"{ranked} of {len(done)} MEASURED keywords"
            + (f" — {len(failed)} of {len(rows)} requested keywords errored and are excluded "
               f"from both numerator and denominator; they are NOT evidence of absence"
               if failed else f" (all {len(rows)} requested keywords measured)")),
        "depthRetrievedMin": min(depths), "depthRetrievedMax": max(depths),
        "depthBasis": (f"absence means absent from the top {min(depths)} retrieved, "
                       f"not from any deeper position — those were never fetched"),
        "aiOverviewChecked": checked,
        "aiOverviewCoverage": len([r for r in done if r["aiOverview"] is True]),
        "targetCitedInAio": len([r for r in done if r["aiOverviewCitesTarget"] is True]),
        "cachedRows": len(cached_rows), "cacheTtlHours": TTL_HOURS,
        "cacheAgeHoursMax": max(ages) if ages else None,
        "competitorAvgPositions": {c: avg(c) for c in competitors}},
        "rows": rows}


# ------------------------------------------------------------------------- cli

def read_keywords(path: str) -> list[str]:
    return [l.strip() for l in Path(path).read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.startswith("#")]


def main() -> int:
    global MAX_ATTEMPTS
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
    # Added, never renamed: 52 agent prompts and two scheduled jobs call this CLI.
    ap.add_argument("--max-attempts", type=int, dest="max_attempts",
                    help=f"bounded retry attempts per query on 429/5xx (default {MAX_ATTEMPTS}, max 5)")
    ap.add_argument("--fail-on-error", action="store_true", dest="fail_on_error",
                    help="exit 1 if any query failed to measure (default: exit 0 — the failed "
                         "rows are written either way, with status=error)")
    a = ap.parse_args()

    if a.max_attempts:
        MAX_ATTEMPTS = max(1, min(5, a.max_attempts))

    opts = {"location": a.location, "gl": a.gl, "hl": a.hl, "device": a.device,
            "num": a.num, "no_cache": a.no_cache, "provider": a.provider}

    if a.command == "providers":
        print("SERP providers (set one key in .env):\n")
        for name, cap in CAPABILITIES.items():
            state = "CONFIGURED" if os.environ.get(cap["env"]) else "not set"
            print(f'  {name:<10} {cap["env"]:<20} {state}')
            print(f'  {"":<10} {cap["docs"]}\n')
        print(f"  cache TTL: {TTL_HOURS}h · retry: up to {MAX_ATTEMPTS} attempts on "
              f'{sorted(RETRY_STATUSES)} (Retry-After honoured, capped at {MAX_SLEEP_SECONDS}s)\n')
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
        allr = []
        for i, k in enumerate(kws):
            print(f"  {k}", file=sys.stderr)
            try:
                r = serp_search(k, opts)
            except SystemExit:
                raise                               # NO_SERP_PROVIDER — abort, do not pretend
            except Exception as e:
                # The row survives. It used to exist only in the .md, so the JSON
                # agents cite came back short and the missing queries read as
                # "checked, not ranking" rather than "never checked".
                r = error_result(k, e, opts)
            allr.append(r)
            if not r.get("cached") and i + 1 < len(kws):
                time.sleep(0.25)
        measured = [r for r in allr if r["status"] == MEASURED]
        errored = [r for r in allr if r["status"] == ERROR]
        depths = [r["depth"] for r in measured] or [0]
        cached_n = len([r for r in measured if r.get("cached")])
        ages = [r.get("cacheAgeHours") for r in measured
                if r.get("cached") and r.get("cacheAgeHours") is not None]
        md = [f"# SERP batch — {len(kws)} keywords requested",
              f'*{now_utc()} ({now_local()} local) · location: {a.location} · '
              f'device: {a.device or "desktop"} · provider: '
              f'{(measured[0].get("provider") if measured else resolve_provider(opts)) or "none"}*\n',
              f"**Measured: {len(measured)} · errored: {len(errored)} · "
              f"requested: {len(kws)}**\n",
              f"*Depth retrieved: {min(depths)}–{max(depths)} organic results per query "
              f"(`--num {a.num}` requested). Absence means absent from the top {min(depths)} "
              f"retrieved, not from any deeper position.*\n",
              f"*Cache: {cached_n} of {len(measured)} measured rows served from cache"
              + (f", ages {min(ages)}h–{max(ages)}h" if ages else "")
              + f"; TTL {TTL_HOURS}h. Cached rows are not point-in-time with the live ones.*\n"]
        if errored:
            md.append("> **Do not compute a rate over the measured rows alone without saying so.** "
                      f"{len(errored)} of {len(kws)} queries produced no measurement: "
                      + ", ".join(f'`{r["query"]}`' for r in errored)
                      + ". They are recorded in serp-batch.json with `status: error` and are "
                      "NOT evidence of absence.\n")
        for r in allr:
            md += [to_markdown(r, analyze_serp(r) if r["status"] == MEASURED else {}), "\n---\n"]
        (out / "serp-batch.json").write_text(json.dumps(allr, indent=2, ensure_ascii=False), encoding="utf-8")
        (out / "serp-batch.md").write_text("\n".join(md), encoding="utf-8")
        print(f"Wrote {out}/serp-batch.{{json,md}} — {len(measured)} measured, "
              f"{len(errored)} error, {len(kws)} requested "
              f"(every requested query has a row with an explicit status)")
        return 1 if errored and a.fail_on_error else 0

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
        queries = read_keywords(f)
        rows = []
        for i, q in enumerate(queries):
            print(f"  {q}", file=sys.stderr)
            try:
                r = serp_search(q, opts); an = analyze_serp(r)
                rows.append({"query": q, "status": MEASURED, "present": an["aiOverviewPresent"],
                             "sources": an["aiOverviewSources"], "snippet": an["snippetHolder"],
                             "cached": bool(r.get("cached")),
                             "cacheAgeHours": r.get("cacheAgeHours"),
                             "depthRetrieved": len(r.get("organic") or []),
                             "request": r.get("request")})
                if not r.get("cached") and i + 1 < len(queries):
                    time.sleep(0.25)
            except SystemExit:
                raise
            except Exception as e:
                rows.append({"query": q, "status": ERROR, "error": str(e), "present": None,
                             "sources": [], "snippet": None})
        done = [r for r in rows if r.get("status") == MEASURED]
        failed = [r for r in rows if r.get("status") != MEASURED]
        cached_n = len([r for r in done if r.get("cached")])
        ages = [r["cacheAgeHours"] for r in done
                if r.get("cached") and r.get("cacheAgeHours") is not None]
        with_aio = [r for r in rows if r.get("present")]
        cited: dict[str, int] = {}
        for r in with_aio:
            for d in r["sources"]:
                cited[d] = cited.get(d, 0) + 1
        L = ["# AI Overview check",
             f'*{len(rows)} queries requested · {name} · {a.location} · '
             f'device: {a.device or "desktop"} · {now_utc()} ({now_local()} local)*\n',
             f"**Measured: {len(done)} · errored: {len(failed)} · requested: {len(rows)}**\n",
             f"AI Overview present on **{len(with_aio)}/{len(done)} MEASURED** queries"
             + (f" — {len(failed)} of {len(rows)} requested queries errored and are excluded "
                f"from that denominator; they are NOT evidence of absence.\n" if failed
                else f" (all {len(rows)} requested queries measured).\n"),
             f"*Cache: {cached_n} of {len(done)} measured rows served from cache"
             + (f", ages {min(ages)}h–{max(ages)}h" if ages else "")
             + f"; TTL {TTL_HOURS}h — a cached row reflects the SERP as of its age, not now.*\n"]
        if cited:
            L += ["## Most-cited domains\n", "| Domain | Cited on |", "|---|---|"]
            L += [f"| {d} | {n} |" for d, n in sorted(cited.items(), key=lambda kv: -kv[1])]
            L.append("")
        L += ["| Query | AI Overview | Cited sources | Measured |", "|---|---|---|---|"]
        for r in rows:
            state = ("ERROR — not measured" if r.get("status") == ERROR
                     else ("yes" if r.get("present") else "none"))
            when = ("—" if r.get("status") == ERROR else
                    (f'cached {r.get("cacheAgeHours")}h' if r.get("cached") else "live"))
            L.append(f'| {r["query"]} | {state} | {", ".join(r.get("sources") or []) or "—"} '
                     f'| {when} |')
        out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
        (out / "ai-overview-check.md").write_text("\n".join(L), encoding="utf-8")
        (out / "ai-overview-check.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        print("\n".join(L))
        return 0

    if a.command == "compare":
        if not a.domain or not a.keywords:
            raise SystemExit("usage: serp.py compare --domain <d> --vs a.com,b.com --keywords <file>")
        vs = [x.strip() for x in a.vs.split(",") if x.strip()]
        kws = read_keywords(a.keywords)
        results = []
        for i, k in enumerate(kws):
            print(f"  {k}", file=sys.stderr)
            try:
                r = serp_search(k, opts)
                if not r.get("cached") and i + 1 < len(kws):
                    time.sleep(0.25)
            except SystemExit:
                raise
            except Exception as e:
                # Same rule as batch: the failure keeps its row. Dropping it here
                # shrank the denominator twice over — the query vanished AND
                # summary["keywords"] was recomputed from the survivors, so
                # "ranks for 0/27" printed as though 27 had been the ask.
                print(f"  !! {k}: {e}", file=sys.stderr)
                r = error_result(k, e, opts)
            results.append(r)
        target = re.sub(r"^www\.", "", a.domain)
        cmp = compare_domains(results, target, vs)
        out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
        (out / "competitive-position.json").write_text(json.dumps(cmp, indent=2), encoding="utf-8")

        s = cmp["summary"]
        dmin, dmax = s["depthRetrievedMin"], s["depthRetrievedMax"]
        # The depth actually retrieved, never --num. This line used to read
        # "Ranks in top 20" off ten-result data, so a reader concluded the domain
        # was absent from positions 11-20 that were never fetched.
        depth_label = f"top {dmin}" if dmin == dmax else f"top {dmin}–{dmax}"
        L = [f"# Competitive SERP position — {a.domain}",
             f'*{s["keywordsRequested"]} keywords requested · {s["keywordsMeasured"]} measured · '
             f'{s["keywordsErrored"]} errored · {a.location} · device: {a.device or "desktop"} · '
             f'{now_utc()} ({now_local()} local)*\n',
             f'- Ranks in the **{depth_label} retrieved** for '
             f'**{s["targetRanksIn"]}/{s["keywordsMeasured"]}** measured keywords '
             f'({s["targetVisibilityRate"]}% — {s["targetVisibilityRateBasis"]})',
             f'- Depth: providers returned {dmin}–{dmax} organic results per query against '
             f'`--num {a.num}` requested. **Absent here means absent from the {depth_label} '
             f'retrieved, not from any deeper position — those were never fetched.**',
             f'- Cache: {s["cachedRows"]} of {s["keywordsMeasured"]} measured rows came from '
             f'cache (TTL {s["cacheTtlHours"]}h'
             + (f', oldest {s["cacheAgeHoursMax"]}h' if s["cacheAgeHoursMax"] is not None else "")
             + '). Cached rows are not point-in-time with the live ones; re-run with '
               '`--no-cache` for a single-moment snapshot.']
        if s["keywordsErrored"]:
            plural = "keyword" if s["keywordsErrored"] == 1 else "keywords"
            L.append(f'- **{s["keywordsErrored"]} {plural} produced no measurement:** '
                     + ", ".join(f'`{q}`' for q in s["erroredQueries"])
                     + ' — excluded from the rate above and NOT evidence of absence. '
                       'They are in competitive-position.json with `status: error`.')
        if s["aiOverviewChecked"] == 0:
            prov = next((r.get("provider") for r in results if r.get("provider")), "provider")
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
                 " | Depth | AIO | Snippet | Click avail (est) | Format |")
        L.append("|---|" + "---|" * (len(vs) + 6))
        for r in cmp["rows"]:
            if r["status"] != MEASURED:
                # "—" in a rank column reads as "checked, not there". An unmeasured
                # query must say so in every cell a reader might scan.
                L.append(f'| {r["query"]} | NOT MEASURED | ' +
                         " | ".join("not measured" for _ in vs) +
                         f' | 0 | not measured | not measured | not measured | '
                         f'{r["status"]}: {(r.get("error") or "")[:60]} |')
                continue
            aio = ("not checked" if r["aiOverview"] is None else
                   ("cites us" if r["aiOverviewCitesTarget"] else "yes") if r["aiOverview"] else "none")
            absent = f'absent from top {r["depthRetrieved"]}'
            depth_cell = str(r["depthRetrieved"])
            if r["cached"]:
                depth_cell += f' · cached {r["cacheAgeHours"]}h'
            L.append(f'| {r["query"]} | {r["target"] or absent} | ' +
                     " | ".join(str(r["competitors"][c] or absent) for c in vs) +
                     f' | {depth_cell}'
                     f' | {aio} | {r["snippetHolder"] or "—"} | '
                     f'~{r["clickAvailabilityEstimate"]}% | {r["format"]} |')
        (out / "competitive-position.md").write_text("\n".join(L), encoding="utf-8")
        print("\n".join(L))
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())

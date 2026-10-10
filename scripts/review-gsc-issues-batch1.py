#!/usr/bin/env python3
"""Batch 1: agent review for GSC 403 + redirect-error issues (live HTTP evidence)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
AGENTS_403 = ["crawler-access-engineer", "technical-seo-engineer"]
AGENTS_ERR = ["technical-seo-engineer", "index-coverage-analyst"]

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "gsc-issues.json"
PROBE = ROOT / "data" / "_probe-403-error.json"


def review_403(issue: dict, st, final) -> dict:
    url = issue["url"]
    action = (issue.get("action") or "").strip()
    if "Duplicate without" in url or not str(url).startswith("http"):
        return {
            "why": "This row is a GSC coverage label, not a URL — it cannot be fetched or redirected.",
            "fix": "Remove or re-classify this sheet row. Pull the actual URLs from GSC Coverage and add those URLs as separate issues.",
            "ownerTeam": "SEO",
            "effort": "15m",
            "observedStatus": None,
            "reviewedAt": NOW,
            "agents": AGENTS_ERR,
        }
    if '"https:' in url or str(url).count("http") > 1 or "[" in url:
        return {
            "why": f"Malformed URL is generating a broken request path (live status {st}). Bots waste crawl on junk URLs and never reach the real page.",
            "fix": "Find the template/CMS field that concatenates absolute URLs into hrefs; emit a single clean path. Remove the bad link from sitemap/HTML. "
            + (action or "Link only to the real destination URL."),
            "ownerTeam": "Dev",
            "effort": "1h",
            "observedStatus": st,
            "reviewedAt": NOW,
            "agents": AGENTS_403,
        }
    if st == 404:
        return {
            "why": f"GSC reported access forbidden, but live fetch now returns 404 for {url}. The URL is unreachable for users and Googlebot.",
            "fix": (action or "Restore a 200 landing page or 301 to the nearest live hub.")
            + " After deploy, confirm Googlebot gets 200/301 (not 403/404). Use URL Inspection.",
            "ownerTeam": "Dev",
            "effort": "half-day",
            "observedStatus": st,
            "reviewedAt": NOW,
            "agents": AGENTS_403,
        }
    if st == 200:
        return {
            "why": "Sheet listed this under 403, but live fetch currently returns 200. Validate Googlebot parity (WAF may still challenge bots).",
            "fix": (action or "Keep URL returning 200.")
            + " Confirm Cloudflare/WAF allows Googlebot; if this should redirect, use a single 301 to the canonical.",
            "ownerTeam": "Dev",
            "effort": "1h",
            "observedStatus": st,
            "reviewedAt": NOW,
            "agents": AGENTS_403,
        }
    return {
        "why": f"Live fetch returns HTTP 403 for browser and Googlebot-style UA on {url}. Hub/money paths that 403 cannot be crawled or indexed — front-door failure (WAF/CDN/ACL), not on-page SEO.",
        "fix": (action or "Return 200 OK to users and Googlebot.")
        + " In Cloudflare/origin: allowlist Googlebot/Bingbot; disable Bot Fight rules on these paths; fix IP/geo/ASN denies. Verify with URL Inspection + logs. Do not noindex as a workaround.",
        "ownerTeam": "Dev",
        "effort": "half-day",
        "observedStatus": st,
        "reviewedAt": NOW,
        "agents": AGENTS_403,
    }


def review_error(issue: dict, st, final) -> dict:
    url = issue["url"]
    action = (issue.get("action") or "").strip()
    if "Duplicate without" in url or not str(url).startswith("http"):
        return {
            "why": "Sheet cell contains a GSC exclusion category name instead of a URL, so redirect-error triage cannot run.",
            "fix": "Export real URLs from that GSC coverage bucket into the Error sheet; delete this placeholder row.",
            "ownerTeam": "SEO",
            "effort": "15m",
            "observedStatus": None,
            "reviewedAt": NOW,
            "agents": AGENTS_ERR,
        }
    if "[" in url or '"https:' in url or str(url).count("http") > 1:
        return {
            "why": f"Malformed href embeds another URL inside the path (live status {st}). Creates redirect/404 noise in GSC and breaks internal equity.",
            "fix": (action or "Fix the broken nested link.")
            + " Patch the content/template; 301 the junk URL to the real destination if it has links/impressions.",
            "ownerTeam": "Dev",
            "effort": "1h",
            "observedStatus": st,
            "reviewedAt": NOW,
            "agents": AGENTS_ERR,
        }
    if st == 404:
        return {
            "why": "GSC flagged a redirect error; live URL now 404s. Users and bots hit a dead end.",
            "fix": (action or "Add one direct 301 to the current canonical URL that returns 200.")
            + " Remove chains/loops; update internal links and sitemap to the final URL only.",
            "ownerTeam": "Dev",
            "effort": "1h",
            "observedStatus": st,
            "reviewedAt": NOW,
            "agents": AGENTS_ERR,
        }
    if st in (301, 302):
        return {
            "why": f"Live response is {st}. GSC redirect errors usually mean a chain, loop, or hop to an error page.",
            "fix": (action or "Collapse to a single 301 to the canonical that returns 200.")
            + f" Trace the full chain from {url}; ensure final URL is 200 and self-canonical; update internal links to final URL.",
            "ownerTeam": "Dev",
            "effort": "1h",
            "observedStatus": st,
            "finalUrl": final,
            "reviewedAt": NOW,
            "agents": AGENTS_ERR,
        }
    return {
        "why": f"Live fetch returns 200 for {url}, but GSC reported a redirect error — often a past chain, slash ping-pong, or unclear canonical. Soft risk: duplicate signals and crawl waste.",
        "fix": (action or "Ensure one direct 301 to the canonical if this path is not canonical; otherwise self-canonicalize.")
        + " Pick one URL form; 301 alternates in one hop; update internal links + sitemap; re-inspect in GSC.",
        "ownerTeam": "SEO",
        "effort": "1h",
        "observedStatus": st,
        "finalUrl": final,
        "reviewedAt": NOW,
        "agents": AGENTS_ERR,
    }


def main() -> None:
    if not PROBE.exists():
        raise SystemExit(f"Missing probe file: {PROBE} — re-run HTTP probe first")
    probe = json.loads(PROBE.read_text(encoding="utf-8"))
    data = json.loads(PATH.read_text(encoding="utf-8"))
    n = 0
    for issue in data["issues"]:
        if issue["category"] not in ("403", "error"):
            continue
        if issue.get("agentReview"):
            continue
        p = probe.get(issue["url"], {})
        st = p.get("status")
        final = p.get("final")
        if issue["category"] == "403":
            issue["agentReview"] = review_403(issue, st, final)
        else:
            issue["agentReview"] = review_error(issue, st, final)
        n += 1

    reviewed = sum(1 for i in data["issues"] if i.get("agentReview"))
    data["lastAgentReviewAt"] = NOW
    data["reviewedCount"] = reviewed
    data["lastAgentReviewNote"] = (
        f"Batch 1: {n} critical issues (403+error) reviewed with live HTTP probes; "
        "agents crawler-access-engineer + technical-seo-engineer "
        "(+ index-coverage-analyst on errors)."
    )
    PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    PROBE.unlink(missing_ok=True)
    print(f"reviewed_this_run={n} total_with_review={reviewed}")


if __name__ == "__main__":
    main()

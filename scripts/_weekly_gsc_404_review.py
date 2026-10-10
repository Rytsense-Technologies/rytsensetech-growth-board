#!/usr/bin/env python3
"""Weekly GSC Issues agent review — batch: 404 category (pending), grounded in live
Google Search Console URL Inspection data (mcp gsc__inspect_url) gathered this run.
Agents: crawler-access-engineer + technical-seo-engineer (per routing rule for 404s).
"""
import json
from datetime import datetime, timezone
from pathlib import Path

NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
AGENTS = ["crawler-access-engineer", "technical-seo-engineer"]

ROOT = Path.home() / "mnt" / "growth-board"
PATH = ROOT / "data" / "gsc-issues.json"

# Per-issue live facts gathered via gsc__inspect_url this run.
# status: "404" (genuine, confirmed via GSC URL Inspection on the exact/raw URL or its
#   cleaned canonical form), "ok" (clean canonical URL is indexed & healthy — raw GSC
#   row is a malformed href leak, not a missing page), "not-indexed" (crawled but Google
#   is choosing not to index it — not a 404 issue at all).
FACTS = {
    "gsc-4183139068": {"group": "A", "status": "404", "crawl": "2026-05-23T21:17:20Z", "money": True},
    "gsc-7a80985108": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/industry/ai-in-healthcare/", "crawl": "2026-09-20T15:18:02Z", "leak": "a stray trailing single-quote"},
    "gsc-c9cb483eb5": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/blog/hire-laravel-developer/", "crawl": "2026-09-21T07:06:09Z", "leak": "a raw <a href= anchor tag fragment"},
    "gsc-0ad3f5e76e": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/blog/hire-dedicated-software-developers-india/", "crawl": "2026-08-30T00:20:51Z", "leak": "a raw <a href= anchor tag fragment"},
    "gsc-8dfbf39ce6": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/blog/hire-offshore-software-developers/", "crawl": "2026-08-28T23:09:06Z", "leak": "a raw <a href= anchor tag fragment"},
    "gsc-034df29920": {"group": "I", "status": "404", "clean": "https://rytsensetech.com/blog/why-is-custom-software-development-important/", "crawl": "2026-08-11T06:55:15Z", "leak": "a stray \" class= attribute fragment"},
    "gsc-48d457e104": {"group": "H", "status": "not-indexed", "clean": "https://rytsensetech.com/blog/enterprise-ai-development-company-selection-guide/", "crawl": "2026-08-28T23:32:05Z", "leak": "a raw <a href= anchor tag fragment"},
    "gsc-e3992cea32": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/blog/how-to-hire-developers-in-india/", "crawl": "2026-09-15T14:09:25Z", "leak": "a pasted heading (\"Which Programming Languages Are Used Most Often in AI Development\") appended to the path"},
    "gsc-99790e1151": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/blog/top-ai-agent-development-companies/", "crawl": "2026-09-04T14:00:17Z", "leak": "an unencoded space in place of a hyphen"},
    "gsc-6231504952": {"group": "G", "status": "ok", "clean": "https://rytsensetech.com/industry/ai-in-retail/", "crawl": "2026-08-28T02:28:38Z", "leak": "a missing trailing slash", "traffic": "8 impressions / 0 clicks (28d) on the clean URL"},
    "gsc-43defb6741": {"group": "C", "status": "404", "crawl": "2026-09-23T01:49:56Z", "has_action": True},
    "gsc-5538607b8e": {"group": "C", "status": "404", "crawl": "2026-09-08T09:47:42Z"},
    "gsc-cf9b20f44c": {"group": "B", "status": "404", "crawl": "2026-08-31T01:35:45Z"},
    "gsc-58ea4c4a7f": {"group": "B", "status": "404", "crawl": "2026-08-30T11:45:29Z"},
    "gsc-7b490469f4": {"group": "C", "status": "404", "crawl": "2026-08-28T00:47:58Z"},
    "gsc-dce0b8c86b": {"group": "D", "status": "404", "crawl": "2026-07-28T21:17:31Z"},
    "gsc-b50adb8a93": {"group": "C", "status": "404", "crawl": "2026-07-26T21:54:35Z"},
    "gsc-25d645d85d": {"group": "B", "status": "404", "crawl": "2026-07-13T12:41:23Z"},
    "gsc-337f2719c6": {"group": "F2", "status": "404", "crawl": "2026-07-05T01:39:04Z"},
    "gsc-7a64314a48": {"group": "B", "status": "404", "crawl": "2026-07-02T04:38:16Z"},
    "gsc-8540eb9aee": {"group": "B", "status": "404", "crawl": "2026-06-12T08:45:35Z"},
    "gsc-71ff64149f": {"group": "D", "status": "404", "crawl": "2026-06-08T14:16:42Z"},
    "gsc-e2da51fd27": {"group": "A", "status": "404", "crawl": "2026-05-24T06:39:57Z"},
    "gsc-42dad8a128": {"group": "A", "status": "404", "crawl": "2026-05-24T06:31:38Z"},
    "gsc-0e5e0bffdd": {"group": "A", "status": "404", "crawl": "2026-05-24T05:48:36Z"},
    "gsc-7d43573013": {"group": "F", "status": "404", "crawl": "2026-05-24T01:12:15Z"},
    "gsc-8ea821224e": {"group": "A", "status": "404", "crawl": "2026-05-23T09:42:31Z"},
    "gsc-fa4bfbf2e0": {"group": "A", "status": "404", "crawl": "2026-05-22T14:24:55Z"},
    "gsc-d134d5ca26": {"group": "F", "status": "404", "crawl": "2026-05-22T12:32:46Z"},
    "gsc-ddd3f8caff": {"group": "A", "status": "404", "crawl": "2026-05-22T12:29:47Z"},
    "gsc-0ac8e89826": {"group": "A", "status": "404", "crawl": "2026-05-22T12:22:52Z"},
    "gsc-69cee5eade": {"group": "A", "status": "404", "crawl": "2026-05-22T11:49:33Z"},
    "gsc-f7591cadd3": {"group": "A", "status": "404", "crawl": "2026-05-22T11:34:17Z"},
    "gsc-0fb7f6e302": {"group": "F", "status": "404", "crawl": "2026-05-22T08:07:05Z"},
    "gsc-81f332398d": {"group": "A", "status": "404", "crawl": "2026-05-21T19:29:59Z"},
    "gsc-dab5d03d67": {"group": "A", "status": "404", "crawl": "2026-05-21T14:23:44Z"},
    "gsc-9995f3321c": {"group": "A", "status": "404", "crawl": "2026-05-21T13:28:15Z"},
    "gsc-154e3317f7": {"group": "F", "status": "404", "crawl": "2026-05-21T08:12:18Z"},
    "gsc-e4af1a99a6": {"group": "F", "status": "404", "crawl": "2026-05-19T22:18:45Z"},
    "gsc-e2c14f51c9": {"group": "F", "status": "404", "crawl": "2026-05-19T20:54:05Z"},
    "gsc-409f1fb709": {"group": "F", "status": "404", "crawl": "2026-05-16T00:37:47Z"},
    "gsc-6a0b15c9ea": {"group": "A", "status": "404", "crawl": "2026-05-14T10:47:13Z"},
    "gsc-b6fa8246dc": {"group": "A", "status": "404", "crawl": "2026-05-14T05:50:31Z"},
    "gsc-d1184971df": {"group": "A", "status": "404", "crawl": "2026-05-12T12:52:28Z"},
    "gsc-f7fcd9000c": {"group": "E", "status": "404", "crawl": "2026-04-12T21:57:02Z"},
    "gsc-19681f4e83": {"group": "E", "status": "404", "crawl": "2026-04-12T21:52:01Z"},
    "gsc-76da6c77a5": {"group": "E", "status": "404", "crawl": "2026-04-12T06:21:49Z"},
    "gsc-daf384890c": {"group": "E", "status": "404", "crawl": "2026-04-12T03:51:49Z"},
    "gsc-7bedc83242": {"group": "E", "status": "404", "crawl": "2026-04-12T02:29:37Z"},
    "gsc-6cc8481a9d": {"group": "E", "status": "404", "crawl": "2026-04-11T23:45:43Z"},
    "gsc-3e096058d9": {"group": "E", "status": "404", "crawl": "2026-04-11T20:00:43Z"},
    "gsc-6d33db8219": {"group": "E", "status": "404", "crawl": "2026-04-11T20:00:42Z"},
    "gsc-ce9d7fa1e8": {"group": "E", "status": "404", "crawl": "2026-04-11T05:42:30Z"},
    "gsc-756354a83a": {"group": "E", "status": "404", "crawl": "2026-04-10T22:09:52Z"},
    "gsc-f713f82e64": {"group": "E", "status": "404", "crawl": "2026-04-10T21:31:22Z"},
}

GROUP_A_COUNT = sum(1 for f in FACTS.values() if f["group"] == "A")
GROUP_B_COUNT = sum(1 for f in FACTS.values() if f["group"] == "B")
GROUP_E_COUNT = sum(1 for f in FACTS.values() if f["group"] == "E")


def build(issue, f):
    url = issue["url"]
    action = (issue.get("action") or "").strip()
    group = f["group"]
    crawl = f.get("crawl")

    if group == "A":
        money_note = " This is one of the site's listed money pages (audit.json moneyPages), so it should be prioritized." if f.get("money") else ""
        why = (
            f"Google Search Console URL Inspection confirms this /us/ page returns 404 (indexingState: "
            f"\"Not found (404)\"); last successful Googlebot crawl was {crawl}. It is 1 of {GROUP_A_COUNT} "
            f"/us/ market pages in this batch alone showing the identical pattern (all last successfully "
            f"crawled between 2026-05-12 and 2026-05-24), which points to a single bulk event — a template/"
            f"routing regression or an unannounced content pruning of the /us/ service-and-industry page set "
            f"around late May 2026 — rather than {GROUP_A_COUNT} unrelated deletions.{money_note}"
        )
        fix = (
            (action + " ") if action else ""
        ) + (
            "Confirm with Dev whether the /us/ service/industry pages were intentionally retired or "
            "whether a routing/build change silently dropped this URL set. If retired, add one 301 per "
            "URL to the closest live equivalent (global page or the /us/ hub) and update internal links + "
            "sitemap; if it was a regression, restore the route and redeploy. Treat this as one batch fix "
            "(redirect map) covering all affected /us/ URLs rather than one-off patches. After deploy, "
            "re-run URL Inspection on each to confirm 200/indexed."
        )
        owner = "Dev"
        effort = "1d+" if f.get("money") else "half-day"

    elif group == "B":
        why = (
            f"GSC URL Inspection confirms 404 (last successful crawl {crawl}). It is 1 of {GROUP_B_COUNT} "
            f"\"/company/service/*\" URLs in this batch all returning 404, suggesting this URL path was "
            f"deprecated/restructured into a different service-page location without 301s being put in place."
        )
        fix = (
            "Confirm the current canonical path for this service (check the live nav/sitemap for the "
            "equivalent service page) and add a single 301 from this old /company/service/* URL to it. "
            "Cover all 5 affected /company/service/* URLs with one redirect-map fix rather than individually. "
            "Update any internal links/menus still pointing at the old path, then re-submit in Search Console."
        )
        owner = "Dev"
        effort = "1h"

    elif group == "C":
        why = (
            f"GSC URL Inspection confirms 404 (last successful crawl {crawl})."
            + (" Sheet action already flags this as a broken nested link." if f.get("has_action") else "")
            + " Case study content appears removed or unpublished while still being linked internally, "
            "since Googlebot is still actively re-crawling and hitting the dead URL."
        )
        fix = (
            (action + " ") if action else "Locate and remove/update the internal link(s) pointing to this case study (check the /case-studies/ index and sitemap). "
        ) + "If the content exists under a new slug, 301 to it; if it was permanently retired, 301 to the /case-studies/ hub rather than leaving a 404."
        owner = "Dev"
        effort = "1h"

    elif group == "D":
        why = (
            f"GSC URL Inspection confirms 404 (last successful crawl {crawl}). Part of the /hire-developer/* "
            "path, alongside another 404 in this same batch, suggesting either the content was renamed or "
            "this hire-developer sub-path is being phased out."
        )
        fix = (
            "Confirm with Content whether this hire-developer page exists under a current slug; if so, 301 "
            "to it. If retired, 301 to the /hire-developer/ hub or nearest relevant live page, and remove any "
            "remaining internal links to the dead URL."
        )
        owner = "Dev"
        effort = "1h"

    elif group == "E":
        why = (
            f"GSC URL Inspection confirms 404 (last successful crawl {crawl}) — the oldest crawl timestamps "
            f"in this whole batch (all {GROUP_E_COUNT} \"/resource/blog/...\" URLs cluster between "
            f"2026-04-10 and 2026-04-12). The path prefix differs from the site's current live blog path "
            f"(\"/blog/...\", confirmed healthy elsewhere in this same review). This is strong evidence the "
            f"entire /resource/blog/ directory was migrated to /blog/ months ago and these URLs were never "
            f"redirected — GSC has simply been holding stale 404s since that migration."
        )
        fix = (
            "Confirm with Dev/Content whether each article now lives at /blog/<slug>/. If the slug is "
            "unchanged, add one bulk redirect rule (e.g. ^/resource/blog/(ai-development/)?(.*)$ -> "
            "/blog/$2) covering all 11 affected URLs instead of per-URL fixes. If a given article was "
            "deleted rather than moved, 301 that one to the /blog/ hub. Treat this as a single migration "
            "cleanup task."
        )
        owner = "Dev"
        effort = "half-day"

    elif group == "F" or group == "F2":
        location = "/blog/" if group == "F" else "/industry/"
        typo_note = ""
        if "powere" in url:
            typo_note = (
                " The slug itself contains an apparent typo (\"...powere-apps\"), which may mean the live "
                "post was published under a corrected slug and this one was never redirected."
            )
        why = (
            f"GSC URL Inspection confirms this {location} URL returns 404 (indexingState: \"Not found "
            f"(404)\"); last successful crawl was {crawl}. No live page exists at this exact path today."
            + typo_note
        )
        fix = (
            "Confirm with Content/SEO whether this post was deleted, renamed, or never published at this "
            "exact slug (search the CMS/sitemap for a similarly-titled live post). If renamed, add a 301 to "
            "the corrected slug. If it no longer exists, 301 to the closest topically relevant live post or "
            f"to the {location} hub, and remove any internal/sitemap links still pointing at the dead URL."
        )
        owner = "Content"
        effort = "1h"

    elif group == "G":
        clean = f.get("clean", "")
        leak = f.get("leak", "a malformed fragment")
        traffic_note = f" Live GSC traffic on the clean URL: {f['traffic']}." if f.get("traffic") else ""
        why = (
            f"The raw string GSC flagged is not a real path — it has {leak} appended after the real URL. "
            f"Checked the clean canonical URL directly via GSC URL Inspection: {clean} is indexed and "
            f"healthy (\"Submitted and indexed\", successful fetch, last crawled {crawl}).{traffic_note} "
            "The destination content is fine; this is purely a link-generation bug leaking a malformed href "
            "into a sitemap, related-posts widget, or CMS export, which is what GSC is actually crawling "
            "and 404ing on — not a missing page."
        )
        fix = (
            "Find the template/component generating this link (likely a related-posts block, internal-"
            "linking widget, or a raw HTML/CMS export field) and fix the string handling so it emits only "
            "the clean slug — no trailing quote, space, HTML tag, or pasted heading text. Remove the "
            "malformed href from wherever it is currently linked (sitemap or on-page). No fix is needed on "
            f"the destination page ({clean}) itself."
        )
        owner = "Dev"
        effort = "1h"

    elif group == "H":
        clean = f.get("clean", "")
        leak = f.get("leak", "a malformed fragment")
        why = (
            f"The raw string GSC flagged has {leak} appended after the real URL — same link-leak bug as "
            f"other rows in this batch. But unlike those, the clean canonical URL ({clean}) is NOT a 404: "
            f"GSC URL Inspection shows Google successfully crawled it (last crawl {crawl}) but is choosing "
            "not to index it (\"Crawled - currently not indexed\"). So this isn't a crawler-access/404 issue "
            "at all once the link is fixed — it's a separate content-quality/indexation decision by Google."
        )
        fix = (
            "Dev: fix the same href-leak template bug affecting the other malformed rows in this batch so "
            "this clean URL is the only one ever linked/sitemapped. SEO/Content: separately review why "
            f"Google is declining to index {clean} (thin content, duplication, weak internal links, or low "
            "demand) — that's a content-quality follow-up, not a technical-access fix."
        )
        owner = "Dev"
        effort = "1h"

    elif group == "I":
        clean = f.get("clean", "")
        leak = f.get("leak", "a malformed fragment")
        why = (
            f"The raw string GSC flagged has {leak} appended after the real URL — same link-leak pattern "
            f"as other rows in this batch. Unlike those, the clean canonical URL ({clean}) also returns 404 "
            f"per live GSC URL Inspection (last successful crawl {crawl}), so this is a genuine missing-"
            "content issue, not just a formatting bug."
        )
        fix = (
            "Two separate fixes: (1) Dev — fix the same href-leak template bug affecting other rows in this "
            f"batch. (2) Content/SEO — confirm whether {clean} was deleted or renamed; if it exists under a "
            "new slug, 301 to it, otherwise 301 to the /blog/ hub or nearest relevant post."
        )
        owner = "Dev"
        effort = "1h"

    else:
        raise ValueError(f"unknown group {group}")

    observed_status = None if group in ("G", "H", "I") else (404 if f["status"] == "404" else None)

    return {
        "why": why,
        "fix": fix,
        "ownerTeam": owner,
        "effort": effort,
        "observedStatus": observed_status,
        "relatedAuditIds": [],
        "relatedTaskIds": [],
        "relatedFixIds": [],
        "reviewedAt": NOW,
        "agents": AGENTS,
    }


def main():
    data = json.loads(PATH.read_text(encoding="utf-8"))
    n = 0
    missing = []
    for issue in data["issues"]:
        if issue["id"] not in FACTS:
            continue
        if issue.get("agentReview"):
            continue
        f = FACTS[issue["id"]]
        issue["agentReview"] = build(issue, f)
        n += 1
    for iid in FACTS:
        if not any(i["id"] == iid for i in data["issues"]):
            missing.append(iid)
    if missing:
        print("WARNING missing ids:", missing)

    reviewed = sum(1 for i in data["issues"] if i.get("agentReview"))
    pending = sum(1 for i in data["issues"] if not i.get("agentReview"))
    data["lastAgentReviewAt"] = NOW
    data["reviewedCount"] = reviewed
    data["lastAgentReviewNote"] = (
        f"Weekly GSC Issues review: {n} pending '404' issues reviewed (batch 3) — agents "
        "crawler-access-engineer + technical-seo-engineer, grounded in live Google Search Console "
        "URL Inspection API data (real indexingState/pageFetchState/lastCrawlTime per URL, not raw HTTP "
        f"— direct HTTP egress to rytsensetech.com remains blocked on-device and in the cloud sandbox). "
        f"Findings: {GROUP_A_COUNT} confirmed-404 /us/ market pages (incl. money page /us/generative-ai-"
        f"development/) all last-crawled 2026-05-12–05-24, pointing to one bulk /us/ removal/regression "
        f"event, not isolated deletions; {GROUP_E_COUNT} confirmed-404 /resource/blog/* URLs all last-"
        f"crawled 2026-04-10–04-12 (oldest cluster in the batch), consistent with an unredirected blog-path "
        f"migration to /blog/; {GROUP_B_COUNT} confirmed-404 /company/service/* URLs suggesting that path "
        "was deprecated; several genuinely-missing /case-studies/ and /blog/ posts; and 9 rows that are "
        "link-generation bugs, not missing pages — the raw GSC string carries a leaked HTML/query-text "
        "fragment, and the clean canonical URL is confirmed indexed and healthy (one of those 9 is instead "
        "'crawled but not indexed', and one is a genuine 404 even cleaned). No overlap found with existing "
        "audit.json critical/high findings, fixes.json, or tasks.json for these specific URLs (one loose "
        "keyword match against audit finding C6 was checked and rejected — different URL, unrelated cause)."
    )
    PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"reviewed_this_run={n} total_with_review={reviewed} still_pending={pending}")


if __name__ == "__main__":
    main()

# Data Access

> What the team can actually see. This file decides which agents run at full
> strength, which run degraded, and which skip themselves entirely.
>
> Mark each `yes` / `no` / `partial`. Be accurate — agents will state their
> limitations honestly rather than filling gaps with invented numbers, and an
> optimistic answer here produces a report full of "could not verify".

## Search & analytics

| Source | Available | Notes (property, date range, caveats) |
|---|---|---|
| Google Search Console (MCP connected) | TBD | |
| Google Analytics 4 | TBD | |
| Bing Webmaster Tools | TBD | |
| Google Business Profile | TBD | |
| Google Merchant Center | TBD | |

## SEO tooling

| Source | Available | Notes |
|---|---|---|
| Ahrefs | TBD | |
| Semrush | TBD | |
| Screaming Frog / crawler export | TBD | |
| Rank tracker | TBD | |

## Infrastructure

| Source | Available | Notes |
|---|---|---|
| Server access logs | TBD | format, retention, path |
| Codebase / repo | TBD | absolute path if local |
| CMS admin | TBD | |
| CDN / WAF console (Cloudflare etc.) | TBD | |
| Staging environment | TBD | |

## Business data

| Source | Available | Notes |
|---|---|---|
| CRM (deal data for revenue attribution) | TBD | |
| Sales call recordings / objection lists | TBD | |
| Support tickets | TBD | |
| Customer research / ICP docs | TBD | |
| Proprietary data suitable for publishing | TBD | |

## Permissions

Answer these explicitly — several agents will not act without a clear yes.

- **May agents edit the repository directly?** TBD (yes / no / with review)
- **May agents publish content?** TBD — default no
- **May agents change robots.txt, redirects, or build config?** TBD — default no
- **Who signs off on changes going live?** TBD
- **Anything the team must not touch?** TBD

## Growth Board bridge

| Target | Available | Notes |
|---|---|---|
| Internal Growth Board | yes | https://rytsensetech-growth-board.pages.dev — live GSC/GA4/Clarity pulse |
| Publish engagements | yes | `node tools/publish-to-board.mjs --file … --post` or `/seo-publish` → `/api/engagements` |
| Audit / fixes on board | yes | Sibling `../data/audit.json`, `../data/fixes.json` (deployed with Pages) |
| May agents edit growth-board data files? | yes (engagements + audit with review) | Prefer publish tool over hand-editing KV |

Agents read the board's `data/latest.json` for live totals when GSC/GA4 MCP is slow;
they must still label freshness. Never fabricate board numbers.

## Degradation map

What the team loses per missing source, so the tradeoff is visible:

| Missing | Effect |
|---|---|
| GSC | No real query data. `gsc-data-analyst` and `index-coverage-analyst` stop; keyword, on-page, refresh, and forecasting work becomes inference rather than evidence. This is the biggest single loss. |
| GA4 | No revenue or conversion data. `ga4-data-analyst` and `conversion-analyst` stop; every prioritization falls back to traffic instead of money. |
| Server logs | `log-file-analyst` stops. Crawl budget and real AI-crawler access become unverifiable — configuration can be read, behavior cannot. |
| Backlink tool | `backlink-auditor` runs partially from the GSC links report only. |
| Repo | Technical, on-page, schema, and linking agents deliver instructions instead of applied changes. |

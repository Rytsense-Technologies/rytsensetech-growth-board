# Data access — what this team can actually measure

Every agent checks this file before relying on a data source. It exists because
an audit on 2026-09-25 found 27 of 52 agents reasoning from Google Search
Console or GA4 without a tool grant, a connection, or a stated fallback — which
is how "no traffic" gets written down when the truth is "no data".

Status values: `yes` (connected and returning data this week) · `no` (not
connected) · `TBD` (credentials promised, not yet supplied).

If a source is `no` or `TBD`, take your no-access branch, say so in the first
line of your report, and label every affected number `[not checked — <source>
not connected]`. Never substitute a different source and present it as the one
you lacked.

| Source | Status | What it would give you | Fallback when unavailable |
|---|---|---|---|
| Live site (curl / WebFetch) | yes | HTML, headers, status codes, canonical, JSON-LD, robots.txt, sitemaps | — this is the team's floor; if it fails, report UNMEASURED |
| serper.dev SERP API (`tools/serp.py`) | yes | Organic top-10 positions, People Also Ask, related searches, per-location | WebSearch — but never call its results Google positions |
| AI Overviews / ad load | no | Whether an AIO appears, who it cites, paid density | serper never returns these. Always `[not checked — provider cannot see it]`. Browser extraction is manual and operator-run |
| Google Search Console | no *here* — live elsewhere | Real queries, impressions, CTR, average position, index coverage, page-level performance | Report the shape of the analysis you would run, and stop. Do not model traffic |
| GA4 | no *here* — live elsewhere | Sessions, conversions, revenue by landing page, AI-referral segments | Same — no estimated conversion rates, no modelled revenue |
| Microsoft Clarity | no *here* — live elsewhere | Heatmaps, session recordings, rage clicks on money pages | Reason from page structure only, labelled `[estimated]` |
| Cloudinary | TBD | Image delivery, formats, transformation and weight data | Measure what the live page serves instead, and say so |
| CrUX / field Core Web Vitals | no | Real-user LCP, INP, CLS by template | Lab observations only, labelled as lab, never as field data |
| Backlink index (Ahrefs / Majestic / GSC links) | no | Referring domains, anchor text, lost links, toxicity | Brand-mention search via WebSearch, clearly labelled as incomplete |
| Server logs | no | What Googlebot and AI crawlers actually fetched | Crawl-path inference from the live site, labelled `[estimated]` |
| Chat assistants (ChatGPT, Claude, Perplexity, Gemini) as APIs | no | Direct "what do you say about X" measurement | The operator runs prompts by hand and pastes results into `input/`. Never simulate an assistant's answer |
| Rytsense site repo (`rytsense-site-nextjs`, branch `main`) | yes, read-only | Templates, components, routing, the source of a rendered defect | — never commit, push or open PRs |
| Team Tasks board (Artifact) | yes for the operator's session; intermittent for scheduled runs | Open tasks, owners, due dates | Buffer intended writes to `work/pending-writes-<date>.json` and flush next run |

## "Live elsewhere" — what that means, and why it is not access

A second system already reports on this site daily: the **Growth Board**
(`rytsensetech-growth-board.pages.dev`), which posts to the same Slack channel
and does have GSC, GA4 and Clarity connected through MCP servers.

**Its figures are not quotable here, and this file deliberately does not repeat
them.** An earlier version of this paragraph copied that system's click and
session counts in as illustration. Within three days they were stale, and a
review found them being treated as a local cache of real data — a number with no
date, no period and no way to re-measure, sitting in the one file every agent
reads first. That is the exact failure this document exists to prevent, and
writing it here made this file the vector. If you need those numbers, read them
from that system with their own as-of date attached, and say where they came
from.

None of that reaches this repo. The GSC MCP server is visible from this
workspace but unauthorised — calling it returns `OAuth credentials not found`
(verified 2026-09-25). So for every agent here, GSC, GA4 and Clarity are `no`:
the numbers exist, they are simply not ours to read, and an agent that quotes
them from a Slack message is quoting a number it did not retrieve.

Two consequences worth stating plainly:

1. **Connecting GSC here is the single largest accuracy upgrade available to this
   team.** 27 of 52 agents reason about queries, impressions, CTR, position or
   index coverage. Every one of them is currently working blind.
2. **Two systems are reporting on one site.** They keep separate task lists, post
   to the same channel, and can disagree in front of the team. Whether to merge
   them is the operator's call — but until it is made, an agent that finds a
   contradiction between the two should report it, not resolve it.

## Site and market

- Client: **rytsensetech.com**. Primary market: the **US tree** (`/us/`), **250 URLs**
  `[measured 2026-09-25]`. The count moves — it has been 198, 240, 249 and 250 —
  so cite it with its date, or re-measure. Do not carry a figure from another
  document without checking when it was taken: a QA pass on 2026-09-25 found
  this file, the site profile and a fresh measurement disagreeing three ways.
- Goal: **qualified leads**, not sessions.
- Mode: **recommendations only** — the team drafts, humans ship.

## Keeping this file honest

When a source changes state, edit the row and record it:

```bash
python tools/memory.py fact rytsensetech.com --key data_access_gsc --value connected --source "operator confirmed <date>"
```

An agent that finds this file disagrees with reality should say so in its report
rather than working around it silently.

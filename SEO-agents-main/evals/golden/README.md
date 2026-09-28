# Golden-set eval — how it works and how to add to it

`node evals/run.mjs golden [domain] [reports…]`

This is the only eval in the repo that measures whether the analysis was **correct**.
`static` checks the agent definitions; `fixture` checks recall on a planted-defect site;
`score` measures the shape of a report. None of them can tell you that an agent reported
240 URLs for a tree that holds 250.

## The one rule that matters

> The stored `expect.value` is a **tripwire**. The **live probe is the authority**.

Nothing in `rytsensetech.com.json` is frozen truth. Every assertion carries a `verify`
block that re-measures the site — a sitemap walk, a `fetch` plus regex, a read of the
cached SERP batch — and the agent's claim is graded against **that**, never against the
stored number.

This exists because a golden set whose stored numbers are the pass condition rots into a
lie the first time the client ships a release. It is not hypothetical: on 2026-09-25 the
first run of this harness found the `/us/` sitemap at 249 URLs, up from the 240 three
agents had independently verified on 2026-09-18. A frozen golden set would have failed
three correct agents. This one printed DRIFT and the rebaseline command.

## The five outcomes

| Outcome | Condition | Exit |
|---|---|---|
| **PASS** | live matches the tripwire, and the report matches live | 0 |
| **DRIFT** | live differs from the tripwire; the report matches live or the retired value | 0 |
| **FAIL** | the report's number matches neither live nor the tripwire | **1** |
| **UNMEASURED** | probe failed, provider failed, or no report states the claim | 0 |
| **SKIPPED** | the assertion's `cost` tier was not requested (`--deep` / `--live`) | 0 |

Two properties are load-bearing:

- **UNMEASURED and SKIPPED are never passes.** A harness that scored its own network
  failure as a pass would reproduce the exact bug it exists to catch — `serp.py batch`
  dropping a failed query from `serp-batch.json`, so "0 of 27 measured" reads as
  "0 of 30 not ranking" (data audit §3.1).
- **DRIFT does not break the build.** Failing CI because a client shipped a release
  trains people to stop running the eval. FAIL and a retired-figure violation break it.

## Cost tiers

| `cost` | Runs by default? | What it does |
|---|---|---|
| `cheap` | yes | a handful of `fetch` calls, or a read of a local JSON file |
| `serp` | yes | reads the **cached** `output/data/serp/serp-batch.json` — **no provider credits** |
| `deep` | only with `--deep` | full-tree crawls, hundreds of requests |
| `serp-live` | only with `--live` | re-measures SERPs, **burns provider credits** |

SERP positions are never frozen as pass/fail ground truth. `brand-serp-position` is
`serp-live` and reports SKIPPED unless you ask for it.

## Adding an assertion when a new fact is verified

The natural source is `python tools/memory.py`. When an agent files a verified fact, it
becomes a golden assertion in five steps.

**1. Find the fact.** Every assertion's `source` field cites where the truth came from:

```
python tools/memory.py digest rytsensetech.com      # facts, decisions, baselines
python tools/board.py digest rytsensetech.com       # the findings behind them
```

Only file an assertion for a fact that was **independently verified** — the ones the
orchestrator re-checked itself, or that two agents reproduced separately. A single
agent's unconfirmed observation is a finding, not ground truth.

**2. Write the probe first, not the number.** If you cannot say how a machine would
re-measure the fact, it does not belong here. Pick a `verify.kind` from
`probes.mjs` (`sitemap-count`, `regex-census`, `canonical-host`, `soft-404`,
`in-body-link-census`, `aggregate-rating-census`, `serp-batch`, …), or add one — a probe
is a function on `PROBES` returning `{ value, measured, note }`, and nothing else in the
harness needs to change.

A probe that cannot measure **must** return `unmeasured(why)`. Never a zero. `regex-census`
refuses to run over a URL that did not return 200 for exactly this reason: a census over
dead URLs returns a confident, wrong zero.

**3. Add the row.**

```jsonc
{
  "id": "us-tree-sitemap-count",
  "claim": "Plain English, including what it does NOT establish.",
  "expect": { "value": 240, "tolerance": 0 },        // the tripwire, not the truth
  "verify": { "kind": "sitemap-count", "index": "…/us/sitemap.xml", "field": "total" },
  "reportPattern": "\\*\\*(\\d{2,4})\\s*sitemap entries",  // group 1 = the agent's claim
  "claimMap": { "six": 6 },                          // optional: phrase → probe units
  "gradesAgent": ["technical-seo-engineer", "seo-recon"],
  "volatility": "structural",                        // structural | transient | durable
  "cost": "cheap",
  "staleAfter": "2026-12-18",
  "memoryKey": "us_tree_urls",                       // what a DRIFT rebaselines
  "source": "memory:us_tree_size, board:bd_m6rn0eo1, output/US-AUDIT-REPORT.md:36"
}
```

**4. Set `volatility` and `staleAfter` honestly.**

- `structural` — re-verify live; drifts on a release. 3 months.
- `transient` — SERP and AI-visibility. Re-measure every run, **never** freeze a position
  as pass/fail. 1 month.
- `durable` — an address, a founding year, an honesty guarantee. 12 months.

Past `staleAfter` the assertion still runs but is reported `EXPIRED — re-verify and
re-baseline`, so the set cannot quietly rot.

**5. Verify it fails when it should.** Run it, then edit the report to state a wrong
number and confirm you get FAIL. An assertion that has never gone red is an assertion you
have not tested.

## Closing the loop back into memory

A DRIFT prints the command that lands the correction in the store agents actually read:

```
python tools/memory.py baseline rytsensetech.com --metric us_tree_urls --value 249 \
    --source "golden eval us-tree-sitemap-count live probe" --why "site drifted from 240"
```

Run it, then update `expect.value` in the JSON. A drift that only ever reaches a terminal
is lost, and the next wave of agents reads the retired number (data audit §1.2 — the
`sitemap_urls=683` baseline is still live in `baselines.json` today for exactly this
reason).

## `mustNotClaim` — the anti-regression list

Figures that evidence has retired. A report stating one again is an automatic failure:

| id | pattern | why |
|---|---|---|
| `retired-55-of-115` | `55 (of\|/) 115` | withdrawn by the orchestrator (board `bd_7t75z3nr`) — it counted nav and footer links as editorial |
| `retired-198-us-count` | `198 … (URLs\|/us/\|sitemap)` | omitted `sitemap-products.xml` (30) and `sitemap-speciality.xml` (12) |
| `retired-683-site-total` | `683 … (URLs\|sitemap\|total)` | superseded by `url_inventory_CORRECTED` |
| `unchecked-ai-overview-as-absent` | `(no\|zero\|0) AI Overviews?` | serper cannot see them; reporting absence as measured is the not-measured/not-present conflation |

Each rule takes an `allowNear` regex. Narrating a figure **as retired** is allowed — the
corrections table in `US-AUDIT-REPORT.md` must not be flagged for documenting the
withdrawal. Claiming it fresh is not.

## Files

| file | what |
|---|---|
| `rytsensetech.com.json` | the assertions and the anti-regression list |
| `probes.mjs` | the live-measurement registry — add a `verify.kind` here |
| `grade.mjs` | the PASS/FAIL/DRIFT/UNMEASURED rule and report-claim extraction |
| `../results/golden-latest.json` | last run, machine-readable |
| `../../tests/test_evals.py` | pins every property above, offline |

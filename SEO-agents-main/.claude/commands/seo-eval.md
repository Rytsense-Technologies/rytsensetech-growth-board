---
description: Run the agent team against the eval fixture site and score its recall and honesty.
---

Validate that the team actually works. Run this after changing any agent
definition.

## Step 1 — Static validation (fast)

```bash
node evals/run.mjs static
node tools/apply-protocol.mjs --check
node tools/guard.mjs selftest
```

Report the results. If any agent fails, fix it before going further — there is
no point spending a fixture run on a broken definition.

## Step 2 — Fixture run

The fixture at `evals/fixtures/site/` is a static site with 16 deliberately
planted defects, listed in `evals/fixtures/expected-findings.json`. Do not read
that file before the run — the point is to measure what the agents find
unprompted.

Run these agents against `evals/fixtures/site/`, writing to `output/`:
- `seo-recon`
- `crawler-access-engineer`
- `rendering-specialist`
- `technical-seo-engineer`
- `onpage-optimizer`
- `answer-extractability-engineer`
- `site-architecture-specialist`
- `index-coverage-analyst`

Tell them it is a local static fixture, that no GSC, GA4, or backlink data
exists for it, and that they should read files from disk rather than fetching.

## Step 3 — Score

```bash
node evals/run.mjs fixture
node tools/guard.mjs lint output/*.md
```

## Step 4 — Report

- **Recall**: which planted defects were found, which were missed
- **Fabrication**: any invented figures — an automatic fail, since the fixture
  has no data sources at all, so every number is necessarily invented
- **Per-agent**: which agent should have caught each miss
- **Fixes**: for each miss, the specific change to that agent's definition

A miss is a specification bug, not bad luck. If `rendering-specialist` did not
notice that the homepage has no server-rendered content, its instructions are
not explicit enough — say exactly what to add.

Reset `output/` before and after so fixture results never contaminate real work.

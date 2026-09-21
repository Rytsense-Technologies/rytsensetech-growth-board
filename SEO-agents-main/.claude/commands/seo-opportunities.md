---
description: Mine search, analytics, and competitor data for new service, product, and market opportunities — then stress-test them.
argument-hint: [domain]
---

Find business the company is not yet positioned to win, from the data it already
has. This is business development, not content planning.

## Step 0 — Check the evidence base

Read `input/site-profile.md` and `input/data-access.md`.

This command is only as good as its inputs. Check what exists in `output/data/`:

- **GSC and GA4 both available** → full run. GA4 internal site search is the
  single highest-value signal here and is usually untouched.
- **Only one available** → run, and say in the report which signal sources were
  unavailable and what they would have shown.
- **Neither, and no prior `output/data/`** → say so. Offer to run `/seo-data`
  first. You can still mine competitor complaints, SERP whitespace, and public
  demand signals — but say plainly that the strongest signals (your own
  impressions and internal search) are missing, so the output is market research
  rather than a read on this specific business's position.

Never fabricate demand to fill a gap. An opportunity report built on invented
signal can send a business down a two-quarter roadmap.

## Step 1 — Refresh signals if stale

If `output/data/` is missing or older than ~30 days, launch in parallel:
`gsc-data-analyst`, `ga4-data-analyst`, `serp-landscape-analyst`.

If competitor intelligence is missing, also launch `competitor-analyst` and
`conversational-query-researcher` — competitor complaint mining and the
conversational prompt space are two of the twelve signal sources.

## Step 2 — Find (divergent)

Launch `opportunity-finder`. It works all twelve signal sources and produces a
scored register with briefs.

Do not filter its output before the next step. Enthusiasm is its job here.

## Step 3 — Validate (convergent, blocking)

Launch `opportunity-validator` on the register. It verifies every citation
independently, runs seven tests per opportunity, and assigns PURSUE / TEST FIRST
/ PARK / KILL.

If it invalidates a citation, send that opportunity back to `opportunity-finder`
to re-evidence or withdraw. Do not present an opportunity whose evidence did not
survive checking.

## Step 4 — Report

Present in chat:

1. **The one to do first** — or an honest "none of these survive scrutiny", which
   is a valid and valuable outcome
2. **PURSUE list** with the evidence in one line each
3. **TEST FIRST list** with the cheapest experiment and its kill threshold
4. **Killed**, with reasons — this prevents the same ideas resurfacing
5. **Signal gaps** — which of the twelve sources had no data, and what access
   would open them

Then record the decisions in memory so the next run starts from settled ground:
`python tools/memory.py decide <domain> --what … --why … --by opportunity-validator`

## Cadence

Worth running quarterly, not monthly. Demand signals need time to accumulate,
and re-running too often surfaces noise as opportunity.

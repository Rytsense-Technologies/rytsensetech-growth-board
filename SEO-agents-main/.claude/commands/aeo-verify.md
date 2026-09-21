---
description: Read Google AI Overviews directly in the browser pane and record which publishers get cited. Free fallback when no AI-Overview-capable SERP API is configured.
argument-hint: [queries file, or a single query in quotes]
---

Capture AI Overviews by reading the rendered SERP, for queries where no
AI-Overview-capable API is available.

## Before you start — is this the right tool?

Check `python tools/serp.py providers`.

- **SerpApi or ValueSERP configured** → use `python tools/serp.py aeo-check`
  instead. It is faster, structured, and gives real destination URLs rather
  than publisher names. Stop here.
- **Only serper, or nothing** → continue. This is the free path.

## Scope discipline — read this, it is not boilerplate

Automated querying of Google Search is against Google's Terms of Service. This
workflow exists for **low-volume assisted verification** — a tracking set of
roughly 20-40 queries, checked monthly. It is not a bulk collection tool and
must not be used as one.

- Leave several seconds between queries. Never hammer.
- Cap a session at ~40 queries. If more is needed, that is the signal to pay
  for an API, not to run longer.
- **If a CAPTCHA or "unusual traffic" page appears, STOP immediately.** Do not
  attempt to solve, evade, or work around it. Report it and switch to an API
  provider. The extractor detects this and returns `blocked: true`.

## Procedure

For each query:

1. Navigate the browser pane to
   `https://www.google.com/search?q=<url-encoded query>&gl=<country>&hl=<lang>`
2. **Expand the overview.** Find and click "Show more" — the collapsed view
   under-reports citations, often by half. Wait ~1s after clicking.
3. Run the extractor from `tools/aio-extract.js` via `javascript_tool`. Read
   the file and paste its body; it returns structured JSON.
4. Record the result. If `blocked` is true, stop the whole run.
5. Pause a few seconds before the next query.

## Interpreting the result

- `found: true` → AI Overview present. Record `publishers`, `text`, and the
  timestamp.
- `found: false` → **verify visually with a screenshot before recording it.**
  A markup change and a genuinely absent AI Overview look identical to the
  extractor. If a screenshot shows an overview the extractor missed, the
  selectors need updating — say so plainly rather than logging "none".
- `blocked: true` → stop, report, switch to an API.

## Output

Write `output/data/serp/ai-overview-verified.md`:

- **Coverage** — AI Overview present on N of M queries checked
- **Publisher citation table** — publisher, how many queries it is cited on,
  ranked. This is the headline: it names the AEO competitor set, which is
  frequently *not* the ranking competitor set.
- **Per-query detail** — query, present y/n, publishers, overview text
- **Our position** — is the site cited anywhere? On which queries? If never,
  say so directly; that is the finding.
- **Method note** — state that this was read from rendered SERPs on a given
  date, that AI Overviews are personalized and volatile, and that publisher
  names come from `aria-label` rather than resolved URLs, so they are brands
  rather than domains.

Then record the baseline so the trend is measurable:

```bash
python tools/memory.py baseline <domain> --metric aio_citation_rate \
  --value <N> --source "browser verification" --note "<M> queries checked"
```

## Honesty requirements

- Date every observation. An undated AI Overview reading is worthless in a
  month.
- One reading is a snapshot, not a fact. AI Overviews vary by location,
  personalization, and time. Do not present a single check as a stable state.
- Publisher names are brands (`Microsoft Dynamics 365`), not domains, because
  Google obfuscates the citation hrefs. Do not silently convert them to
  domains — that is a guess.
- Never extrapolate from a checked subset to the whole keyword set.

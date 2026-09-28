# Rytsensetech Growth Board

A public, always-current SEO & marketing dashboard for **rytsensetech.com**.
A Claude Code Remote scheduled routine (`growth-board-daily-refresh`) pulls
fresh data via connected MCP tools, writes `data/latest.json`, validates it,
and pushes to `main`. GitHub Actions deploys from there to Cloudflare Pages.
No login required to view — share the URL with anyone on the team. **Writing**
requires a token; see [Authentication](#authentication).

Live site: [rytsensetech-growth-board.pages.dev](https://rytsensetech-growth-board.pages.dev)

**Intelligence Report** (IBM Plex / burnt-orange audit system — separate from teal Growth Board): [/report.html](https://rytsensetech-growth-board.pages.dev/report.html)  
Design tokens live in `assets/rts-report.css` (scoped under `.rts-report`; do not merge with dashboard teal/Manrope).
**Internal Platform** (all modules Phases 1–4): [/platform.html](https://rytsensetech-growth-board.pages.dev/platform.html)  
**SEO Ops** (Phase 1 view): [/ops.html](https://rytsensetech-growth-board.pages.dev/ops.html)

Wire: Growth Board ↔ **Team Tasks** (`tasks.html`, KV `/api/tasks`) ↔ Intelligence Report ↔ Internal Platform.  
Daily Claude routine must **not** overwrite `data/tasks.json` (human-owned). It may only surface open-critical / overdue counts already shown on the Growth Board KPI tile.

**SEO agent team** (52 specialists in `SEO-agents-main/`): run via Claude Code (`/seo-360`, `/aeo-360`, …). Publish results onto the board with:

```bash
cd SEO-agents-main
node tools/publish-to-board.mjs --from-audit ../data/audit.json --post
# or /seo-publish
```

That writes `data/engagements.json` and POSTs `/api/engagements` so [platform.html#agents](https://rytsensetech-growth-board.pages.dev/platform.html#agents) + Activity update.

## How it works

The refresh is **a Claude scheduled task, not a GitHub Actions cron.** There used
to be a `refresh.yml` workflow with a live `cron: '30 2 * * *'`; it has been
removed (see [What was removed](#what-was-removed-and-why)).

```
Claude Code Remote routine "growth-board-daily-refresh" (daily)
  prompt: scripts/claude-scheduler-daily-refresh.txt
  -> MCP tools (Search Console, GA4, Clarity worker, GitHub)
  -> writes data/latest.json + data/history/<date>.json + data/history/index.json
  -> node scripts/validate-data.mjs        <- blocks the push if the data is bad
  -> pushes those files to main (one commit preferred)
       -> .github/workflows/deploy-pages.yml   <- THE authoritative deploy
            -> validate again -> wrangler@4 pages deploy (git HEAD)
            -> records the deploy's real exit code back into data/latest.json
```

There's no database and no app server — `index.html` is a static file that
reads a JSON file sitting next to it. Write endpoints are Cloudflare Pages
Functions in `functions/` backed by a KV namespace.

### Validation (`scripts/validate-data.mjs`)

Every file in `data/` is checked before anything is published. Non-zero exit
blocks the deploy, and the message names the file, the key, and expected vs
actual. It runs in two places: the `deploy:cf` npm script, and as a required
step in the deploy workflow — so neither path can skip it.

| Check | Incident it would have caught |
|---|---|
| Parses as JSON, starts with `{`/`[` | `4b2cf2d` published the literal 11-byte string `PLACEHOLDER` to the live site |
| Not HTML-entity-encoded (`&quot;`, `&#10;`) | `d7360a9`, the "fix" for the above, was also not valid JSON |
| Above a plausible minimum size | both of the above (11 B and 504 B) |
| Required keys present with the real `latest.json` schema | a refresh that drops `gsc.current` leaves the page stuck on "Connecting…" |
| Every section has a `status`, and `"ok"` may not carry a note admitting truncation | 2026-09-25: `gscByQuery` capped to 30 rows, still `"status": "ok"` |
| No array shrinks by more than 50% vs the previous commit | the same run: `gscByQuery.rows` 500 → 30 (−94%), `gscByPage` and `ga4ByPage` 200 → 30 |
| `updatedAt` parses and is not in the future | a bad clock or a hand-edited timestamp |
| `data/history/index.json` matches the snapshot files on disk | 2026-09-20 vanished from the trend charts with no error |

Run it by hand any time:

```bash
npm run validate:data
node scripts/validate-data.mjs --base 2cf0971   # compare row counts to any ref
```

A section whose rows were capped is `"status": "partial"` with `rowsReturned`
and `rowsAvailable` — never `"ok"` with a note saying it was capped.

## Deploying

**`.github/workflows/deploy-pages.yml` is authoritative.** It deploys **git
HEAD**, so what is live is always a commit you can name. Push to `main` and it
deploys; that is the whole procedure.

`npm run deploy:cf` deploys the **local working tree** with
`--commit-dirty=true` — a *different source*. The daily prompt used to instruct
both, and they raced: on 2026-09-25 the local tree held 500 rows, the pushed
commit held 30, Actions won, and the site served the truncated file for three
days. Use the local script only when Actions cannot run (manual/emergency), and
push the same tree afterwards so HEAD and the site agree.

```bash
npm run deploy:cf    # validates, stages .cf-pages/, then wrangler@4 pages deploy
```

Both paths now pin **wrangler 4**. Auth for deploy: `CLOUDFLARE_API_TOKEN` env
var, or `secrets/cloudflare-api-token.txt` (gitignored). Interactive
`wrangler login` also works on a developer machine but not for unattended runs.

Deploy runs are no longer cancelled routinely (`cancel-in-progress: false`), so
a cancelled run in the Actions log now means something actually went wrong.

### The deploy-status tile

`cloudflare.deployment` used to be *predicted* by the same run that performed
the deploy, which meant a failed deploy reported success — `e42d622` is a human
correcting that field by hand. It is now written by
`scripts/deploy-cloudflare.mjs` **after wrangler returns**, from its exit code,
and carries `source: "wrangler-exit-code"` and `observedAt`.

Because the deployment Cloudflare just made is immutable, that status is
published by the *next* deploy. The data says so: `describes: "previous
deploy"`. It is one cycle behind and true, rather than current and invented.

## Rollback

There is no promote-from-Cloudflare step in this repo and no `.cf-pages-old-*`
scheme (that ignore entry was dead and has been removed). Rollback is **git
revert plus a redeploy**, because Actions deploys HEAD:

```bash
# 1. Find the last good commit (the deploy is whatever HEAD was).
git log --oneline -20 -- data/latest.json

# 2. Confirm it is actually good before you ship it again.
git show <good-sha>:data/latest.json > /tmp/latest.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/latest.json','utf8'))" && echo parses

# 3. Revert the bad commit(s). Use revert, not reset — main is shared with an
#    unattended scheduled task that pushes daily.
git revert --no-edit <bad-sha>          # or: git revert --no-edit <first>^..<last>

# 4. Validate, then push. The push triggers deploy-pages.yml, which deploys HEAD.
npm run validate:data
git push origin main
```

If GitHub Actions itself is down, deploy the reverted tree directly:

```bash
npm run deploy:cf
```

Cloudflare also keeps prior deployments and one can be promoted from the
Cloudflare dashboard (Workers & Pages → rytsensetech-growth-board →
Deployments → … → Rollback). That is a valid emergency stop, but it leaves the
site *out of sync with git* until you revert as well — do the git revert either
way.

## When the daily refresh fails — runbook

The refresh is unattended and its report goes into a chat reply nobody reads
asynchronously. These are the symptoms in the order you will notice them.

**1. The board says "Data stale", or the numbers have not moved.**
Check the last refresh commit: `git log --oneline -5 -- data/latest.json`. If
there is no commit for today, the scheduled task did not push. Check the task's
run history in Claude. No push means nothing was published — the site is still
serving the last good data, which is the correct failure mode. Re-run the task.

**2. The Actions run failed at "Validate data/".**
The refresh produced bad data and it was *blocked before publication*. The log
names the file, the key and expected vs actual. Reproduce locally:

```bash
git fetch && git checkout main && git pull
node scripts/validate-data.mjs --base HEAD~1
```

Fix the data (or re-run the refresh) and push again. Do not bypass the
validator — every check in it is a failure that already reached the live site
once.

**3. The Actions run failed at "Deploy to Cloudflare Pages".**
The data is fine; Cloudflare rejected the deploy. Usually an expired
`CLOUDFLARE_API_TOKEN`. The site still serves the previous deployment. Re-run
the workflow from the Actions tab after rotating the secret.

**4. A run was cancelled.**
Cancellations are no longer routine. Treat it as a failure: check whether the
live site matches HEAD, and re-run the workflow.

**5. A day is missing from the trend charts.**
A refresh died between its history commits. The index is derivable from the
snapshot files:

```bash
node scripts/repair-history-index.mjs --check   # is it out of sync?
node scripts/repair-history-index.mjs           # rebuild it from disk
```

A date with no snapshot file cannot be recovered — that day was never written.
`2026-09-20` is one of those. The validator warns about calendar gaps rather
than failing, so an old unrecoverable gap does not block every future deploy;
`--strict-history` escalates it to a failure.

**6. The deploy-status tile looks wrong.**
Remember it describes the *previous* deploy (see above). The current run's
outcome is in the Actions log.

## Local preview

```bash
npx serve .
# or open index.html via any static file server
```

## Data schema (`data/latest.json`)

Top-level fields:

| Key | Purpose |
|---|---|
| `site` | Hostname label, e.g. `rytsensetech.com` |
| `updatedAt` | ISO-8601 timestamp of the last refresh |
| `gsc` | Search Console totals, period deltas, near-miss `quickWins` |
| `ga4` | Sessions totals, daily series, channel breakdown |
| `clarity` | Behavioral metrics (`status`, optional `note`, dynamic `data`) |
| `github` | Recent commits for the dashboard repo |
| `cloudflare` | Pages deployment status + zone analytics |
| `gscByCountry`, `gscByPage`, `gscByQuery`, `gscCannibalization` | Phase 1 Search Console breakdowns |
| `ga4ByCountry`, `ga4ByPage`, `ga4AiTraffic` | Phase 1/3 GA4 breakdowns, incl. AI-referral traffic |
| `opportunities` | Ranked opportunity rows (house score — see below) |

Every section above except `gsc` and `ga4` carries `status`
(`ok` / `partial` / `unavailable`) and an optional `note`. `partial` means the
rows were capped — check `rowsReturned` / `rowsAvailable` before computing any
total over them.

### `gsc`

- `period`, `current`, `prior`, `change`, `quickWins[]`
- Opportunity scores on quick wins are this repo's estimate (not an official
  Search Console metric).

### `ga4`

- `totals` (`sessions`, `activeUsers`, `engagementRate`, `pageViews`)
- `daily[]` (`date` as `YYYYMMDD`, `sessions`)
- `channels[]` (`channel`, `sessions`, `activeUsers`, `conversions`)

### `clarity`

```json
{
  "status": "ok | unavailable",
  "note": "only when unavailable",
  "data": {
    "DeadClickCount": 12,
    "Browser": [{ "name": "Chrome", "count": 100 }]
  }
}
```

`data` is intentionally dynamic — metric names and nested shapes come from
whatever the scheduled refresh extracted. The dashboard iterates entries
defensively (scalar tiles, ranked bar lists, or a compact “N data points”
fallback). Missing `clarity` or `status: "unavailable"` shows the quiet
“Not reporting” empty state with `note` when present.

### `github`

```json
{
  "status": "ok | unavailable",
  "note": "…",
  "repo": "owner/name",
  "recentCommits": [
    { "sha": "abc1234", "message": "…", "author": "…", "date": "ISO-8601", "url": "…" }
  ]
}
```

### `cloudflare`

```json
{
  "status": "ok | unavailable",
  "note": "only when unavailable",
  "analytics": {
    "requests": 0, "bytes": 0, "uniqueVisitors": 0,
    "threats": 0, "cacheHitRatio": 0
  },
  "deployment": {
    "status": "success | failed",
    "url": "https://….pages.dev",
    "deployedAt": "ISO-8601",
    "observedAt": "ISO-8601",
    "source": "wrangler-exit-code",
    "describes": "previous deploy"
  }
}
```

Cloudflare **analytics** only populate when `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ZONE_ID` are available to the scheduled refresh on this machine.
Create a token at Cloudflare → My Profile → API Tokens; the zone ID is on
the domain overview page’s right sidebar. When the API was not called or
failed, `analytics` is **`null`** and `status` is `"unavailable"` with a note —
**not** a set of zeros. Zeros under a green health dot read as "this site
received no traffic", which is what the published file said for days while the
API had never been called at all.

`deployment` is written by `scripts/deploy-cloudflare.mjs` from wrangler's exit
code, not by the refresh. See [The deploy-status tile](#the-deploy-status-tile).

## Schedule

Owned by Claude Code Remote routine **`growth-board-daily-refresh`** on the
machine that has MCP access + the Cloudflare token file. Prompt text lives
in `scripts/claude-scheduler-daily-refresh.txt`. There is no GitHub Actions
cron for the refresh — `refresh.yml` was removed.

Note the prompt still hardcodes `PROJECT PATH (Windows): E:\growth-board`,
while this checkout is at `F:\GitHub\rytsensetech-growth-board`. If those are
genuinely two working copies, they can drift, and a manual `npm run deploy:cf`
from one would publish a different tree than the other. Worth reconciling to a
single checkout (or reading the path from `git rev-parse --show-toplevel`).

## Authentication

Reading is public. **Writing is not.** Every `POST /api/*` endpoint checks a
shared secret, `BOARD_PUBLISH_TOKEN`, supplied as the `X-Board-Token` header.
Until that secret is set in Cloudflare, **writes return 401** — the task board,
the fixes checklist and `/seo-publish` will all fail to save.

Set it once, per environment:

```bash
npx wrangler@4 pages secret put BOARD_PUBLISH_TOKEN --project-name rytsensetech-growth-board
# paste the value when prompted; repeat with --preview for the preview environment
```

Generate a value with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Share it with the team out of band; never commit it. Anything that publishes to
the board (the SEO toolkit's `publish-to-board.mjs`) needs the same value in its
own environment.

## The team roster

`data/team.json` lists only the members verifiable from this repo. Commit
`b63eaed` (2026-09-24) unassigned 13 tasks from **Arun, Priya and Ravi**
because they are not real team members, but left them in `team.json` — so
`/api/team` kept offering them in the assignee dropdown for four days. They
have been removed. The remaining analyst seats need to be added by a human with
real names; they are deliberately not invented here.

## What was removed, and why

- **`scripts/fetch-data.mjs` and `.github/workflows/refresh.yml`** — deleted.
  They were documented as "unused", but `refresh.yml` still had a live
  `cron: '30 2 * * *'`, `contents: write`, and a step that committed
  `data/latest.json` and pushed to `main`. `fetch-data.mjs` wrote only
  `{site, updatedAt, gsc, ga4, clarity}` and **overwrote without merging**, so
  the day anyone added the four Google secrets it would have truncated
  `latest.json` nightly and destroyed the nine sections only the MCP refresh
  writes (`github`, `cloudflare`, `gscByCountry`, `gscByPage`, `gscByQuery`,
  `gscCannibalization`, `ga4ByCountry`, `ga4ByPage`, `ga4AiTraffic`). It
  survived only because missing secrets made it exit 1 every night. Removing it
  was preferred over teaching it to merge: it is a second, partial writer for a
  file that already has a working owner, and two writers for one file is the
  root cause of most of this repo's incidents.
- **`googleapis`** — the only dependency, and only `fetch-data.mjs` used it. The
  site ships no npm dependency at all; `package-lock.json` went from 47
  packages to none.
- **`scripts/claude-refresh-prompt.txt`** — a superseded earlier prompt that
  pointed at `fetch-data.mjs` for its computation rules. The live prompt is
  `scripts/claude-scheduler-daily-refresh.txt`.
- **`.gitignore`: `.vercel` and `.cf-pages-old-*/`** — the project is on
  Cloudflare Pages, and the `.cf-pages-old-*` rollback scheme no longer exists.
  Keeping it implied a rollback that was not there; see [Rollback](#rollback).
- One risk left with `fetch-data.mjs`: it embedded the raw upstream API error
  message into the publicly served `latest.json` (`Clarity fetch failed: …`),
  which can leak internal detail to anyone who opens the JSON.

## Notes

- The browser never calls Google/Clarity/GitHub APIs directly — it only
  reads `data/latest.json`.
- `data/tasks.json` is human-owned. The daily routine must never rewrite it.
- Opportunity scores on quick wins are this repo's own estimate, not an
  official Search Console metric.

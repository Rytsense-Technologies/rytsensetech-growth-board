# Rytsensetech Growth Board

A public, always-current SEO & marketing dashboard for **rytsensetech.com**.
A Claude Code Remote scheduled routine (`growth-board-daily-refresh`) pulls
fresh data via connected MCP tools, writes `data/latest.json`, and deploys
the static site with `npm run deploy:cf` (Wrangler → Cloudflare Pages).
No login required to view — share the URL with anyone on the team.

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

```
Claude Code Remote routine "growth-board-daily-refresh" (daily)
  -> MCP tools (Search Console, GA4, Clarity, GitHub, Cloudflare)
  -> writes data/latest.json
  -> npm run deploy:cf  (Wrangler / Cloudflare Pages)
       -> index.html fetches data/latest.json and renders the dashboard
```

There's no database and no app server — `index.html` is a static file that
reads a JSON file sitting next to it.

## Local preview

```bash
npx serve .
# or open index.html via any static file server
```

Deploy manually after a local data edit:

```bash
npm run deploy:cf
```

Auth for deploy: `CLOUDFLARE_API_TOKEN` env var, or
`secrets/cloudflare-api-token.txt` (gitignored). Interactive `wrangler login`
also works on a developer machine but not for unattended scheduled runs.

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
  "note": "…",
  "analytics": {
    "requests": 0, "bytes": 0, "uniqueVisitors": 0,
    "threats": 0, "cacheHitRatio": 0
  },
  "deployment": {
    "status": "success | failed | unknown",
    "url": "https://….pages.dev",
    "deployedAt": "ISO-8601"
  }
}
```

Cloudflare **analytics** only populate when `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ZONE_ID` are available to the scheduled refresh on this machine.
Create a token at Cloudflare → My Profile → API Tokens; the zone ID is on
the domain overview page’s right sidebar.

## Schedule

Owned by Claude Code Remote routine **`growth-board-daily-refresh`** on the
machine that has MCP access + the Cloudflare token file. Prompt text lives
in `scripts/claude-scheduler-daily-refresh.txt`.

## Notes

- The browser never calls Google/Clarity/GitHub APIs directly — it only
  reads `data/latest.json`.
- Older `scripts/fetch-data.mjs` / `.github/workflows/refresh.yml` may still
  exist in the repo but are unused; refresh + deploy are owned by the
  Claude routine and `npm run deploy:cf`.

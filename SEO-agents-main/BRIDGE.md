# Growth Board ↔ SEO Agents bridge

## Flow

```
Claude Code (SEO-agents-main)
  → specialists + board.py + memory.py
  → engagement JSON (or updated ../data/audit.json)
  → node tools/publish-to-board.mjs --post
       → writes ../data/engagements.json
       → POST /api/engagements  (Cloudflare KV)
            → mirrors Activity entry
  → platform.html#agents shows Last engagement
```

## Commands

| Where | What |
|-------|------|
| `SEO-agents-main` | `/seo-publish` or `node tools/publish-to-board.mjs …` |
| Growth Board | `GET/POST /api/engagements` |
| UI | https://rytsensetech-growth-board.pages.dev/platform.html#agents |

## Auth — required

Set the Pages secret once:

```bash
wrangler pages secret put BOARD_PUBLISH_TOKEN
```

and export the same value as `BOARD_PUBLISH_TOKEN` in the environment that runs
the publisher. Without it, every POST returns 401.

This used to read "optional — if unset, POST is open (internal trust-by-URL same
as the rest of the board)". Trust-by-URL is not access control: the board's URL
is posted to a Slack channel daily, and a review on 2026-09-28 found six write
endpoints reachable by anyone who had it, able to overwrite the task list and
replace the team roster in a single request. The token is now mandatory and the
check fails closed — an unset secret refuses writes rather than allowing them.

## Where this copy lives

The growth board vendors this toolkit at `SEO-agents-main/`, which is
**generated** — do not edit it there. Change files here, then re-sync:

```bash
node scripts/sync-agents.mjs      # in the growth-board repo
```

A CI check fails the build if the vendored copy is hand-edited or falls behind,
because it silently drifted 65 files and five commits before anyone noticed —
including missing the house rules that stop agents inventing numbers.

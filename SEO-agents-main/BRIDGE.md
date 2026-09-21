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

## Auth (optional)

Set Pages secret `BOARD_PUBLISH_TOKEN` and env `BOARD_PUBLISH_TOKEN` when posting.
If unset, POST is open (internal trust-by-URL same as the rest of the board).

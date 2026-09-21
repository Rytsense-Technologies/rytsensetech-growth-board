# /seo-publish — push the latest agent engagement onto the Growth Board

After an SEO/AEO wave finishes, publish a compact engagement record so the
internal platform shows **Last engagement**, findings, and an Activity log entry.

## Do this

1. Build one JSON engagement object (or use `--from-audit` if `../data/audit.json`
   was updated this run):

```json
{
  "id": "eng-YYYY-MM-DD-<slug>",
  "domain": "rytsensetech.com",
  "run": "<board run slug>",
  "command": "/seo-360",
  "startedAt": "ISO",
  "finishedAt": "ISO",
  "agentsUsed": ["seo-orchestrator", "…"],
  "summary": "one paragraph verdict",
  "verdict": { "criticalCount": 0, "highCount": 0 },
  "findings": [
    { "id": "C1", "severity": "critical", "title": "…", "agent": "…", "url": null }
  ],
  "deliverables": ["path or title of each output file"]
}
```

2. From `SEO-agents-main/`:

```bash
node tools/publish-to-board.mjs --file path/to/engagement.json --post
# or
node tools/publish-to-board.mjs --from-audit ../data/audit.json --post
```

3. Confirm on the platform:  
   https://rytsensetech-growth-board.pages.dev/platform.html#agents

`--post` hits `/api/engagements` (KV) so the UI updates immediately. Without
`--post`, only `data/engagements.json` is updated — run `npm run deploy:cf` from
the growth-board root afterward.

Optional: `BOARD_PUBLISH_TOKEN` + Pages secret if write protection is enabled.

## Rules

- Do not invent findings; only publish what the wave actually verified.
- Keep `findings` ≤ 50; prefer critical/high.
- After publish, mention the platform `#agents` link in the final reply.

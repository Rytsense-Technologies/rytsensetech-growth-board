---
description: Content production run — briefs to drafts to edited, publish-ready pieces.
argument-hint: [number of pieces, or a specific brief name]
---

Produce content. Assumes strategy exists; if `output/06-content-strategy.md` is
missing, run `/seo-360` first or say so.

1. Read `output/06-content-strategy.md` and list available briefs in
   `output/briefs/`.

2. If `$1` names a brief, produce that one. If `$1` is a number, take that many
   from the top of the priority order. Default to 3.

3. For each piece, in sequence:
   - `content-writer` drafts it from the brief
   - `answer-extractability-engineer` structures it for citation — the answer
     block, section independence, tables and step lists
   - `content-editor` fact-checks, cuts, and verifies against the brief
   - `schema-engineer` produces the JSON-LD for it
   - `internal-linking-engineer` specifies the links in and out

   Multiple pieces can run in parallel, but keep each piece's own chain
   sequential — the editor cannot check a draft that does not exist yet.

4. Report per piece: the editor's verdict, every outstanding `[DATA NEEDED]` and
   `[PROOF NEEDED]` item, and what a human must supply before publishing.

Never publish anything. Drafts land in `output/drafts/` for human review.
Anything still carrying a `[DATA NEEDED]` marker is not ready regardless of how
finished it reads.

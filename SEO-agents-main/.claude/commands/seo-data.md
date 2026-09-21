---
description: Run the data department only — GSC, GA4, logs, indexation, SERP landscape. Builds the evidence base without the full engagement.
argument-hint: [domain]
---

Run the data foundation only. Use this when the goal is to understand what is
actually happening before deciding what to do about it — or as a standalone
monthly data refresh.

1. Read `input/site-profile.md` and `input/data-access.md`. Use `$1` as the
   domain if supplied.

2. Launch `seo-recon` and wait.

3. Launch in parallel (single message):
   - `gsc-data-analyst`
   - `ga4-data-analyst`
   - `log-file-analyst` — only if logs are available
   - `serp-landscape-analyst`

4. Then `index-coverage-analyst`, which needs the GSC output.

5. Report in chat:
   - The 10 most significant things the data shows, ranked by what they imply
     for revenue
   - Every anomaly worth investigating
   - Tracking problems found — these invalidate downstream conclusions, so lead
     with them if any exist
   - What the data cannot tell us, and which access would fix that

Do not recommend actions here beyond fixing broken tracking. This command
establishes facts; `/seo-360` decides what to do with them.

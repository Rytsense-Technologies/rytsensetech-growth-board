# PSI Implementation Complete — Ready for Claude Build

**Commit:** `955fdfe`  
**Date:** 2026-10-28  
**Status:** ✅ All templates created and committed

---

## What's Been Built

### 1. Database Schema ✅
**File:** `supabase/migrations/0002_psi.sql`
- `psi_scores` — stores PSI scores (mobile/desktop, LCP, FCP, CLS, TTFB) per page per day
- `psi_issues` — stores critical/high issues with severity and task linking
- RLS policies — org-scoped isolation
- Indexes — optimized for date range and severity queries

### 2. Daily Sync Job ✅
**File:** `server/src/jobs/sync-psi.js`
- Fetches top 25 pages from GSC for each site
- Calls Google PageSpeed Insights API (mobile + desktop)
- Extracts Core Web Vitals + issues
- Upsert scores, insert issues (no duplicates)
- Handles rate limits (1s delay per page, batch delays)
- Error handling: marks connection status, keeps prior rows

### 3. Weekly Task Creation ✅
**File:** `server/src/jobs/create-psi-tasks.js`
- Finds critical/high issues without tasks (reviewed < 1 week)
- Creates task: title `[PSI] {page}: {issue_title}`
- Assigns to "dev" role (assignee_id = null for self-assign)
- Links task_id to issue, marks reviewed_at
- Posts Slack notification: severity + page + task ID
- Deduplication: checks if task already exists

### 4. API Routes ✅
**File:** `server/src/routes/psi.js`
- `GET /api/psi/scores?site_id=X&days=28` — scores + summary stats
  - Returns avg mobile/desktop scores, critical/high counts, pages_scanned
  - Org-scoped via RLS
- `GET /api/psi/issues?site_id=X&severity=critical,high` — issues with task status
  - Filters: severity, category, has_task
  - Org-scoped via RLS

### 5. Dashboard UI ✅
**File:** `psi.html`
- KPI tiles: avg mobile, avg desktop, critical count, high count, pages scanned
- Filters: severity, category
- Table: page URL → mobile score → desktop score → date → issues → task status
- Color coding: 0-50=red, 50-89=yellow, 90-100=green
- Responsive design, loads live data from API

### 6. Build Instructions ✅
**File:** `PSI-BUILD-PROMPT.md`
- Complete step-by-step integration guide
- Copy-paste code snippets for server/index.js, server/jobs.js, index.html
- Environment setup (Google API key, Slack webhook)
- Test procedures (curl + manual verification)
- Acceptance criteria checklist
- Troubleshooting guide

---

## Files Created

```
✅ supabase/migrations/0002_psi.sql
✅ server/src/jobs/sync-psi.js
✅ server/src/jobs/create-psi-tasks.js
✅ server/src/routes/psi.js
✅ psi.html
✅ PSI-BUILD-PROMPT.md
✅ PSI-IMPLEMENTATION-SUMMARY.md (this file)
```

---

## Next Steps: Use This Prompt in Claude

**Copy the full text of `PSI-BUILD-PROMPT.md` and paste into Claude Desktop with this message:**

```
I have a Growth Board Express/Supabase app. I've created template files 
for a PSI (Page Speed Index) feature:
- Database migration (2002_psi.sql)
- Daily sync job (sync-psi.js)
- Weekly task creation (create-psi-tasks.js)
- API routes (psi.js)
- Dashboard UI (psi.html)

Now I need you to:
1. Apply the database migration to Supabase
2. Update server/src/index.js to register PSI routes
3. Update server/src/jobs.js to wire in daily sync + weekly tasks with cron
4. Update index.html to show PSI health tile
5. Update .env.example with Google API key and Slack webhook config
6. Test all endpoints with curl or postman

Here's the full build prompt with all details and code snippets:

[PASTE PSI-BUILD-PROMPT.md HERE]
```

---

## Architecture Overview

```
Google PageSpeed Insights API
         ↓
    sync-psi.js (daily 2 AM UTC)
         ↓
    psi_scores ← → psi_issues (Postgres)
         ↓
    RLS: organization_id scoping
         ↓
    create-psi-tasks.js (weekly Wed 8 AM UTC)
         ↓
    Create tasks → critical/high issues
         ↓
    Assign to "dev" role → Slack notification
         ↓
    /api/psi/scores + /api/psi/issues (Express)
         ↓
    Growth Board dashboard (psi.html) + home tile
         ↓
    Dev team: see PSI tasks in /tasks.html
```

---

## Key Features

### Automation
- ✅ Daily: fetch PSI from Google, store scores + issues
- ✅ Weekly: auto-create tasks for critical/high issues
- ✅ Slack: notify dev team when tasks are created
- ✅ Dedup: skip duplicate tasks (title + URL + date)

### Safety
- ✅ Org isolation: RLS ensures Org A ≠ Org B data
- ✅ Role-based: "dev" assigned, "admin" can override
- ✅ Error handling: failed API → connection.error_status (no fake zeros)
- ✅ Rate limiting: 1s delay per page, batch delays

### Visibility
- ✅ Dashboard: KPIs, trends, issue list
- ✅ Home tile: avg score + critical count → link to full PSI dash
- ✅ Task board: PSI tasks appear in /tasks.html
- ✅ API: live scores for other integrations

---

## Environment Variables Needed

```env
# Google PageSpeed Insights
GOOGLE_PAGESPEED_API_KEY=your_psi_api_key_here

# Slack notifications (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
SLACK_DEV_CHANNEL=#dev-alerts

# Existing
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=...
```

---

## Testing Checklist

After Claude builds everything:

- [ ] Supabase migration applied; `psi_scores` table exists
- [ ] `npm run dev` starts without errors
- [ ] `GET /api/health` returns `{ ok: true, database: true }`
- [ ] `GET /api/jobs/psi-sync` returns `{ ok: true, result: { syncedPages: N, ... } }`
- [ ] Pages appear in `psi_scores` with real PSI data
- [ ] Issues appear in `psi_issues` with severity + impact_score
- [ ] `GET /api/psi/scores?site_id=RYTSENSE_SITE` returns valid JSON
- [ ] `/psi.html?site_id=RYTSENSE_SITE` renders dashboard
- [ ] KPI tiles show real numbers
- [ ] Table shows pages with scores
- [ ] Home `/index.html` shows PSI health tile
- [ ] `GET /api/jobs/psi-tasks` creates tasks for critical/high issues
- [ ] Tasks appear in `/tasks.html` with "dev" assignment
- [ ] Slack notification sent (if webhook configured)
- [ ] Org B cannot see Org A's PSI data (RLS test)

---

## Estimated Build Time (Claude)

- **Database migration:** 2 min (manual run in Supabase console)
- **Route registration:** 5 min (copy 2 lines into index.js)
- **Job wiring:** 10 min (copy cron scheduler into jobs.js)
- **Home tile:** 5 min (copy tile HTML + JS into index.html)
- **Env config:** 2 min (update .env.example)
- **Testing:** 15 min (curl endpoints, verify data)

**Total: ~40 minutes**

---

## What This Achieves

✅ **Closed feedback loop:** Detect PSI issues → Auto-assign to devs → Track status  
✅ **Live dashboard:** Always-current page speed health  
✅ **Team visibility:** Devs see PSI work in task board  
✅ **Data-driven:** Real scores + impact, no invented numbers  
✅ **Org isolation:** Multi-tenant safe, RLS enforced  

---

## Post-Launch Enhancements (Future)

1. **Score trends** — line chart of avg score over 28 days
2. **Recommendations** — top 3 fixes per page
3. **Threshold alerts** — notify when score drops below 50
4. **Competitor PSI** — scan competitor URLs for comparison
5. **Export to PDF** — format report for clients
6. **Lighthouse audit** — link to full Lighthouse report

---

## Questions Before Building?

- Do you want Slack notifications? (set `SLACK_WEBHOOK_URL`)
- Do you want to customize which pages to scan? (currently top 25 from GSC)
- Do you want to auto-assign specific devs instead of "dev" role? (modify create-psi-tasks.js)
- Do you need historical PSI data import? (add import script)

---

**Status: Ready to build. Copy PSI-BUILD-PROMPT.md → Claude Desktop → implement → test ✅**

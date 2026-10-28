# Growth Board: Page Speed Index (PSI) Integration — Full Build Prompt

**Use this prompt with Claude Desktop or any AI assistant to implement the complete PSI feature.**

---

## Context

You are building an additional module for Growth Board, an internal SEO operating system on Supabase + Express. This repo already has:
- Daily metrics sync (GSC, GA4, Clarity)
- Weekly Anthropic reviews for SEO issues
- Task management with role-based assignment (admin, seo, dev, viewer)
- Multi-company isolation (RLS, organization_id scoping)
- Cloudflare Pages static UI + Express API

**Your task:** Add Page Speed Index (PSI) tracking with automatic dev task creation for critical/high issues.

---

## Files You'll Implement

All files are included in the repo as templates. You will:

1. ✅ **Database migration** — `supabase/migrations/0002_psi.sql` (DONE)
   - `psi_scores` table (org-scoped, per-page PSI snapshots)
   - `psi_issues` table (critical/high issues linked to tasks)
   - RLS policies for org isolation
   
2. ✅ **Daily sync job** — `server/src/jobs/sync-psi.js` (DONE)
   - Fetch top 25 pages from GSC per site
   - Call Google PageSpeed Insights API (mobile + desktop)
   - Extract core web vitals + issues
   - Upsert psi_scores, insert psi_issues
   - Handle rate limits & errors gracefully
   
3. ✅ **Weekly task creation** — `server/src/jobs/create-psi-tasks.js` (DONE)
   - Find critical/high issues without tasks
   - Create tasks assigned to "dev" role
   - Link task_id to issue
   - Post Slack notification
   
4. ✅ **API routes** — `server/src/routes/psi.js` (DONE)
   - `GET /api/psi/scores?site_id=X&days=28` — list scores + summary
   - `GET /api/psi/issues?site_id=X&severity=critical,high` — list issues with task status
   - RLS enforcement on all queries
   
5. ✅ **PSI Dashboard** — `psi.html` (DONE)
   - KPI tiles (avg mobile, avg desktop, critical/high counts)
   - Filters (severity, category)
   - Table: page URL → scores → issues → task links
   
6. ⏳ **Integration** (YOUR TASK):
   - Update `server/src/index.js` — register PSI routes
   - Update `server/src/jobs.js` — add daily sync + weekly task creation to cron
   - Update `index.html` — add PSI health tile linking to `/psi.html`
   - Update `.env.example` — document new env vars

---

## Step 1: Register PSI Routes (server/src/index.js)

After the existing routes (around line 350), add:

```javascript
// PSI routes
import psiRoutes from './routes/psi.js';
app.use('/api', psiRoutes);
```

Make sure `psiRoutes` is imported at the top.

---

## Step 2: Add Jobs to Scheduler (server/src/jobs.js)

At the top of the file, add imports:

```javascript
import { runPSISync } from './jobs/sync-psi.js';
import { createPSITasks } from './jobs/create-psi-tasks.js';
```

In the `createApp()` section where cron jobs are defined (search for `/api/jobs/daily`), add:

```javascript
app.get('/api/jobs/psi-sync', async (req, res) => {
  try {
    const result = await runPSISync();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('PSI sync job error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/psi-tasks', async (req, res) => {
  try {
    const result = await createPSITasks();
    res.json({ ok: true, result });
  } catch (err) {
    console.error('PSI tasks job error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

If using `node-cron`, wire them:

```javascript
import cron from 'node-cron';

// Daily 2 AM UTC: sync PSI
cron.schedule('0 2 * * *', () => runPSISync().catch(err => console.error('PSI sync failed:', err)));

// Weekly Wed 8 AM UTC: create PSI tasks
cron.schedule('0 8 * * 3', () => createPSITasks().catch(err => console.error('PSI tasks failed:', err)));
```

---

## Step 3: Update Home Dashboard (index.html)

Find the KPI tiles section (search for `<div id="kpis">`). Add a new tile after the last one:

```html
<div class="kpi" id="psi-tile">
  <div class="label">Page Speed Health</div>
  <div class="value" id="psi-value">—</div>
  <div class="subtitle" id="psi-critical">— critical issues</div>
  <a href="/psi.html" style="margin-top: 0.75rem; display: inline-block; color: #00a3e0; text-decoration: none; font-size: 0.875rem;">View Dashboard →</a>
</div>
```

In the JavaScript section of index.html (search for where other KPIs are fetched), add:

```javascript
// Fetch PSI summary
async function loadPSISummary() {
  try {
    const siteId = window.RYTSENSE_SITE || ''; // Use global if available
    if (!siteId) return;
    
    const response = await fetch(`${window.GB_API_BASE || '/'}/api/psi/scores?site_id=${siteId}&days=28`, {
      headers: { 'Authorization': `Bearer ${window.authToken}` },
    });
    
    if (response.ok) {
      const data = await response.json();
      const score = data.summary?.avg_mobile_score || data.summary?.avg_desktop_score || null;
      const critical = data.summary?.critical_issues || 0;
      
      document.getElementById('psi-value').textContent = score ? `${score}/100` : 'N/A';
      document.getElementById('psi-critical').textContent = `${critical} critical issues`;
    }
  } catch (err) {
    console.error('PSI summary fetch error:', err);
  }
}

// Call when page loads
document.addEventListener('DOMContentLoaded', loadPSISummary);
```

---

## Step 4: Update .env.example

Add these lines:

```env
# Google PageSpeed Insights
GOOGLE_PAGESPEED_API_KEY=your_psi_api_key_here

# Slack notifications for PSI tasks (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
SLACK_DEV_CHANNEL=#dev-alerts
```

---

## Step 5: Apply Supabase Migration

Run this in your Supabase console or via CLI:

```bash
supabase migration up
```

Or manually apply the SQL from `supabase/migrations/0002_psi.sql`.

---

## Step 6: Test the Implementation

### Manual Test (Development)

1. **Test daily sync:**
   ```bash
   curl http://localhost:3000/api/jobs/psi-sync \
     -H "x-cron-secret: $(echo $CRON_SECRET)"
   ```
   Expected: `{ ok: true, result: { syncedPages: N, syncedIssues: M, errors: 0 } }`

2. **Test task creation:**
   ```bash
   curl http://localhost:3000/api/jobs/psi-tasks \
     -H "x-cron-secret: $(echo $CRON_SECRET)"
   ```
   Expected: `{ ok: true, result: { tasksCreated: N } }`

3. **Test API endpoints:**
   ```bash
   curl "http://localhost:3000/api/psi/scores?site_id=SITE_ID&days=28" \
     -H "Authorization: Bearer $USER_TOKEN"
   ```
   Expected: JSON with summary + scores array

4. **Test UI:**
   - Open `http://localhost:3000/psi.html?site_id=SITE_ID`
   - Should show KPI tiles and table

### Acceptance Criteria

- [ ] Schema applied; `psi_scores` table exists in Supabase
- [ ] Daily sync job runs without errors; creates psi_scores rows
- [ ] Scores are fetched from Google PSI API (real data, not mocked)
- [ ] Weekly job creates tasks for critical/high issues
- [ ] Tasks are linked to issues (task_id populated)
- [ ] `/api/psi/scores` returns org-scoped data only
- [ ] `/api/psi/issues` filters work (severity, category, has_task)
- [ ] PSI dashboard renders with scores and KPIs
- [ ] Home dashboard shows PSI tile linking to full dashboard
- [ ] Two-company isolation test: Org B cannot see Org A's PSI data
- [ ] Slack notifications appear when tasks are created

---

## Environment Setup

You need:

1. **Google PageSpeed Insights API Key**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable PageSpeed Insights API
   - Create an API key (no restrictions needed for dev)
   - Set `GOOGLE_PAGESPEED_API_KEY` in `.env`

2. **Slack Webhook (optional but recommended)**
   - Go to your Slack workspace → Apps → Incoming Webhooks
   - Create a new webhook
   - Set `SLACK_WEBHOOK_URL` and `SLACK_DEV_CHANNEL` in `.env`

3. **Database migration**
   - Apply `supabase/migrations/0002_psi.sql` to your Supabase project

---

## Troubleshooting

**Q: PSI API returns 403 "Forbidden"**
- Check that `GOOGLE_PAGESPEED_API_KEY` is set correctly
- Verify API is enabled in Google Cloud Console

**Q: "No pages to scan" or sync finds 0 pages**
- Make sure GSC data exists for the site (sync GSC first)
- Check that `search_pages` table is populated

**Q: Tasks not being created**
- Verify psi_issues exist in Postgres
- Check that issues have severity ∈ [critical, high]
- Check task duplication logic (may skip if title already exists)

**Q: RLS errors on /api/psi/**
- Verify actor extraction in index.js sets `req.userOrgId` or `req.actor`
- Check that user token is valid

---

## Future Enhancements

1. **Historical trend chart** — line chart of avg score over 28 days
2. **Page-level recommendations** — show top 3 optimizations per page
3. **Mobile-vs-desktop pivot** — compare scores side-by-side
4. **Export to PDF** — format PSI report for client delivery
5. **Threshold alerts** — notify when avg score drops below 50
6. **Competitor benchmarking** — fetch PSI for competitor URLs

---

## Files Summary

| File | Status | Purpose |
|------|--------|---------|
| `supabase/migrations/0002_psi.sql` | ✅ Ready | Database schema |
| `server/src/jobs/sync-psi.js` | ✅ Ready | Daily sync from Google API |
| `server/src/jobs/create-psi-tasks.js` | ✅ Ready | Weekly task auto-creation |
| `server/src/routes/psi.js` | ✅ Ready | API endpoints |
| `psi.html` | ✅ Ready | Dashboard UI |
| `server/src/index.js` | ⏳ Update | Register routes |
| `server/src/jobs.js` | ⏳ Update | Wire cron jobs |
| `index.html` | ⏳ Update | Add PSI tile |
| `.env.example` | ⏳ Update | Document env vars |

---

## Success Metrics

Once live:
- Daily: ~25 pages scanned per site, scores stored in Postgres
- Weekly: critical/high issues → auto-tasks with "dev" role
- Dashboard: live PSI health visible alongside GSC/GA4
- Teams: devs see PSI tasks in `/tasks.html` → status → tracked

**You're building a closed feedback loop: detect → alert → assign → verify.**

---

**Ready to build? Start with Step 1 (register routes), then Step 2 (wire jobs), then test with manual curl calls.**

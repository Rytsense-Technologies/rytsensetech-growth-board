# PSI Feature — Quick Start Guide

## What You Have

All PSI code templates are ready. **You don't need to write code — just wire it together.**

## What's Included

| File | Status | What it does |
|------|--------|------------|
| `supabase/migrations/0002_psi.sql` | ✅ Ready | Database tables + RLS |
| `server/src/jobs/sync-psi.js` | ✅ Ready | Daily: fetch PSI from Google |
| `server/src/jobs/create-psi-tasks.js` | ✅ Ready | Weekly: auto-create dev tasks |
| `server/src/routes/psi.js` | ✅ Ready | API endpoints (/api/psi/*) |
| `psi.html` | ✅ Ready | PSI dashboard UI |
| `PSI-BUILD-PROMPT.md` | ✅ Ready | Full Claude build instructions |

## Steps to Ship

### Step 1: Copy the build prompt
Open `PSI-BUILD-PROMPT.md` in Growth Board repo and copy the entire file.

### Step 2: Go to Claude Desktop
Open Claude and paste this:

```
I have a Growth Board Express/Supabase app. I've already created template files 
for a PSI feature. Now I need you to integrate them:

[PASTE PSI-BUILD-PROMPT.md HERE]
```

### Step 3: Claude will:
- ✅ Apply database migration
- ✅ Update server/src/index.js (register routes)
- ✅ Update server/src/jobs.js (wire cron jobs)
- ✅ Update index.html (add PSI tile)
- ✅ Update .env.example
- ✅ Test all endpoints

### Step 4: Deploy
```bash
npm run deploy:cf
```

## What You Get After

✅ Daily at 2 AM UTC: Fetches PSI for top 25 pages  
✅ Weekly Wed 8 AM: Creates tasks for critical/high issues  
✅ Dashboard at `/psi.html`: Live scores + KPIs  
✅ Home tile: Quick health check  
✅ Slack: Dev team gets notified of new PSI tasks  

## Timeline

- **30 min:** Claude builds everything
- **5 min:** You deploy
- **2 hours:** First sync runs, data appears
- **1 week:** First PSI tasks created

## Monitoring

After deployment, check:

```bash
# Via curl (replace TOKEN)
curl "http://localhost:3000/api/psi/scores?site_id=SITE_ID" \
  -H "Authorization: Bearer $TOKEN"

# Via browser
open https://rytsensetech-growth-board.pages.dev/psi.html
```

## Cost

- **Google PSI:** Free tier = 25k/day (enough for 25 pages daily)
- **Slack:** Free (if webhook configured)
- **Supabase:** Included in existing plan
- **Express:** Included in existing plan

## Questions?

See `PSI-BUILD-PROMPT.md` for:
- Full code snippets
- Environment setup
- Troubleshooting
- Future enhancements

---

**TL;DR:** Copy `PSI-BUILD-PROMPT.md` → paste in Claude → Claude builds it → deploy ✅

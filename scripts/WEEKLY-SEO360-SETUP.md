# Weekly autonomous SEO agents — what you need + how to turn it on

You asked for:
1. **Weekly full** (`/seo-360`)
2. **Auto-create tasks** from **critical** findings
3. **Claude schedulers**

Daily metrics refresh stays separate. This is a **second** Claude scheduled task.

---

## 1. Claude prompt (copy into a new scheduled routine)

**File in repo:** `scripts/claude-scheduler-weekly-seo360.txt`

**Suggested schedule name:** `growth-board-weekly-seo360`  
**Suggested cadence:** weekly (e.g. Monday 06:00 IST / Sunday evening UTC)

Paste the **entire contents** of that file into the Claude scheduled task instructions.

It will (token-optimized **52-agent routing**):
1. **DIGEST** — `memory.py digest` + audit + open tasks + `latest.json`  
2. **REVIEW GATE** — STILL_TRUE / FIXED / REGRESSED / UNKNOWN  
3. **Route real specialists** from `SEO-agents-main/.claude/agents/*.md`  
   - STILL_TRUE → 1 verify agent each (cap 5)  
   - REGRESSED/UNKNOWN → 2–4 deep agents per theme + `seo-qa-auditor`  
   - Cap ~12 specialist invocations/week — **not** all 52 every time, **not** orchestrator-only  
4. **UPDATE memory** + `data/audit.json`  
5. `POST /api/engagements` with **real** `agentsUsed` names  
6. Refresh **SEO Work** JSON (`internal-links`, `content-ideas`, `topic-trends`)  
   + **continue GSC Issues agent Why/Fix** (~40–60 pending/week; see STEP 4b)  
7. Auto-tasks for **NEW / REGRESSED** criticals only (audit findings — not every GSC row)  
8. Slack summary (agent names + task counts by team)  

### What you should do in the UI right now

1. Open https://rytsensetech-growth-board.pages.dev/seo-work.html#issues  
2. Filter **Agent reviewed** → see the **47** already done (403 + redirect errors)  
3. Click **Create task** only for ones the team should work  
4. Leave **Pending** for the weekly Claude schedule to chew through (404 → fix → …)

**Yes — use the weekly scheduler** for ongoing suggestions. Paste/update the weekly prompt from `scripts/claude-scheduler-weekly-seo360.txt` (STEP 4b now includes GSC review). Optional: also keep `scripts/claude-scheduler-gsc-issues-review.txt` as a manual “catch-up” run after a big Excel drop.

**Runtime:** Prefer Claude Code / scheduler with Task/subagents that can load `.claude/agents/*.md`. If agents cannot be loaded, the run must report `blocked` — not a fake solo analysis.

---

## 2. Keep the daily job as-is

| Schedule | Prompt file | Does |
|----------|-------------|------|
| **Daily** | `scripts/claude-scheduler-daily-refresh.txt` | GSC/GA4/Clarity → `latest.json` → deploy |
| **Weekly** | `scripts/claude-scheduler-weekly-seo360.txt` | Full agents → publish → auto tasks |
| **GSC Issues review** (as needed) | `scripts/claude-scheduler-gsc-issues-review.txt` | Agent Why/Fix on `gsc-issues.json` → SEO Work |

Do **not** merge daily + weekly into one job. GSC Issues review can be a third Claude schedule (e.g. after SEO drops a new Excel) or run manually in Claude Code / Cursor.

### GSC Issues → Why / Fix → optional tasks

1. Import sheet: `npm run import:gsc-issues`  
2. Run the **GSC Issues review** prompt (Claude scheduled task or paste into Claude Code / Cursor Agent)  
3. Open https://rytsensetech-growth-board.pages.dev/seo-work.html#issues — column **Agent: Why & Fix**  
4. Humans click **Create task** only for ones they want (Unassigned)

**Do you need Claude?** Yes for the intended path — the 52 specialists live under `SEO-agents-main/.claude/agents/`. Cursor can follow the same prompt file and agent `.md` files. You do not need a separate agent product.


---

## 3. Additional checklist (do these once)

### Required
- [ ] **Claude schedule created** with the weekly prompt above  
- [ ] **Folder access:** Claude can read/write `E:\growth-board` and `SEO-agents-main`  
- [ ] **MCP / tools for agents:** browser + whatever you already use for GSC/GA4 (same as daily)  
- [ ] **Live APIs working:**  
  - https://rytsensetech-growth-board.pages.dev/api/tasks  
  - https://rytsensetech-growth-board.pages.dev/api/engagements  
  - https://rytsensetech-growth-board.pages.dev/api/team  
- [ ] **KV bound** on Pages (`FIXES`) — already used for tasks (needed for auto-create)

### Strongly recommended
- [ ] Fill remaining **`[NEEDS ANSWER]`** in `SEO-agents-main/input/site-profile.md` (ICP, deal size)  
- [ ] Keep `input/data-access.md` accurate  
- [ ] **SERP API key** in `SEO-agents-main/.env` (from `.env.example`) so competitive/AEO waves are live, not guessed  
- [ ] Optional Pages secret **`BOARD_PUBLISH_TOKEN`** + tell Claude the value via a secret/env the scheduler can read (if unset, publish stays open by URL)  
- [ ] **Slack connected** in Claude — both daily + weekly prompts post a short run summary (tasks open/done by team). Point the Slack app at your SEO/growth channel.

### Already done / not blockers
- [x] Team Tasks UI + `POST /api/tasks`  
- [x] Publish bridge + `/api/engagements`  
- [x] GitHub Actions deploy for daily `latest.json`  
- [x] Rule: daily refresh must not wipe tasks  

### Do not need for this weekly job
- Vercel  
- GitHub Issues  
- Clarity MCP (agents can use browser; daily job uses Clarity worker)  
- Phase 4 CRM/Ahrefs (still gated)

---

## 4. Behaviour you should expect

| Finding type | Auto task? |
|--------------|------------|
| `criticalIssues` (C1, C2, …) | **Yes** — create if not already open |
| `highIssues` | No (listed on board via publish only) |
| `easyWins` | No (humans / existing tasks) |

| Field | Value |
|-------|--------|
| Priority | `critical` |
| Status | `todo` |
| Due | +7 days from run |
| Assignee | Best roster match by team, else Unassigned |

After a weekly run: check **Platform → Agents**, **Activity**, and **Team Tasks**.

---

## 5. Optional hardening (later)

Not required to turn the schedule on:

1. Script `SEO-agents-main/tools/critical-to-tasks.mjs` (same logic as Step D) for local/CI  
2. Cursor Automation as backup if Claude schedule flakes  
3. Auto-create from **high** findings with priority `high`  
4. Slack/email digest of “N critical tasks created”

---

## 6. First-run tip

Before trusting the weekly schedule unattended, run the prompt **once manually** in Claude (same instructions) and confirm:

1. `audit.json` updated  
2. Platform Agents shows new engagement  
3. Only **new** critical tasks appeared (no duplicates of W1/C2 already open)

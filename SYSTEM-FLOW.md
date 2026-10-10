# Rytsense Growth Board — Complete System Flow (A → Z)

**Live:** https://rytsensetech-growth-board.pages.dev  
**Repo:** https://github.com/Rytsense-Technologies/rytsensetech-growth-board  
**Purpose:** Internal SEO / AEO operating system for **rytsensetech.com** — live metrics, audit intelligence, agent findings, and team task execution in one place.

This document describes what is implemented today, how data moves, what each part is for, and how humans + Claude agents use it.

---

## 1. Use case (why this exists)

| Who | What they need | Where they go |
|-----|----------------|---------------|
| Leadership / SEO lead | Are we growing? What’s broken? What’s next? | Growth Board + Intelligence Report |
| Dev / Content / Marketing | Own work, deadlines, status | Team Tasks |
| Claude scheduled job | Refresh live metrics every day | `data/latest.json` → Cloudflare Pages |
| Claude SEO agent team | Deep audits, then publish findings to the board | `SEO-agents-main/` → `/api/engagements` |
| Ops / specialist | Drill into GSC/GA4 modules, fixes, goals | SEO Ops + Internal Platform |

**Not** a public marketing site. **Not** Vercel. Hosting is **Cloudflare Pages** (static HTML + Pages Functions + one KV namespace).

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SOURCES OF TRUTH                                │
│  GSC · GA4 · Clarity worker · GitHub · (optional) CF analytics          │
│  Claude SEO agents (52) · Humans (tasks / fixes / goals)                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ Daily metrics    │  │ Agent findings   │  │ Human ops state      │
│ data/latest.json │  │ audit.json       │  │ tasks / team / fixes │
│ + data/history/  │  │ engagements.json │  │ goals / activity     │
└────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘
         │                     │                        │
         │            publish-to-board.mjs              │
         │                     │                        │
         └──────────┬──────────┴──────────┬─────────────┘
                    ▼                     ▼
         Static files on Pages    Pages Functions + KV (FIXES)
         (HTML / JSON / assets)   /api/tasks · /api/team · …
                    │                     │
                    └──────────┬──────────┘
                               ▼
                    Browser (no login)
         index · report · tasks · ops · platform
```

**Design rule:** metrics files are overwritten by automation; **tasks are human-owned** and must never be wiped by the daily refresh.

---

## 3. Repository structure

```
growth-board/
├── index.html              # Growth Board (teal / Manrope) — live KPIs
├── report.html             # Intelligence Report (IBM Plex / burnt orange)
├── tasks.html              # Team Tasks (by-person / board / list)
├── ops.html                # SEO Ops drill-downs (Phase 1 modules)
├── platform.html           # Internal Platform hub (all modules)
├── assets/
│   ├── site-nav.css / .js  # Sticky top nav (all pages)
│   └── rts-report.css      # Report design system (.rts-report scope)
├── data/
│   ├── latest.json         # Daily metrics snapshot (GSC/GA4/Clarity/…)
│   ├── history/            # Compact daily totals (trend)
│   ├── audit.json          # Structured SEO findings (agent/human)
│   ├── engagements.json    # Last agent engagement publish
│   ├── tasks.json          # Seed / fallback task list
│   ├── team.json           # Team roster seed
│   ├── fixes.json · goals.json · activity.json
├── functions/api/          # Cloudflare Pages Functions
│   ├── tasks.js · tasks/[id].js
│   ├── team.js
│   ├── engagements.js
│   ├── fixes.js · fixes/[id].js
│   ├── goals.js · activity.js
├── scripts/
│   ├── deploy-cloudflare.mjs
│   ├── claude-scheduler-daily-refresh.txt   # Daily Claude routine prompt
│   └── …
├── .github/workflows/
│   └── deploy-pages.yml    # Auto-deploy on push to data/** (etc.)
├── wrangler.toml           # Pages project + KV binding FIXES
├── secrets/                # gitignored (CF API token, etc.)
└── SEO-agents-main/        # 52-agent SEO/AEO pack + board bridge
    ├── .claude/agents/     # 52 specialist definitions
    ├── .claude/commands/   # /seo-360, /aeo-360, /seo-publish, …
    ├── tools/              # serp.py, board.py, memory.py, publish-to-board.mjs
    ├── input/              # site-profile.md, data-access.md
    └── BRIDGE.md
```

---

## 4. Product surfaces (pages)

| Page | URL path | Design | Job |
|------|----------|--------|-----|
| **Growth Board** | `/` · `index.html` | Teal / Manrope | Executive live dashboard from `latest.json` |
| **Intelligence Report** | `/report` · `report.html` | IBM Plex / burnt orange | Narrative audit / findings UI (scoped CSS) |
| **Team Tasks** | `/tasks` · `tasks.html` | Dark / burnt orange | Assign, filter, status write-back; roster |
| **SEO Ops** | `/ops` · `ops.html` | Teal ops | Module drill-downs (keywords, pages, cannibalization, …) |
| **Internal Platform** | `/platform` · `platform.html` | Teal ops | Single hub: modules + agents + fixes + goals |

Shared: sticky top site nav (`assets/site-nav.*`). Active tab works with pretty URLs (`/tasks` as well as `tasks.html`).

---

## 5. Data system design

### 5.1 Two storage layers

| Layer | What | Where | Who writes |
|-------|------|-------|------------|
| **Static JSON** | Snapshots shipped with the site | `data/*.json` on Pages CDN | Claude daily job, agents publish, humans via git/deploy |
| **KV (runtime)** | Mutable ops state | Cloudflare KV binding `FIXES` | Browser → Pages Functions `/api/*` |

On first read, APIs typically **seed KV from static JSON** if empty, then serve/update KV. Static files remain the deployable seed and offline fallback.

### 5.2 Core data files

| File | Role | Overwritten daily? |
|------|------|--------------------|
| `data/latest.json` | Live GSC / GA4 / Clarity / GitHub / Cloudflare + Phase-1 additive slices | **Yes** (Claude) |
| `data/history/YYYY-MM-DD.json` | Compact day totals for trends | Appended daily |
| `data/history/index.json` | List of history dates (≤90 days) | Updated daily |
| `data/audit.json` | Findings / issues for report & agents | By agent/human workflows |
| `data/engagements.json` | Last published agent engagement | Via `publish-to-board.mjs` |
| `data/tasks.json` | Task seed (W/C/H ids, assignees, due dates) | **Never by daily job** |
| `data/team.json` | Roster seed (name, team, initials) | Human / Team modal |
| `data/fixes.json` | Fix tracker items | Humans + API |
| `data/goals.json` | Goals | Humans + API |
| `data/activity.json` | Activity feed | APIs / publish bridge |

### 5.3 `latest.json` shape (metrics bus)

```
site, updatedAt
gsc          → period, current, prior, change, quickWins[]
ga4          → totals, daily[], channels[]
clarity      → status + data{} (from Clarity worker HTTP, not broken MCP)
github       → recentCommits[]
cloudflare   → analytics (optional) + deployment status
gscByCountry / gscByPage / gscByQuery / gscCannibalization
ga4ByCountry / ga4ByPage / ga4AiTraffic
```

**Rules:** GSC current = last 28 full days ending yesterday (UTC); CTR as percent; quickWins = position 4–15 & impressions ≥ 100. Failed sources set `status: "unavailable"` — never invent numbers.

### 5.4 Tasks model (operational layer)

Each task roughly:

```
id · title · details · team · assignee · status · priority · dueDate
source · location · rationale · effort · notes[] · createdAt · completedAt
```

Statuses: `todo` | `in-progress` | `blocked` | `done`  
Teams: Development · Content · Marketing · SEO  

UI views: **By person** · **Board** · **List**, plus KPIs (open / overdue / due in 3 days / blocked / complete %).

### 5.5 API map (Pages Functions)

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/tasks` | GET, POST | List / create tasks (KV) |
| `/api/tasks/:id` | GET, PATCH | Update status, assignee, notes, … |
| `/api/team` | GET, POST, DELETE-ish | Team roster CRUD |
| `/api/engagements` | GET, POST | Agent publish → board + activity |
| `/api/fixes` · `/api/fixes/:id` | GET, POST, PATCH | Fix tracker |
| `/api/goals` | GET, POST | Goals |
| `/api/activity` | GET, POST | Activity feed |

Optional: `BOARD_PUBLISH_TOKEN` on Pages + client env for authenticated engagement POSTs.

---

## 6. End-to-end flows

### 6.1 Daily metrics refresh (A → Z)

```
1. Claude scheduled routine "growth-board-daily-refresh"
     (prompt: scripts/claude-scheduler-daily-refresh.txt)
2. Pull live data
     · GSC MCP  · GA4 MCP
     · Clarity via HTTPS worker (NOT Clarity MCP — known bug)
     · GitHub commits · optional CF analytics
3. Write E:\growth-board\data\latest.json
4. Write data/history/YYYY-MM-DD.json + update history/index.json
5. Do NOT touch data/tasks.json
6. Publish to GitHub (API or git) — Contents API if Windows shell bridge is down
7. Deploy path (shell-bridge resilient):
     PRIMARY: GitHub push → Actions (.github/workflows/deploy-pages.yml)
              → npm run deploy:cf → Cloudflare Pages
     FALLBACK: local `npm run deploy:cf` when device shell works
8. Browsers load https://…pages.dev/data/latest.json (short cache)
9. Growth Board / Ops / Platform re-render from that JSON
```

**Known constraint:** Claude’s Windows `device_bash` may fail (Plan9 / virtiofs). File write + GitHub API still work; **Actions deploy** is the reliable public update path. Secret required: repo Actions secret `CLOUDFLARE_API_TOKEN`.

### 6.2 Manual / Cursor deploy

```
edit files → npm run deploy:cf
  → scripts/deploy-cloudflare.mjs stages .cf-pages/
  → wrangler pages deploy → project rytsensetech-growth-board
  → Functions from /functions + KV FIXES binding
```

### 6.3 SEO agent engagement → board

```
1. Fill SEO-agents-main/input/site-profile.md + data-access.md
2. In Claude Code, run e.g. /seo-360 or /aeo-360
     (or ask seo-orchestrator in plain language)
3. Orchestrator routes specialists in waves; board.py + memory.py coordinate
4. Findings land in audit / engagement payload
5. Publish:
     cd SEO-agents-main
     node tools/publish-to-board.mjs --from-audit ../data/audit.json --post
     # or Claude command /seo-publish
6. Script writes data/engagements.json + POST /api/engagements
7. platform.html#agents shows last engagement; activity feed updates
8. Humans turn findings into Team Tasks (or agents suggest; humans own status)
```

### 6.4 Team Tasks day-to-day

```
1. Open /tasks
2. Filter by team / status / search; switch By person | Board | List
3. + New task → modal → POST /api/tasks
4. Team → roster modal → add/remove → /api/team
5. Change status on card → PATCH /api/tasks/:id (KV write-back)
6. Growth Board open-critical KPI reads task API / seed (not overwritten by daily job)
```

### 6.5 Fixes & goals

Same pattern: UI on platform/ops → `/api/fixes` / `/api/goals` → KV, seeded from static JSON.

---

## 7. SEO agents — what they are and what they do

### 7.1 Role in this project

Agents are **not** the live dashboard runtime. They are an offline Claude Code “search department” that:

1. Investigates the site (crawl, SERP, content, AEO, tech, …)
2. Writes structured findings
3. Optionally **publishes** onto the Growth Board via the bridge

Dashboard remains static + KV; agents remain in `SEO-agents-main/`.

### 7.2 Runtime split

| Layer | Stack | Job |
|-------|-------|-----|
| Agents + commands | Claude Code markdown | Roles & playbooks |
| `serp.py` · `board.py` · `memory.py` | Python | SERP API, coordination board, memory |
| `guard.mjs` | Node PreToolUse hook | Block unsafe / out-of-scope tool use |
| `publish-to-board.mjs` | Node | Bridge → `engagements.json` + `/api/engagements` |
| `aio-extract.js` | Browser JS | AI Overview extraction helper |

### 7.3 Commands (entry points)

| Command | Use |
|---------|-----|
| `/seo-360` | Full SEO pass |
| `/aeo-360` | Answer-engine / AI-search pass |
| `/seo-quick` | Short triage |
| `/seo-content` | Content-focused wave |
| `/seo-data` | Data / analytics-focused |
| `/seo-opportunities` | Opportunity discovery |
| `/seo-monthly` | Monthly rhythm |
| `/seo-eval` | Eval / QA of agent outputs |
| `/aeo-verify` | Verify AEO claims |
| `/seo-publish` | Push results to Growth Board |

Front door without slash commands: ask **`seo-orchestrator`**.

### 7.4 Agent roster (52) by function

| Group | Count | Examples (what they do) |
|-------|------:|-------------------------|
| **Orchestration** | 1 | `seo-orchestrator` — triage, route, adjudicate conflicts, collect |
| **Leadership** | 3 | director, project manager, QA auditor |
| **Data & discovery** | 6 | recon, GSC/GA4 analysts, log-file, index-coverage, SERP landscape |
| **Technical** | 8 | technical SEO, crawl access, rendering, architecture, CWV, mobile, international, migration |
| **Market intelligence** | 5 | keywords, intent, competitors, topical authority, brand SERP |
| **Content** | 7 | architect, writer, editor, refresh, pruning, EEAT, conversion copy |
| **AEO / AI search** | 5 | AEO strategist, answer extractability, entity grounding, conversational queries, AI brand monitor |
| **On-page & structured data** | 3 | on-page optimizer, internal linking, schema engineer |
| **Off-page** | 4 | authority, backlinks, digital PR, local SEO |
| **Vertical (conditional)** | 4 | ecommerce, programmatic, video, image |
| **Opportunity** | 2 | opportunity-finder + opportunity-validator |
| **Measurement** | 4 | seo-analyst, conversion-analyst, forecaster, experiment-designer |

Exact filenames live under `SEO-agents-main/.claude/agents/`.

### 7.5 Coordination mechanics (implemented)

- Orchestrator runs **waves**; specialists write to a shared board (`board.py`).
- **Conflicts** gate the wave until adjudicated (honesty > shipping disputed claims).
- **Memory** (`memory.py`) carries context across runs.
- **Guard** blocks dangerous deploys / out-of-policy tool calls.
- **Publish** is explicit (`/seo-publish`) — agents do not silently overwrite the live site.

---

## 8. Design systems (two, on purpose)

| Surface | Tokens | Scope |
|---------|--------|-------|
| Growth Board / Ops / Platform | Teal, Manrope | Default dashboard look |
| Intelligence Report + Team Tasks chrome | IBM Plex, burnt orange | `.rts-report` / tasks dark UI |

Do **not** merge report orange into the teal board CSS.

---

## 9. What is implemented vs gated

### Implemented (in production use)

- [x] Static multi-page board on Cloudflare Pages  
- [x] Daily `latest.json` refresh (Claude) + history snapshots  
- [x] GitHub Actions auto-deploy on `data/**` (and site) pushes  
- [x] Growth Board KPIs from GSC/GA4/Clarity/GitHub  
- [x] Intelligence Report page + scoped design  
- [x] SEO Ops + Internal Platform modules (Phase 1+ additive JSON slices)  
- [x] Team Tasks UI (by-person / board / list, modals, KPIs)  
- [x] Tasks + Team APIs with KV write-back  
- [x] Fixes / goals / activity / engagements APIs  
- [x] SEO-agents pack (52) + `publish-to-board` bridge  
- [x] Sticky site nav across pages  

### Deliberately constrained / not connected

- Phase 4 “not connected” shells stay flagged until real integrations exist  
- Clarity **MCP** disabled — use Clarity **worker HTTP** only  
- Tasks **not** synced to GitHub Issues (KV option chosen)  
- No Vercel deployment (legacy mentions in old comments only)  
- Daily job must **not** rewrite `tasks.json`  

---

## 10. Security & secrets (short)

| Secret | Where | Use |
|--------|-------|-----|
| `CLOUDFLARE_API_TOKEN` | Local `secrets/` + GitHub Actions secret | Deploy Pages |
| Optional zone id | Local secrets | Analytics only |
| Optional `BOARD_PUBLISH_TOKEN` | Pages env | Protect engagement POST |
| SEO-agents `.env` | Local only (gitignored) | SERP API keys |

Never commit `secrets/` or real `.env` files.

---

## 11. One-page “mental model”

```
MEASURE  →  Claude daily  →  latest.json  →  Growth Board / Ops
AUDIT    →  52 agents     →  audit/engage →  Platform #agents / Report
EXECUTE  →  Humans        →  /api/tasks   →  Team Tasks
SHIP     →  git push or npm run deploy:cf →  Cloudflare Pages
```

That’s the complete A→Z loop: **measure → understand → assign → ship → measure again**.

---

## 12. Quick commands

```bash
# Preview locally
npx serve .

# Deploy from this machine
npm run deploy:cf

# Publish agent findings to the live board APIs
cd SEO-agents-main
node tools/publish-to-board.mjs --from-audit ../data/audit.json --post
```

Claude daily: paste / keep `scripts/claude-scheduler-daily-refresh.txt` as the scheduled routine instructions.

---

*Generated for Rytsense Growth Board · repo `rytsensetech-growth-board` · hosting Cloudflare Pages.*

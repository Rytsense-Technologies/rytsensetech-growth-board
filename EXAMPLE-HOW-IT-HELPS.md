# Example: How Growth Board Helps (and How It Works)

A concrete walkthrough for **rytsensetech.com** — not abstract architecture.

---

## The problem (before)

SEO work was scattered:

- Numbers lived in GSC / GA4 / Clarity tabs
- Audit notes lived in chats and docs
- Devs didn’t know what to ship next
- Nobody saw “who owns what by Friday”

**Growth Board’s job:** one place to **see → decide → assign → check again tomorrow**.

---

## Example story (one week)

### Monday morning — Leadership opens the Growth Board

**URL:** https://rytsensetech-growth-board.pages.dev

Claude’s **daily refresh** already ran overnight:

1. Pulled GSC + GA4 + Clarity (worker) + GitHub
2. Wrote `data/latest.json`
3. Pushed to GitHub → Actions deployed Cloudflare Pages

On the board they see something like:

| Signal | What it means |
|--------|----------------|
| GSC clicks **1,107** (−29% vs prior 28d) | Organic is soft — dig in |
| GA4 sessions **4,021** | Traffic still moving |
| Clarity rage/dead clicks | UX friction on key pages |
| Open critical tasks tile | Work still not done |

**Help:** in 30 seconds they know *health*, not just “we should do SEO.”

---

### Monday 10:00 — SEO lead opens Intelligence Report + Platform

They open **`/report`** (audit narrative) and **`/platform`** (ops modules).

From live data they spot:

- **Quick wins:** queries in positions 4–15 with high impressions (near page 1)
- **Cannibalization:** same query hitting `/` and `/us/…`
- **Content gaps:** trust/security page missing, conflicting headcounts

**Help:** decisions are evidence-backed (GSC/GA4 slices), not gut feel.

---

### Monday 11:00 — Run the agent team (deep dive)

Lead opens `SEO-agents-main/` in Claude Code and runs:

```text
/seo-360
```

What happens:

1. **`seo-orchestrator`** triages and assigns specialists  
2. Technical agents check canonicals, schema, 404s  
3. Content / AEO agents check answer blocks, entity facts  
4. Findings land in `data/audit.json`  
5. Publish to the board:

```bash
cd SEO-agents-main
node tools/publish-to-board.mjs --from-audit ../data/audit.json --post
```

**Platform → Agents** now shows the last engagement. Activity feed updates.

**Help:** 52 specialists produce a structured audit without hiring a full agency for one pass — then results show up *on the same board* the team already uses.

---

### Monday afternoon — Turn findings into Team Tasks

Open **`/tasks`**.

Example cards already on the board:

| ID | Task | Owner | Team |
|----|------|-------|------|
| W1 | Fix canonical → www.rytsense.com | Srivishwa | Development |
| W4 | Publish entity facts block | Priya | Content |
| W10 | Align brand SERP (GBP / LinkedIn) | Ravi | Marketing |

Lead clicks **+ New task** for a new agent finding:

- Title: “Strip fabricated AggregateRating schema”
- Team: Development · Priority: P1 · Owner: Srivishwa · Due: Wed

Browser → `POST /api/tasks` → saved in **Cloudflare KV** (not wiped by tomorrow’s daily refresh).

**Help:** audit → ticket in one UI; Dev / Content / Marketing see *their* column in **By person** view.

---

### Tuesday–Wednesday — Execution

Srivishwa opens `/tasks` → **By person → Srivishwa**:

1. Sees “Broken canonical…” with **Due today**
2. Sets status → **in-progress** (writes KV via API)
3. Ships fix on the website
4. Sets status → **done**

Priya’s column shows content tasks; Ravi’s shows marketing.

KPIs at the top update: open count drops, complete % rises.

**Help:** no separate Jira required for this SEO programme — ownership and deadlines are visible to everyone with the URL.

---

### Thursday — Ops check

SEO specialist opens **`/ops`** or Platform modules:

- Keywords / pages / US vs global
- Still no CRM leads or Ahrefs DA → tiles say **Phase 4 · not connected** (honest empty state, not fake `0`)

**Help:** team trusts the numbers that *are* live; missing vendors are labeled clearly.

---

### Friday — Did we move the needle?

Next daily refresh updates `latest.json` again.

Leadership compares:

- Did clicks / impressions improve on fixed URLs?
- Did Clarity dead-clicks drop?
- Are critical tasks closed?

History files under `data/history/` keep a compact trail day by day.

**Help:** close the loop — **measure → fix → measure**.

---

## How the pieces fit (same story, one diagram)

```
Night: Claude refresh
   → latest.json → deploy Pages
        ↓
Morning: Leadership sees KPIs on Growth Board
        ↓
Deep dive: /seo-360 agents → audit → publish → Platform #agents
        ↓
Assign: /tasks (KV) → Dev / Content / Marketing columns
        ↓
Ship on website → mark done on board
        ↓
Next night: refresh again → prove impact
```

---

## What each person gets

| Person | Example win |
|--------|-------------|
| **CEO / lead** | One URL for “are we okay?” without logging into 5 tools |
| **SEO** | Quick wins + cannibalization + agent audit in one system |
| **Developer** | Clear tickets (W1, C2…) with due dates and status |
| **Content** | Entity / trust / FAQ work listed under their name |
| **Marketing** | Brand SERP / GBP tasks visible next to SEO work |
| **Claude (daily)** | Keeps metrics fresh without humans copy-pasting |
| **Claude (agents)** | Deep SEO/AEO work that *publishes back* to the board |

---

## What this project is *not* doing (on purpose)

| Thing | Why |
|-------|-----|
| Fake CRM / Ahrefs numbers | Phase 4 waits until you pick vendors |
| Clarity MCP | Broken — worker HTTP used instead |
| Overwriting `tasks.json` on daily run | Humans own execution state |
| Vercel | Live host is Cloudflare Pages |

---

## One-sentence pitch

**Growth Board turns “SEO is complicated” into a daily loop: live metrics on Pages, deep audits from agents, and human-owned tasks in KV — so Rytsense can see problems, assign owners, and prove fixes.**

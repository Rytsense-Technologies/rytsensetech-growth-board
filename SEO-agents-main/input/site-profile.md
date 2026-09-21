# Site Profile — Rytsense Technologies

> Fields marked **[verified]** were established by live recon on 2026-09-17.
> Fields marked **[NEEDS ANSWER]** block or materially change the work.

## 1. Identity
- **Site name:** Rytsense Technologies
- **Primary domain:** https://rytsensetech.com/ **[verified]**
- **Regional variant:** https://rytsensetech.com/us/ (en-US) **[verified]**
- **Business model:** B2B services — AI and custom software development agency **[verified via llms.txt]**
- **What they sell:** Production-grade agentic AI, generative AI, machine learning,
  computer vision, mobile apps, SaaS platforms, and DevOps for enterprises and
  startups **[verified via llms.txt]**
- **Founded:** 2016 **[verified]**
- **HQ:** Chennai, India. Offices: India, USA (California), UAE (Dubai), UK (London) **[verified]**

## 2. Market
- **Primary geography:** Global + USA (two indexed regional trees) **[verified]**
- **Languages / hreflang:** `en` (global), `en-US` (/us/), `x-default` → global.
  Reciprocal and correct on both homepages **[verified]**
- **Target audience:** [NEEDS ANSWER] — enterprise buyers? startup founders?
  Which job title signs the contract?
- **Average deal size:** [NEEDS ANSWER] — changes whether to chase volume or
  a handful of high-intent queries
- **Sales cycle:** [NEEDS ANSWER]

## 3. Competitors

**Client-named (2026-09-17):** appinventiv.com, leewayhertz.com, solulab.com
— supplied as a starting point, explicitly "could be more and different".

**Verified against 15 US commercial SERPs (top-10, serper, 2026-09-17):**

| Domain | SERPs | Avg pos | On client list? |
|---|---|---|---|
| effectivesoft.com | 6/15 | 2.2 | **No — missed** |
| masterofcode.com | 6/15 | 5.0 | **No — missed** |
| appinventiv.com | 5/15 | 4.4 | Yes |
| itransition.com | 5/15 | 2.0 | **No — missed** |
| leewayhertz.com | 4/15 | 4.0 | Yes |
| softteco.com | 3/15 | 2.7 | No |
| techaheadcorp.com | 3/15 | 5.7 | No |
| **rytsensetech.com** | **0/15** | — | — |
| solulab.com | 0/15 | — | Yes — but AEO-only |

**Two distinct competitor sets, barely overlapping:**
- **SERP + AEO (win both):** masterofcode.com, leewayhertz.com
- **SERP only:** effectivesoft.com, itransition.com, appinventiv.com, softteco.com
- **AEO only:** solulab.com, simform.com — cited by models, zero top-10 SERP presence

SERP competitors observed on 2026-09-17 (different per market):
- **"ai agent development services"** (US SERP): nerdery.com, n-ix.com,
  neurons-lab.com, deviniti.com, rishabhsoft.com, abstracta.us
- **"ai development company india"** (India SERP): aidevelopmentcompany.in,
  seesec.io, orangemantra.com, suntecindia.com — **but positions 2, 5 and 6 are
  listicles** (avixa.org, LinkedIn, designrush.com), not competitors
- **"custom ai development company usa"**: leewayhertz.com at #3

## 4. Current state **[verified]**
- **Indexed pages (sitemap count): ~683**
  - Global: 485 — 244 blog, 91 services, 87 main, 36 case studies, 27 industry
  - US: 198 — 118 blog, 31 case studies, 17 resources, 13 main, 12 services, 7 industry
- **Ranking for core commercial terms: 0 of 4 in top 20** (checked from US,
  2026-09-17: ai development company india / ai agent development services /
  custom ai development company usa / generative ai development services)
- **Monthly organic sessions:** [NEEDS ANSWER — requires GSC or GA4]
- **Monthly organic conversions:** [NEEDS ANSWER — requires GA4]

## 5. Tech stack **[verified]**
- **Framework:** Next.js (App Router — `/_next/` paths, RSC payload params in robots)
- **CMS:** Sanity likely (`/studio/` disallowed in robots)
- **Rendering: server-rendered.** Raw HTML contains full body content, real
  `<a href>` links (197 global / 156 US), one H1, JSON-LD, and hreflang — all
  present without JavaScript. **This site passes the biggest AEO trap.**
- **Can we edit code directly? NO.** Agents produce recommendations and dev
  tickets only. No repo writes.

## 6. Access available
- Google Search Console: **owner is authorising** — MCP present, OAuth pending.
  Re-run the data wave once live.
- Google Analytics 4: **available to the owner**, not yet connected to the team.
  Needs either an MCP connector or a manual export.
- Ahrefs / Semrush: present as MCP connectors, not authorized
- **Live SERP data: WORKING** — serper.dev configured and verified
- Server logs: [NEEDS ANSWER]
- Codebase: [NEEDS ANSWER]

## 7. Goals & constraints
- **Primary goal: QUALIFIED LEADS.** Judge everything on enquiries, not sessions.
- **Priority market: USA.** Focus the /us/ tree. Global tree is secondary;
  where the two conflict for the same English query, /us/ wins.
- **Money pages:** [NEEDS ANSWER] — which services actually sell?
- **Publishing capacity:** [NEEDS ANSWER] — 362 blog posts already exist; what
  is the sustainable monthly rate now?
- **Off-limits:** [NEEDS ANSWER]

## 8. AEO specifics **[verified — unusually strong starting point]**
- `/llms.txt` and `/llms-full.txt` present, well-structured, with company facts,
  service list, and an explicit AI content policy
- `/auth.md` published for agents
- `Content-Signal: ai-train=yes, search=yes, ai-input=yes`
- AI search and citation bots explicitly allowed: OAI-SearchBot, ChatGPT-User,
  PerplexityBot, PerplexityBot-User, anthropic-ai, Gemini-Deep-Research, YouBot
- Training crawlers deliberately not blocked
- **Assessment:** AI crawler access and entity self-description are already
  handled better than most sites the team will ever see. The open questions are
  whether it is *working* — citation share, and whether models describe the
  company accurately.
- **Named experts / authors with credentials:** [NEEDS ANSWER]
- **Original data or research to publish:** [NEEDS ANSWER]

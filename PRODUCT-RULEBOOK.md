# Growth Board product rule book

Reference for building and operating the multi-company product. The screens stay. The live store is Supabase. Express performs Google sync, Claude reviews, and the ask box. Rytsense Technologies is company one.

This file is the operating contract. If a later change conflicts with it, update this file in the same change.

## 1. Who may do what

### Superadmin

The platform owner. Not a member of a customer company unless they also hold a membership.

Allowed:

- Create a company, its first site, and its first admin invite
- Suspend or reactivate a company
- See the company list, last sync, and plan
- Open one company’s board for support (recorded in `audit_log`)
- See failed syncs across companies

Forbidden:

- Mark a customer task done
- Assign a task to a person inside a company
- Put a Google refresh token or the Anthropic key into a screen, a ticket, or a chat
- Bypass company scope without an `audit_log` row

### Client

A user with a membership on one organization.

Roles:

- **admin** — connect Google, invite teammates, manage sites, create and update tasks, use the ask box
- **seo** — create and update tasks, use SEO Work and the ask box, cannot disconnect Google or invite people
- **dev** — update task status and notes, read issues and reviews
- **viewer** — read dashboards, issues, and tasks; cannot create tasks, change status, connect Google, or use the ask box

A client never lists other companies, never reads another company’s metrics, and never receives another company’s token in an API response.

One login can belong to more than one company later. The active company is chosen explicitly. It is never guessed from the email domain.

## 2. Company isolation

Every business table has `organization_id`. Site-scoped tables also have `site_id`.

Express sets the company from the membership on the session. A request body cannot choose a different `organization_id`.

Superadmin routes live under `/api/admin` and use the service role only after the superadmin check. They write `audit_log`.

Row Level Security in Supabase is the backstop. The browser uses the anon key and the user JWT. The service role key exists only on the Express host.

Two-company test, required before a real second customer: company B’s user receives no Rytsense rows from overview, issues, tasks, or the ask box.

## 3. Data ownership

| Writer | May write | Must not write |
|---|---|---|
| Daily sync | `metric_daily`, `search_pages`, `search_queries`, connection `last_sync_at` | tasks, task status, reviews that a human edited |
| Weekly review | `issue_reviews`, `agent_runs` | task status, assignees |
| Ask box | `ask_threads`, `ask_messages` | task status, unless a human confirms Create task |
| Human | tasks, task status, notes, assignee | another company’s rows |

Automation may refresh metrics and suggestions. Humans own task status.

Create task is a human action. The model may propose the title and details. Express inserts the task only when the user confirms. The new task is Unassigned (`assignee` null) unless the user picks a member of their own company.

## 4. Sync rules

The daily job does not call a language model.

- Search Console window: last 28 full days ending yesterday, UTC
- Store one `metric_daily` row per site, per day, per source
- Replace `search_pages` and `search_queries` for that site and period. Do not append duplicates
- CTR is stored as a percent number, matching the current board (1.0 means 1%)
- If a source fails, set that connection or source status to `error` with a short note. Leave the previous good rows in place. Do not invent zeros
- A failed token surfaces Reconnect on that site only
- Sync does not deploy the website and does not commit JSON

Clarity is fetched from the existing worker URL. Google Analytics 4 and Search Console use the refresh token stored for that site.

## 5. Claude review rules

Weekly, about 40 to 60 pending issues per company site.

Order: 403, error, 404, fix, not-indexed, us-page, global-page. Prefer hub URLs (`/services/`, `/us/`, `/blog/`) and URLs that have impressions.

System prompt text comes from `SEO-agents-main/.claude/agents/`. Do not freestyle a specialist role.

Required output, valid JSON only: `why`, `fix`, `owner_team`, `effort`, `observed_status`. Express rejects anything else and records the run as failed for that issue without writing a fake review.

`observed_status` is the HTTP status Express fetched, or null. The model must not invent it. Express passes the status in. The model explains it.

Skip issues that already have a review for the current `url` and `action` this week.

Do not create tasks from this job.

## 6. Ask box rules

`POST /api/ask` requires a member who is not a viewer, plus a site in their company.

Tools Express may run, each filtered by organization and site:

- `search_metrics`
- `list_issues`
- `list_tasks`
- `page_detail`

Never send: refresh tokens, service role key, Anthropic key, another company’s rows, or the full table.

The model answers only from tool results. If the tool returns nothing, the answer says the data is missing.

A follow-up stays on the same `ask_thread` and the same site.

## 7. Secrets

| Secret | Where |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Express host only |
| `ANTHROPIC_API_KEY` | Express host only |
| Google client secret | Express host only |
| Google refresh token | Supabase Vault, referenced by `connections.vault_secret_id` |
| Supabase anon key | Browser, safe only because RLS is on |

Forbidden: secrets in git, in `latest.json`, in a normal Postgres column the client can select, or in a Claude Desktop transcript used as a store.

## 8. Environments and deploy

- **Local Express** talks to the Supabase project (or a branch) using a service role in `.env` (gitignored)
- **Production Express** uses the host’s secret store
- **Pages** serves the HTML. Set `window.GB_API_BASE` to the Express origin. Until that value is set, screens keep reading the deployed JSON so the current board stays up
- Deploy Pages only when HTML, CSS, or client scripts change
- A data sync never triggers a Pages deploy
- JSON files and Cloudflare KV stay until the matching screen has been checked against the API. Then that screen stops reading them. Do not delete the JSON files in git until the import has been re-run and the numbers match

## 9. Login

Supabase Auth is the only login. Superadmin is a row in `platform_admins` for that auth user. It is not a second password.

A new company is created by a superadmin: name, primary domain, admin email. The email receives an invite. Until they connect Google, the dashboard shows setup, not fake zeros.

Rytsense is the seeded organization. Its historical metrics come from one import of `data/latest.json`, `data/history/`, and `data/gsc-issues.json`.

## 10. Acceptance checks

### Week 1

- This file exists
- FigJam architecture shows people, Pages, Express jobs, Supabase, and Google, Anthropic, and Clarity

### Week 2

- Schema applied
- Rytsense organization and site exist
- A non-member JWT cannot select Rytsense metric rows

### Week 3

- Import is idempotent
- Overview totals match the imported `latest.json` clicks, impressions, and sessions

### Week 4

- `GET /api/health` returns ok
- Superadmin can create a second company
- A client token cannot call `/api/admin`

### Week 5

- Growth Board, Platform, and Ops render from the API when `GB_API_BASE` is set
- With `GB_API_BASE` unset, they still render from JSON

### Week 6

- SEO Work lists issues and reviews from Postgres
- Create task writes `tasks` and a `task_events` row
- The model path does not call that insert by itself

### Week 7

- OAuth callback stores a vault reference, not the raw token in `connections`
- One cron run upserts `metric_daily` without a git commit
- Local daily Claude schedule is turned off only after that run matches the board

### Week 8

- One weekly run writes at most 60 reviews
- Failed model output does not insert a review
- Local GSC review schedule is turned off only after that run

### Week 9

- Viewer receives 403 on `/api/ask`
- Ask tools refuse a site id from another company

### Week 10

- Suspended company cannot sign in to the product API
- Company B cannot read company A
- Sync error for one connection does not clear the other company’s rows
- Issue and task CSV export returns only the caller’s company

## 11. What this product will not do in v1

- CockroachDB or Cloud SQL as the application database
- Claude Desktop as the production runner
- Auto-assign tasks to Rama, Srivishwa, or any client user
- A rewrite of the visual design
- Billing (add when a plan field needs to charge)

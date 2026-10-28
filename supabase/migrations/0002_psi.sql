-- Page Speed Index (PSI) tracking
-- One psi_scores row per page per day (mobile + desktop), and one psi_issues row
-- per failing Lighthouse performance audit per strategy. Written by the server's
-- service-role client; read by members of the owning organization through RLS.

create table if not exists public.psi_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  page_url text not null,
  metric_date date not null,

  desktop_score int,        -- 0-100 Lighthouse performance score
  mobile_score int,
  lcp_desktop numeric,      -- Largest Contentful Paint, seconds
  lcp_mobile numeric,
  fcp_desktop numeric,      -- First Contentful Paint, seconds
  fcp_mobile numeric,
  cls_desktop numeric,      -- Cumulative Layout Shift
  cls_mobile numeric,
  ttfb_desktop numeric,     -- server response time, seconds
  ttfb_mobile numeric,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, site_id, page_url, metric_date)
);

create table if not exists public.psi_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  psi_score_id uuid not null references public.psi_scores (id) on delete cascade,
  strategy text not null check (strategy in ('mobile', 'desktop')),
  audit_id text not null,

  issue_type text not null,               -- 'opportunity' | 'diagnostic'
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  title text not null,
  description text,
  impact_score int,                        -- 0-100, higher = worse
  estimated_savings text,                  -- Lighthouse displayValue, e.g. "Potential savings of 1.2 s"
  category text not null default 'performance',

  -- tasks.id is text (e.g. "T-lx3k9a"), so this must be text too.
  task_id text references public.tasks (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),

  unique (psi_score_id, strategy, audit_id)
);

alter table public.psi_scores enable row level security;
alter table public.psi_issues enable row level security;

-- Read access mirrors every other product table (see 0001_product.sql).
-- No insert/update policies: only the service-role server writes these tables.
drop policy if exists psi_scores_read on public.psi_scores;
create policy psi_scores_read on public.psi_scores
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

drop policy if exists psi_issues_read on public.psi_issues;
create policy psi_issues_read on public.psi_issues
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create index if not exists idx_psi_scores_site_date on public.psi_scores (site_id, metric_date desc);
create index if not exists idx_psi_issues_site_severity on public.psi_issues (site_id, severity);
create index if not exists idx_psi_issues_task_id on public.psi_issues (task_id);

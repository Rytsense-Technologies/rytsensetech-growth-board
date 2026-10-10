-- Growth Board product schema. Apply in the Supabase SQL editor or via supabase db push.
-- Rytsense is organization one. Superadmin rows are inserted after the first Auth user exists.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'seo', 'dev', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  domain text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, domain)
);

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  provider text not null check (provider in ('gsc', 'ga4', 'clarity')),
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error')),
  external_property_id text,
  vault_secret_id uuid,
  last_sync_at timestamptz,
  last_error text,
  unique (site_id, provider)
);

create table if not exists public.metric_daily (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  day date not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb,
  unique (site_id, day, source)
);

create table if not exists public.site_snapshots (
  site_id uuid not null references public.sites (id) on delete cascade,
  kind text not null,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (site_id, kind)
);

create table if not exists public.search_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  period_start date,
  period_end date,
  page text not null,
  clicks numeric,
  impressions numeric,
  ctr numeric,
  position numeric
);

create table if not exists public.search_queries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  period_start date,
  period_end date,
  query text not null,
  clicks numeric,
  impressions numeric,
  ctr numeric,
  position numeric
);

create table if not exists public.issues (
  id text primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  category text,
  category_label text,
  url text,
  action text,
  note text,
  market text,
  priority text,
  status text not null default 'open',
  source text
);

create table if not exists public.issue_reviews (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references public.issues (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  why text,
  fix text,
  owner_team text,
  effort text,
  observed_status text,
  agents text[] default '{}',
  reviewed_at timestamptz not null default now()
);

create table if not exists public.recommendations (
  id text primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  kind text not null,
  document jsonb not null
);

create table if not exists public.tasks (
  id text primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  issue_id text references public.issues (id) on delete set null,
  title text not null,
  details text,
  status text not null default 'todo' check (status in ('todo', 'in-progress', 'blocked', 'done')),
  priority text,
  assignee text,
  team text,
  due_date date,
  source text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.tasks (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor text,
  from_status text,
  to_status text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  kind text not null,
  status text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ask_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ask_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ask_threads (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  organization_id uuid,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists metric_daily_site_day_idx on public.metric_daily (site_id, day);
create index if not exists issues_site_idx on public.issues (site_id, category);
create index if not exists tasks_org_idx on public.tasks (organization_id, status);

insert into public.organizations (id, name, slug, status)
values ('11111111-1111-4111-8111-111111111111', 'Rytsense', 'rytsense', 'active')
on conflict (id) do nothing;

insert into public.sites (id, organization_id, domain, name)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'rytsensetech.com',
  'Rytsense'
)
on conflict (id) do nothing;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

create or replace function public.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.members where user_id = auth.uid();
$$;

create or replace function public.store_connection_secret(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  sid uuid;
begin
  select vault.create_secret(p_secret, p_name, 'growth-board connection') into sid;
  return sid;
end;
$$;

revoke all on function public.store_connection_secret(text, text) from public, anon, authenticated;

create or replace function public.read_connection_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where id = p_id;
  return secret;
end;
$$;

revoke all on function public.read_connection_secret(uuid) from public, anon, authenticated;

alter table public.organizations enable row level security;
alter table public.platform_admins enable row level security;
alter table public.members enable row level security;
alter table public.sites enable row level security;
alter table public.connections enable row level security;
alter table public.metric_daily enable row level security;
alter table public.site_snapshots enable row level security;
alter table public.search_pages enable row level security;
alter table public.search_queries enable row level security;
alter table public.issues enable row level security;
alter table public.issue_reviews enable row level security;
alter table public.recommendations enable row level security;
alter table public.tasks enable row level security;
alter table public.task_events enable row level security;
alter table public.agent_runs enable row level security;
alter table public.ask_threads enable row level security;
alter table public.ask_messages enable row level security;
alter table public.audit_log enable row level security;

create policy platform_admins_self on public.platform_admins
  for select to authenticated
  using (user_id = auth.uid());

create policy organizations_read on public.organizations
  for select to authenticated
  using (id in (select public.my_org_ids()) or public.is_platform_admin());

create policy members_read on public.members
  for select to authenticated
  using (user_id = auth.uid() or organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy sites_read on public.sites
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy connections_read on public.connections
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy metric_daily_read on public.metric_daily
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy snapshots_read on public.site_snapshots
  for select to authenticated
  using (
    site_id in (select id from public.sites where organization_id in (select public.my_org_ids()))
    or public.is_platform_admin()
  );

create policy search_pages_read on public.search_pages
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy search_queries_read on public.search_queries
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy issues_read on public.issues
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy reviews_read on public.issue_reviews
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy recommendations_read on public.recommendations
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy tasks_read on public.tasks
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy task_events_read on public.task_events
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy agent_runs_read on public.agent_runs
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy ask_threads_read on public.ask_threads
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) and (user_id = auth.uid() or public.is_platform_admin()));

create policy ask_messages_read on public.ask_messages
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

create policy audit_log_admin on public.audit_log
  for select to authenticated
  using (public.is_platform_admin());

-- Client writes go through Express with the service role. Authenticated users do not insert directly.
grant select on all tables in schema public to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.my_org_ids() to authenticated;

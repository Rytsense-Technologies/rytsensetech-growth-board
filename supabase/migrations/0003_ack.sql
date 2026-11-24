-- Human "Addressed / live" claims + LLM verify outcomes.
-- Humans click; Express writes with the service role. Authenticated users read only.

create table if not exists public.acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  source_kind text not null check (source_kind in ('gsc_issue', 'psi_issue', 'audit_finding', 'fix', 'task')),
  source_id text not null,
  claim_snapshot jsonb not null default '{}'::jsonb,
  claimed_by text,
  claimed_at timestamptz not null default now(),
  verify_status text not null default 'pending'
    check (verify_status in ('pending', 'confirmed', 'failed')),
  verify_detail jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, site_id, source_kind, source_id)
);

create index if not exists acknowledgements_site_claimed_idx
  on public.acknowledgements (site_id, claimed_at desc);

create index if not exists acknowledgements_site_verify_idx
  on public.acknowledgements (site_id, verify_status);

alter table public.acknowledgements enable row level security;

drop policy if exists acknowledgements_read on public.acknowledgements;
create policy acknowledgements_read on public.acknowledgements
  for select to authenticated
  using (organization_id in (select public.my_org_ids()) or public.is_platform_admin());

grant select on public.acknowledgements to authenticated;

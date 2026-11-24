-- Expand Addressed checkbox to every board surface (KPI, keywords, cannibalization, etc.).

alter table public.acknowledgements
  drop constraint if exists acknowledgements_source_kind_check;

alter table public.acknowledgements
  add constraint acknowledgements_source_kind_check
  check (source_kind in (
    'gsc_issue',
    'psi_issue',
    'audit_finding',
    'fix',
    'task',
    'kpi',
    'keyword',
    'page',
    'channel',
    'cannibalization',
    'content_idea',
    'topic_trend',
    'internal_link',
    'clarity',
    'deploy',
    'ops',
    'board'
  ));

-- Reconnect Google OAuth must update an existing vault secret by name.
-- vault.create_secret alone fails on secrets_name_idx when gsc-<siteId> already exists.

create or replace function public.store_connection_secret(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  sid uuid;
begin
  select id into sid from vault.secrets where name = p_name limit 1;
  if sid is not null then
    perform vault.update_secret(sid, p_secret, p_name, 'growth-board connection');
    return sid;
  end if;
  select vault.create_secret(p_secret, p_name, 'growth-board connection') into sid;
  return sid;
end;
$$;

revoke all on function public.store_connection_secret(text, text) from public, anon, authenticated;

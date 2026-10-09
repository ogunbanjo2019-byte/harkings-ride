create table if not exists public.app_records (
  collection text not null,
  id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists app_records_collection_idx on public.app_records (collection);
alter table public.app_records enable row level security;
revoke all on public.app_records from anon, authenticated;

-- The current singleton API keeps an in-memory snapshot. This RPC makes each
-- complete snapshot replacement atomic so a failed request cannot leave a
-- partially emptied collection.
create or replace function public.replace_app_records_snapshot(p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  delete from public.app_records;
  insert into public.app_records (collection, id, data)
  select records.collection, records.id, records.data
  from jsonb_to_recordset(p_rows) as records(collection text, id text, data jsonb);
end;
$$;
revoke all on function public.replace_app_records_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.replace_app_records_snapshot(jsonb) to service_role;

-- Run this in Supabase Storage settings or SQL where storage schema permissions allow it.
insert into storage.buckets (id, name, public) 
values ('sensitive-documents', 'sensitive-documents', false) 
on conflict (id) do update set public = false;

-- The API uses the service-role key and is the only document access path.
drop policy if exists sensitive_documents_no_anon_read on storage.objects;
create policy sensitive_documents_no_anon_read on storage.objects for all to anon, authenticated using (false) with check (false);

-- Optional audit retention indexes when audit data is migrated out of JSONB.
create index if not exists app_records_audit_created_idx on public.app_records ((data->>'createdAt')) where collection = 'auditLogs';
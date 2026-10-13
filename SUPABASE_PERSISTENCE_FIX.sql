-- Harkingzride API persistence repair
-- Run in the Supabase SQL Editor for the same project used by Render.
-- This creates/repairs only the app_records storage table and atomic snapshot RPC.

create table if not exists public.app_records (
  collection text not null,
  id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists app_records_collection_idx
  on public.app_records (collection);

alter table public.app_records enable row level security;
revoke all on public.app_records from anon, authenticated;
grant select, insert, update, delete on public.app_records to service_role;

create or replace function public.replace_app_records_snapshot(p_rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  delete from public.app_records;

  insert into public.app_records (collection, id, data)
  select records.collection, records.id, records.data
  from jsonb_to_recordset(p_rows) as records(collection text, id text, data jsonb);
end;
$$;

revoke all on function public.replace_app_records_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_app_records_snapshot(jsonb)
  to service_role;

-- Ask Supabase/PostgREST to refresh its schema cache after creating the RPC.
notify pgrst, 'reload schema';

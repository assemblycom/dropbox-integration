-- Let anon receive private broadcasts, scoped to our two topics (payloads carry no secrets).
drop policy if exists "anon_receive_curated_broadcasts" on realtime.messages;
create policy "anon_receive_curated_broadcasts"
on realtime.messages
for select
to anon
using (
  realtime.topic() like 'channel_sync:%'
  or realtime.topic() like 'dropbox_connection:%'
);

-- Revoke all anon access to app tables.
REVOKE INSERT, UPDATE, DELETE, SELECT ON ALL TABLES IN SCHEMA public FROM anon;

-- Enable RLS on every public table.
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', r.tablename);
  end loop;
end $$;

-- channel_sync: broadcast a curated, secret-free payload (no dbx_cursor/account/root ids).
create or replace function public.broadcast_channel_sync_status()
returns trigger
language plpgsql
as $$
begin
  -- Skip no-op broadcasts (hot path writes dbx_cursor every page); emit only on UI-visible change.
  if (
    new.status, new.synced_files_count, new.total_files_count,
    new.last_synced_at, new.dbx_root_path, new.assembly_channel_id
  ) is distinct from (
    old.status, old.synced_files_count, old.total_files_count,
    old.last_synced_at, old.dbx_root_path, old.assembly_channel_id
  ) then
    perform realtime.send(
      jsonb_build_object(
        'id', new.id,
        'portal_id', new.portal_id,
        'assembly_channel_id', new.assembly_channel_id,
        'dbx_root_path', new.dbx_root_path,
        'status', new.status,
        'total_files_count', new.total_files_count,
        'synced_files_count', new.synced_files_count,
        'last_synced_at', new.last_synced_at
      ),
      'sync_update',                       -- event
      'channel_sync:' || new.portal_id,    -- topic (per-portal)
      true                                 -- private channel (anon RLS in supabase/snippets)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_broadcast_channel_sync_status on public.channel_sync;
create trigger trg_broadcast_channel_sync_status
after update on public.channel_sync
for each row
execute function public.broadcast_channel_sync_status();

-- dropbox_connections: broadcast status only (no refresh_token/account/namespace ids).
create or replace function public.broadcast_dropbox_connection_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    perform realtime.send(
      jsonb_build_object(
        'id', new.id,
        'portal_id', new.portal_id,
        'status', new.status
      ),
      'connection_update',
      'dropbox_connection:' || new.portal_id,
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_broadcast_dropbox_connection_status on public.dropbox_connections;
create trigger trg_broadcast_dropbox_connection_status
after update on public.dropbox_connections
for each row
execute function public.broadcast_dropbox_connection_status();

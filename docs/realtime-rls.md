# Realtime + RLS (OUT-3846)

How the frontend gets live status updates without ever reading our tables directly.

## The problem

The browser uses the Supabase **anon key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) only for
realtime updates — two of them:

- `useRealtimeSync` → sync progress for a channel
- `useRealtimeDropboxConnections` → Dropbox connection status

We can't just let anon read the `channel_sync` / `dropbox_connections` tables, because:

- Those tables hold **secrets** (`refresh_token`, `account_id`, `dbx_cursor`, etc.).
- The old `postgres_changes` realtime mode broadcasts the **whole row**, secrets included.
- There's no logged-in Supabase user, so RLS can't scope rows per-portal. Any anon
  policy is effectively "world readable".

## The approach: broadcast a curated payload from the database

Instead of exposing tables, the database **pushes a hand-picked, secret-free payload**
to the client over a private realtime channel.

```
table UPDATE  ─▶  trigger  ─▶  realtime.send(curated payload, ... , private=true)
                                        │
                                        ▼
                              realtime.messages   ──(private channel)──▶  browser (anon)
```

## What we changed

### 1. Lock down the tables — RLS on, anon revoked

Row Level Security is enabled on every app table, and **all access is revoked from anon**.
The browser can never read or write our tables directly. (Server-side sync code connects
as the `postgres` role, which has `BYPASSRLS`, so Trigger.dev jobs are unaffected.)

### 2. Trigger functions that broadcast curated payloads

Two `AFTER UPDATE` triggers build a small JSON payload with **only the safe columns the UI
needs** — no secrets — and call `realtime.send(payload, event, topic, private => true)`.

| Trigger | Topic | Event | Fires when |
|---|---|---|---|
| `broadcast_channel_sync_status` | `channel_sync:<portal_id>` | `sync_update` | a UI-visible column changes (cursor-only writes are ignored) |
| `broadcast_dropbox_connection_status` | `dropbox_connection:<portal_id>` | `connection_update` | `status` changes |

> The 4th arg to `realtime.send` is `private`. `true` = private channel.

### 3. Policy so anon can receive the broadcast

Private channels only deliver messages the role is allowed to read, enforced by RLS on
`realtime.messages`. We add a `SELECT` policy for `anon`, scoped to just our two topics:

```sql
create policy "anon_receive_curated_broadcasts"
on realtime.messages
for select
to anon
using (
  realtime.topic() like 'channel_sync:%'
  or realtime.topic() like 'dropbox_connection:%'
);
```

Manually run file `supabase/snippets/2026-06-12-rls_and_anon_policy_to_realtime.sql` to
enable RLS on all tables and create the policy.

No per-portal scoping is possible (anon has no JWT). That's fine here because the broadcast
payloads contain no secrets.

### 4. Client subscribes to the private channel

The channel name must equal the trigger's topic, and it must be marked private:

```ts
supabase.channel(topic, { config: { private: true } })
```

## Files

- `src/db/migrations/20260611081157_realtime_broadcast_triggers.sql` — triggers + trigger functions (Drizzle migration)
- `supabase/snippets/2026-06-12-rls_and_anon_policy_to_realtime.sql` — RLS enable, anon revoke, `realtime.messages` policy (run manually in the SQL editor)
- `src/lib/supabase/hooks/useRealtime.tsx` — generic private-channel subscriber
- `src/features/sync/hooks/useRealtimeSync.ts`
- `src/features/auth/hooks/useRealtimeDropboxConnetions.ts`

## Why it's safe

| Layer | Guarantee |
|---|---|
| RLS on + anon revoked | browser can't touch app tables |
| Curated payload | only non-secret columns ever leave the DB |
| Private channel + policy | anon receives only our two topics |
| `postgres` role `BYPASSRLS` | server sync jobs unaffected |

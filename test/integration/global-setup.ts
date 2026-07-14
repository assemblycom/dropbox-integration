import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import type { ProvidedContext } from 'vitest'

// Starts ONE Postgres container for the whole integration run, applies the real
// Drizzle migrations, and hands the connection string to the workers via
// `provide`/`inject`. Pinned to testcontainers v10: v12 pulls undici 8, which
// breaks on Node 20 (`markAsUncloneable is not a function`).
let container: StartedPostgreSqlContainer

type Provide = <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void

export default async function setup({ provide }: { provide: Provide }) {
  // 17 to match supabase/config.toml (major_version = 17).
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const databaseUrl = container.getConnectionUri()

  const migrationClient = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {
      /* silence trigger DROP ... NOTICE noise */
    },
  })
  try {
    await migrate(drizzle(migrationClient), {
      migrationsFolder: fileURLToPath(new URL('../../src/db/migrations', import.meta.url)),
    })
    // Vanilla Postgres lacks Supabase's `realtime` schema, but the broadcast
    // triggers (migration 20260611...) call `realtime.send(...)` on UPDATE of
    // channel_sync / dropbox_connections. Stub a no-op so those UPDATEs don't
    // throw `schema "realtime" does not exist` in tests. (Broadcast delivery
    // itself is out of scope for these integration tests.)
    await migrationClient`CREATE SCHEMA IF NOT EXISTS realtime`
    await migrationClient.unsafe(
      `CREATE OR REPLACE FUNCTION realtime.send(jsonb, text, text, boolean)
       RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$`,
    )
  } finally {
    await migrationClient.end()
  }

  provide('databaseUrl', databaseUrl)

  return async () => {
    await container.stop()
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}

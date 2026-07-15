import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, inject } from 'vitest'
import { server } from '../msw/server'
import { applyPlaceholderServerEnv } from '../support/placeholder-env'

// Runs in every worker BEFORE any test file imports `@/db`. Point the app's DB
// singleton (`src/db/index.ts` reads `env.DATABASE_URL` at import) at the
// container, and satisfy the rest of the server-env Zod schema with placeholders.
applyPlaceholderServerEnv()

// MSW fakes Dropbox + Copilot over HTTP. `error` mode flags any unmocked call;
// per-test overrides are cleared between tests.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// SAFETY: only ever run (and TRUNCATE) against a local Testcontainers DB. If the
// injected URL is anything but localhost, refuse to start — never touch a remote
// / production database.
const databaseUrl = inject('databaseUrl')
const dbHost = new URL(databaseUrl).hostname
if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
  throw new Error(
    `Integration tests refuse to run against non-local DB host "${dbHost}". ` +
      'Expected a Testcontainers localhost URL.',
  )
}
process.env.DATABASE_URL = databaseUrl

// Dedicated client for isolation — separate from the app singleton under test.
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  onnotice: () => {
    /* silence NOTICE noise */
  },
})

// Reset all app tables between tests. The drizzle bookkeeping table lives in the
// `drizzle` schema, so filtering to `public` leaves migrations intact.
beforeEach(async () => {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `
  if (tables.length > 0) {
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
    await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
  }
})

afterAll(async () => {
  await sql.end()
})

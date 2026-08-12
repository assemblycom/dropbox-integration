import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { dropboxConnectionSeeder } from '../seeders'
import { minutesAgo } from '../time'

const ACCOUNT = 'acc-debounce'

const readConnection = async () => {
  const [row] = await db
    .select()
    .from(dropboxConnections)
    .where(eq(dropboxConnections.accountId, ACCOUNT))
  return row
}

// Account-level webhook debounce (handleDropboxEvents): within the 5-min window we defer
// (mark pending, no trigger); older than the window we trigger a sync.
describe('webhook debounce', () => {
  it('defers (pendingWebhook=true, no sync) when synced within the 5-min window', async () => {
    await dropboxConnectionSeeder.create({
      accountId: ACCOUNT,
      pendingWebhook: false,
      lastWebhookSyncStartedAt: minutesAgo(4),
    })

    await new DropboxWebhook().handleDropboxEvents([ACCOUNT])

    const row = await readConnection()
    expect(row.pendingWebhook).toBe(true)
    expect(row.lastWebhookSyncedAt).toBeNull() // no sync ran
  })

  it('triggers a sync when the last sync is older than the window', async () => {
    // No channels seeded: fetchDropBoxChanges clears pending + stamps timestamps with no external calls.
    await dropboxConnectionSeeder.create({
      accountId: ACCOUNT,
      pendingWebhook: false,
      lastWebhookSyncStartedAt: minutesAgo(6),
    })

    await new DropboxWebhook().handleDropboxEvents([ACCOUNT])

    const row = await readConnection()
    expect(row.pendingWebhook).toBe(false)
    expect(row.lastWebhookSyncedAt).not.toBeNull()
  })
})

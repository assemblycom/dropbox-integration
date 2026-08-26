import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '@/db'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { processDropboxChanges } from '@/trigger/processFileSync'
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

afterEach(() => vi.restoreAllMocks())

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
    await dropboxConnectionSeeder.create({
      accountId: ACCOUNT,
      pendingWebhook: false,
      lastWebhookSyncStartedAt: minutesAgo(6),
    })
    // Isolate debounce timing from the pre-check (covered in dropbox-webhook-precheck):
    // assume the account has changes so the trigger path runs.
    vi.spyOn(DropboxWebhook.prototype, 'accountHasPendingChanges').mockResolvedValue(true)

    await new DropboxWebhook().handleDropboxEvents([ACCOUNT])

    const row = await readConnection()
    expect(row.pendingWebhook).toBe(false)
    expect(row.lastWebhookSyncedAt).not.toBeNull()
  })

  it('does nothing when the account has no active connection', async () => {
    // status:false → handleDropboxEvents' own status=true lookup misses → account skipped.
    await dropboxConnectionSeeder.create({
      accountId: ACCOUNT,
      status: false,
      pendingWebhook: false,
      lastWebhookSyncStartedAt: minutesAgo(6),
    })
    // Spy the trigger so we prove handleDropboxEvents itself never reached the sync branch,
    // independent of the redundant connection re-check inside fetchDropBoxChanges.
    const triggerSpy = vi
      .spyOn(processDropboxChanges, 'trigger')
      .mockResolvedValue(undefined as never)

    await new DropboxWebhook().handleDropboxEvents([ACCOUNT])

    expect(triggerSpy).not.toHaveBeenCalled()
    const row = await readConnection()
    expect(row.pendingWebhook).toBe(false) // untouched
    expect(row.lastWebhookSyncedAt).toBeNull() // no sync ran
  })

  it('skips when a webhook is already pending, even past the debounce window', async () => {
    // pendingWebhook already set + last sync older than the window: the pending guard wins,
    // so it neither defers again nor triggers a sync (the cron will pick it up).
    await dropboxConnectionSeeder.create({
      accountId: ACCOUNT,
      pendingWebhook: true,
      lastWebhookSyncStartedAt: minutesAgo(6),
    })

    await new DropboxWebhook().handleDropboxEvents([ACCOUNT])

    const row = await readConnection()
    expect(row.pendingWebhook).toBe(true) // unchanged
    expect(row.lastWebhookSyncedAt).toBeNull() // no sync triggered
  })
})

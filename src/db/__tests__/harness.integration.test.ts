import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'

// Smoke test for the Testcontainers harness (OUT-3985). Proves the plumbing:
// migrations applied, the app DB singleton reaches the container, the GENERATED
// column and partial unique index behave, and truncate isolates tests.

async function seedChannel() {
  const [row] = await db
    .insert(channelSync)
    .values({
      portalId: 'portal_1',
      dbxAccountId: 'acc_1',
      assemblyChannelId: 'ch_1',
      dbxRootPath: '/root',
    })
    .returning({ id: channelSync.id })
  return row.id
}

describe('integration harness', () => {
  it('applies migrations and reaches the container via the app db singleton', async () => {
    const channelSyncId = await seedChannel()
    expect(channelSyncId).toBeTypeOf('string')
  })

  it('populates the GENERATED item_path_lower column', async () => {
    const channelSyncId = await seedChannel()
    const [row] = await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
      .returning({ itemPathLower: fileFolderSync.itemPathLower })
    expect(row.itemPathLower).toBe('/foo/bar.pdf')
  })

  it('enforces the partial unique index on a second live row at the same path', async () => {
    const channelSyncId = await seedChannel()
    await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
    await expect(
      db
        .insert(fileFolderSync)
        .values({ portalId: 'portal_1', channelSyncId, itemPath: '/foo/bar.pdf' }),
    ).rejects.toThrow()
  })

  it('frees the path once the existing row is soft-deleted (partial predicate)', async () => {
    const channelSyncId = await seedChannel()
    const [first] = await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
      .returning({ id: fileFolderSync.id })
    await db
      .update(fileFolderSync)
      .set({ deletedAt: new Date() })
      .where(eq(fileFolderSync.id, first.id))

    const inserted = await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
      .returning({ id: fileFolderSync.id })
    expect(inserted).toHaveLength(1)
  })

  it('returns nothing from onConflictDoNothing when the live row already exists', async () => {
    const channelSyncId = await seedChannel()
    await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
    const result = await db
      .insert(fileFolderSync)
      .values({ portalId: 'portal_1', channelSyncId, itemPath: '/Foo/Bar.PDF' })
      .onConflictDoNothing()
      .returning({ id: fileFolderSync.id })
    expect(result).toEqual([])
  })

  it('allows UPDATEs that fire the realtime broadcast trigger (realtime.send stubbed)', async () => {
    const channelSyncId = await seedChannel()
    // channel_sync has an AFTER UPDATE trigger calling realtime.send(); without
    // the stub in global-setup this throws `schema "realtime" does not exist`.
    await db.update(channelSync).set({ status: true }).where(eq(channelSync.id, channelSyncId))
    const [row] = await db
      .select({ status: channelSync.status })
      .from(channelSync)
      .where(eq(channelSync.id, channelSyncId))
    expect(row.status).toBe(true)
  })

  // Two tests that would collide without truncate-between-tests isolation.
  it('isolation A: writes a channel row', async () => {
    await seedChannel()
    expect(await db.select().from(channelSync)).toHaveLength(1)
  })

  it('isolation B: starts from an empty table', async () => {
    expect(await db.select().from(channelSync)).toHaveLength(0)
  })
})

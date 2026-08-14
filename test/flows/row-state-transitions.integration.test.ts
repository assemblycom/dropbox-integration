import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType, PendingAction, PendingActionTarget } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type { WhereClause } from '@/features/sync/types'
import type User from '@/lib/copilot/models/User.model'
import { channelSeeder, fileSyncSeeder, pendingCreate, tombstone } from '../seeders'

// Direct-DB tests for the row state-transition helpers (markAttempt/markDeleted/
// markUpdated/markFailure), the channel cascade soft-delete transaction, and the
// soft-delete/portal guard difference between getAllFileMaps and getSingleFileMap
// (OUT-4044).

// Insert paths only read this.user.portalId, and no method here makes an HTTP call.
function makeService(portalId: string) {
  const user = { portalId, token: 'test-token' } as unknown as User
  const connectionToken = {
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: null,
  } as DropboxConnectionTokens
  return new MapFilesService(user, connectionToken)
}

async function seed() {
  const channel = await channelSeeder.create({ dbxRootPath: '/root' })
  return { channel, service: makeService(channel.portalId) }
}

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

describe('MapFilesService#markAttempt', () => {
  it('increments the attempt count and clears the last error when action + target are unchanged', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/a.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      pendingActionAttempts: 2,
      pendingActionLastError: 'boom',
    })

    const updated = await service.markAttempt(
      row.id,
      PendingAction.CREATE,
      PendingActionTarget.ASSEMBLY,
    )

    expect(updated.pendingActionAttempts).toBe(3)
    expect(updated.pendingActionLastError).toBeNull()
    expect(updated.pendingActionLastAttemptAt).not.toBeNull()
  })

  it('resets the attempt count to 1 when the target changes', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/b.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      pendingActionAttempts: 5,
    })

    const updated = await service.markAttempt(
      row.id,
      PendingAction.CREATE,
      PendingActionTarget.DROPBOX,
    )

    expect(updated.pendingActionAttempts).toBe(1)
    expect(updated.pendingActionTarget).toBe(PendingActionTarget.DROPBOX)
  })

  it('resets the attempt count to 1 when the action changes', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/b2.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      pendingActionAttempts: 5,
    })

    // Same target, different action: the CASE needs BOTH to match to increment.
    const updated = await service.markAttempt(
      row.id,
      PendingAction.DELETE,
      PendingActionTarget.ASSEMBLY,
    )

    expect(updated.pendingActionAttempts).toBe(1)
    expect(updated.pendingAction).toBe(PendingAction.DELETE)
  })

  it('throws when the row does not exist', async () => {
    const { service } = await seed()
    await expect(
      service.markAttempt(randomUUID(), PendingAction.CREATE, PendingActionTarget.ASSEMBLY),
    ).rejects.toThrow(/row not found/)
  })

  it('throws when the row belongs to another portal (portal guard)', async () => {
    const { channel } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/c.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
    })
    const foreignService = makeService('portal-other')

    await expect(
      foreignService.markAttempt(row.id, PendingAction.CREATE, PendingActionTarget.ASSEMBLY),
    ).rejects.toThrow(/row not found/)
  })
})

describe('MapFilesService#markDeleted', () => {
  it('soft-deletes the row and clears every pending field', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/d.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      pendingActionAttempts: 4,
      pendingActionLastError: 'boom',
    })

    await service.markDeleted(row.id)

    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.pendingAction).toBeNull()
    expect(after.pendingActionTarget).toBeNull()
    expect(after.pendingActionAttempts).toBe(0)
    expect(after.pendingActionLastAttemptAt).toBeNull()
    expect(after.pendingActionLastError).toBeNull()
  })

  it('throws when the row does not exist', async () => {
    const { service } = await seed()
    await expect(service.markDeleted(randomUUID())).rejects.toThrow(/row not found/)
  })

  it('throws and leaves the row live when it belongs to another portal (portal guard)', async () => {
    const { channel } = await seed()
    const row = await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/d2.txt' })
    const foreignService = makeService('portal-other')

    await expect(foreignService.markDeleted(row.id)).rejects.toThrow(/row not found/)
    expect((await rowById(row.id)).deletedAt).toBeNull() // guard blocked the soft-delete
  })
})

describe('MapFilesService#markUpdated', () => {
  it('applies the payload and clears pending fields without soft-deleting', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/e.txt',
      ...pendingCreate(PendingActionTarget.DROPBOX),
      pendingActionAttempts: 2,
      pendingActionLastError: 'boom',
    })
    const assemblyFileId = randomUUID()

    const updated = await service.markUpdated(row.id, { contentHash: 'hash-1', assemblyFileId })

    expect(updated.contentHash).toBe('hash-1')
    expect(updated.assemblyFileId).toBe(assemblyFileId)
    expect(updated.pendingAction).toBeNull()
    expect(updated.pendingActionTarget).toBeNull()
    expect(updated.pendingActionAttempts).toBe(0)
    expect(updated.pendingActionLastAttemptAt).toBeNull()
    expect(updated.pendingActionLastError).toBeNull()
    expect(updated.deletedAt).toBeNull() // markUpdated must never tombstone the row
  })

  it('throws when the row does not exist', async () => {
    const { service } = await seed()
    await expect(service.markUpdated(randomUUID(), { contentHash: 'x' })).rejects.toThrow(
      /row not found/,
    )
  })

  it('throws and leaves the row unchanged when it belongs to another portal (portal guard)', async () => {
    const { channel } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/e2.txt',
      contentHash: 'original',
    })
    const foreignService = makeService('portal-other')

    await expect(foreignService.markUpdated(row.id, { contentHash: 'hacked' })).rejects.toThrow(
      /row not found/,
    )
    expect((await rowById(row.id)).contentHash).toBe('original') // guard blocked the update
  })
})

describe('MapFilesService#markFailure', () => {
  it('records a truncated error and stamps the last-attempt time', async () => {
    const { channel, service } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/f.txt',
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      pendingActionLastAttemptAt: null,
    })

    await service.markFailure(row.id, 'x'.repeat(600))

    const after = await rowById(row.id)
    expect(after.pendingActionLastError).toHaveLength(500) // capped at MAX_ERROR_MESSAGE_LENGTH
    expect(after.pendingActionLastAttemptAt).not.toBeNull()
  })

  // The contrast with the mark* helpers above: markFailure has no row-found guard.
  it('does not throw when the row is missing', async () => {
    const { service } = await seed()
    await expect(service.markFailure(randomUUID(), 'boom')).resolves.toBeUndefined()
    expect(await db.select().from(fileFolderSync)).toHaveLength(0) // and creates nothing
  })
})

describe('MapFilesService#deleteChannelMapsByIds', () => {
  it('cascade soft-deletes the channel and its file rows, leaving other channels untouched', async () => {
    const { channel, service } = await seed()
    const rowA = await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/x.txt' })
    const rowB = await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/y.txt' })
    // A second channel on the same portal whose rows must survive the delete.
    const otherChannel = await channelSeeder.create({
      portalId: channel.portalId,
      dbxRootPath: '/other',
    })
    const otherRow = await fileSyncSeeder.create({
      channelSyncId: otherChannel.id,
      itemPath: '/other/z.txt',
    })

    await service.deleteChannelMapsByIds([channel.id])

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.deletedAt).not.toBeNull()
    expect(ch.status).toBe(false)
    expect((await rowById(rowA.id)).deletedAt).not.toBeNull()
    expect((await rowById(rowB.id)).deletedAt).not.toBeNull()

    const [survivor] = await db
      .select()
      .from(channelSync)
      .where(eq(channelSync.id, otherChannel.id))
    expect(survivor.deletedAt).toBeNull()
    expect((await rowById(otherRow.id)).deletedAt).toBeNull()
  })

  it('is a no-op for an empty id list', async () => {
    const { channel, service } = await seed()

    await service.deleteChannelMapsByIds([])

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.deletedAt).toBeNull()
  })
})

// No call sites to getSingleFileMap() function for now
describe('getAllFileMaps vs getSingleFileMap guards', () => {
  it('getAllFileMaps hides a soft-deleted row while getSingleFileMap returns it', async () => {
    const { channel, service } = await seed()
    const deleted = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/gone.txt',
      object: ObjectType.FILE,
      ...tombstone(),
    })

    const all = await service.getAllFileMaps(eq(fileFolderSync.id, deleted.id) as WhereClause)
    expect(all).toHaveLength(0) // getAllFileMaps filters deletedAt IS NULL

    const single = await service.getSingleFileMap(eq(fileFolderSync.id, deleted.id) as WhereClause)
    expect(single?.id).toBe(deleted.id) // getSingleFileMap has no soft-delete guard
  })

  it('getAllFileMaps enforces the portal guard while getSingleFileMap does not', async () => {
    const { channel } = await seed()
    const row = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/mine.txt',
    })
    const foreignService = makeService('portal-other')

    const all = await foreignService.getAllFileMaps(eq(fileFolderSync.id, row.id) as WhereClause)
    expect(all).toHaveLength(0) // portal guard excludes another portal's row

    const single = await foreignService.getSingleFileMap(
      eq(fileFolderSync.id, row.id) as WhereClause,
    )
    expect(single?.id).toBe(row.id) // getSingleFileMap has no portal guard
  })
})

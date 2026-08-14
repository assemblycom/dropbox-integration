import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type User from '@/lib/copilot/models/User.model'
import { channelSeeder, fileSyncSeeder } from '../seeders'

// deleteChannelMapsByIds takes ids directly; it must still enforce the portal
// boundary so a foreign id can never delete another workspace's data (OUT-4047).

// The service only reads this.user.portalId here; no method makes an HTTP call.
function makeService(portalId: string) {
  const user = { portalId, token: 'test-token' } as unknown as User
  const connectionToken = {
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: null,
  } as DropboxConnectionTokens
  return new MapFilesService(user, connectionToken)
}

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

const channelById = async (id: string) => {
  const [row] = await db.select().from(channelSync).where(eq(channelSync.id, id))
  return row
}

describe('MapFilesService#deleteChannelMapsByIds portal guard', () => {
  it('ignores a channel id owned by another portal', async () => {
    const foreignChannel = await channelSeeder.create({ dbxRootPath: '/foreign' })
    const foreignRow = await fileSyncSeeder.create({
      channelSyncId: foreignChannel.id,
      itemPath: '/foreign/a.txt',
    })
    const service = makeService('portal-other') // a different workspace

    await service.deleteChannelMapsByIds([foreignChannel.id])

    expect((await channelById(foreignChannel.id)).deletedAt).toBeNull() // guard blocked it
    expect((await rowById(foreignRow.id)).deletedAt).toBeNull()
  })

  it('still cascade soft-deletes the caller portal own channel and its rows', async () => {
    const channel = await channelSeeder.create({ dbxRootPath: '/root' })
    const row = await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/a.txt' })
    const service = makeService(channel.portalId)

    await service.deleteChannelMapsByIds([channel.id])

    const after = await channelById(channel.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.status).toBe(false)
    expect((await rowById(row.id)).deletedAt).not.toBeNull()
  })

  it('deletes only the caller portal ids in a mixed batch', async () => {
    const own = await channelSeeder.create({ dbxRootPath: '/root' })
    const ownRow = await fileSyncSeeder.create({ channelSyncId: own.id, itemPath: '/root/a.txt' })
    const foreign = await channelSeeder.create({ dbxRootPath: '/foreign' })
    const foreignRow = await fileSyncSeeder.create({
      channelSyncId: foreign.id,
      itemPath: '/foreign/a.txt',
    })
    const service = makeService(own.portalId)

    await service.deleteChannelMapsByIds([own.id, foreign.id])

    expect((await channelById(own.id)).deletedAt).not.toBeNull()
    expect((await rowById(ownRow.id)).deletedAt).not.toBeNull()
    expect((await channelById(foreign.id)).deletedAt).toBeNull() // foreign untouched
    expect((await rowById(foreignRow.id)).deletedAt).toBeNull()
  })
})

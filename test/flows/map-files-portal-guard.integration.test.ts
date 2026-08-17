import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type User from '@/lib/copilot/models/User.model'
import { channelSeeder, fileSyncSeeder } from '../seeders'

// deleteFileMap / updateChannelMapById / updateChannelMapSyncedFilesCount all
// mutate a row by id; each must enforce the portal boundary so a foreign id can
// never reach another workspace's data (OUT-4047, follow-up to #131).

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

describe('MapFilesService#deleteFileMap portal guard', () => {
  it('ignores a file row owned by another portal', async () => {
    const foreignRow = await fileSyncSeeder.create({ itemPath: '/foreign/a.txt' })
    const service = makeService('portal-other') // a different workspace

    await service.deleteFileMap(foreignRow.id)

    expect(await rowById(foreignRow.id)).toBeDefined() // guard blocked the delete
  })

  it('still hard-deletes the caller portal own row', async () => {
    const row = await fileSyncSeeder.create({ itemPath: '/root/a.txt' })
    const service = makeService(row.portalId)

    await service.deleteFileMap(row.id)

    expect(await rowById(row.id)).toBeUndefined()
  })
})

describe('MapFilesService#updateChannelMapById portal guard', () => {
  it('ignores a channel owned by another portal', async () => {
    const foreignChannel = await channelSeeder.create({ dbxRootPath: '/foreign' })
    const service = makeService('portal-other')

    await service.updateChannelMapById({ dbxRootPath: '/hijacked' }, foreignChannel.id)

    expect((await channelById(foreignChannel.id)).dbxRootPath).toBe('/foreign') // untouched
  })

  it('still updates the caller portal own channel', async () => {
    const channel = await channelSeeder.create({ dbxRootPath: '/root' })
    const service = makeService(channel.portalId)

    await service.updateChannelMapById({ dbxRootPath: '/renamed' }, channel.id)

    expect((await channelById(channel.id)).dbxRootPath).toBe('/renamed')
  })
})

describe('MapFilesService#updateChannelMapSyncedFilesCount portal guard', () => {
  it('ignores a channel owned by another portal', async () => {
    const foreignChannel = await channelSeeder.create({ dbxRootPath: '/foreign' })
    const before = (await channelById(foreignChannel.id)).syncedFilesCount
    const service = makeService('portal-other')

    await service.updateChannelMapSyncedFilesCount(foreignChannel.id)

    expect((await channelById(foreignChannel.id)).syncedFilesCount).toBe(before) // untouched
  })

  it('still increments the caller portal own channel', async () => {
    const channel = await channelSeeder.create({ dbxRootPath: '/root' })
    const before = channel.syncedFilesCount
    const service = makeService(channel.portalId)

    await service.updateChannelMapSyncedFilesCount(channel.id)

    expect((await channelById(channel.id)).syncedFilesCount).toBe(before + 1)
  })
})

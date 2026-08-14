import { eq } from 'drizzle-orm'
import { HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { ResyncService } from '@/features/workers/resync-failed-files/lib/resync-failed-files.service'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { resyncFailedFilesAndMasterSync } from '@/trigger/processFileSync'
import { mockCopilot } from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder } from '../seeders'

// Direct-DB tests for the channel-map mismatch guard, the stale channel-map bulk
// soft-delete in listFormattedChannelMap (Copilot faked via MSW), and the
// remaining resyncFailedFilesForChannel guards (OUT-4045).

// MapFilesService only reads this.user.portalId / this.user.token here; the token
// makes this.copilot hit MSW. No Dropbox HTTP call is made.
function makeMapService(portalId: string) {
  const user = { portalId, token: 'test-token' } as unknown as User
  const connectionToken = {
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: null,
  } as DropboxConnectionTokens
  return new MapFilesService(user, connectionToken)
}

const channelById = async (id: string) => {
  const [row] = await db.select().from(channelSync).where(eq(channelSync.id, id))
  return row
}

const fileById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

afterEach(() => vi.restoreAllMocks())

describe('MapFilesService#getOrCreateChannelMap', () => {
  it('throws 400 when an existing channel matches one key but the other differs', async () => {
    const channel = await channelSeeder.create({ assemblyChannelId: 'ch-A', dbxRootPath: '/rootA' })
    const service = makeMapService(channel.portalId)

    // Same assemblyChannelId, different dbxRootPath: the OR-match finds the row,
    // then the fields disagree → conflict.
    await expect(
      service.getOrCreateChannelMap({
        dbxAccountId: channel.dbxAccountId,
        assemblyChannelId: 'ch-A',
        dbxRootPath: '/rootB',
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('returns the existing channel when both keys match', async () => {
    const channel = await channelSeeder.create({ assemblyChannelId: 'ch-A', dbxRootPath: '/rootA' })
    const service = makeMapService(channel.portalId)

    const result = await service.getOrCreateChannelMap({
      dbxAccountId: channel.dbxAccountId,
      assemblyChannelId: 'ch-A',
      dbxRootPath: '/rootA',
    })

    expect(result.id).toBe(channel.id)
  })
})

describe('MapFilesService#listFormattedChannelMap', () => {
  it('bulk soft-deletes channel maps whose Assembly file channel no longer exists', async () => {
    const connection = await dropboxConnectionSeeder.create()
    const live = await channelSeeder.create({
      portalId: connection.portalId,
      assemblyChannelId: 'ch-live',
      dbxRootPath: '/live',
    })
    const stale = await channelSeeder.create({
      portalId: connection.portalId,
      assemblyChannelId: 'ch-stale',
      dbxRootPath: '/stale',
    })
    const staleFile = await fileSyncSeeder.create({
      channelSyncId: stale.id,
      itemPath: '/stale/a.txt',
    })
    const liveFile = await fileSyncSeeder.create({
      channelSyncId: live.id,
      itemPath: '/live/a.txt',
    })
    const service = makeMapService(connection.portalId)

    // Copilot only knows about ch-live; ch-stale is gone → its map row is stale.
    mockCopilot('/v1/channels/files', () =>
      HttpResponse.json({
        data: [{ id: 'ch-live', membershipType: 'company', companyId: 'comp-1', memberIds: null }],
      }),
    )
    mockCopilot('/v1/companies', () =>
      HttpResponse.json({
        data: [
          {
            id: 'comp-1',
            name: 'Co',
            iconImageUrl: null,
            isPlaceholder: false,
            createdAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      }),
    )

    const result = await service.listFormattedChannelMap()

    // Only the live channel is returned...
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(live.id)

    // ...and the stale one is soft-deleted and deactivated.
    const staleRow = await channelById(stale.id)
    expect(staleRow.deletedAt).not.toBeNull()
    expect(staleRow.status).toBe(false)
    expect((await fileById(staleFile.id)).deletedAt).not.toBeNull() // file rows cascade too

    // The live channel and its rows are untouched.
    const liveRow = await channelById(live.id)
    expect(liveRow.deletedAt).toBeNull()
    expect((await fileById(liveFile.id)).deletedAt).toBeNull()
  })
})

// The 404 (unknown channel) and 409 (already resyncing) guards are covered by the
// resync-sweep suite; these are the remaining paths.
describe('ResyncService#resyncFailedFilesForChannel guards', () => {
  it('throws 404 when the portal has no active Dropbox connection', async () => {
    // The only connection for this portal is inactive, so the status=true lookup misses.
    const connection = await dropboxConnectionSeeder.create({ status: false })
    const channel = await channelSeeder.create({ portalId: connection.portalId })
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)

    // Assert the message too so this can't silently start exercising the other
    // 404 guard (channel-not-found) after a seeder-default or guard-order change.
    await expect(
      new ResyncService().resyncFailedFilesForChannel(channel.id, user),
    ).rejects.toMatchObject({ status: 404, message: 'Dropbox connection not found' })
  })

  it('clears resyncingAt and rethrows when the trigger fails', async () => {
    const connection = await dropboxConnectionSeeder.create()
    const channel = await channelSeeder.create({ portalId: connection.portalId })
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    // Assert inside the trigger that resyncingAt was already set, so this proves the
    // full set-then-clear cycle — not just that it happens to be null at both ends.
    vi.spyOn(resyncFailedFilesAndMasterSync, 'trigger').mockImplementation(async () => {
      expect((await channelById(channel.id)).resyncingAt).not.toBeNull()
      throw new Error('trigger boom')
    })

    await expect(new ResyncService().resyncFailedFilesForChannel(channel.id, user)).rejects.toThrow(
      'trigger boom',
    )

    // The catch block must clear the in-progress flag so the channel isn't stuck.
    expect((await channelById(channel.id)).resyncingAt).toBeNull()
  })
})

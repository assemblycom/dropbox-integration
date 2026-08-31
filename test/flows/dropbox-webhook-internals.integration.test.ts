import { eq } from 'drizzle-orm'
import { DropboxResponseError } from 'dropbox'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { getDropboxChanges } from '@/features/webhook/dropbox/utils/getDropboxChanges'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import { handleChannelFileChanges } from '@/trigger/processFileSync'
import { dropboxDeletedFactory, dropboxEntryFactory } from '../factories'
import {
  DROPBOX_RPC_HOST,
  mockDropboxLatestCursor,
  paginateDropboxListFolder,
  server,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, synced } from '../seeders'

const CONNECTION_TOKEN = { refreshToken: 'rt', accountId: 'acc', rootNamespaceId: 'ns' }

async function seed() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: 'acc',
    rootNamespaceId: 'ns',
    refreshToken: 'rt',
  })
  const user = new User('test-token', { workspaceId: connection.portalId } as Token)
  const mapFilesService = new MapFilesService(user, CONNECTION_TOKEN)
  const dbxClient = new DropboxClient('rt', 'ns').getDropboxClient()
  return { connection, user, mapFilesService, dbxClient }
}

const channelById = async (id: string) => {
  const [row] = await db.select().from(channelSync).where(eq(channelSync.id, id))
  return row
}

afterEach(() => vi.restoreAllMocks())

// handleDbxRootPathMove decides whether the delta cycle can proceed, and recovers
// the root path when Dropbox reports it moved. The metadata call is wrapped in a
// long-backoff withRetry, so we inject the outcome at the getDropboxFileMetadata seam.
describe('handleDbxRootPathMove', () => {
  it('recovers the root path when the folder was moved, then skips the cycle', async () => {
    const { connection, mapFilesService, dbxClient } = await seed()
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxRootId: 'id:root',
      dbxCursor: 'cursor:old',
    })
    const webhook = new DropboxWebhook()
    const metaSpy = vi.spyOn(webhook, 'getDropboxFileMetadata')
    // 1st (by current path) → 409 gone; 2nd (by stored dbxRootId) → the new location.
    metaSpy.mockRejectedValueOnce(
      new DropboxResponseError(409, {} as never, { error_summary: 'path/not_found/..' } as never),
    )
    metaSpy.mockResolvedValueOnce({ result: { path_display: '/moved-root' } } as never)
    mockDropboxLatestCursor('cursor:new')

    const proceed = await webhook.handleDbxRootPathMove(channel, mapFilesService, dbxClient)

    expect(proceed).toBe(false) // skip this cycle after recovery
    const after = await channelById(channel.id)
    expect(after.dbxRootPath).toBe('/moved-root')
    expect(after.dbxCursor).toBe('cursor:new')
  })

  it('rethrows a non-409 error and leaves the channel map untouched', async () => {
    const { connection, mapFilesService, dbxClient } = await seed()
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxRootId: 'id:root',
      dbxCursor: 'cursor:old',
    })
    const webhook = new DropboxWebhook()
    vi.spyOn(webhook, 'getDropboxFileMetadata').mockRejectedValueOnce(new Error('network down'))

    await expect(
      webhook.handleDbxRootPathMove(channel, mapFilesService, dbxClient),
    ).rejects.toThrow('network down')

    const after = await channelById(channel.id)
    expect(after.dbxRootPath).toBe('/root') // unchanged
    expect(after.dbxCursor).toBe('cursor:old')
  })

  it('fails safely when the moved root has no saved id, leaving the channel map untouched', async () => {
    const { connection, mapFilesService, dbxClient } = await seed()
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxRootId: null, // nothing to recover the new location from
      dbxCursor: 'cursor:old',
    })
    const webhook = new DropboxWebhook()
    // Current path is gone (409); with no saved root id, recovery can't proceed.
    vi.spyOn(webhook, 'getDropboxFileMetadata').mockRejectedValueOnce(
      new DropboxResponseError(409, {} as never, { error_summary: 'path/not_found/..' } as never),
    )

    // Specifically the missing-root-id guard (not just any throw): the second
    // metadata lookup must never be reached with a null id.
    await expect(
      webhook.handleDbxRootPathMove(channel, mapFilesService, dbxClient),
    ).rejects.toThrow(/expected string, received null/i)

    const after = await channelById(channel.id)
    expect(after.dbxRootPath).toBe('/root') // unchanged
    expect(after.dbxCursor).toBe('cursor:old') // cursor not advanced or cleared
  })
})

// The full webhook change-sync path per account. The cursor must be established on
// the first run and must never move forward unless the changes were applied.
describe('fetchDropBoxChanges cursor safety', () => {
  const fakeAuthFor = (portalId: string) =>
    vi
      .spyOn(User, 'authenticate')
      .mockResolvedValue(new User('test-token', { workspaceId: portalId } as Token))

  // Root exists → the delta cycle proceeds (skip the long-backoff metadata call).
  const stubRootExists = (webhook: DropboxWebhook) =>
    vi
      .spyOn(webhook, 'getDropboxFileMetadata')
      .mockResolvedValue({ result: { path_display: '/root' } } as never)

  it('sets a starting cursor on the first sync when the channel has none', async () => {
    const { connection } = await seed()
    fakeAuthFor(connection.portalId)
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxRootId: 'id:root',
      dbxCursor: null, // first sync, no cursor yet
    })
    const webhook = new DropboxWebhook()
    stubRootExists(webhook)
    // Record that the first-sync baseline (get_latest_cursor) actually ran. Its
    // cursor value 'cursor:99' is distinct from what an empty-cursor sync would
    // produce ('cursor:0'), so the saved cursor below fails if the baseline is skipped.
    let baselined = false
    server.use(
      http.post(`${DROPBOX_RPC_HOST}/2/files/list_folder/get_latest_cursor`, () => {
        baselined = true
        return HttpResponse.json({ cursor: 'cursor:99' })
      }),
    )
    server.use(...paginateDropboxListFolder([])) // no changes since the baseline

    await webhook.fetchDropBoxChanges(connection.accountId as string)

    expect(baselined).toBe(true) // baselined instead of syncing from an empty cursor
    const after = await channelById(channel.id)
    expect(after.dbxCursor).toBe('cursor:99') // the baseline cursor was saved
    expect(after.lastSyncedAt).not.toBeNull()
  })

  it('does not advance the cursor when applying the changes fails', async () => {
    const { connection } = await seed()
    fakeAuthFor(connection.portalId)
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxRootId: 'id:root',
      dbxCursor: 'cursor:0', // already has a cursor
    })
    const webhook = new DropboxWebhook()
    stubRootExists(webhook)
    // One change is waiting under the root.
    server.use(
      ...paginateDropboxListFolder([
        dropboxEntryFactory.build({
          id: 'dbx:new',
          name: 'new.txt',
          path_display: '/root/new.txt',
        }),
      ]),
    )
    // Applying the change fails.
    vi.spyOn(handleChannelFileChanges, 'triggerAndWait').mockRejectedValue(
      new Error('apply failed'),
    )

    await expect(webhook.fetchDropBoxChanges(connection.accountId as string)).rejects.toThrow(
      'apply failed',
    )

    const after = await channelById(channel.id)
    expect(after.dbxCursor).toBe('cursor:0') // NOT advanced — the changes get retried
    expect(after.lastSyncedAt).toBeNull() // sync never marked complete
  })
})

// getDropboxChanges resolves deleted entries to their mapped dbxFileId, drops the
// unresolvable ones, validates the payload, and scopes results to the root path.
describe('getDropboxChanges', () => {
  async function seedChannel() {
    const { connection, mapFilesService, dbxClient } = await seed()
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
    })
    return { channel, mapFilesService, dbxClient }
  }

  it('drops a deleted entry that has no mapped row', async () => {
    const { channel, mapFilesService, dbxClient } = await seedChannel()
    server.use(
      ...paginateDropboxListFolder([
        dropboxDeletedFactory.build({
          id: 'x',
          name: 'ghost.txt',
          path_display: '/root/ghost.txt',
        }),
      ]),
    )

    const result = await getDropboxChanges(
      'cursor:0',
      '/root',
      dbxClient,
      mapFilesService,
      channel.id,
    )

    expect(result.entries).toEqual([])
  })

  it('drops a deleted entry whose mapped row has no dbxFileId', async () => {
    const { channel, mapFilesService, dbxClient } = await seedChannel()
    await fileSyncSeeder.create({
      ...synced(), // assemblyFileId set, but no dbxFileId
      channelSyncId: channel.id,
      itemPath: '/orphan.txt',
      object: ObjectType.FILE,
    })
    server.use(
      ...paginateDropboxListFolder([
        dropboxDeletedFactory.build({
          id: 'y',
          name: 'orphan.txt',
          path_display: '/root/orphan.txt',
        }),
      ]),
    )

    const result = await getDropboxChanges(
      'cursor:0',
      '/root',
      dbxClient,
      mapFilesService,
      channel.id,
    )

    expect(result.entries).toEqual([])
  })

  it('throws when an entry fails schema validation', async () => {
    const { channel, mapFilesService, dbxClient } = await seedChannel()
    // Missing id + name → DropboxFileListFolderResultEntriesSchema.safeParse fails.
    server.use(...paginateDropboxListFolder([{ '.tag': 'file', path_display: '/root/bad.txt' }]))

    await expect(
      getDropboxChanges('cursor:0', '/root', dbxClient, mapFilesService, channel.id),
    ).rejects.toThrow('Invalid Dropbox entries format')
  })

  it('keeps only entries under the root path and ignores the rest', async () => {
    const { channel, mapFilesService, dbxClient } = await seedChannel()
    server.use(
      ...paginateDropboxListFolder([
        dropboxEntryFactory.build({ id: 'a', name: 'a.txt', path_display: '/root/a.txt' }),
        dropboxEntryFactory.build({ id: 'b', name: 'b.txt', path_display: '/other/b.txt' }),
        dropboxEntryFactory.build({ id: 'c', name: 'c.txt', path_display: '/ROOT/c.txt' }),
      ]),
    )

    const result = await getDropboxChanges(
      'cursor:0',
      '/root',
      dbxClient,
      mapFilesService,
      channel.id,
    )

    const paths = result.entries.map((e) => e.path_display)
    expect(paths).toContain('/root/a.txt')
    expect(paths).toContain('/ROOT/c.txt') // case-insensitive prefix
    expect(paths).not.toContain('/other/b.txt')
  })
})

// fetchDropBoxChanges bails out before doing any work if the connection can't be used.
describe('fetchDropBoxChanges guards', () => {
  it('returns early when the account has no active connection', async () => {
    // No connection seeded — a stray Dropbox/Copilot call would trip onUnhandledRequest:'error'.
    await expect(new DropboxWebhook().fetchDropBoxChanges('ghost-account')).resolves.toBeUndefined()
  })

  it('returns early when the connection has no refresh token', async () => {
    await dropboxConnectionSeeder.create({ accountId: 'acc-no-rt', refreshToken: null })

    await new DropboxWebhook().fetchDropBoxChanges('acc-no-rt')

    const [row] = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.accountId, 'acc-no-rt'))
    expect(row.lastWebhookSyncedAt).toBeNull() // bailed before the end-of-sync stamp
  })
})

import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/webhook/assembly/route'
import db from '@/db'
import { ObjectType, PendingActionTarget } from '@/db/constants'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { copilotDownloadableFactory, copilotFileFactory } from '../factories'
import { mockAssemblyFileDownload, mockDropboxGetMetadata, mockDropboxUpload } from '../msw'
import {
  channelSeeder,
  dropboxConnectionSeeder,
  fileSyncSeeder,
  pendingCreate,
  synced,
  tombstone,
} from '../seeders'
import { mockSleepInstant } from '../time'

// Controller sleeps 800ms (always) + 5000ms (only on the create path); keep instant.
vi.mock('@/utils/sleep')

// Fake Copilot auth (SDK-internal token decode, not MSW-interceptable) so the controller
// resolves the seeded workspace.
const fakeAuthFor = (portalId: string) =>
  vi
    .spyOn(User, 'authenticate')
    .mockResolvedValue(new User('test-token', { workspaceId: portalId } as Token))

const post = (eventType: string, data: unknown) =>
  POST(
    new NextRequest('https://x/api/webhook/assembly?token=test-token', {
      method: 'POST',
      body: JSON.stringify({ eventType, data }),
    }),
    undefined,
  )

async function seedActive() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: 'acc-ctl',
    rootNamespaceId: 'ns-ctl',
    refreshToken: 'rt-ctl',
  })
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: '/root',
  })
  fakeAuthFor(connection.portalId)
  return { channel }
}

const rowsFor = (channelId: string) =>
  db.select().from(fileFolderSync).where(eq(fileFolderSync.channelSyncId, channelId))

afterEach(() => vi.restoreAllMocks())

// The webhook controller decides whether an Assembly change should be synced to Dropbox.
describe('Assembly webhook: deciding whether to sync to Dropbox', () => {
  it('ignores a "created" event for a file we are still uploading to Assembly (our own change coming back)', async () => {
    const { channel } = await seedActive()
    await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY), // our own Dropbox→Assembly create, still in flight
      channelSyncId: channel.id,
      itemPath: '/echo.txt',
      dbxFileId: 'dbx:echo',
      object: ObjectType.FILE,
    })
    const sleepSpy = mockSleepInstant()
    const data = copilotFileFactory.build({
      channelId: channel.assemblyChannelId,
      path: 'echo.txt',
    })

    const res = await post('file.created', data)

    expect(res.status).toBe(200)
    const rows = await rowsFor(channel.id)
    expect(rows).toHaveLength(1) // only the in-flight pending row; no sync happened
    expect(rows[0].assemblyFileId).toBeNull()
    expect(sleepSpy).not.toHaveBeenCalledWith(5000) // create path never entered
  })

  it('uploads a newly created Assembly file to Dropbox', async () => {
    const { channel } = await seedActive()
    const sleepSpy = mockSleepInstant()
    mockDropboxGetMetadata({})
    mockDropboxUpload()
    mockAssemblyFileDownload()
    const data = copilotDownloadableFactory.build({
      channelId: channel.assemblyChannelId,
      path: 'new.txt',
    })

    const res = await post('file.created', data)

    expect(res.status).toBe(200)
    const [row] = await rowsFor(channel.id)
    expect(row).toMatchObject({ itemPath: '/new.txt', assemblyFileId: data.id, deletedAt: null })
    expect(row.dbxFileId).toBeTruthy()
    expect(sleepSpy).toHaveBeenCalledWith(5000)
  })

  it('still uploads a new file even when a different file is mid-upload', async () => {
    const { channel } = await seedActive()
    await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/other.txt', // in flight, but NOT this event's path
      dbxFileId: 'dbx:other',
      object: ObjectType.FILE,
    })
    const sleepSpy = mockSleepInstant()
    mockDropboxGetMetadata({})
    mockDropboxUpload()
    mockAssemblyFileDownload()
    const data = copilotDownloadableFactory.build({
      channelId: channel.assemblyChannelId,
      path: 'fresh.txt',
    })

    const res = await post('file.created', data)

    expect(res.status).toBe(200)
    const created = (await rowsFor(channel.id)).find((r) => r.itemPath === '/fresh.txt')
    expect(created?.assemblyFileId).toBe(data.id) // dedup scoped by path — did not match /other.txt
    expect(sleepSpy).toHaveBeenCalledWith(5000)
  })

  it('ignores event types it does not handle', async () => {
    const { channel } = await seedActive()
    mockSleepInstant()
    const data = copilotFileFactory.build({ channelId: channel.assemblyChannelId, path: 'x.txt' })

    const res = await post('link.created', data)

    expect(await res.json()).toEqual({})
    expect(await rowsFor(channel.id)).toHaveLength(0)
  })

  it('ignores objects that are not files or folders (e.g. links)', async () => {
    const { channel } = await seedActive()
    mockSleepInstant()
    // valid event type, but object is not file/folder → validateHandleableEvent drops it
    const data = copilotFileFactory.build({
      channelId: channel.assemblyChannelId,
      path: 'x.txt',
      object: 'link' as ObjectType,
    })

    const res = await post('file.created', data)

    expect(await res.json()).toEqual({})
    expect(await rowsFor(channel.id)).toHaveLength(0)
  })

  it('does not delete again when the file was already deleted', async () => {
    const { channel } = await seedActive()
    mockSleepInstant()
    const row = await fileSyncSeeder.create({
      ...synced(),
      ...tombstone(),
      channelSyncId: channel.id,
      itemPath: '/dead.txt',
      dbxFileId: 'dbx:dead',
      object: ObjectType.FILE,
    })
    const data = copilotFileFactory.build({
      id: row.assemblyFileId as string,
      channelId: channel.assemblyChannelId,
      path: 'dead.txt',
    })

    // No delete_v2 mock registered — a stray delete would trip onUnhandledRequest:'error'.
    const res = await post('file.deleted', data)

    expect(res.status).toBe(200)
    const [after] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, row.id))
    expect(after.deletedAt).toEqual(row.deletedAt) // untouched
    expect(after.updatedAt).toStrictEqual(row.updatedAt) // row was not written at all
  })

  it('ignores an update event that carries no actual changes', async () => {
    const { channel } = await seedActive()
    mockSleepInstant()
    const row = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/u.txt',
      dbxFileId: 'dbx:u',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    // Plain factory: no previousAttributes → controller skips (Copilot's own upload echo).
    const data = copilotFileFactory.build({
      id: row.assemblyFileId as string,
      channelId: channel.assemblyChannelId,
      path: 'u.txt',
    })

    const res = await post('file.updated', data)

    expect(res.status).toBe(200)
    const [after] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, row.id))
    expect(after.deletedAt).toBeNull()
    expect(after.dbxFileId).toBe('dbx:u')
    expect(after.updatedAt).toStrictEqual(row.updatedAt)
  })

  it('does nothing when syncing is turned off for the workspace', async () => {
    const connection = await dropboxConnectionSeeder.create({ status: false })
    fakeAuthFor(connection.portalId)
    mockSleepInstant()
    const data = copilotFileFactory.build({ path: 'x.txt' })

    const res = await post('file.created', data)

    expect(await res.json()).toEqual({})
  })

  it('returns 404 when the connection has no Dropbox account', async () => {
    const connection = await dropboxConnectionSeeder.create({ accountId: null })
    fakeAuthFor(connection.portalId)
    mockSleepInstant()
    const data = copilotFileFactory.build({ path: 'x.txt' })

    const res = await post('file.created', data)

    expect(res.status).toBe(404)
  })
})

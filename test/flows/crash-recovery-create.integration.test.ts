import { eq } from 'drizzle-orm'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '@/db'
import { ObjectType, PendingActionTarget } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { SyncService } from '@/features/sync/lib/Sync.service'
import { retryFailedSyncsForPortal } from '@/features/workers/resync-failed-files/helper/resync-failed-files.helper'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { copilotDownloadableFactory, copilotFileFactory, dropboxEntryFactory } from '../factories'
import {
  dropboxFileMetadata,
  mockAssemblyFileDownload,
  mockCopilotCreateFile,
  mockCopilotDeleteFile,
  mockCopilotRetrieveFile,
  mockDropboxDownload,
  mockDropboxGetMetadata,
  mockDropboxMove,
  mockDropboxUpload,
  server,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, pendingCreate } from '../seeders'
import { hoursAgo } from '../time'

// Drive the real file-create path, crash it between two DB steps (a spied step
// throws once), then run the sweeper and check the half-created file is
// recovered — not lost, not duplicated, count correct.

const CONN = { accountId: 'acc-crash', rootNamespaceId: 'ns-crash', refreshToken: 'rt-crash' }

async function seed() {
  const connection = await dropboxConnectionSeeder.create(CONN)
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: '/root',
  })
  const user = new User('test-token', { workspaceId: connection.portalId } as Token)
  const svc = new SyncService(user, CONN)
  return { connection, channel, svc }
}

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

const countOf = async (channelId: string) => {
  const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channelId))
  return ch.syncedFilesCount
}

// Throw once on the given step so the create dies right there.
const crashAt = (step: 'markUpdated') =>
  vi.spyOn(MapFilesService.prototype, step).mockImplementationOnce(() => {
    throw new Error(`crash: before ${step}`)
  })

const dbxEntry = () =>
  dropboxEntryFactory.build({
    id: 'dbx:f',
    name: 'f.txt',
    path_display: '/root/f.txt',
    content_hash: 'h',
  })

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// Dropbox -> Assembly steps: create file -> save id -> upload -> mark done -> count++
// ---------------------------------------------------------------------------
describe('crash recovery: Dropbox -> Assembly create', () => {
  const seedPendingRow = (channelId: string) =>
    fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channelId,
      itemPath: '/f.txt',
      dbxFileId: 'dbx:f',
      object: ObjectType.FILE,
    })

  const drive = (
    svc: SyncService,
    channel: { id: string; assemblyChannelId: string },
    rowId: string,
  ) =>
    svc.completePendingAssemblyCreate({
      pendingRowId: rowId,
      assemblyChannelId: channel.assemblyChannelId,
      channelSyncId: channel.id,
      entry: dbxEntry(),
      assemblyCreatePath: '/f.txt',
    })

  // Crash after the id is saved but before the file is uploaded.
  it('recovers a half-created file whose upload never finished', async () => {
    const { connection, channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/f.txt',
      dbxFileId: 'dbx:f',
      object: ObjectType.FILE,
      createdAt: hoursAgo(13), // past the 12h stuck-pending threshold by sweep time
    })

    // The crash is mid-upload (a spy can't reach it), so fail the upload — it
    // throws after the id is already saved.
    const uploadUrl = 'https://upload.example/put'
    mockCopilotCreateFile({ uploadUrl })
    mockDropboxDownload({ '/root/f.txt': 'bytes' })
    server.use(http.put(uploadUrl, () => new HttpResponse(null, { status: 500 })))

    await expect(drive(svc, channel, row.id)).rejects.toThrow()

    const crashed = await rowById(row.id)
    const savedId = crashed.assemblyFileId
    expect(savedId).toBeTruthy() // id saved before the failed upload
    expect(crashed.assemblyPath).toBeNull() // never marked done
    expect(crashed.pendingAction).toBe('create')

    // Sweep: the file is still pending and the row is stale → delete + recreate.
    mockDropboxGetMetadata({
      'dbx:f': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:f' }),
    })
    mockCopilotRetrieveFile({
      [savedId as string]: copilotFileFactory.build({
        id: savedId as string,
        status: 'pending',
      }),
    })
    const { deletedIds } = mockCopilotDeleteFile()
    mockCopilotCreateFile() // fresh, succeeding create for the recreate
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(deletedIds).toEqual([savedId]) // stale half-created file removed
    expect(after.assemblyFileId).toBeTruthy()
    expect(after.assemblyFileId).not.toBe(savedId) // recreated fresh
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)
  })

  // Crash after the upload but before the record is marked done.
  it('recovers a file that uploaded but was never marked done', async () => {
    const { connection, channel, svc } = await seed()
    const row = await seedPendingRow(channel.id)

    crashAt('markUpdated')
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await expect(drive(svc, channel, row.id)).rejects.toThrow('crash')

    const crashed = await rowById(row.id)
    const savedId = crashed.assemblyFileId
    expect(savedId).toBeTruthy()
    expect(crashed.assemblyPath).toBeNull() // never marked done
    expect(crashed.pendingAction).toBe('create')

    // Sweep: the saved file is already completed, so recovery just marks it done.
    mockDropboxGetMetadata({
      'dbx:f': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:f' }),
    })
    mockCopilotRetrieveFile({
      [savedId as string]: copilotFileFactory.build({
        id: savedId as string,
        status: 'completed',
        path: '/f.txt',
      }),
    })

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBe(savedId) // same file reused — no duplicate
    expect(after.assemblyPath).toBe('/f.txt')
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Assembly -> Dropbox steps: create + upload -> mark done -> count++
// ---------------------------------------------------------------------------
describe('crash recovery: Assembly -> Dropbox create', () => {
  const seedPendingRow = (channelId: string, assemblyFileId: string) =>
    fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.DROPBOX),
      channelSyncId: channelId,
      itemPath: '/f.txt',
      assemblyFileId,
      object: ObjectType.FILE,
    })

  const drive = (
    svc: SyncService,
    channelId: string,
    rowId: string,
    assemblyFile: { id: string },
  ) =>
    svc.completePendingDropboxCreate({
      pendingRowId: rowId,
      channelSyncId: channelId,
      dbxRootPath: '/root',
      file: { ...assemblyFile, object: ObjectType.FILE, path: 'f.txt' } as never,
    })

  // Crash after the Dropbox upload but before the record is marked done.
  it('recovers a Dropbox file created but never marked done', async () => {
    const { connection, channel, svc } = await seed()
    const assemblyFile = copilotDownloadableFactory.build() // completed, has downloadUrl
    const row = await seedPendingRow(channel.id, assemblyFile.id)

    crashAt('markUpdated')
    mockDropboxGetMetadata({}) // path is free on the first create
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await expect(drive(svc, channel.id, row.id, assemblyFile)).rejects.toThrow('crash')

    const crashed = await rowById(row.id)
    expect(crashed.dbxFileId).toBeNull() // id never saved
    expect(crashed.pendingAction).toBe('create')

    // Sweep: the upload already landed, so the file now sits at the path; recovery
    // re-creates over it and saves the record.
    mockCopilotRetrieveFile({ [assemblyFile.id]: assemblyFile })
    mockDropboxGetMetadata({
      '/root/f.txt': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:existing' }),
    })
    mockDropboxMove()
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(after.dbxFileId).toBeTruthy() // recovered, not lost
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)
  })
})

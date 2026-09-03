import { randomUUID } from 'node:crypto'
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
import { ResyncService } from '@/features/workers/resync-failed-files/lib/resync-failed-files.service'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { copilotDownloadableFactory, copilotFileFactory, dropboxEntryFactory } from '../factories'
import {
  dropboxFileMetadata,
  mockAssemblyFileDownload,
  mockCopilot,
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
// throws once), then run the sweeper and check recovery. Cases tagged KNOWN GAP
// pin current behaviour that isn't fully correct yet (see app-gaps.md).

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

// Throw once on the given MapFilesService step so the create dies right there.
const crashAt = (step: 'updateFileMap' | 'markUpdated' | 'updateChannelMapSyncedFilesCount') =>
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

// Assembly renames a duplicate path (/f.txt -> /f (1).txt) instead of rejecting,
// and the new file starts pending. Returns the paths it handed back, in order.
const mockAssemblyCreateRenamingDuplicates = (uploadUrl: string) => {
  const createdPaths: string[] = []
  mockCopilot(
    '/v1/files/:fileType',
    async ({ request, params }) => {
      const { path, channelID } = (await request.json()) as { path: string; channelID: string }
      const fileType = params.fileType as string
      let finalPath = path
      let n = 0
      while (createdPaths.includes(finalPath)) {
        n += 1
        finalPath = path.replace(/(\.[^.]+)?$/, ` (${n})$1`)
      }
      createdPaths.push(finalPath)
      return HttpResponse.json({
        id: randomUUID(),
        channelId: channelID,
        name: finalPath.slice(finalPath.lastIndexOf('/') + 1),
        object: fileType,
        path: finalPath,
        ...(fileType === 'file' ? { uploadUrl } : {}),
      })
    },
    'post',
  )
  server.use(http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })))
  return { createdPaths }
}

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

  // Crash after the file is created in Assembly, before its id is saved.
  it('crashes before saving the id: recovery makes a second renamed file and orphans the first (KNOWN GAP)', async () => {
    const { connection, channel, svc } = await seed()
    const row = await seedPendingRow(channel.id)

    const { createdPaths } = mockAssemblyCreateRenamingDuplicates('https://upload.example/put-a1')
    crashAt('updateFileMap')
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await expect(drive(svc, channel, row.id)).rejects.toThrow('crash')

    const crashed = await rowById(row.id)
    expect(crashed.assemblyFileId).toBeNull() // id never saved
    expect(crashed.pendingAction).toBe('create')

    // Sweep: no id → recreate. The orphan still holds /f.txt, so Assembly renames
    // this one to /f (1).txt.
    mockDropboxGetMetadata({
      'dbx:f': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:f' }),
    })
    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBeTruthy() // file recovered, not lost
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1) // count correct

    // KNOWN GAP: two files exist — the first orphaned at /f.txt, and the recovered
    // one Assembly renamed to /f (1).txt, now mismatched from the Dropbox path.
    expect(createdPaths).toEqual(['/f.txt', '/f (1).txt'])
    expect(after.assemblyPath).toBe('/f (1).txt')
  })

  // Crash after the id is saved, before the file is uploaded.
  it('crashes before upload: an abandoned stamped row is reclaimed and fully recovered', async () => {
    const { connection, channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/f.txt',
      dbxFileId: 'dbx:f',
      object: ObjectType.FILE,
      createdAt: hoursAgo(13), // past the 12h stuck-pending threshold by sweep time
    })

    // Crash is mid-upload (a spy can't reach it), so fail the upload PUT — it
    // throws after the id is already stamped.
    const uploadUrl = 'https://upload.example/put'
    mockCopilotCreateFile({ uploadUrl })
    mockDropboxDownload({ '/root/f.txt': 'bytes' })
    server.use(http.put(uploadUrl, () => new HttpResponse(null, { status: 500 })))

    await expect(drive(svc, channel, row.id)).rejects.toThrow()

    const crashed = await rowById(row.id)
    const stampedId = crashed.assemblyFileId
    expect(stampedId).toBeTruthy() // id stamped before the failed upload
    expect(crashed.assemblyPath).toBeNull() // never marked done
    expect(crashed.pendingAction).toBe('create')

    // Sweep: stamped file is still `pending` and the row is stale → delete + recreate.
    mockDropboxGetMetadata({
      'dbx:f': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:f' }),
    })
    mockCopilotRetrieveFile({
      [stampedId as string]: copilotFileFactory.build({
        id: stampedId as string,
        status: 'pending',
      }),
    })
    const { deletedIds } = mockCopilotDeleteFile()
    mockCopilotCreateFile() // fresh, succeeding create for the recreate
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(deletedIds).toEqual([stampedId]) // stale half-created file removed
    expect(after.assemblyFileId).toBeTruthy()
    expect(after.assemblyFileId).not.toBe(stampedId) // recreated fresh
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)
  })

  // Crash after the upload, before the record is marked done. Cleanest recovery.
  it('crashes before markUpdated: sweeper reconciles the already-completed file', async () => {
    const { connection, channel, svc } = await seed()
    const row = await seedPendingRow(channel.id)

    crashAt('markUpdated')
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await expect(drive(svc, channel, row.id)).rejects.toThrow('crash')

    const crashed = await rowById(row.id)
    const stampedId = crashed.assemblyFileId
    expect(stampedId).toBeTruthy()
    expect(crashed.assemblyPath).toBeNull() // never marked done
    expect(crashed.pendingAction).toBe('create')

    // Sweep: the saved file is already completed, so recovery just marks it done.
    mockDropboxGetMetadata({
      'dbx:f': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:f' }),
    })
    mockCopilotRetrieveFile({
      [stampedId as string]: copilotFileFactory.build({
        id: stampedId as string,
        status: 'completed',
        path: '/f.txt',
      }),
    })

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBe(stampedId) // same file reused — no duplicate
    expect(after.assemblyPath).toBe('/f.txt')
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)
  })

  // Crash after the record is marked done, before the count bump.
  it('crashes before the count bump: file is synced but the count under-counts (KNOWN GAP)', async () => {
    const { channel, svc } = await seed()
    const row = await seedPendingRow(channel.id)

    crashAt('updateChannelMapSyncedFilesCount')
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/f.txt': 'bytes' })

    await expect(drive(svc, channel, row.id)).rejects.toThrow('crash')

    // The row is fully healthy: created, uploaded, marked updated.
    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBeTruthy()
    expect(after.assemblyPath).toBe('/f.txt')
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()

    // KNOWN GAP: count never bumped and the sweeper skips non-pending rows.
    expect(await countOf(channel.id)).toBe(0)
    const ids = (await new ResyncService().findFailedSyncs()).map((r) => r.id)
    expect(ids).not.toContain(row.id)
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

  // Crash after the Dropbox upload, before the record is marked done.
  it('crashes before markUpdated: recovery renames the existing file, leaving a duplicate (KNOWN GAP)', async () => {
    const { connection, channel, svc } = await seed()
    const assemblyFile = copilotDownloadableFactory.build() // completed, has downloadUrl
    const row = await seedPendingRow(channel.id, assemblyFile.id)

    crashAt('markUpdated')
    mockDropboxGetMetadata({}) // /root/f.txt not there yet → create
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await expect(drive(svc, channel.id, row.id, assemblyFile)).rejects.toThrow('crash')

    const crashed = await rowById(row.id)
    expect(crashed.dbxFileId).toBeNull() // id never stamped
    expect(crashed.pendingAction).toBe('create')

    // Sweep: the file now sits at the path, so the recreate renames it and re-uploads.
    mockCopilotRetrieveFile({ [assemblyFile.id]: assemblyFile })
    mockDropboxGetMetadata({
      '/root/f.txt': dropboxFileMetadata({ path_display: '/root/f.txt', id: 'dbx:existing' }),
    })
    const movedFrom: string[] = []
    mockDropboxMove((from) => {
      movedFrom.push(from)
      return dropboxFileMetadata({ path_display: `${from}.moved` })
    })
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await retryFailedSyncsForPortal(connection.portalId, [await rowById(row.id)])

    const after = await rowById(row.id)
    expect(after.dbxFileId).toBeTruthy() // recovered, not lost
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    expect(await countOf(channel.id)).toBe(1)

    // KNOWN GAP: the crashed file was renamed aside → a leftover duplicate.
    expect(movedFrom).toEqual(['/root/f.txt'])
  })

  // Crash after the record is marked done, before the count bump.
  it('crashes before the count bump: file is synced but the count under-counts (KNOWN GAP)', async () => {
    const { channel, svc } = await seed()
    const assemblyFile = copilotDownloadableFactory.build()
    const row = await seedPendingRow(channel.id, assemblyFile.id)

    crashAt('updateChannelMapSyncedFilesCount')
    mockDropboxGetMetadata({})
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await expect(drive(svc, channel.id, row.id, assemblyFile)).rejects.toThrow('crash')

    // Healthy row: Dropbox file created + stamped, pending cleared.
    const after = await rowById(row.id)
    expect(after.dbxFileId).toBeTruthy()
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()

    // KNOWN GAP: count never bumped, and the sweeper won't pick up a non-pending row.
    expect(await countOf(channel.id)).toBe(0)
    const ids = (await new ResyncService().findFailedSyncs()).map((r) => r.id)
    expect(ids).not.toContain(row.id)
  })
})

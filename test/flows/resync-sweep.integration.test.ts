import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '@/db'
import { ObjectType, PendingActionTarget } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { retryFailedSyncsForPortal } from '@/features/workers/resync-failed-files/helper/resync-failed-files.helper'
import { ResyncService } from '@/features/workers/resync-failed-files/lib/resync-failed-files.service'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { resyncFailedFilesAndMasterSync } from '@/trigger/processFileSync'
import { copilotDownloadableFactory, copilotFileFactory } from '../factories'
import {
  copilotError,
  dropboxFileMetadata,
  mockAssemblyFileDownload,
  mockCopilot,
  mockCopilotCreateFile,
  mockCopilotDeleteFile,
  mockCopilotRetrieveFile,
  mockDropboxDeleteFile,
  mockDropboxDownload,
  mockDropboxGetMetadata,
  mockDropboxUpload,
} from '../msw'
import {
  channelSeeder,
  dropboxConnectionSeeder,
  fileSyncSeeder,
  pendingCreate,
  pendingDelete,
  synced,
  tombstone,
} from '../seeders'
import { hoursAgo, minutesAgo } from '../time'

async function seed() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: 'acc-rs',
    rootNamespaceId: 'ns-rs',
    refreshToken: 'rt-rs',
  })
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: '/root',
  })
  return { connection, channel }
}

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

afterEach(() => vi.restoreAllMocks())

// The resync sweep retries failed pending rows and reconciles them.
describe('resync sweep', () => {
  it('selects rows past their backoff and skips too-recent / capped / deleted ones', async () => {
    const { channel } = await seed()
    const base = {
      channelSyncId: channel.id,
      object: ObjectType.FILE,
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
    }
    const ready = await fileSyncSeeder.create({
      ...base,
      itemPath: '/ready.txt',
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    const noLastAttempt = await fileSyncSeeder.create({
      ...base,
      itemPath: '/null.txt',
      pendingActionLastAttemptAt: null,
    })
    const tooRecent = await fileSyncSeeder.create({
      ...base,
      itemPath: '/recent.txt',
      pendingActionLastAttemptAt: minutesAgo(4),
    })
    const capped = await fileSyncSeeder.create({
      ...base,
      itemPath: '/capped.txt',
      pendingActionAttempts: 10,
      pendingActionLastAttemptAt: minutesAgo(120),
    })
    const deleted = await fileSyncSeeder.create({
      ...base,
      ...tombstone(),
      itemPath: '/deleted.txt',
      pendingActionLastAttemptAt: minutesAgo(120),
    })

    const ids = (await new ResyncService().findFailedSyncs()).map((r) => r.id)

    expect(ids).toContain(ready.id)
    expect(ids).toContain(noLastAttempt.id)
    expect(ids).not.toContain(tooRecent.id)
    expect(ids).not.toContain(capped.id)
    expect(ids).not.toContain(deleted.id)
  })

  it('retries a failed Dropbox delete and soft-deletes the row', async () => {
    const { connection, channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    const { deletedPaths } = mockDropboxDeleteFile()

    await retryFailedSyncsForPortal(connection.portalId, [row])

    expect(deletedPaths).toEqual(['/root/gone.txt']) // dbxRootPath + itemPath
    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.pendingAction).toBeNull()
  })

  it('retries a failed Assembly delete and soft-deletes the row', async () => {
    const { connection, channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...synced(), // gives an assemblyFileId
      ...pendingDelete(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    const { deletedIds } = mockCopilotDeleteFile()

    await retryFailedSyncsForPortal(connection.portalId, [row])

    expect(deletedIds).toEqual([row.assemblyFileId])
    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.pendingAction).toBeNull()
  })

  it('retries a failed Dropbox create by re-uploading and clearing the tombstone', async () => {
    const { connection, channel } = await seed()
    const assemblyFile = copilotDownloadableFactory.build() // not pending, has a downloadUrl
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/doc.txt',
      assemblyFileId: assemblyFile.id,
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    mockCopilotRetrieveFile({ [assemblyFile.id]: assemblyFile })
    mockDropboxGetMetadata({}) // /root/doc.txt not found → upload
    mockDropboxUpload()
    mockAssemblyFileDownload() // the Assembly file body fetched from its downloadUrl

    await retryFailedSyncsForPortal(connection.portalId, [row])

    const after = await rowById(row.id)
    expect(after.dbxFileId).toBe('id:dbx:/root/doc.txt') // freshly re-uploaded at the row's path
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
  })

  it('reconciles a stuck create whose Assembly file already completed', async () => {
    const { connection, channel } = await seed()
    const assemblyFile = copilotFileFactory.build({ status: 'completed', path: '/recon.txt' })
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/recon.txt',
      dbxFileId: 'dbx:recon',
      assemblyFileId: assemblyFile.id,
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    // getFileFromDropbox looks up by dbxFileId used as the metadata path.
    mockDropboxGetMetadata({
      'dbx:recon': dropboxFileMetadata({ path_display: '/root/recon.txt' }),
    })
    mockCopilotRetrieveFile({ [assemblyFile.id]: assemblyFile })

    await retryFailedSyncsForPortal(connection.portalId, [row])

    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBe(assemblyFile.id)
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.syncedFilesCount).toBe(1)
  })

  it('rejects a manual channel resync for an unknown channel with 404', async () => {
    const { connection } = await seed()
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    await expect(
      new ResyncService().resyncFailedFilesForChannel('00000000-0000-4000-8000-000000000000', user),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('rejects a manual channel resync already in progress with 409', async () => {
    const connection = await dropboxConnectionSeeder.create({ accountId: 'acc-rs2' })
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      resyncingAt: new Date(),
    })
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    await expect(
      new ResyncService().resyncFailedFilesForChannel(channel.id, user),
    ).rejects.toMatchObject({ status: 409 })
  })

  // The created Assembly file is still "pending" and the row is only 11h old (under the 12h
  // cut-off), so resync assumes a slow in-progress upload: retry later, no delete/recreate.
  it('leaves a recently-stuck Assembly upload alone and retries it later', async () => {
    const { connection, channel } = await seed()
    const assemblyFile = copilotFileFactory.build({ status: 'pending', path: '/young.txt' })
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/young.txt',
      dbxFileId: 'dbx:young',
      assemblyFileId: assemblyFile.id,
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
      createdAt: hoursAgo(11), // younger than the 12h threshold
    })
    mockDropboxGetMetadata({
      'dbx:young': dropboxFileMetadata({ path_display: '/root/young.txt' }),
    })
    mockCopilotRetrieveFile({ [assemblyFile.id]: assemblyFile })
    // No delete/create mocks: a young stuck row must not delete or recreate.

    await retryFailedSyncsForPortal(connection.portalId, [row])

    const after = await rowById(row.id)
    expect(after.assemblyFileId).toBe(assemblyFile.id) // untouched
    expect(after.deletedAt).toBeNull()
    expect(after.pendingActionLastError).not.toBeNull() // markFailure
  })

  it('reconciles an abandoned stuck create by deleting the stale file and recreating', async () => {
    const { connection, channel } = await seed()
    const oldAssemblyId = randomUUID()
    const stalePending = copilotFileFactory.build({ id: oldAssemblyId, status: 'pending' })
    const row = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/aband.txt',
      dbxFileId: 'dbx:aband',
      assemblyFileId: oldAssemblyId,
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
      createdAt: hoursAgo(13), // older than the 12h threshold → abandoned
    })
    mockDropboxGetMetadata({
      'dbx:aband': dropboxFileMetadata({ path_display: '/root/aband.txt', id: 'dbx:aband' }),
    })
    mockCopilotRetrieveFile({ [oldAssemblyId]: stalePending })
    const { deletedIds } = mockCopilotDeleteFile() // stale file removed before recreate
    mockCopilotCreateFile() // recreate → fresh assemblyFileId
    mockDropboxDownload({ '/root/aband.txt': 'bytes' })

    await retryFailedSyncsForPortal(connection.portalId, [row])

    const after = await rowById(row.id)
    expect(deletedIds).toEqual([oldAssemblyId]) // old file deleted
    expect(after.assemblyFileId).toBeTruthy()
    expect(after.assemblyFileId).not.toBe(oldAssemblyId) // recreated with a new id
    expect(after.pendingAction).toBeNull()
    expect(after.deletedAt).toBeNull()
  })

  it('keeps retrying the rest of the batch when one row throws', async () => {
    const { connection, channel } = await seed()
    const good = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/keep.txt',
      dbxFileId: 'dbx:keep',
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    const bad = await fileSyncSeeder.create({
      ...pendingCreate(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/bad.txt',
      assemblyFileId: randomUUID(),
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    mockDropboxDeleteFile() // good row's delete succeeds
    // bad row's retrieveFile errors with a non-404 (not retried) → throws → markFailure
    mockCopilot(
      '/v1/files/:id',
      () => copilotError({ status: 400, body: { message: 'boom' } }),
      'get',
    )

    // bad row first, to prove the good row still runs
    await retryFailedSyncsForPortal(connection.portalId, [bad, good])

    const goodAfter = await rowById(good.id)
    const badAfter = await rowById(bad.id)
    expect(goodAfter.deletedAt).not.toBeNull() // batch continued past the throw
    expect(badAfter.deletedAt).toBeNull()
    expect(badAfter.pendingActionLastError).not.toBeNull()
  })

  // Stub the retry so we can see the reset itself — otherwise the retry soft-deletes the row
  // and markDeleted would zero the fields regardless.
  it('resets the pending rows attempts + last-attempt and flags the channel resyncing', async () => {
    const { connection, channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/reset.txt',
      dbxFileId: 'dbx:reset',
      object: ObjectType.FILE,
      pendingActionAttempts: 3,
      pendingActionLastAttemptAt: minutesAgo(1),
    })
    // Stub the orchestration (nothing retries the row); return value is ignored.
    vi.spyOn(resyncFailedFilesAndMasterSync, 'trigger').mockResolvedValue(undefined as never)
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)

    const result = await new ResyncService().resyncFailedFilesForChannel(channel.id, user)

    expect(result.pendingCount).toBe(1)
    const after = await rowById(row.id)
    expect(after.pendingActionAttempts).toBe(0) // backoff counter reset
    expect(after.pendingActionLastAttemptAt).toBeNull() // eligible immediately
    expect(after.pendingAction).toBe('delete') // still a pending row, just reset
    expect(after.deletedAt).toBeNull() // not retried (orchestration stubbed)
    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.resyncingAt).not.toBeNull() // marked in-progress (finally didn't run — stubbed)
  })

  // The user "Resync" button, end-to-end: resets the row (runs now despite backoff), runs the
  // retry + a master sync inline, then clears the "resyncing" flag. (Master sync no-ops here —
  // the base MSW handlers list nothing.)
  it('runs a manual channel resync now (bypassing backoff) and clears the in-progress flag', async () => {
    const { connection, channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      pendingActionAttempts: 3,
      pendingActionLastAttemptAt: minutesAgo(1), // inside the auto-sweep backoff → would be skipped
    })
    mockDropboxDeleteFile()
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)

    const result = await new ResyncService().resyncFailedFilesForChannel(channel.id, user)

    expect(result.pendingCount).toBe(1) // one pending row was reset
    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull() // reset AND retried inline (the delete ran)
    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.resyncingAt).toBeNull() // orchestrator's finally cleared the in-progress flag
  })

  it('does nothing when the portal has no Dropbox connection', async () => {
    const { channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.DROPBOX),
      channelSyncId: channel.id,
      itemPath: '/orphan.txt',
      dbxFileId: 'dbx:orphan',
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })

    // A portal id with no connection → early return before any row is processed.
    await retryFailedSyncsForPortal(randomUUID(), [row])

    const after = await rowById(row.id)
    expect(after.deletedAt).toBeNull()
    expect(after.pendingAction).toBe('delete') // untouched
    expect(after.pendingActionLastError).toBeNull()
  })

  it('marks a row failed when its action/target combo is unrecognised', async () => {
    const { connection, channel } = await seed()
    const row = await fileSyncSeeder.create({
      ...pendingDelete(PendingActionTarget.ASSEMBLY),
      channelSyncId: channel.id,
      itemPath: '/weird.txt',
      dbxFileId: 'dbx:weird',
      object: ObjectType.FILE,
      pendingActionLastAttemptAt: minutesAgo(6),
    })
    // Hand the dispatcher a row whose target is out of range; the DB row keeps a valid combo.
    const mangled = { ...row, pendingActionTarget: 'BOGUS' } as unknown as typeof row

    await retryFailedSyncsForPortal(connection.portalId, [mangled])

    const after = await rowById(row.id)
    expect(after.pendingActionLastError).toContain('unrecognised')
    expect(after.deletedAt).toBeNull() // never dispatched to a real handler
  })
})

import { eq } from 'drizzle-orm'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { initiateAssemblyToDropboxSync } from '@/trigger/processFileSync'
import { copilotDownloadableFactory, copilotFolderFactory, copilotListPage } from '../factories'
import {
  mockAssemblyFileDownload,
  mockCopilot,
  mockDropboxCreateFolder,
  mockDropboxGetMetadata,
  mockDropboxUpload,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder } from '../seeders'

// Initial Assembly -> Dropbox sync: drive the real graph inline, empty -> populated.
describe('initial sync: Assembly -> Dropbox', () => {
  it('creates a Dropbox mapping row for a folder, a top-level file, and a nested file', async () => {
    // ---- seed the connection + channel (no fileFolderSync rows: fresh sync) ----
    const accountId = 'acc-a2d'
    const rootNamespaceId = 'ns-a2d'
    const refreshToken = 'rt-a2d'
    const connection = await dropboxConnectionSeeder.create({
      accountId,
      rootNamespaceId,
      refreshToken,
    })
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
    })
    const channelId = channel.assemblyChannelId

    // ---- remote fixtures (folder-first so the folder row exists when the nested
    // file resolves its parent via getMappedFolderByAssemblyPath). NOTE: Assembly
    // paths have NO leading slash (the flow prepends one). ----
    const folder = copilotFolderFactory.build({ path: 'folder-A', channelId })
    const topFile = copilotDownloadableFactory.build({ path: 'file-top.txt', channelId })
    const nestedFile = copilotDownloadableFactory.build({
      path: 'folder-A/file-nested.txt',
      channelId,
    })

    // ---- MSW: Copilot listing + Dropbox write endpoints ----
    mockCopilot('/v1/files', () =>
      HttpResponse.json(copilotListPage([folder, topFile, nestedFile])),
    )
    mockDropboxGetMetadata({}) // every path -> 409 not_found (nothing exists yet)
    mockDropboxCreateFolder() // folder create -> folder metadata
    mockDropboxUpload() // default gives a distinct dbxFileId per path
    mockAssemblyFileDownload() // the Assembly file body (bare fetch of file.downloadUrl)

    // Drive the real half; the DB assertions below are the verification (a thrown
    // leaf resolves to { ok: false } without failing this call, so an ok-check is vacuous).
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    await initiateAssemblyToDropboxSync.triggerAndWait({
      dbxRootPath: '/root',
      assemblyChannelId: channelId,
      connectionToken: { refreshToken, accountId, rootNamespaceId },
      user,
    })

    // ---- assert final DB state ----
    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    expect(rows).toHaveLength(3)

    const byPath = Object.fromEntries(rows.map((r) => [r.itemPath, r]))

    const folderRow = byPath['/folder-A']
    expect(folderRow).toMatchObject({
      object: 'folder',
      assemblyPath: '/folder-A',
      assemblyFileId: folder.id,
      pendingAction: null,
      pendingActionTarget: null,
      deletedAt: null,
    })
    expect(folderRow.dbxFileId).toBeTruthy()
    expect(folderRow.contentHash).toBeNull() // folders carry no content hash

    const topRow = byPath['/file-top.txt']
    expect(topRow).toMatchObject({
      object: 'file',
      assemblyFileId: topFile.id,
      pendingAction: null,
    })
    expect(topRow.dbxFileId).toBeTruthy()
    expect(topRow.contentHash).toBe('hash-file')

    const nestedRow = byPath['/folder-A/file-nested.txt']
    expect(nestedRow).toMatchObject({ object: 'file', assemblyFileId: nestedFile.id })
    expect(nestedRow.dbxFileId).toBeTruthy()

    // all three mapped to distinct Dropbox ids (unique index would have rejected dups)
    expect(new Set(rows.map((r) => r.dbxFileId)).size).toBe(3)

    // A->D half increments syncedFilesCount once per created row; it does NOT touch
    // status/dbxCursor/lastSyncedAt (those belong to the Dropbox->Assembly half).
    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.syncedFilesCount).toBe(3)
    expect(ch.status).toBe(true) // unchanged from the seeded value
    expect(ch.dbxCursor).toBeNull()
    expect(ch.lastSyncedAt).toBeNull()
  })
})

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { initiateDropboxToAssemblySync } from '@/trigger/processFileSync'
import { dropboxEntryFactory, dropboxFolderFactory } from '../factories'
import {
  mockCopilotCreateFile,
  mockDropboxDownload,
  paginateDropboxListFolder,
  server,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder } from '../seeders'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// L1.1 (PR3) — initial Dropbox -> Assembly sync. Drives the REAL
// initiateDropboxToAssemblySync graph inline (L1.0 double) against Testcontainers
// Postgres, Dropbox + Copilot faked via MSW. Empty mapping -> populated; assert the
// final fileFolderSync rows + the channelSync completion stamps (status/cursor/lastSyncedAt).
describe('initial sync: Dropbox -> Assembly', () => {
  it('creates an Assembly mapping row for a folder, a top-level file, and a nested file', async () => {
    // ---- seed the connection + channel (no fileFolderSync rows: fresh sync) ----
    const accountId = 'acc-d2a'
    const rootNamespaceId = 'ns-d2a'
    const refreshToken = 'rt-d2a'
    const connection = await dropboxConnectionSeeder.create({
      accountId,
      rootNamespaceId,
      refreshToken,
    })
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
    })

    // ---- remote fixtures: Dropbox list_folder entries under /root, folder-first so
    // the folder row (with dbxFileId) exists before the nested file resolves. ----
    const folder = dropboxFolderFactory.build({
      id: 'dbx:folder-A',
      name: 'folder-A',
      path_display: '/root/folder-A',
    })
    const topFile = dropboxEntryFactory.build({
      id: 'dbx:file-top',
      name: 'file-top.txt',
      path_display: '/root/file-top.txt',
      content_hash: 'hash-top',
    })
    const nestedFile = dropboxEntryFactory.build({
      id: 'dbx:file-nested',
      name: 'file-nested.txt',
      path_display: '/root/folder-A/file-nested.txt',
      content_hash: 'hash-nested',
    })

    // ---- MSW: Dropbox listing + content download; Copilot create + upload ----
    server.use(...paginateDropboxListFolder([folder, topFile, nestedFile]))
    mockDropboxDownload({
      '/root/file-top.txt': 'top-bytes',
      '/root/folder-A/file-nested.txt': 'nested-bytes',
    })
    mockCopilotCreateFile() // POST /v1/files/{file|folder} (+ upload URL PUT for files)

    // ---- drive the real half in-process (DB assertions are the real verification) ----
    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    await initiateDropboxToAssemblySync.triggerAndWait({
      dbxRootPath: '/root',
      assemblyChannelId: channel.assemblyChannelId,
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
      dbxFileId: 'dbx:folder-A',
      pendingAction: null,
      pendingActionTarget: null,
      deletedAt: null,
    })
    expect(folderRow.assemblyFileId).toMatch(UUID_RE)
    expect(folderRow.contentHash).toBeNull() // folders carry no content hash

    const topRow = byPath['/file-top.txt']
    expect(topRow).toMatchObject({
      object: 'file',
      assemblyPath: '/file-top.txt',
      dbxFileId: 'dbx:file-top',
      contentHash: 'hash-top', // = entry.content_hash
      pendingAction: null,
    })
    expect(topRow.assemblyFileId).toMatch(UUID_RE)

    const nestedRow = byPath['/folder-A/file-nested.txt']
    expect(nestedRow).toMatchObject({
      object: 'file',
      assemblyPath: '/folder-A/file-nested.txt',
      dbxFileId: 'dbx:file-nested',
      contentHash: 'hash-nested',
    })
    expect(nestedRow.assemblyFileId).toMatch(UUID_RE)

    // distinct Assembly ids (unique index on (portal, channel, assemblyFileId) would reject dups)
    expect(new Set(rows.map((r) => r.assemblyFileId)).size).toBe(3)

    // D->A half stamps channel completion: status true, cursor persisted, lastSyncedAt set.
    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.status).toBe(true)
    expect(ch.dbxCursor).toBe('cursor:3') // paginateDropboxListFolder cursor after 3 entries
    expect(ch.lastSyncedAt).not.toBeNull()
    expect(ch.syncedFilesCount).toBe(3)
  })
})

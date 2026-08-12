import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { dropboxDeletedFactory, dropboxEntryFactory } from '../factories'
import {
  dropboxFolderMetadata,
  mockCopilotCreateFile,
  mockCopilotDeleteFile,
  mockDropboxDownload,
  mockDropboxGetMetadata,
  paginateDropboxListFolder,
  server,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, synced } from '../seeders'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT = '/root'
const ACCOUNT = 'acc-delta'

// Seeds an active connection + channel with a non-empty cursor (so the delta loop
// uses list_folder/continue) and mocks the root get_metadata handleDbxRootPathMove needs.
async function seedChannel() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: ACCOUNT,
    rootNamespaceId: 'ns-delta',
    refreshToken: 'rt-delta',
  })
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: ROOT,
    dbxCursor: 'cursor:0',
  })
  mockDropboxGetMetadata({ [ROOT]: dropboxFolderMetadata({ path_display: ROOT }) })
  return channel
}

const liveRows = (channelId: string) =>
  db
    .select()
    .from(fileFolderSync)
    .where(and(eq(fileFolderSync.channelSyncId, channelId), isNull(fileFolderSync.deletedAt)))

// Cursor-based Dropbox -> Assembly delta. Drive fetchDropBoxChanges directly (it builds
// the user locally); assert final DB state per change type.
describe('webhook delta: Dropbox -> Assembly', () => {
  it('new file → creates a mapped Assembly row', async () => {
    const channel = await seedChannel()
    const entry = dropboxEntryFactory.build({
      id: 'dbx:new',
      name: 'new.txt',
      path_display: '/root/new.txt',
      content_hash: 'h-new',
    })
    server.use(...paginateDropboxListFolder([entry]))
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/new.txt': 'bytes' })

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      itemPath: '/new.txt',
      dbxFileId: 'dbx:new',
      object: 'file',
      contentHash: 'h-new',
      pendingAction: null,
      deletedAt: null,
    })
    expect(rows[0].assemblyFileId).toMatch(UUID_RE)

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxCursor).not.toBe('cursor:0') // cursor advanced
    expect(ch.lastSyncedAt).not.toBeNull()
  })

  it('deleted entry → soft-deletes the mapped row', async () => {
    const channel = await seedChannel()
    await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt', // root-relative, as stored rows are
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const del = dropboxDeletedFactory.build({ name: 'gone.txt', path_display: '/root/gone.txt' })
    server.use(...paginateDropboxListFolder([del]))
    mockCopilotDeleteFile()

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.dbxFileId, 'dbx:gone'))
    expect(row.deletedAt).not.toBeNull()
    expect(row.pendingAction).toBeNull()
    expect(await liveRows(channel.id)).toHaveLength(0)
  })

  it('rename (delete + new, same dbxFileId) → old soft-deleted, new live', async () => {
    const channel = await seedChannel()
    await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/old.txt',
      dbxFileId: 'dbx:X',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const del = dropboxDeletedFactory.build({ name: 'old.txt', path_display: '/root/old.txt' })
    const created = dropboxEntryFactory.build({
      id: 'dbx:X', // same Dropbox id moved to a new path
      name: 'new.txt',
      path_display: '/root/new.txt',
      content_hash: 'h',
    })
    server.use(...paginateDropboxListFolder([del, created]))
    mockCopilotDeleteFile()
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/new.txt': 'bytes' })

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    const oldRow = rows.find((r) => r.itemPath === '/old.txt')
    const newRow = rows.find((r) => r.itemPath === '/new.txt')
    expect(oldRow?.deletedAt).not.toBeNull()
    expect(oldRow?.pendingAction).toBeNull()
    expect(newRow).toMatchObject({ dbxFileId: 'dbx:X', deletedAt: null, pendingAction: null })
    expect(newRow?.assemblyFileId).toMatch(UUID_RE)
  })

  it('content change → old soft-deleted, new row with the new hash', async () => {
    const channel = await seedChannel()
    await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/doc.txt',
      dbxFileId: 'dbx:D',
      object: ObjectType.FILE,
      contentHash: 'old-hash',
    })
    const changed = dropboxEntryFactory.build({
      id: 'dbx:D',
      name: 'doc.txt',
      path_display: '/root/doc.txt',
      content_hash: 'new-hash',
    })
    server.use(...paginateDropboxListFolder([changed]))
    mockCopilotDeleteFile()
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/doc.txt': 'bytes' })

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(
        and(eq(fileFolderSync.channelSyncId, channel.id), eq(fileFolderSync.dbxFileId, 'dbx:D')),
      )
    const live = rows.filter((r) => r.deletedAt === null)
    const dead = rows.filter((r) => r.deletedAt !== null)
    expect(dead).toHaveLength(1)
    expect(live).toHaveLength(1)
    expect(live[0].contentHash).toBe('new-hash')
    expect(live[0].assemblyFileId).toMatch(UUID_RE)
  })

  it('unchanged content → no delete/create, row untouched', async () => {
    const channel = await seedChannel()
    const seeded = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/same.txt',
      dbxFileId: 'dbx:S',
      object: ObjectType.FILE,
      contentHash: 'same-hash',
    })
    // Delta entry carrying the SAME content_hash as the mapped row.
    const unchanged = dropboxEntryFactory.build({
      id: 'dbx:S',
      name: 'same.txt',
      path_display: '/root/same.txt',
      content_hash: 'same-hash',
    })
    server.use(...paginateDropboxListFolder([unchanged]))
    // Deliberately NO createFile/delete/download mocks: if the flow wrongly recreated,
    // it would hit an unmocked endpoint and onUnhandledRequest:'error' fails the test.

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      itemPath: '/same.txt',
      dbxFileId: 'dbx:S',
      contentHash: 'same-hash',
      assemblyFileId: seeded.assemblyFileId, // same row, not recreated (no fresh UUID)
      deletedAt: null,
      pendingAction: null,
    })
  })
})

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
  dropboxRpcError,
  mockCopilotCreateFile,
  mockCopilotDeleteFile,
  mockDropboxDownload,
  mockDropboxGetMetadata,
  mockDropboxRpc,
  paginateDropboxListFolder,
  server,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, synced } from '../seeders'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT = '/root'
const ACCOUNT = 'acc-delta'

// Seeds an active connection + channel with a non-empty cursor (so the delta loop
// uses list_folder/continue).
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
    const gone = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt', // root-relative, as stored rows are
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const del = dropboxDeletedFactory.build({ name: 'gone.txt', path_display: '/root/gone.txt' })
    server.use(...paginateDropboxListFolder([del]))
    const { deletedIds } = mockCopilotDeleteFile()

    await new DropboxWebhook().fetchDropBoxChanges(ACCOUNT)

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.dbxFileId, 'dbx:gone'))
    expect(row.deletedAt).not.toBeNull()
    expect(row.pendingAction).toBeNull()
    expect(await liveRows(channel.id)).toHaveLength(0)
    // outbound: exactly the mapped file's Copilot id was deleted (once)
    expect(deletedIds).toEqual([gone.assemblyFileId])
  })

  it('rename (delete + new, same dbxFileId) → old soft-deleted, new live', async () => {
    const channel = await seedChannel()
    const old = await fileSyncSeeder.create({
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
    const { deletedIds } = mockCopilotDeleteFile()
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
    // outbound: the OLD Copilot file (not the new one) was the delete target
    expect(deletedIds).toEqual([old.assemblyFileId])
  })

  it('content change → old soft-deleted, new row with the new hash', async () => {
    const channel = await seedChannel()
    const doc = await fileSyncSeeder.create({
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
    const { deletedIds } = mockCopilotDeleteFile()
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
    // outbound: the stale Copilot file was deleted before the new one was created
    expect(deletedIds).toEqual([doc.assemblyFileId])
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

// A moved/renamed root or a reset both fail list_folder/continue with a 409. Recovery
// re-resolves the folder by its stable id, then RECONCILES: it re-lists the folder and
// diffs against sync records so changes in the skipped gap (dead cursor → now) are not
// lost. The re-listing's own cursor becomes the new baseline.
describe('webhook delta: cursor recovery + reconcile (move / reset)', () => {
  const dbxContinue = (resolver: Parameters<typeof mockDropboxRpc>[1]) =>
    mockDropboxRpc('/2/files/list_folder/continue', resolver)

  const rootMoved = () =>
    dropboxRpcError({
      status: 409,
      errorSummary: 'path/not_found/..',
      error: { '.tag': 'path', path: { '.tag': 'not_found' } },
    })
  const cursorReset = () =>
    dropboxRpcError({ status: 409, errorSummary: 'reset/..', error: { '.tag': 'reset' } })

  async function seedMovableChannel(account: string, dbxRootPath = ROOT) {
    const connection = await dropboxConnectionSeeder.create({
      accountId: account,
      rootNamespaceId: `ns-${account}`,
      refreshToken: `rt-${account}`,
    })
    return channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath,
      dbxRootId: 'id:root',
      dbxCursor: 'cursor:stale',
    })
  }

  it('root renamed (409 path) → reconciles a file added in the gap, adopts new path + listing cursor', async () => {
    const channel = await seedMovableChannel('acc-move')
    // The re-listing at the new path surfaces a file added during the skipped gap.
    const added = dropboxEntryFactory.build({
      id: 'dbx:added',
      name: 'added.txt',
      path_display: '/moved-root/added.txt',
      content_hash: 'h-added',
    })
    server.use(...paginateDropboxListFolder([added]))
    dbxContinue(rootMoved) // registered last so the dead-cursor 409 wins over the paginator
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: '/moved-root' }) })
    mockCopilotCreateFile()
    mockDropboxDownload({ '/moved-root/added.txt': 'bytes' })

    await new DropboxWebhook().fetchDropBoxChanges('acc-move')

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.dbxFileId, 'dbx:added'))
    expect(row).toMatchObject({ itemPath: '/added.txt', deletedAt: null, pendingAction: null })
    expect(row.assemblyFileId).toMatch(UUID_RE)

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe('/moved-root')
    expect(ch.dbxCursor).toBe('cursor:1') // the re-listing's own cursor, not the dead one
    expect(ch.lastSyncedAt).not.toBeNull() // the gap had a real change
  })

  it('cursor reset (409 reset) → reconciles a file deleted in the gap', async () => {
    const channel = await seedMovableChannel('acc-reset-del')
    const gone = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    // Folder intact (id resolves to same path), but the file is gone from the listing.
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: ROOT }) })
    server.use(...paginateDropboxListFolder([]))
    dbxContinue(cursorReset) // registered last so the dead-cursor 409 wins over the paginator
    const { deletedIds } = mockCopilotDeleteFile()

    await new DropboxWebhook().fetchDropBoxChanges('acc-reset-del')

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.dbxFileId, 'dbx:gone'))
    expect(row.deletedAt).not.toBeNull()
    expect(await liveRows(channel.id)).toHaveLength(0)
    expect(deletedIds).toEqual([gone.assemblyFileId]) // the mapped Copilot file was removed

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe(ROOT)
    expect(ch.dbxCursor).toBe('cursor:0') // empty listing's cursor
    expect(ch.lastSyncedAt).not.toBeNull()
  })

  it('file renamed in the gap (same id, new path) → old soft-deleted, new live at the new path', async () => {
    const channel = await seedMovableChannel('acc-reset-rename')
    const old = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/old.txt',
      dbxFileId: 'dbx:moved',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    // Folder intact, but the file is listed under the same id at a new path — a rename
    // during the gap that a full listing carries no delete marker for.
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: ROOT }) })
    const renamed = dropboxEntryFactory.build({
      id: 'dbx:moved',
      name: 'new.txt',
      path_display: '/root/new.txt',
      content_hash: 'h',
    })
    server.use(...paginateDropboxListFolder([renamed]))
    dbxContinue(cursorReset) // registered last so the dead-cursor 409 wins over the paginator
    const { deletedIds } = mockCopilotDeleteFile()
    mockCopilotCreateFile()
    mockDropboxDownload({ '/root/new.txt': 'bytes' })

    await new DropboxWebhook().fetchDropBoxChanges('acc-reset-rename')

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    const oldRow = rows.find((r) => r.itemPath === '/old.txt')
    const newRow = rows.find((r) => r.itemPath === '/new.txt')
    expect(oldRow?.deletedAt).not.toBeNull()
    expect(newRow).toMatchObject({ dbxFileId: 'dbx:moved', deletedAt: null, pendingAction: null })
    expect(newRow?.assemblyFileId).toMatch(UUID_RE)
    // outbound: the OLD Copilot file was the delete target, not the recreated one
    expect(deletedIds).toEqual([old.assemblyFileId])

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.lastSyncedAt).not.toBeNull() // a rename is a real change
  })

  it('plain move, nothing changed → adopts path + cursor without a false last-synced', async () => {
    const channel = await seedMovableChannel('acc-move-noop')
    const keep = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/keep.txt',
      dbxFileId: 'dbx:keep',
      object: ObjectType.FILE,
      contentHash: 'h-keep',
    })
    // Same file, same hash, just under the new root — no real change.
    const unchanged = dropboxEntryFactory.build({
      id: 'dbx:keep',
      name: 'keep.txt',
      path_display: '/moved-root/keep.txt',
      content_hash: 'h-keep',
    })
    server.use(...paginateDropboxListFolder([unchanged]))
    dbxContinue(rootMoved) // registered last so the dead-cursor 409 wins over the paginator
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: '/moved-root' }) })
    // No create/delete/download mocks: a wrongful sync would hit an unmocked endpoint and fail.

    await new DropboxWebhook().fetchDropBoxChanges('acc-move-noop')

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe('/moved-root')
    expect(ch.dbxCursor).toBe('cursor:1')
    expect(ch.lastSyncedAt).toBeNull() // nothing changed → no false sync (OUT-4142)

    // The row is untouched (not recreated: same Assembly file id, still live).
    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.dbxFileId, 'dbx:keep'))
    expect(row).toMatchObject({ assemblyFileId: keep.assemblyFileId, deletedAt: null })
  })

  it('recovery failure propagates so the run retries (path + cursor untouched)', async () => {
    const channel = await seedMovableChannel('acc-recover-fail')
    dbxContinue(cursorReset)
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: '/moved-root' }) })
    // The re-listing itself fails, before anything is persisted.
    mockDropboxRpc('/2/files/list_folder', () =>
      dropboxRpcError({ status: 500, errorSummary: 'boom', error: {} }),
    )

    await expect(new DropboxWebhook().fetchDropBoxChanges('acc-recover-fail')).rejects.toThrow()

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe(ROOT) // nothing adopted
    expect(ch.dbxCursor).toBe('cursor:stale') // stale cursor left as-is for the retry
  })

  it('recovery cannot run without a saved root id → propagates, cursor untouched', async () => {
    const connection = await dropboxConnectionSeeder.create({
      accountId: 'acc-no-root-id',
      rootNamespaceId: 'ns-acc-no-root-id',
      refreshToken: 'rt-acc-no-root-id',
    })
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: ROOT,
      dbxRootId: null, // no id to re-resolve the folder by
      dbxCursor: 'cursor:0',
    })
    dbxContinue(() =>
      dropboxRpcError({ status: 409, errorSummary: 'reset/..', error: { '.tag': 'reset' } }),
    )

    // Assert the missing-id guard fires (parse throws) before any metadata lookup,
    // not just that the run rejects for some later reason.
    await expect(new DropboxWebhook().fetchDropBoxChanges('acc-no-root-id')).rejects.toThrow(
      /expected string, received null/i,
    )

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxCursor).toBe('cursor:0') // stale cursor left as-is for the retry
  })
})

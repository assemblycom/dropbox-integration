import { and, eq, isNull } from 'drizzle-orm'
import { HttpResponse } from 'msw'
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
  mockDropboxLatestCursor,
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

// A moved/renamed root or a reset both fail list_folder/continue with a 409. Either way the
// stored path may be gone, so recovery always re-resolves the folder by its stable id.
describe('webhook delta: cursor recovery (move / reset)', () => {
  const dbxContinue = (resolver: Parameters<typeof mockDropboxRpc>[1]) =>
    mockDropboxRpc('/2/files/list_folder/continue', resolver)

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
      dbxCursor: 'cursor:0',
    })
  }

  it('root renamed (409 path) → recovers new path + cursor by id', async () => {
    const channel = await seedMovableChannel('acc-move')
    dbxContinue(() =>
      dropboxRpcError({
        status: 409,
        errorSummary: 'path/not_found/..',
        error: { '.tag': 'path', path: { '.tag': 'not_found' } },
      }),
    )
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: '/moved-root' }) })
    mockDropboxLatestCursor('cursor:new')

    await new DropboxWebhook().fetchDropBoxChanges('acc-move')

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe('/moved-root')
    expect(ch.dbxCursor).toBe('cursor:new')
    expect(ch.lastSyncedAt).toBeNull() // recovery is not a real sync
  })

  // Regression: a folder moved OUT of its parent surfaces as 409 `reset`. Recovery must
  // re-resolve by id — NOT re-list at the stale stored path, which 409s and crashed the run.
  it('root moved out of parent (409 reset, stale path gone) → recovers by id', async () => {
    const channel = await seedMovableChannel('acc-moved-out', '/parent/child')
    dbxContinue(() =>
      dropboxRpcError({ status: 409, errorSummary: 'reset/..', error: { '.tag': 'reset' } }),
    )
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: '/child' }) })
    // The old path no longer resolves; only the new path yields a cursor.
    mockDropboxRpc('/2/files/list_folder/get_latest_cursor', async ({ request }) => {
      const { path } = (await request.json()) as { path: string }
      return path === '/child'
        ? HttpResponse.json({ cursor: 'cursor:new' })
        : dropboxRpcError({
            status: 409,
            errorSummary: 'path/not_found/..',
            error: { '.tag': 'path', path: { '.tag': 'not_found' } },
          })
    })

    await expect(new DropboxWebhook().fetchDropBoxChanges('acc-moved-out')).resolves.toBeUndefined()

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe('/child') // adopted the new path (no crash on the old one)
    expect(ch.dbxCursor).toBe('cursor:new')
  })

  it('cursor reset with folder intact (409 reset) → refreshes cursor, path unchanged', async () => {
    const channel = await seedMovableChannel('acc-reset')
    dbxContinue(() =>
      dropboxRpcError({ status: 409, errorSummary: 'reset/..', error: { '.tag': 'reset' } }),
    )
    // Folder is fine: id resolves to the same path.
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: ROOT }) })
    mockDropboxLatestCursor('cursor:new')

    await expect(new DropboxWebhook().fetchDropBoxChanges('acc-reset')).resolves.toBeUndefined()

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxRootPath).toBe(ROOT) // path unchanged
    expect(ch.dbxCursor).toBe('cursor:new')
  })

  it('recovery failure propagates so the run retries (cursor untouched)', async () => {
    const channel = await seedMovableChannel('acc-reset-fail')
    dbxContinue(() =>
      dropboxRpcError({ status: 409, errorSummary: 'reset/..', error: { '.tag': 'reset' } }),
    )
    mockDropboxGetMetadata({ 'id:root': dropboxFolderMetadata({ path_display: ROOT }) })
    mockDropboxRpc('/2/files/list_folder/get_latest_cursor', () =>
      dropboxRpcError({ status: 500, errorSummary: 'boom', error: {} }),
    )

    await expect(new DropboxWebhook().fetchDropBoxChanges('acc-reset-fail')).rejects.toThrow()

    const [ch] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(ch.dbxCursor).toBe('cursor:0') // stale cursor left as-is for the retry
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

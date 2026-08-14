import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType, PendingAction, PendingActionTarget } from '@/db/constants'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type User from '@/lib/copilot/models/User.model'
import { channelSeeder, fileSyncSeeder, tombstone } from '../seeders'

// Direct-DB tests for MapFilesService.insertFileMap / insertCreatePending (OUT-4043).
// The database is the risk here: the partial-unique path index, the GENERATED
// item_path_lower column, the same-path insert race, and the IS DISTINCT FROM
// guard on the conflict update.

async function seed() {
  const channel = await channelSeeder.create({ dbxRootPath: '/root' })
  // The real constructor is (user, connectionToken); insert paths only read
  // this.user.portalId, and no method here makes an HTTP call.
  const user = { portalId: channel.portalId, token: 'test-token' } as unknown as User
  const connectionToken = {
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: null,
  } as DropboxConnectionTokens
  const service = new MapFilesService(user, connectionToken)
  return { channel, service }
}

const rowsForChannel = (channelSyncId: string) =>
  db.select().from(fileFolderSync).where(eq(fileFolderSync.channelSyncId, channelSyncId))

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

describe('MapFilesService#insertFileMap', () => {
  it('inserts a new row and returns it', async () => {
    const { channel, service } = await seed()

    const row = await service.insertFileMap({
      portalId: channel.portalId,
      channelSyncId: channel.id,
      itemPath: '/root/a.txt',
      object: ObjectType.FILE,
    })

    expect(row).not.toBeNull()
    expect(row?.itemPath).toBe('/root/a.txt')
    expect(await rowsForChannel(channel.id)).toHaveLength(1)
  })

  it('populates the GENERATED item_path_lower column', async () => {
    const { channel, service } = await seed()

    const row = await service.insertFileMap({
      portalId: channel.portalId,
      channelSyncId: channel.id,
      itemPath: '/Root/Foo.PDF',
      object: ObjectType.FILE,
    })

    expect(row?.itemPathLower).toBe('/root/foo.pdf')
  })

  it('returns null on a partial-unique path conflict (case-insensitive)', async () => {
    const { channel, service } = await seed()
    await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/Foo.PDF' })

    // Same path in a different case collides via item_path_lower.
    const row = await service.insertFileMap({
      portalId: channel.portalId,
      channelSyncId: channel.id,
      itemPath: '/root/foo.pdf',
      object: ObjectType.FILE,
    })

    expect(row).toBeNull()
    expect(await rowsForChannel(channel.id)).toHaveLength(1)
  })

  it('lets exactly one row win a concurrent same-path insert race', async () => {
    const { channel, service } = await seed()
    const payload = {
      portalId: channel.portalId,
      channelSyncId: channel.id,
      itemPath: '/root/race.txt',
      object: ObjectType.FILE,
    }

    const results = await Promise.all([
      service.insertFileMap({ ...payload }),
      service.insertFileMap({ ...payload }),
    ])

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1) // the loser's onConflictDoNothing returns null
    expect(await rowsForChannel(channel.id)).toHaveLength(1)
  })

  it('frees the path for a new insert once the existing row is soft-deleted', async () => {
    const { channel, service } = await seed()
    // The partial index only covers live rows, so a tombstone releases the path.
    await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/gone.txt',
      ...tombstone(),
    })

    const row = await service.insertFileMap({
      portalId: channel.portalId,
      channelSyncId: channel.id,
      itemPath: '/root/gone.txt',
      object: ObjectType.FILE,
    })

    expect(row).not.toBeNull()
  })
})

describe('MapFilesService#insertCreatePending', () => {
  it('inserts a create-pending placeholder row and returns it', async () => {
    const { channel, service } = await seed()

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/new.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: 'dbx:1',
    })

    expect(row).not.toBeNull()
    expect(row?.pendingAction).toBe(PendingAction.CREATE)
    expect(row?.pendingActionTarget).toBe(PendingActionTarget.ASSEMBLY)
    expect(row?.pendingActionLastAttemptAt).not.toBeNull() // stamped for the sweeper backoff
    expect(row?.dbxFileId).toBe('dbx:1')
  })

  it('returns null when a live row already exists at the path', async () => {
    const { channel, service } = await seed()
    await fileSyncSeeder.create({ channelSyncId: channel.id, itemPath: '/root/dup.txt' })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/dup.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: null,
    })

    expect(row).toBeNull()
    expect(await rowsForChannel(channel.id)).toHaveLength(1) // no second row
  })

  it('updates dbxFileId on conflict for an ASSEMBLY create, NULL-safe via IS DISTINCT FROM', async () => {
    const { channel, service } = await seed()
    // Existing row has no dbxFileId yet: NULL IS DISTINCT FROM 'dbx:new' is TRUE,
    // so the update must fire (a plain `<>` would skip it and drop the new id).
    const existing = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/x.txt',
      dbxFileId: null,
    })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/x.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: 'dbx:new',
    })

    expect(row).toBeNull()
    expect((await rowById(existing.id)).dbxFileId).toBe('dbx:new')
  })

  it('updates dbxFileId on a case-variant conflict, from one non-null id to another', async () => {
    const { channel, service } = await seed()
    // The production case: the row already had a Dropbox id and the file was
    // re-uploaded under a new one ('dbx:old' IS DISTINCT FROM 'dbx:new').
    // The paths differ only in case, so this also guards the update's
    // lower(itemPath) = lower(payload) lookup against a case-sensitive regression.
    const existing = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/Case.txt',
      dbxFileId: 'dbx:old',
    })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/case.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: 'dbx:new',
    })

    expect(row).toBeNull()
    expect((await rowById(existing.id)).dbxFileId).toBe('dbx:new')
  })

  it('skips the dbxFileId write on conflict when the id is unchanged', async () => {
    const { channel, service } = await seed()
    const existing = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/same.txt',
      dbxFileId: 'dbx:same',
    })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/same.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: 'dbx:same',
    })

    expect(row).toBeNull()
    const after = await rowById(existing.id)
    expect(after.dbxFileId).toBe('dbx:same')
    // IS DISTINCT FROM matches no rows, so the row is never updated (updatedAt untouched).
    expect(after.updatedAt.getTime()).toBe(existing.updatedAt.getTime())
  })

  it('leaves dbxFileId untouched on conflict when the target is DROPBOX', async () => {
    const { channel, service } = await seed()
    const existing = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/dbx.txt',
      dbxFileId: 'dbx:old',
    })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/dbx.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.DROPBOX,
      assemblyFileId: null,
      dbxFileId: 'dbx:new',
    })

    expect(row).toBeNull()
    expect((await rowById(existing.id)).dbxFileId).toBe('dbx:old') // update is ASSEMBLY-only
  })

  it('leaves dbxFileId untouched on conflict when the new dbxFileId is null', async () => {
    const { channel, service } = await seed()
    const existing = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/keep.txt',
      dbxFileId: 'dbx:old',
    })

    const row = await service.insertCreatePending({
      channelSyncId: channel.id,
      itemPath: '/root/keep.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: null,
    })

    expect(row).toBeNull()
    expect((await rowById(existing.id)).dbxFileId).toBe('dbx:old') // guarded by `&& payload.dbxFileId`
  })
})

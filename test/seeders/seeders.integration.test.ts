import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType, PendingAction, PendingActionTarget } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type User from '@/lib/copilot/models/User.model'
import { dropboxDeletedFactory, dropboxEntryFactory } from '../factories'
import {
  channelSeeder,
  dropboxConnectionSeeder,
  fileSyncSeeder,
  fromDropboxEntry,
  pendingCreate,
  pendingDelete,
  synced,
  tombstone,
} from './index'

describe('dropboxConnectionSeeder', () => {
  it('persists a connection row with sane defaults', async () => {
    const conn = await dropboxConnectionSeeder.create()
    const [found] = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.id, conn.id))
    expect(found.portalId).toBe(conn.portalId)
    expect(found.status).toBe(true)
    expect(found.initiatedBy).toBe(conn.initiatedBy)
  })

  it('applies overrides', async () => {
    const conn = await dropboxConnectionSeeder.create({ portalId: 'portal-custom' })
    expect(conn.portalId).toBe('portal-custom')
  })
})

describe('channelSeeder', () => {
  it('auto-creates a connection and shares its portal/account when none is given', async () => {
    const channel = await channelSeeder.create()
    const [conn] = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.portalId, channel.portalId))
    expect(conn).toBeDefined()
    expect(conn.accountId).toBe(channel.dbxAccountId)
  })

  it('does not create a connection when portalId + dbxAccountId are supplied', async () => {
    const channel = await channelSeeder.create({ portalId: 'portal-x', dbxAccountId: 'acc-x' })
    const [row] = await db.select().from(channelSync).where(eq(channelSync.id, channel.id))
    expect(row.portalId).toBe('portal-x')
    const conns = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.portalId, 'portal-x'))
    expect(conns).toHaveLength(0)
  })

  it('reuses an existing connection when only portalId is supplied', async () => {
    const conn = await dropboxConnectionSeeder.create()
    const channel = await channelSeeder.create({ portalId: conn.portalId })
    expect(channel.dbxAccountId).toBe(conn.accountId)
    const conns = await db
      .select()
      .from(dropboxConnections)
      .where(eq(dropboxConnections.portalId, conn.portalId))
    expect(conns).toHaveLength(1)
  })

  it('throws when dbxAccountId is supplied without portalId', async () => {
    await expect(channelSeeder.create({ dbxAccountId: 'acc-orphan' })).rejects.toThrow(/portalId/)
  })

  it('rejects when the existing connection for the portal has no accountId', async () => {
    const conn = await dropboxConnectionSeeder.create({ accountId: null })
    await expect(channelSeeder.create({ portalId: conn.portalId })).rejects.toThrow(/no accountId/)
  })

  it('rejects an explicit dbxAccountId that conflicts with the portal connection', async () => {
    const conn = await dropboxConnectionSeeder.create()
    await expect(
      channelSeeder.create({ portalId: conn.portalId, dbxAccountId: 'acc-other' }),
    ).rejects.toThrow(/does not match/)
  })
})

describe('fileSyncSeeder', () => {
  it('auto-creates the full connection -> channel -> file chain when given no parent', async () => {
    const row = await fileSyncSeeder.create()
    expect(row.channelSyncId).toBeTypeOf('string')
    const [channel] = await db
      .select()
      .from(channelSync)
      .where(eq(channelSync.id, row.channelSyncId))
    expect(channel).toBeDefined()
    expect(row.portalId).toBe(channel.portalId)
    // GENERATED column is populated by the DB.
    expect(row.itemPathLower).toBe(row.itemPath?.toLowerCase())
  })

  it('reuses an explicit channelSyncId and inherits its portalId', async () => {
    const channel = await channelSeeder.create()
    const row = await fileSyncSeeder.create({ channelSyncId: channel.id })
    expect(row.channelSyncId).toBe(channel.id)
    expect(row.portalId).toBe(channel.portalId)
  })

  it('pendingCreate trait satisfies the action/target CHECK constraint', async () => {
    const row = await fileSyncSeeder.create(pendingCreate(PendingActionTarget.DROPBOX))
    expect(row.pendingAction).toBe(PendingAction.CREATE)
    expect(row.pendingActionTarget).toBe(PendingActionTarget.DROPBOX)
    expect(row.pendingActionAttempts).toBe(1)
  })

  it('pendingDelete trait satisfies the action/target CHECK constraint', async () => {
    const row = await fileSyncSeeder.create(pendingDelete(PendingActionTarget.ASSEMBLY))
    expect(row.pendingAction).toBe(PendingAction.DELETE)
    expect(row.pendingActionTarget).toBe(PendingActionTarget.ASSEMBLY)
    expect(row.pendingActionAttempts).toBe(1)
  })

  it('tombstone frees the path for a new live insert (partial unique index)', async () => {
    const channel = await channelSeeder.create()
    await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/dup.txt',
      ...tombstone(),
    })
    // A second LIVE row at the same path must be allowed because the first is soft-deleted.
    const live = await fileSyncSeeder.create({
      channelSyncId: channel.id,
      itemPath: '/root/dup.txt',
    })
    expect(live.deletedAt).toBeNull()
  })

  it('fromDropboxEntry keeps the row consistent with the remote fixture', async () => {
    const entry = dropboxEntryFactory.build()
    const row = await fileSyncSeeder.create(fromDropboxEntry(entry))
    expect(row.itemPath).toBe(entry.path_display)
    expect(row.dbxFileId).toBe(entry.id)
    expect(row.contentHash).toBe(entry.content_hash)
    expect(row.object).toBe(ObjectType.FILE)
  })

  it('throws a clear error when given a nonexistent channelSyncId', async () => {
    await expect(
      fileSyncSeeder.create({ channelSyncId: '00000000-0000-4000-8000-0000000000ff' }),
    ).rejects.toThrow(/channelSync .* not found/)
  })

  it('rejects a portalId that does not own the supplied channelSyncId', async () => {
    const channel = await channelSeeder.create()
    await expect(
      fileSyncSeeder.create({ channelSyncId: channel.id, portalId: 'portal-foreign' }),
    ).rejects.toThrow(/does not own/)
  })

  it('fromDropboxEntry refuses to derive a live row from a deleted entry', () => {
    expect(() => fromDropboxEntry(dropboxDeletedFactory.build())).toThrow(/deleted/)
  })
})

describe('seeded scenario round-trips through the real read path', () => {
  it('a synced row seeded from a Dropbox entry is found by getDbxMappedFileFromPath', async () => {
    const channel = await channelSeeder.create()
    const entry = dropboxEntryFactory.build()
    await fileSyncSeeder.create(
      fromDropboxEntry(entry, {
        channelSyncId: channel.id,
        itemPath: '/nested.txt',
        ...synced({ assemblyPath: '/nested.txt' }),
      }),
    )

    // Constructed like the existing unit test (MapFiles.tombstone.test.ts): the
    // real constructor is (user: User, connectionToken: DropboxConnectionTokens),
    // not `new MapFilesService(portalId)`.
    const user = { portalId: channel.portalId, token: 'test-token' } as unknown as User
    const connectionToken = {
      refreshToken: 'rt',
      accountId: 'acc',
      rootNamespaceId: null,
    } as DropboxConnectionTokens
    const mapFiles = new MapFilesService(user, connectionToken)

    const found = await mapFiles.getDbxMappedFileFromPath('/nested.txt', channel.id)
    expect(found?.dbxFileId).toBe(entry.id)
  })
})

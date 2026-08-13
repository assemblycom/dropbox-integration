import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { AssemblyWebhookService } from '@/features/webhook/assembly/lib/webhook.service'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { copilotDownloadableFactory, copilotFileFactory, copilotRenamedFactory } from '../factories'
import {
  mockAssemblyFileDownload,
  mockDropboxDeleteFile,
  mockDropboxGetMetadata,
  mockDropboxUpload,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, synced } from '../seeders'

const ACCOUNT = 'acc-asm'

async function seed() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: ACCOUNT,
    rootNamespaceId: 'ns-asm',
    refreshToken: 'rt-asm',
  })
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: '/root',
  })
  const user = new User('test-token', { workspaceId: connection.portalId } as Token)
  const svc = new AssemblyWebhookService(user, {
    refreshToken: 'rt-asm',
    accountId: ACCOUNT,
    rootNamespaceId: 'ns-asm',
  })
  return { channel, svc }
}

// How an Assembly change is applied to Dropbox (create / delete / update).
describe('Assembly webhook: applying a change to Dropbox', () => {
  it('creates the file in Dropbox and records the mapping', async () => {
    const { channel, svc } = await seed()
    const data = copilotDownloadableFactory.build({
      channelId: channel.assemblyChannelId,
      path: 'created.txt', // Copilot paths have no leading slash
    })
    mockDropboxGetMetadata({}) // 404 → doesn't exist yet
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await svc.handleFileCreated({ eventType: 'file.created', data })

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    expect(row).toMatchObject({
      itemPath: '/created.txt',
      assemblyFileId: data.id,
      object: 'file',
      pendingAction: null,
      deletedAt: null,
    })
    expect(row.dbxFileId).toBeTruthy()
  })

  it('deletes the file from Dropbox and marks the mapping as deleted', async () => {
    const { channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const data = copilotFileFactory.build({
      id: row.assemblyFileId as string,
      channelId: channel.assemblyChannelId,
      path: 'gone.txt',
    })
    const { deletedPaths } = mockDropboxDeleteFile()

    await svc.handleFileDeleted({ eventType: 'file.deleted', data })

    const [updated] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, row.id))
    expect(updated.deletedAt).not.toBeNull()
    expect(updated.pendingAction).toBeNull()
    // outbound: the mapped Dropbox path (root + itemPath) was the delete target
    expect(deletedPaths).toEqual(['/root/gone.txt'])
  })

  it('replaces the file in Dropbox by deleting the old one and uploading the new one', async () => {
    const { channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/upd.txt',
      dbxFileId: 'dbx:old',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const data = copilotRenamedFactory.build({
      id: row.assemblyFileId as string,
      channelId: channel.assemblyChannelId,
      path: 'upd.txt',
      downloadUrl: 'https://content.example/download',
    })
    const { deletedPaths } = mockDropboxDeleteFile()
    mockDropboxGetMetadata({})
    mockDropboxUpload()
    mockAssemblyFileDownload()

    await svc.handleFileUpdated({ eventType: 'file.updated', data })

    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    const oldRow = rows.find((r) => r.id === row.id)
    const newRow = rows.find((r) => r.itemPath === '/upd.txt' && r.deletedAt === null)
    expect(oldRow?.deletedAt).not.toBeNull()
    expect(newRow?.dbxFileId).toBe('id:dbx:/root/upd.txt') // freshly re-uploaded
    expect(deletedPaths).toEqual(['/root/upd.txt'])
  })
})

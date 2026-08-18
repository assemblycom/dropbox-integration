import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { ObjectType, type ObjectTypeValue } from '@/db/constants'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { SyncService } from '@/features/sync/lib/Sync.service'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'
import User from '@/lib/copilot/models/User.model'
import type { CopilotFileRetrieve, Token } from '@/lib/copilot/types'
import { copilotDownloadableFactory, copilotFileFactory } from '../factories'
import {
  copilotError,
  copilotNotFound,
  type DropboxMeta,
  dropboxFileMetadata,
  dropboxPathLookupNotFound,
  dropboxRpcError,
  mockAssemblyFileDownload,
  mockCopilotDeleteFile,
  mockDropboxDeleteFile,
  mockDropboxGetMetadata,
  mockDropboxMove,
  mockDropboxUpload,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder, fileSyncSeeder, synced } from '../seeders'

const CONNECTION_TOKEN = { refreshToken: 'rt', accountId: 'acc', rootNamespaceId: 'ns' }

function makeService(portalId: string) {
  const user = new User('test-token', { workspaceId: portalId } as Token)
  return new SyncService(user, CONNECTION_TOKEN)
}

async function seed() {
  const connection = await dropboxConnectionSeeder.create({
    accountId: 'acc',
    rootNamespaceId: 'ns',
    refreshToken: 'rt',
  })
  const channel = await channelSeeder.create({
    portalId: connection.portalId,
    dbxRootPath: '/root',
  })
  return { connection, channel, svc: makeService(connection.portalId) }
}

const rowById = async (id: string) => {
  const [row] = await db.select().from(fileFolderSync).where(eq(fileFolderSync.id, id))
  return row
}

// createAndUploadFileInDropbox returns undefined on the dead-end branches; the caller
// (completePendingDropboxCreate) turns that into a throw.
describe('Dropbox create-vs-update: dead-end branches throw', () => {
  it('throws when the existing Dropbox item has an unexpected tag (not file or folder)', async () => {
    const svc = makeService('portal-x')
    const file = copilotFileFactory.build({ path: 'weird.txt' }) as CopilotFileRetrieve & {
      object: ObjectTypeValue
    }
    // filesGetMetadata resolves with a deleted-tag item → neither folder nor file branch.
    const deletedMeta: DropboxMeta = {
      '.tag': 'deleted',
      id: 'id:x',
      name: 'weird.txt',
      path_display: '/root/weird.txt',
      path_lower: '/root/weird.txt',
    }
    mockDropboxGetMetadata({ '/root/weird.txt': deletedMeta })

    await expect(
      svc.completePendingDropboxCreate({
        pendingRowId: 'row-x',
        channelSyncId: 'chan-x',
        dbxRootPath: '/root',
        file,
      }),
    ).rejects.toThrow('returned undefined')
  })

  it('throws when the file type is out of range (not file or folder)', async () => {
    const svc = makeService('portal-x')
    const file = copilotFileFactory.build({
      path: 'odd.txt',
      object: 'link', // out-of-range object → falls through both create branches
    }) as CopilotFileRetrieve & { object: ObjectTypeValue }
    mockDropboxGetMetadata({}) // not_found → item does not exist yet

    await expect(
      svc.completePendingDropboxCreate({
        pendingRowId: 'row-x',
        channelSyncId: 'chan-x',
        dbxRootPath: '/root',
        file,
      }),
    ).rejects.toThrow('returned undefined')
  })

  it('renames the existing Dropbox file then re-uploads when a file already exists at the path', async () => {
    const svc = makeService('portal-x')
    const file = copilotDownloadableFactory.build({ path: 'dup.txt' })
    // A file already lives at /root/dup.txt → rename-then-reupload branch.
    mockDropboxGetMetadata({
      '/root/dup.txt': dropboxFileMetadata({ path_display: '/root/dup.txt' }),
    })
    const moves: { from: string; to: string }[] = []
    mockDropboxMove((from, to) => {
      moves.push({ from, to })
      return dropboxFileMetadata({ path_display: to })
    })
    mockDropboxUpload()
    mockAssemblyFileDownload()

    const result = await svc.createAndUploadFileInDropbox('/root', ObjectType.FILE, file)

    // Existing file renamed to a timestamped name, new content uploaded at the original path.
    expect(moves).toHaveLength(1)
    expect(moves[0].from).toBe('/root/dup.txt')
    expect(moves[0].to).toMatch(/\/root\/dup \(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\)\.txt$/)
    expect(result?.dbxFileId).toBe('id:dbx:/root/dup.txt')
  })
})

// deleteDropboxFileQuietly swallows a "already gone" 409, rethrows anything else.
describe('deleteDropboxFileQuietly error handling (via removeFileFromDropbox)', () => {
  async function seedDropboxRow() {
    const { connection, channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const file = copilotFileFactory.build({
      id: row.assemblyFileId as string,
      channelId: channel.assemblyChannelId,
      path: 'gone.txt',
    }) as CopilotFileRetrieve & { object: ObjectTypeValue }
    const payload = {
      file,
      opts: {
        channelSyncId: channel.id,
        dbxRootPath: '/root',
        assemblyChannelId: channel.assemblyChannelId,
        // opts.user/connectionToken are unused by removeFileFromDropbox; present to satisfy the type.
        user: new User('test-token', { workspaceId: connection.portalId } as Token),
        connectionToken: CONNECTION_TOKEN,
      },
    }
    return { svc, row, payload }
  }

  it('swallows a 409 path_lookup/not_found and still soft-deletes the row', async () => {
    const { svc, row, payload } = await seedDropboxRow()
    mockDropboxDeleteFile({ error: dropboxPathLookupNotFound })

    await expect(svc.removeFileFromDropbox(payload)).resolves.toBeUndefined()

    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.pendingAction).toBeNull()
  })

  it('rethrows a different 409 and marks the row failed', async () => {
    const { svc, row, payload } = await seedDropboxRow()
    mockDropboxDeleteFile({
      error: () =>
        dropboxRpcError({
          status: 409,
          errorSummary: 'path/conflict/..',
          error: { '.tag': 'path', path: { '.tag': 'conflict' } },
        }),
    })

    await expect(svc.removeFileFromDropbox(payload)).rejects.toThrow()

    const after = await rowById(row.id)
    expect(after.deletedAt).toBeNull()
    expect(after.pendingActionLastError).not.toBeNull()
  })
})

// deleteAssemblyFileQuietly swallows a Copilot 404, rethrows anything else.
describe('deleteAssemblyFileQuietly error handling (via removeFileFromAssembly)', () => {
  async function seedAssemblyRow() {
    const { channel, svc } = await seed()
    const row = await fileSyncSeeder.create({
      ...synced(),
      channelSyncId: channel.id,
      itemPath: '/gone.txt',
      dbxFileId: 'dbx:gone',
      object: ObjectType.FILE,
      contentHash: 'h',
    })
    const entry: DropboxFileListFolderSingleEntry = {
      '.tag': 'file',
      id: 'dbx:gone',
      name: 'gone.txt',
      path_display: '/root/gone.txt',
      content_hash: 'h',
    }
    return { svc, channel, row, entry }
  }

  it('swallows a Copilot 404 and still soft-deletes the row', async () => {
    const { svc, channel, row, entry } = await seedAssemblyRow()
    mockCopilotDeleteFile({ error: copilotNotFound })

    await expect(svc.removeFileFromAssembly(channel.id, '/root', entry)).resolves.toBeUndefined()

    const after = await rowById(row.id)
    expect(after.deletedAt).not.toBeNull()
    expect(after.pendingAction).toBeNull()
  })

  it('rethrows a non-404 Copilot error and marks the row failed', async () => {
    const { svc, channel, row, entry } = await seedAssemblyRow()
    mockCopilotDeleteFile({ error: () => copilotError({ status: 400, body: { message: 'boom' } }) })

    await expect(svc.removeFileFromAssembly(channel.id, '/root', entry)).rejects.toThrow()

    const after = await rowById(row.id)
    expect(after.deletedAt).toBeNull()
    expect(after.pendingActionLastError).not.toBeNull()
  })
})

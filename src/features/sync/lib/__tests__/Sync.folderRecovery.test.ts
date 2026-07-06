import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'

const { createFileMock, listFilesMock } = vi.hoisted(() => ({
  createFileMock: vi.fn(),
  listFilesMock: vi.fn(),
}))

vi.mock('@/lib/dropbox/DropboxClient', () => ({
  DropboxClient: class {
    getDropboxClient() {
      return {}
    }
    dbxAuthClient = { refreshAccessToken: vi.fn() }
  },
}))

vi.mock('@/lib/copilot/CopilotAPI', () => ({
  CopilotAPI: class {
    createFile = (...args: unknown[]) => createFileMock(...args)
    listFiles = (...args: unknown[]) => listFilesMock(...args)
  },
  // Treat anything with a numeric status as a Copilot API error for this test.
  isCopilotApiError: (e: unknown) => typeof (e as { status?: unknown })?.status === 'number',
}))

vi.mock('@/trigger/processFileSync', () => ({
  bidirectionalMasterSync: { trigger: vi.fn() },
}))

import { SyncService } from '@/features/sync/lib/Sync.service'

const user = { portalId: 'p', token: 't', copilot: {} } as never
const connectionToken = { accountId: 'a', refreshToken: 'r', rootNamespaceId: 'n' } as never

const folderExistsError = { status: 400, body: { message: 'Folder already exists' } }

const entry: DropboxFileListFolderSingleEntry = {
  '.tag': 'folder',
  name: 'John_s Cafe',
  path_display: '/root/John_s Cafe',
  id: 'dbx:folder',
}

type FolderSvc = {
  createFolderInAssembly(p: Record<string, unknown>): Promise<void>
}

let service: SyncService

beforeEach(() => {
  vi.restoreAllMocks()
  createFileMock.mockReset()
  listFilesMock.mockReset()
  service = new SyncService(user, connectionToken)
})

describe('createFolderInAssembly :: recovers an unmapped existing folder', () => {
  it('inserts a complete row (id + assemblyPath) when Assembly says the folder already exists but no row exists', async () => {
    // No DB row for the folder (pre-check and post-catch re-check both miss); parent lookup misses too.
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath').mockResolvedValue(
      undefined as never,
    )
    createFileMock.mockRejectedValue(folderExistsError)
    // Assembly lists the folder without a leading slash.
    listFilesMock.mockResolvedValue({
      data: [{ id: 'asm:folder', object: 'folder', path: 'John_s Cafe' }],
      nextToken: undefined,
    })
    const insertFileMap = vi
      .spyOn(service.mapFilesService, 'insertFileMap')
      .mockResolvedValue({ id: 'row-1' } as never)
    vi.spyOn(service.mapFilesService, 'updateChannelMapSyncedFilesCount').mockResolvedValue(
      undefined as never,
    )

    await (service as unknown as FolderSvc).createFolderInAssembly({
      assemblyChannelId: 'ch-1',
      itemPath: '/John_s Cafe',
      assemblyCreatePath: '/John_s Cafe',
      lastItem: true,
      tempFileType: 'folder',
      channelSyncId: 'cs-1',
      entry,
      basePath: '/John_s Cafe',
    })

    expect(insertFileMap).toHaveBeenCalledWith(
      expect.objectContaining({
        itemPath: '/John_s Cafe',
        assemblyPath: '/John_s Cafe',
        assemblyFileId: 'asm:folder',
        dbxFileId: 'dbx:folder',
      }),
    )
  })

  it('does not double-count and stamps dbxFileId when a concurrent recovery won the insert', async () => {
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath').mockResolvedValue(
      undefined as never,
    )
    createFileMock.mockRejectedValue(folderExistsError)
    listFilesMock.mockResolvedValue({
      data: [{ id: 'asm:folder', object: 'folder', path: 'John_s Cafe' }],
      nextToken: undefined,
    })
    // Insert loses the race (onConflictDoNothing → null).
    vi.spyOn(service.mapFilesService, 'insertFileMap').mockResolvedValue(null as never)
    const countSpy = vi
      .spyOn(service.mapFilesService, 'updateChannelMapSyncedFilesCount')
      .mockResolvedValue(undefined as never)
    const updateFileMap = vi
      .spyOn(service.mapFilesService, 'updateFileMap')
      .mockResolvedValue({} as never)

    await (service as unknown as FolderSvc).createFolderInAssembly({
      assemblyChannelId: 'ch-1',
      itemPath: '/John_s Cafe',
      assemblyCreatePath: '/John_s Cafe',
      lastItem: true,
      tempFileType: 'folder',
      channelSyncId: 'cs-1',
      entry,
      basePath: '/John_s Cafe',
    })

    // No spurious count bump on the losing insert...
    expect(countSpy).not.toHaveBeenCalled()
    // ...but the winner's row still gets this entry's dbxFileId stamped.
    expect(updateFileMap).toHaveBeenCalledWith({ dbxFileId: 'dbx:folder' }, expect.anything())
  })
})

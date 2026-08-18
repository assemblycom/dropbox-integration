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

const folderParams = {
  assemblyChannelId: 'ch-1',
  itemPath: '/John_s Cafe',
  assemblyCreatePath: '/John_s Cafe',
  lastItem: true,
  tempFileType: 'folder',
  channelSyncId: 'cs-1',
  entry,
  basePath: '/John_s Cafe',
}

describe('createFolderInAssembly :: catch-branch discriminations (case 84)', () => {
  it('stamps the existing row (no recovery) when the re-lookup finds a row', async () => {
    // Pre-check misses, create hits "Folder already exists", re-lookup now finds the row.
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath')
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce({ id: 'row-x' } as never)
    createFileMock.mockRejectedValue(folderExistsError)
    const updateFileMap = vi
      .spyOn(service.mapFilesService, 'updateFileMap')
      .mockResolvedValue({} as never)

    await (service as unknown as FolderSvc).createFolderInAssembly(folderParams)

    expect(updateFileMap).toHaveBeenCalledWith({ dbxFileId: 'dbx:folder' }, expect.anything())
    expect(listFilesMock).not.toHaveBeenCalled() // no recovery paging
  })

  it('rethrows an error that is not "Folder already exists"', async () => {
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath').mockResolvedValue(
      undefined as never,
    )
    createFileMock.mockRejectedValue(new Error('network down'))

    await expect(
      (service as unknown as FolderSvc).createFolderInAssembly(folderParams),
    ).rejects.toThrow('network down')
  })
})

describe('recoverUnmappedAssemblyFolder :: paging + give-up (case 85)', () => {
  beforeEach(() => {
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath').mockResolvedValue(
      undefined as never,
    )
    createFileMock.mockRejectedValue(folderExistsError)
  })

  it('finds the folder on a later listFiles page (nextToken pagination)', async () => {
    listFilesMock
      .mockResolvedValueOnce({
        data: [{ id: 'asm:other', object: 'folder', path: 'Other' }],
        nextToken: 't1',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'asm:folder', object: 'folder', path: 'John_s Cafe' }],
        nextToken: undefined,
      })
    const insertFileMap = vi
      .spyOn(service.mapFilesService, 'insertFileMap')
      .mockResolvedValue({ id: 'row-1' } as never)
    vi.spyOn(service.mapFilesService, 'updateChannelMapSyncedFilesCount').mockResolvedValue(
      undefined as never,
    )

    await (service as unknown as FolderSvc).createFolderInAssembly(folderParams)

    expect(listFilesMock).toHaveBeenCalledTimes(2) // paged past the first page
    expect(listFilesMock.mock.calls[1][1]).toBe('t1') // followed the nextToken
    expect(insertFileMap).toHaveBeenCalledWith(
      expect.objectContaining({ assemblyFileId: 'asm:folder' }),
    )
  })

  it('gives up silently (no insert, no throw) when the folder is never found', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [{ id: 'asm:other', object: 'folder', path: 'Other' }],
      nextToken: undefined,
    })
    const insertFileMap = vi.spyOn(service.mapFilesService, 'insertFileMap')

    await expect(
      (service as unknown as FolderSvc).createFolderInAssembly(folderParams),
    ).resolves.toBeUndefined()

    expect(insertFileMap).not.toHaveBeenCalled()
  })
})

describe('handleFolderCreatedCase :: no-op guard (case 86)', () => {
  it('does not stamp dbxFileId when the entry is not the last folder item', async () => {
    // Folder already mapped → create is skipped and handleFolderCreatedCase is a no-op
    // because lastItem is false.
    vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath').mockResolvedValue({
      id: 'row-x',
    } as never)
    const updateFileMap = vi.spyOn(service.mapFilesService, 'updateFileMap')

    await (service as unknown as FolderSvc).createFolderInAssembly({
      ...folderParams,
      lastItem: false,
    })

    expect(updateFileMap).not.toHaveBeenCalled()
    expect(createFileMock).not.toHaveBeenCalled() // already mapped → no create attempt
  })
})

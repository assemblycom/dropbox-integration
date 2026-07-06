import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'

// Shared createFile mock, hoisted so the vi.mock factory can reference it.
const { createFileMock } = vi.hoisted(() => ({ createFileMock: vi.fn() }))

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
  },
  isCopilotApiError: () => false,
}))

vi.mock('@/trigger/processFileSync', () => ({
  bidirectionalMasterSync: { trigger: vi.fn() },
}))

import { SyncService } from '@/features/sync/lib/Sync.service'

const user = { portalId: 'p', token: 't', copilot: {} } as never
const connectionToken = { accountId: 'a', refreshToken: 'r', rootNamespaceId: 'n' } as never

const entry: DropboxFileListFolderSingleEntry = {
  '.tag': 'file',
  name: 'file.txt',
  path_display: "/root/John's Cafe/file.txt",
  id: 'dbx:1',
  content_hash: 'h1',
}

let service: SyncService

beforeEach(() => {
  vi.restoreAllMocks()
  createFileMock.mockReset()
  service = new SyncService(user, connectionToken)
})

describe('syncDropboxFilesToAssembly :: pre-resolves child paths from committed ancestors', () => {
  const opts = { dbxRootPath: '/root', assemblyChannelId: 'ch-1', channelSyncId: 'cs-1' } as never

  it('threads the diverged parent assemblyPath to the child without a per-segment lookup', async () => {
    // Existing mapped folder: Dropbox "/John's Cafe" lives in Assembly as "/John_s Cafe".
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([
      {
        itemPathLower: "/john's cafe",
        assemblyPath: '/John_s Cafe',
        assemblyFileId: 'a1',
        dbxFileId: 'd1',
      },
    ] as never)
    const getFromPath = vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath')
    const uploadSpy = vi
      .spyOn(
        service as unknown as { createAndUploadFileToAssembly: (a: unknown) => Promise<void> },
        'createAndUploadFileToAssembly',
      )
      .mockResolvedValue(undefined)

    await service.syncDropboxFilesToAssembly({
      entry,
      opts,
      isRetry: false,
    } as never)

    // The leaf file's create path is composed from the parent's stored assemblyPath...
    expect(uploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ assemblyCreatePath: '/John_s Cafe/file.txt' }),
    )
    // ...in-memory, so no per-segment DB resolution is needed.
    expect(getFromPath).not.toHaveBeenCalled()
  })
})

describe('completePendingAssemblyCreate :: creates at the pre-resolved path + stores it', () => {
  it('creates at the pre-resolved assemblyCreatePath and stores the returned path', async () => {
    vi.spyOn(service.mapFilesService, 'updateFileMap').mockResolvedValue({} as never)
    const markUpdated = vi
      .spyOn(service.mapFilesService, 'markUpdated')
      .mockResolvedValue({} as never)
    vi.spyOn(service.mapFilesService, 'updateChannelMapSyncedFilesCount').mockResolvedValue(
      undefined as never,
    )
    // Assembly echoes back the path WITHOUT a leading slash.
    createFileMock.mockResolvedValue({ id: 'asm:1', path: 'John_s Cafe/file.txt' })

    await service.completePendingAssemblyCreate({
      pendingRowId: 'row-1',
      assemblyCreatePath: '/John_s Cafe/file.txt',
      assemblyChannelId: 'ch-1',
      channelSyncId: 'cs-1',
      entry,
    })

    expect(createFileMock).toHaveBeenCalledWith('/John_s Cafe/file.txt', 'ch-1', 'file')
    // Row records the real Assembly path, normalized to a leading slash.
    expect(markUpdated).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ assemblyPath: '/John_s Cafe/file.txt' }),
    )
  })

  it('uses the assemblyPathOverride verbatim when provided (resync recreate)', async () => {
    vi.spyOn(service.mapFilesService, 'updateFileMap').mockResolvedValue({} as never)
    vi.spyOn(service.mapFilesService, 'markUpdated').mockResolvedValue({} as never)
    vi.spyOn(service.mapFilesService, 'updateChannelMapSyncedFilesCount').mockResolvedValue(
      undefined as never,
    )
    createFileMock.mockResolvedValue({ id: 'asm:1', path: '/John_s Cafe/report_.pdf' })

    await service.completePendingAssemblyCreate({
      pendingRowId: 'row-1',
      assemblyCreatePath: '/John@s Cafe/report@.pdf',
      assemblyChannelId: 'ch-1',
      channelSyncId: 'cs-1',
      entry,
      assemblyPathOverride: '/John_s Cafe/report_.pdf',
    })

    // Override wins over the pre-resolved path.
    expect(createFileMock).toHaveBeenCalledWith('/John_s Cafe/report_.pdf', 'ch-1', 'file')
  })
})

describe('syncAssemblyFilesToDropbox :: routes into the existing Dropbox folder', () => {
  const opts = { dbxRootPath: '/root', assemblyChannelId: 'ch-1', channelSyncId: 'cs-1' } as never

  it('resolves the diverged parent so the file lands in the original Dropbox folder', async () => {
    // Existing folder: Dropbox "John's Cafe" stored in Assembly as "John_s Cafe".
    vi.spyOn(service.mapFilesService, 'getMappedFolderByAssemblyPath').mockResolvedValue({
      itemPath: "/John's Cafe",
    } as never)
    const insert = vi
      .spyOn(service.mapFilesService, 'insertCreatePending')
      .mockResolvedValue({ id: 'p1' } as never)
    const complete = vi.spyOn(service, 'completePendingDropboxCreate').mockResolvedValue(undefined)

    await service.syncAssemblyFilesToDropbox({
      file: { id: 'f1', path: 'John_s Cafe/filename.txt', object: 'file' },
      opts,
    } as never)

    // Row keyed by the real Dropbox path, Assembly path recorded alongside.
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        itemPath: "/John's Cafe/filename.txt",
        assemblyPath: '/John_s Cafe/filename.txt',
      }),
    )
    // Dropbox create uses the resolved Dropbox path, not the raw Assembly path.
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ path: "John's Cafe/filename.txt" }),
      }),
    )
  })

  it('uses the raw path for a top-level file (no parent to resolve)', async () => {
    const lookup = vi.spyOn(service.mapFilesService, 'getMappedFolderByAssemblyPath')
    const insert = vi
      .spyOn(service.mapFilesService, 'insertCreatePending')
      .mockResolvedValue({ id: 'p1' } as never)
    vi.spyOn(service, 'completePendingDropboxCreate').mockResolvedValue(undefined)

    await service.syncAssemblyFilesToDropbox({
      file: { id: 'f1', path: 'top.txt', object: 'file' },
      opts,
    } as never)

    expect(lookup).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ itemPath: '/top.txt', assemblyPath: '/top.txt' }),
    )
  })
})

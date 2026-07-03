import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'

// SyncService's constructor chain builds DropboxClient + CopilotAPI, and it imports a
// Trigger.dev task at module load — stub all three so the service constructs in isolation.
vi.mock('@/lib/dropbox/DropboxClient', () => ({
  DropboxClient: class {
    getDropboxClient() {
      return {}
    }
    dbxAuthClient = { refreshAccessToken: vi.fn() }
  },
}))

vi.mock('@/lib/copilot/CopilotAPI', () => ({
  CopilotAPI: class {},
  isCopilotApiError: () => false,
}))

vi.mock('@/trigger/processFileSync', () => ({
  bidirectionalMasterSync: { trigger: vi.fn() },
}))

import { SyncService } from '@/features/sync/lib/Sync.service'
import logger from '@/lib/logger'

const user = { portalId: 'p', token: 't', copilot: {} } as never
const connectionToken = { accountId: 'a', refreshToken: 'r', rootNamespaceId: 'n' } as never

const opts = {
  dbxRootPath: '/root',
  assemblyChannelId: 'ch-1',
  channelSyncId: 'cs-1',
} as never

const makeEntry = (path_display: string): DropboxFileListFolderSingleEntry => ({
  '.tag': 'file',
  name: path_display.split('/').pop() as string,
  path_display,
  id: 'id:new',
})

let service: SyncService
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  service = new SyncService(user, connectionToken)
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
})

describe('syncDropboxFilesToAssembly :: Assembly disallowed characters', () => {
  const spyUpload = () =>
    vi
      .spyOn(
        service as unknown as { createAndUploadFileToAssembly: (a: unknown) => Promise<void> },
        'createAndUploadFileToAssembly',
      )
      .mockResolvedValue(undefined)

  it('defers leaf-file validation to the create step (gate does not skip on leaf name alone)', async () => {
    // The leaf name is invalid, but the gate must not skip here — existing files
    // must reach the create/resync step. The leaf name is checked downstream.
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([])
    const uploadSpy = spyUpload()

    await service.syncDropboxFilesToAssembly({
      entry: makeEntry('/root/report@.pdf'),
      opts,
      isRetry: false,
    } as never)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(uploadSpy).toHaveBeenCalled()
  })

  it('records failure (not a bare skip) when a retry hits a disallowed NEW folder', async () => {
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([])
    const uploadSpy = spyUpload()
    const failSpy = vi.spyOn(service.mapFilesService, 'markFailure').mockResolvedValue(undefined)

    await service.syncDropboxFilesToAssembly({
      entry: makeEntry('/root/re@port/clean.txt'),
      opts,
      isRetry: true,
      pendingRowId: 'row-9',
    } as never)

    expect(errorSpy).toHaveBeenCalled()
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(failSpy).toHaveBeenCalledWith('row-9', expect.any(String))
  })

  it('skips the entry when a NEW intermediate folder segment is disallowed', async () => {
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([])
    const uploadSpy = spyUpload()

    await service.syncDropboxFilesToAssembly({
      entry: makeEntry('/root/re@port/clean.txt'),
      opts,
      isRetry: false,
    } as never)

    expect(errorSpy).toHaveBeenCalled()
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('does NOT skip when the disallowed char is only in an already-existing folder', async () => {
    // The parent folder already exists (created before the rules changed).
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([
      { itemPathLower: '/re@port' },
    ] as never)
    const uploadSpy = spyUpload()

    await service.syncDropboxFilesToAssembly({
      entry: makeEntry('/root/re@port/clean.txt'),
      opts,
      isRetry: false,
    } as never)

    expect(errorSpy).not.toHaveBeenCalled()
    // The valid leaf under the existing folder still gets processed.
    expect(uploadSpy).toHaveBeenCalled()
  })

  it('proceeds for a valid name (accents allowed)', async () => {
    vi.spyOn(service.mapFilesService, 'getAllFileMaps').mockResolvedValue([])
    const uploadSpy = spyUpload()

    await service.syncDropboxFilesToAssembly({
      entry: makeEntry('/root/café résumé.pdf'),
      opts,
      isRetry: false,
    } as never)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(uploadSpy).toHaveBeenCalled()
  })
})

describe('createLeafFileInAssembly :: leaf name validation', () => {
  type LeafSvc = { createLeafFileInAssembly(p: unknown): Promise<void> }
  const leafParams = {
    assemblyChannelId: 'ch-1',
    itemPath: '/report@.pdf',
    channelSyncId: 'cs-1',
    entry: makeEntry('/root/report@.pdf'),
  }

  it('skips and removes the pending row when a NEW leaf name is disallowed', async () => {
    vi.spyOn(service.mapFilesService, 'insertCreatePending').mockResolvedValue({
      id: 'p1',
    } as never)
    const del = vi.spyOn(service.mapFilesService, 'deleteFileMap').mockResolvedValue(undefined)
    const drive = vi
      .spyOn(
        service as unknown as { driveAssemblyCreate: (...a: unknown[]) => Promise<void> },
        'driveAssemblyCreate',
      )
      .mockResolvedValue(undefined)

    await (service as unknown as LeafSvc).createLeafFileInAssembly(leafParams)

    expect(errorSpy).toHaveBeenCalled()
    expect(del).toHaveBeenCalledWith('p1')
    expect(drive).not.toHaveBeenCalled()
  })

  it('routes an already-synced leaf to resync without a validation error', async () => {
    // Insert conflict => the path already has a live row (existing legacy file).
    vi.spyOn(service.mapFilesService, 'insertCreatePending').mockResolvedValue(null as never)
    const resync = vi
      .spyOn(
        service as unknown as { resyncLeafOnContentChange: (p: unknown) => Promise<void> },
        'resyncLeafOnContentChange',
      )
      .mockResolvedValue(undefined)

    await (service as unknown as LeafSvc).createLeafFileInAssembly(leafParams)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(resync).toHaveBeenCalled()
  })
})

describe('syncAssemblyFilesToDropbox :: Dropbox disallowed characters', () => {
  it('skips the file and logs an error when the name has a backslash', async () => {
    const insertSpy = vi.spyOn(service.mapFilesService, 'insertCreatePending')

    await service.syncAssemblyFilesToDropbox({
      file: { id: 'f1', path: 'fol\\der/doc.txt', object: 'file' },
      opts,
    } as never)

    expect(errorSpy).toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('proceeds past the validation gate for a valid name (including @ * which Dropbox allows)', async () => {
    vi.spyOn(service.mapFilesService, 'getMappedFolderByAssemblyPath').mockResolvedValue(
      undefined as never,
    )
    const insertSpy = vi
      .spyOn(service.mapFilesService, 'insertCreatePending')
      .mockResolvedValue(null as never)

    await service.syncAssemblyFilesToDropbox({
      file: { id: 'f1', path: 'em@il */doc.txt', object: 'file' },
      opts,
    } as never)

    expect(errorSpy).not.toHaveBeenCalled()
    expect(insertSpy).toHaveBeenCalled()
  })
})

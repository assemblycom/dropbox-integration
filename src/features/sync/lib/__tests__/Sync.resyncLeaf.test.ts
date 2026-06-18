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

const user = { portalId: 'p', token: 't', copilot: {} } as never
const connectionToken = { accountId: 'a', refreshToken: 'r', rootNamespaceId: 'n' } as never

const baseEntry: DropboxFileListFolderSingleEntry = {
  '.tag': 'file',
  name: 'birthday.png',
  path_display: '/root/birthday.png',
  id: 'id:new',
}

const params = {
  assemblyChannelId: 'ch-1',
  itemPath: '/birthday.png',
  channelSyncId: 'cs-1',
  dbxRootPath: '/root',
  entry: baseEntry,
}

// getDbxMappedFileFromPath only returns rows that already have an assemblyFileId.
const row = (overrides: Record<string, unknown>) => overrides as never

let service: SyncService
// Private methods under test — reach them through a narrow cast.
let leaf: { createLeafFileInAssembly(p: typeof params): Promise<void> }

let insertSpy: ReturnType<typeof vi.spyOn>
let getPathSpy: ReturnType<typeof vi.spyOn>
let completeSpy: ReturnType<typeof vi.spyOn>
let removeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  service = new SyncService(user, connectionToken)
  leaf = service as unknown as typeof leaf

  insertSpy = vi.spyOn(service.mapFilesService, 'insertCreatePending')
  getPathSpy = vi.spyOn(service.mapFilesService, 'getDbxMappedFileFromPath')
  completeSpy = vi.spyOn(service, 'completePendingAssemblyCreate').mockResolvedValue(undefined)
  removeSpy = vi.spyOn(service, 'removeFileFromAssembly').mockResolvedValue(undefined)
})

describe('createLeafFileInAssembly', () => {
  it('creates the file when the path has no existing row', async () => {
    insertSpy.mockResolvedValueOnce(row({ id: 'row-1' }))

    await leaf.createLeafFileInAssembly(params)

    // Inserted with the leaf create-pending shape, then drove the Assembly create.
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      channelSyncId: 'cs-1',
      itemPath: '/birthday.png',
      dbxFileId: 'id:new',
    })
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ pendingRowId: 'row-1' }))
    // No conflict → never looked at the existing row or removed anything.
    expect(getPathSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
  })
})

describe('resyncLeafOnContentChange (via createLeafFileInAssembly path conflict)', () => {
  it('skips when the content is unchanged', async () => {
    insertSpy.mockResolvedValueOnce(null) // path conflict
    getPathSpy.mockResolvedValueOnce(row({ assemblyFileId: 'a1', contentHash: 'same' }))

    await leaf.createLeafFileInAssembly({
      ...params,
      entry: { ...baseEntry, content_hash: 'same' },
    })

    expect(removeSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('skips when there is no synced row for the path (race lost, or row not yet synced)', async () => {
    // getDbxMappedFileFromPath returns undefined for both: a concurrent insert that
    // won the path, and a row that exists but has no assemblyFileId yet.
    insertSpy.mockResolvedValueOnce(null) // path conflict
    getPathSpy.mockResolvedValueOnce(undefined)

    await leaf.createLeafFileInAssembly({ ...params, entry: { ...baseEntry, content_hash: 'new' } })

    expect(removeSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('skips when the incoming entry has no content_hash', async () => {
    insertSpy.mockResolvedValueOnce(null) // path conflict
    getPathSpy.mockResolvedValueOnce(row({ assemblyFileId: 'a1', contentHash: 'old' }))

    // entry has no content_hash → can't confirm a change → skip
    await leaf.createLeafFileInAssembly(params)

    expect(removeSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('skips when the stored row has no content_hash (no baseline to compare)', async () => {
    insertSpy.mockResolvedValueOnce(null) // path conflict
    getPathSpy.mockResolvedValueOnce(row({ assemblyFileId: 'a1', contentHash: null }))

    // existing.contentHash is null → no baseline → can't confirm a change → skip
    await leaf.createLeafFileInAssembly({ ...params, entry: { ...baseEntry, content_hash: 'new' } })

    expect(removeSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('removes and recreates when the content changed', async () => {
    insertSpy
      .mockResolvedValueOnce(null) // first insert: path conflict
      .mockResolvedValueOnce(row({ id: 'row-2' })) // recreate insert after removal
    getPathSpy.mockResolvedValueOnce(row({ assemblyFileId: 'a1', contentHash: 'old' }))

    await leaf.createLeafFileInAssembly({ ...params, entry: { ...baseEntry, content_hash: 'new' } })

    expect(removeSpy).toHaveBeenCalledWith(
      'cs-1',
      '/root',
      expect.objectContaining({ id: 'id:new', content_hash: 'new' }),
    )
    expect(insertSpy).toHaveBeenCalledTimes(2)
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ pendingRowId: 'row-2' }))
  })

  it('does not recreate when a concurrent insert re-took the path', async () => {
    insertSpy
      .mockResolvedValueOnce(null) // first insert: path conflict
      .mockResolvedValueOnce(null) // recreate insert also conflicts (race lost)
    getPathSpy.mockResolvedValueOnce(row({ assemblyFileId: 'a1', contentHash: 'old' }))

    await leaf.createLeafFileInAssembly({ ...params, entry: { ...baseEntry, content_hash: 'new' } })

    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(completeSpy).not.toHaveBeenCalled()
  })
})

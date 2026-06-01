import { beforeEach, describe, expect, it, vi } from 'vitest'

// Service method spies — shared across mocked class instances.
const markAttempt = vi.fn(async () => undefined)
const markFailure = vi.fn(async () => undefined)
const markUpdated = vi.fn(async () => undefined)
const markDeleted = vi.fn(async () => undefined)
const updateFileMap = vi.fn(async () => undefined)
const updateChannelMapSyncedFilesCount = vi.fn(async () => undefined)

const retrieveFile = vi.fn()
const deleteFile = vi.fn(async () => undefined)
const completePendingAssemblyCreate = vi.fn(async () => undefined)

const filesGetMetadata = vi.fn()
const channelSyncFindFirst = vi.fn()
const dropboxConnectionsFindFirst = vi.fn()

vi.mock('@/config/server.env', () => ({ default: { COPILOT_API_KEY: 'test-key' } }))

vi.mock('@/db', () => ({
  default: {
    query: {
      dropboxConnections: { findFirst: () => dropboxConnectionsFindFirst() },
      channelSync: { findFirst: () => channelSyncFindFirst() },
    },
  },
}))

vi.mock('@/lib/copilot/generateToken', () => ({ generateToken: () => 'token' }))
vi.mock('@/lib/copilot/models/User.model', () => ({
  default: { authenticate: async () => ({ portalId: 'p1' }) },
}))
vi.mock('@/lib/copilot/CopilotAPI', () => ({
  CopilotAPI: class {
    retrieveFile = retrieveFile
    deleteFile = deleteFile
  },
  // Mirror the production guard exactly (instanceof Error + the four SDK fields)
  // rather than importing it — the real module pulls in the Copilot SDK, which
  // vitest's ESM resolver can't load.
  isCopilotApiError: (e: unknown) => {
    if (!(e instanceof Error)) return false
    const x = e as { url?: unknown; status?: unknown; statusText?: unknown; body?: unknown }
    return (
      typeof x.url === 'string' &&
      typeof x.status === 'number' &&
      typeof x.statusText === 'string' &&
      typeof x.body === 'object' &&
      x.body !== null
    )
  },
}))
vi.mock('@/lib/dropbox/DropboxClient', () => ({
  DropboxClient: class {
    getDropboxClient = () => ({ filesGetMetadata })
  },
}))
vi.mock('@/features/sync/lib/Sync.service', () => ({
  SyncService: class {
    completePendingAssemblyCreate = completePendingAssemblyCreate
  },
}))
vi.mock('@/features/sync/lib/MapFiles.service', () => ({
  MapFilesService: class {
    markAttempt = markAttempt
    markFailure = markFailure
    markUpdated = markUpdated
    markDeleted = markDeleted
    updateFileMap = updateFileMap
    updateChannelMapSyncedFilesCount = updateChannelMapSyncedFilesCount
  },
}))

import { PendingAction, PendingActionTarget } from '@/db/constants'
import { retryFailedSyncsForPortal } from '../resync-failed-files.helper'

const DAY_MS = 24 * 60 * 60 * 1000

const makeRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'row-1',
    channelSyncId: 'cs-1',
    dbxFileId: 'id:dbx-1',
    itemPath: '/folder/file.txt',
    assemblyFileId: 'asm-1',
    object: 'file',
    createdAt: new Date(),
    pendingAction: PendingAction.CREATE,
    pendingActionTarget: PendingActionTarget.ASSEMBLY,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture, not the full select shape
  }) as any

const dbxFileEntry = {
  '.tag': 'file',
  name: 'file.txt',
  path_display: '/folder/file.txt',
  id: 'id:dbx-1',
  content_hash: 'hash-abc',
}

beforeEach(() => {
  vi.clearAllMocks()
  dropboxConnectionsFindFirst.mockResolvedValue({
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: 'ns',
    initiatedBy: 'user-1',
  })
  channelSyncFindFirst.mockResolvedValue({
    id: 'cs-1',
    assemblyChannelId: 'ach-1',
    dbxRootPath: '/root',
  })
  filesGetMetadata.mockResolvedValue({ result: dbxFileEntry })
})

describe('retryCreateInAssembly :: reconcile branches', () => {
  it('reconciles when the existing Assembly file is already completed', async () => {
    retrieveFile.mockResolvedValue({ status: 'completed' })

    await retryFailedSyncsForPortal('p1', [makeRow()])

    expect(markUpdated).toHaveBeenCalledWith('row-1', {
      assemblyFileId: 'asm-1',
      contentHash: 'hash-abc',
    })
    expect(updateChannelMapSyncedFilesCount).toHaveBeenCalledWith('cs-1')
    expect(completePendingAssemblyCreate).not.toHaveBeenCalled()
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('waits (marks failure) when the file is still pending and the row is young', async () => {
    retrieveFile.mockResolvedValue({ status: 'pending' })

    await retryFailedSyncsForPortal('p1', [makeRow({ createdAt: new Date() })])

    expect(markFailure).toHaveBeenCalledWith('row-1', expect.stringContaining('still pending'))
    expect(deleteFile).not.toHaveBeenCalled()
    expect(completePendingAssemblyCreate).not.toHaveBeenCalled()
  })

  it('reclaims (nulls id, deletes, re-creates) when pending past the cutoff', async () => {
    retrieveFile.mockResolvedValue({ status: 'pending' })
    const stale = new Date(Date.now() - 2 * DAY_MS)

    await retryFailedSyncsForPortal('p1', [makeRow({ createdAt: stale })])

    expect(updateFileMap).toHaveBeenCalledWith({ assemblyFileId: null }, expect.anything())
    expect(deleteFile).toHaveBeenCalledWith('asm-1')
    expect(completePendingAssemblyCreate).toHaveBeenCalledTimes(1)
    // id is nulled before the delete fires
    expect(updateFileMap.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFile.mock.invocationCallOrder[0],
    )
  })

  it('proceeds to create when the existing file is already gone (404)', async () => {
    retrieveFile.mockRejectedValue(
      Object.assign(new Error('Not found'), {
        url: 'https://api.copilot/files/asm-1',
        status: 404,
        statusText: 'Not Found',
        body: { message: 'Not found' },
      }),
    )

    await retryFailedSyncsForPortal('p1', [makeRow()])

    expect(completePendingAssemblyCreate).toHaveBeenCalledTimes(1)
    expect(markFailure).not.toHaveBeenCalled()
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('skips the reconcile check and creates directly when the row has no assemblyFileId', async () => {
    await retryFailedSyncsForPortal('p1', [makeRow({ assemblyFileId: null })])

    expect(retrieveFile).not.toHaveBeenCalled()
    expect(completePendingAssemblyCreate).toHaveBeenCalledTimes(1)
  })

  it('soft-deletes the row when the Dropbox source no longer exists', async () => {
    filesGetMetadata.mockResolvedValue({ result: { '.tag': 'deleted', name: 'file.txt' } })

    await retryFailedSyncsForPortal('p1', [makeRow()])

    expect(markDeleted).toHaveBeenCalledWith('row-1')
    expect(retrieveFile).not.toHaveBeenCalled()
    expect(completePendingAssemblyCreate).not.toHaveBeenCalled()
  })
})

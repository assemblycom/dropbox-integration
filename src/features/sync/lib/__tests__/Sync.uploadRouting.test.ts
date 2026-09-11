import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DROPBOX_SINGLE_UPLOAD_MAX_BYTES,
  DROPBOX_UPLOAD_CHUNK_BYTES,
} from '@/features/sync/constant'

// The Assembly file body is fetched via node-fetch — mock it so no real request runs.
vi.mock('node-fetch', () => ({ default: vi.fn() }))

// SyncService builds a DropboxClient + CopilotAPI and imports a Trigger.dev task at
// module load — stub all three so the service constructs in isolation.
vi.mock('@/lib/dropbox/DropboxClient', () => ({
  DropboxClient: class {
    getDropboxClient() {
      return {}
    }
    dbxAuthClient = { refreshAccessToken: vi.fn() }
    uploadFile = vi.fn().mockResolvedValue({ id: 'single-id', contentHash: 'single-hash' })
    uploadFileSession = vi.fn().mockResolvedValue({ id: 'session-id', contentHash: 'session-hash' })
  },
}))

vi.mock('@/lib/copilot/CopilotAPI', () => ({
  CopilotAPI: class {},
  isCopilotApiError: () => false,
}))

vi.mock('@/trigger/processFileSync', () => ({
  bidirectionalMasterSync: { trigger: vi.fn() },
}))

import fetch from 'node-fetch'
import { SyncService } from '@/features/sync/lib/Sync.service'

const mockedFetch = vi.mocked(fetch)

const user = { portalId: 'p', token: 't', copilot: {} } as never
const connectionToken = { accountId: 'a', refreshToken: 'r', rootNamespaceId: 'n' } as never

type UploadInternals = {
  uploadFileInDropbox(
    file: unknown,
    path: string,
  ): Promise<{ dbxFileId: string; contentHash: string }>
  dbxClient: {
    uploadFile: ReturnType<typeof vi.fn>
    uploadFileSession: ReturnType<typeof vi.fn>
  }
}

const fileWithSize = (size: number | undefined) => ({
  id: 'asm-1',
  downloadUrl: 'https://assembly/download',
  size,
})

let service: SyncService
let internals: UploadInternals

beforeEach(() => {
  service = new SyncService(user, connectionToken)
  internals = service as unknown as UploadInternals
  mockedFetch.mockResolvedValue({ ok: true, status: 200, body: {} } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('uploadFileInDropbox routing', () => {
  it('uses the single-shot upload when the file is at or below the limit', async () => {
    const result = await internals.uploadFileInDropbox(
      fileWithSize(DROPBOX_SINGLE_UPLOAD_MAX_BYTES),
      '/root/small.txt',
    )

    expect(internals.dbxClient.uploadFile).toHaveBeenCalledTimes(1)
    expect(internals.dbxClient.uploadFileSession).not.toHaveBeenCalled()
    expect(result).toEqual({ dbxFileId: 'single-id', contentHash: 'single-hash' })
  })

  it('uses an upload session when the file is over the limit', async () => {
    const result = await internals.uploadFileInDropbox(
      fileWithSize(DROPBOX_SINGLE_UPLOAD_MAX_BYTES + 1),
      '/root/big.bin',
    )

    expect(internals.dbxClient.uploadFile).not.toHaveBeenCalled()
    expect(internals.dbxClient.uploadFileSession).toHaveBeenCalledTimes(1)
    expect(internals.dbxClient.uploadFileSession.mock.calls[0][0]).toMatchObject({
      filePath: '/root/big.bin',
      chunkSize: DROPBOX_UPLOAD_CHUNK_BYTES,
      rootNamespaceId: 'n',
      refreshToken: 'r',
    })
    expect(typeof internals.dbxClient.uploadFileSession.mock.calls[0][0].getBody).toBe('function')
    expect(result).toEqual({ dbxFileId: 'session-id', contentHash: 'session-hash' })
  })

  it('uses an upload session when the size is unknown', async () => {
    await internals.uploadFileInDropbox(fileWithSize(undefined), '/root/unknown.bin')

    expect(internals.dbxClient.uploadFile).not.toHaveBeenCalled()
    expect(internals.dbxClient.uploadFileSession).toHaveBeenCalledTimes(1)
  })

  it('throws instead of uploading when the Assembly download responds with a non-ok status', async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 403, body: {} } as never)

    await expect(
      internals.uploadFileInDropbox(fileWithSize(1024), '/root/small.txt'),
    ).rejects.toThrow(/download/i)

    expect(internals.dbxClient.uploadFile).not.toHaveBeenCalled()
  })
})

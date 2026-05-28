import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub db.query.fileFolderSync.findMany; per-test we override its return.
const findManyImpl = vi.fn<() => Promise<unknown[]>>(async () => [])
const findFirstChannelSync = vi.fn<() => Promise<unknown>>(async () => undefined)
const findFirstDropboxConnection = vi.fn<() => Promise<unknown>>(async () => undefined)
const updateReturning = vi.fn<() => Promise<unknown[]>>(async () => [])
// Captures every .set(payload) call in order; first index is the first update
// in the service, etc. Tests assert on this to verify which payloads were written.
const updateSetSpy = vi.fn<(payload: unknown) => void>()

vi.mock('@/db', () => ({
  default: {
    query: {
      fileFolderSync: {
        findMany: (..._args: unknown[]) => findManyImpl(),
      },
      channelSync: {
        findFirst: (..._args: unknown[]) => findFirstChannelSync(),
      },
      dropboxConnections: {
        findFirst: (..._args: unknown[]) => findFirstDropboxConnection(),
      },
    },
    update: () => ({
      set: (payload: unknown) => {
        updateSetSpy(payload)
        return {
          where: () => ({
            returning: () => updateReturning(),
          }),
        }
      },
    }),
  },
}))

const triggerSpy = vi.fn<(payload: unknown) => Promise<undefined>>(async () => undefined)
const orchestratorTrigger = vi.fn<(payload: unknown, opts?: unknown) => Promise<undefined>>(
  async () => undefined,
)

vi.mock('@/trigger/processFileSync', () => ({
  resyncFailedFilesInAssembly: {
    trigger: (payload: unknown) => {
      triggerSpy(payload)
      return Promise.resolve()
    },
  },
  resyncFailedFilesAndMasterSync: {
    trigger: (payload: unknown, opts?: unknown) => orchestratorTrigger(payload, opts),
  },
}))

import {
  BACKOFF_INTERVAL_MINUTES,
  MAX_ATTEMPTS,
  ResyncService,
} from '@/features/workers/resync-failed-files/lib/resync-failed-files.service'

beforeEach(() => {
  findManyImpl.mockClear()
  findManyImpl.mockImplementation(async () => [])
  findFirstChannelSync.mockClear()
  findFirstChannelSync.mockImplementation(async () => undefined)
  findFirstDropboxConnection.mockClear()
  findFirstDropboxConnection.mockImplementation(async () => undefined)
  updateReturning.mockClear()
  updateReturning.mockImplementation(async () => [])
  updateSetSpy.mockClear()
  triggerSpy.mockClear()
  orchestratorTrigger.mockClear()
  orchestratorTrigger.mockImplementation(async () => undefined)
})

describe('sweeper constants', () => {
  it('caps attempts at 10 and uses 5-minute scaled backoff', () => {
    expect(MAX_ATTEMPTS).toBe(10)
    expect(BACKOFF_INTERVAL_MINUTES).toBe(5)
  })
})

describe('ResyncService.resyncFailedFiles', () => {
  it('groups rows by portalId and triggers the worker task once per portal', async () => {
    findManyImpl.mockImplementationOnce(async () => [
      { id: 'r1', portalId: 'p1' },
      { id: 'r2', portalId: 'p1' },
      { id: 'r3', portalId: 'p2' },
    ])

    await new ResyncService().resyncFailedFiles()

    expect(triggerSpy).toHaveBeenCalledTimes(2)

    const calls = triggerSpy.mock.calls.map(
      (c) => c[0] as { portalId: string; failedSyncs: unknown[] },
    )
    const p1 = calls.find((c) => c.portalId === 'p1')
    const p2 = calls.find((c) => c.portalId === 'p2')

    expect(p1?.failedSyncs).toHaveLength(2)
    expect(p2?.failedSyncs).toHaveLength(1)
  })

  it('triggers nothing when there are no failed syncs', async () => {
    findManyImpl.mockImplementationOnce(async () => [])
    await new ResyncService().resyncFailedFiles()
    expect(triggerSpy).not.toHaveBeenCalled()
  })
})

describe('ResyncService.resyncFailedFilesForChannel', () => {
  const user = { portalId: 'p1' } as unknown as Parameters<
    ResyncService['resyncFailedFilesForChannel']
  >[1]

  it('throws when the channel mapping is not found', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => undefined)
    await expect(new ResyncService().resyncFailedFilesForChannel('c1', user)).rejects.toThrow(
      'Channel mapping not found',
    )
    expect(orchestratorTrigger).not.toHaveBeenCalled()
  })

  it('throws 409 when a resync is already in progress for the channel', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
      resyncingAt: new Date(),
    }))

    await expect(new ResyncService().resyncFailedFilesForChannel('c1', user)).rejects.toThrow(
      'Resync already in progress for this channel',
    )
    expect(orchestratorTrigger).not.toHaveBeenCalled()
  })

  it('throws when no active dropbox connection exists for the portal', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
    }))
    findFirstDropboxConnection.mockImplementationOnce(async () => undefined)

    await expect(new ResyncService().resyncFailedFilesForChannel('c1', user)).rejects.toThrow(
      'Dropbox connection not found',
    )
    expect(orchestratorTrigger).not.toHaveBeenCalled()
  })

  it('triggers the orchestrator with concurrencyKey=channelSyncId and forwards the bidirectional payload', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
    }))
    findFirstDropboxConnection.mockImplementationOnce(async () => ({
      refreshToken: 'rt',
      accountId: 'acc',
      rootNamespaceId: 'ns',
    }))
    updateReturning.mockImplementationOnce(async () => [
      { id: 'r1', portalId: 'p1', channelSyncId: 'c1' },
    ])

    const result = await new ResyncService().resyncFailedFilesForChannel('c1', user)

    expect(result).toEqual({ pendingCount: 1 })
    expect(orchestratorTrigger).toHaveBeenCalledTimes(1)

    const [payload, opts] = orchestratorTrigger.mock.calls[0] as [
      {
        portalId: string
        channelSyncId: string
        failedSyncs: { id: string }[]
        bidirectionalPayload: {
          dbxRootPath: string
          assemblyChannelId: string
          connectionToken: { refreshToken: string; accountId: string; rootNamespaceId: string }
        }
      },
      { concurrencyKey: string },
    ]
    expect(payload.portalId).toBe('p1')
    expect(payload.channelSyncId).toBe('c1')
    expect(payload.failedSyncs).toHaveLength(1)
    expect(payload.bidirectionalPayload.dbxRootPath).toBe('/root')
    expect(payload.bidirectionalPayload.assemblyChannelId).toBe('ac1')
    expect(payload.bidirectionalPayload.connectionToken.refreshToken).toBe('rt')
    expect(opts.concurrencyKey).toBe('c1')

    // 2 updates expected on the happy path:
    //   1) reset tombstone attempt counters on file_folder_sync rows
    //   2) write resyncingAt on channel_sync so the UI shows "Resyncing..."
    expect(updateSetSpy).toHaveBeenCalledTimes(2)
    expect(updateSetSpy.mock.calls[0][0]).toMatchObject({
      pendingActionAttempts: 0,
      pendingActionLastAttemptAt: null,
    })
    expect(updateSetSpy.mock.calls[1][0]).toMatchObject({
      resyncingAt: expect.any(Date),
    })
  })

  it('accepts connections with a null rootNamespaceId (personal Dropbox accounts)', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
    }))
    findFirstDropboxConnection.mockImplementationOnce(async () => ({
      refreshToken: 'rt',
      accountId: 'acc',
      rootNamespaceId: null,
    }))
    updateReturning.mockImplementationOnce(async () => [])

    await expect(new ResyncService().resyncFailedFilesForChannel('c1', user)).resolves.toEqual({
      pendingCount: 0,
    })

    const [payload] = orchestratorTrigger.mock.calls[0] as [
      { bidirectionalPayload: { connectionToken: { rootNamespaceId: string | null } } },
      unknown,
    ]
    expect(payload.bidirectionalPayload.connectionToken.rootNamespaceId).toBeNull()
  })

  it('clears resyncingAt and re-throws when the orchestrator trigger() fails', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
    }))
    findFirstDropboxConnection.mockImplementationOnce(async () => ({
      refreshToken: 'rt',
      accountId: 'acc',
      rootNamespaceId: 'ns',
    }))
    updateReturning.mockImplementationOnce(async () => [])
    orchestratorTrigger.mockImplementationOnce(() =>
      Promise.reject(new Error('trigger.dev unavailable')),
    )

    await expect(new ResyncService().resyncFailedFilesForChannel('c1', user)).rejects.toThrow(
      'trigger.dev unavailable',
    )

    // 3 updates expected:
    //   1) reset attempt counters
    //   2) set resyncingAt (before trigger)
    //   3) clear resyncingAt (rollback after trigger threw)
    expect(updateSetSpy).toHaveBeenCalledTimes(3)
    expect(updateSetSpy.mock.calls[1][0]).toMatchObject({ resyncingAt: expect.any(Date) })
    expect(updateSetSpy.mock.calls[2][0]).toMatchObject({ resyncingAt: null })
  })

  it('still fires the orchestrator (bidirectional) when there are zero pending rows to reset', async () => {
    findFirstChannelSync.mockImplementationOnce(async () => ({
      id: 'c1',
      portalId: 'p1',
      assemblyChannelId: 'ac1',
      dbxRootPath: '/root',
    }))
    findFirstDropboxConnection.mockImplementationOnce(async () => ({
      refreshToken: 'rt',
      accountId: 'acc',
      rootNamespaceId: 'ns',
    }))
    updateReturning.mockImplementationOnce(async () => [])

    const result = await new ResyncService().resyncFailedFilesForChannel('c1', user)

    expect(result).toEqual({ pendingCount: 0 })
    expect(orchestratorTrigger).toHaveBeenCalledTimes(1)
    const [payload] = orchestratorTrigger.mock.calls[0] as [{ failedSyncs: unknown[] }, unknown]
    expect(payload.failedSyncs).toEqual([])
  })
})

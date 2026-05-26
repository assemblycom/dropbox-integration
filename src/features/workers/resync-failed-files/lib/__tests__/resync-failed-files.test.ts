import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub db.query.fileFolderSync.findMany; per-test we override its return.
const findManyImpl = vi.fn<() => Promise<unknown[]>>(async () => [])

vi.mock('@/db', () => ({
  default: {
    query: {
      fileFolderSync: {
        findMany: (..._args: unknown[]) => findManyImpl(),
      },
    },
  },
}))

// Capture the trigger call so we can assert on per-portal fan-out.
const triggerSpy = vi.fn<(payload: unknown) => Promise<undefined>>(async () => undefined)

vi.mock('@/trigger/processFileSync', () => ({
  resyncFailedFilesInAssembly: {
    trigger: (payload: unknown) => {
      triggerSpy(payload)
      return Promise.resolve()
    },
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
  triggerSpy.mockClear()
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

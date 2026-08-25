import { describe, expect, it, vi } from 'vitest'
import { BATCH_CHUNK_SIZE } from '@/features/sync/constant'
import { chunk, fanOutAndWait } from '@/lib/fanOut'

describe('chunk', () => {
  it('splits into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns an empty array for no items', () => {
    expect(chunk([], 3)).toEqual([])
  })
})

describe('fanOutAndWait', () => {
  it('does not trigger the task for an empty list', async () => {
    const task = { batchTriggerAndWait: vi.fn(() => Promise.resolve()) }

    await fanOutAndWait(task, [] as { payload: string }[], 'portal-1')

    expect(task.batchTriggerAndWait).not.toHaveBeenCalled()
  })

  it('attaches the concurrencyKey to every item', async () => {
    type Item = { payload: string; options?: { concurrencyKey?: string } }
    const task = { batchTriggerAndWait: vi.fn((_items: Item[]) => Promise.resolve()) }

    await fanOutAndWait(task, [{ payload: 'a' }, { payload: 'b' }], 'portal-1')

    expect(task.batchTriggerAndWait.mock.calls[0][0]).toEqual([
      { payload: 'a', options: { concurrencyKey: 'portal-1' } },
      { payload: 'b', options: { concurrencyKey: 'portal-1' } },
    ])
  })

  it('merges the concurrencyKey into existing item options', async () => {
    type Item = { payload: string; options?: Record<string, unknown> }
    const task = { batchTriggerAndWait: vi.fn((_items: Item[]) => Promise.resolve()) }

    await fanOutAndWait(task, [{ payload: 'a', options: { idempotencyKey: 'k1' } }], 'portal-1')

    expect(task.batchTriggerAndWait.mock.calls[0][0]).toEqual([
      { payload: 'a', options: { idempotencyKey: 'k1', concurrencyKey: 'portal-1' } },
    ])
  })

  it('chunks large fan-outs by BATCH_CHUNK_SIZE', async () => {
    const task = { batchTriggerAndWait: vi.fn(() => Promise.resolve()) }
    const items = Array.from({ length: BATCH_CHUNK_SIZE * 2 + 1 }, (_, i) => ({ payload: i }))

    await fanOutAndWait(task, items, 'portal-1')

    expect(task.batchTriggerAndWait).toHaveBeenCalledTimes(3)
  })

  it('awaits batches sequentially — never two waits in flight (Trigger.dev bans parallel waits)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const task = {
      batchTriggerAndWait: vi.fn(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Promise.resolve()
        await Promise.resolve()
        inFlight -= 1
      }),
    }
    const items = Array.from({ length: BATCH_CHUNK_SIZE * 2 + 1 }, (_, i) => ({ payload: i }))

    await fanOutAndWait(task, items, 'portal-1')

    expect(task.batchTriggerAndWait.mock.calls.length).toBeGreaterThan(1)
    expect(maxInFlight).toBe(1)
  })
})

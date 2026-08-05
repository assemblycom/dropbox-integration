import { describe, expect, it, vi } from 'vitest'
import { sleep } from '@/utils/sleep'
import { mockSleepInstant } from './sleep'

// Hoisted: auto-mocks @/utils/sleep for this whole file.
vi.mock('@/utils/sleep')

describe('mockSleepInstant', () => {
  it('resolves immediately and records the requested duration', async () => {
    const spy = mockSleepInstant()
    await sleep(5000)
    expect(spy).toHaveBeenCalledWith(5000)
  })

  it('records multiple calls in order without waiting', async () => {
    const spy = mockSleepInstant()
    await sleep(800)
    await sleep(5000)
    expect(spy).toHaveBeenNthCalledWith(1, 800)
    expect(spy).toHaveBeenNthCalledWith(2, 5000)
  })
})

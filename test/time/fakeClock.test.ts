import { afterEach, describe, expect, it, vi } from 'vitest'
import { sleep } from '@/utils/sleep'
import { useFakeClock } from './fakeClock'

afterEach(() => vi.useRealTimers())

describe('useFakeClock', () => {
  it('freezes now at the given instant', () => {
    const clock = useFakeClock('2026-03-01T12:00:00.000Z')
    expect(new Date().toISOString()).toBe('2026-03-01T12:00:00.000Z')
    expect(Date.now()).toBe(new Date('2026-03-01T12:00:00.000Z').getTime())
    clock.restore()
  })

  it('advances deterministically with advanceByMinutes', async () => {
    const clock = useFakeClock('2026-03-01T12:00:00.000Z')
    await clock.advanceByMinutes(5)
    expect(new Date().toISOString()).toBe('2026-03-01T12:05:00.000Z')
    clock.restore()
  })

  it('advances hours', async () => {
    const clock = useFakeClock('2026-03-01T12:00:00.000Z')
    await clock.advanceByHours(2)
    expect(new Date().toISOString()).toBe('2026-03-01T14:00:00.000Z')
    clock.restore()
  })

  it('flushes a real sleep() without really waiting', async () => {
    const clock = useFakeClock()
    let resolved = false
    const p = sleep(5000).then(() => {
      resolved = true
    })
    await clock.advanceBy(5000)
    await p
    expect(resolved).toBe(true)
    clock.restore()
  })

  it('setNow jumps to an absolute instant', () => {
    const clock = useFakeClock()
    clock.setNow(new Date('2030-01-01T00:00:00.000Z'))
    expect(new Date().getFullYear()).toBe(2030)
    clock.restore()
  })

  it('restore returns to real time', () => {
    const clock = useFakeClock('2000-01-01T00:00:00.000Z')
    clock.restore()
    expect(new Date().getFullYear()).toBeGreaterThan(2020)
  })
})

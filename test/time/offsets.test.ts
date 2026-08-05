import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFakeClock } from './fakeClock'
import { daysAgo, fromNow, hoursAgo, minutesAgo, msAgo, secondsAgo } from './offsets'

afterEach(() => vi.useRealTimers())

describe('offset helpers (real time)', () => {
  it('minutesAgo returns a time before now', () => {
    expect(minutesAgo(5).getTime()).toBeLessThan(Date.now())
  })

  it('fromNow returns a time after now', () => {
    expect(fromNow(10_000).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('offset helpers (frozen clock — exact)', () => {
  it('are exact relative to frozen now', () => {
    const clock = useFakeClock('2026-06-01T00:00:00.000Z')
    expect(msAgo(500).toISOString()).toBe('2026-05-31T23:59:59.500Z')
    expect(secondsAgo(30).toISOString()).toBe('2026-05-31T23:59:30.000Z')
    expect(minutesAgo(5).toISOString()).toBe('2026-05-31T23:55:00.000Z')
    expect(hoursAgo(2).toISOString()).toBe('2026-05-31T22:00:00.000Z')
    expect(daysAgo(1).toISOString()).toBe('2026-05-31T00:00:00.000Z')
    expect(fromNow(60_000).toISOString()).toBe('2026-06-01T00:01:00.000Z')
    clock.restore()
  })
})

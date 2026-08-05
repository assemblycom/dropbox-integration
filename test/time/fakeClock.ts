import { vi } from 'vitest'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

// Faked sources exclude nextTick/queueMicrotask so promises still resolve.
const FAKED = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const

export interface FakeClock {
  advanceBy(ms: number): Promise<void>
  advanceByMinutes(n: number): Promise<void>
  advanceByHours(n: number): Promise<void>
  setNow(date: Date): void
  restore(): void
}

// Freezes time for one test. Advancing is async so pending sleep() calls flush.
export function useFakeClock(iso = '2026-01-01T00:00:00.000Z'): FakeClock {
  vi.useFakeTimers({ toFake: [...FAKED] })
  vi.setSystemTime(new Date(iso))
  return {
    async advanceBy(ms) {
      await vi.advanceTimersByTimeAsync(ms)
    },
    async advanceByMinutes(n) {
      await vi.advanceTimersByTimeAsync(n * MINUTE_MS)
    },
    async advanceByHours(n) {
      await vi.advanceTimersByTimeAsync(n * HOUR_MS)
    },
    setNow(date) {
      vi.setSystemTime(date)
    },
    restore() {
      vi.useRealTimers()
    },
  }
}

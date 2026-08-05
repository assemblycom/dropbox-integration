import { type Mock, vi } from 'vitest'
import { sleep } from '@/utils/sleep'

// Instant spy for sleep() — assert the wait (e.g. toHaveBeenCalledWith(5000))
// with no real delay. Caller's file must hoist vi.mock('@/utils/sleep') first.
export function mockSleepInstant(): Mock<typeof sleep> {
  const spy = vi.mocked(sleep)
  // Reset call history — clearMocks is off in this project.
  spy.mockClear()
  spy.mockImplementation(() => Promise.resolve())
  return spy
}

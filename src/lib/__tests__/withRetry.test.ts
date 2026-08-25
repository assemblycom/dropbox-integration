import { DropboxResponseError } from 'dropbox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withRetry } from '@/lib/withRetry'
import { sleep } from '@/utils/sleep'

// Keep Sentry inert and sleep instant so retries don't wait in real time.
vi.mock('@sentry/nextjs', () => ({
  default: { withScope: (fn: (scope: unknown) => void) => fn({ addEventProcessor: vi.fn() }) },
}))
vi.mock('@/utils/sleep')

// A Copilot error carries only a numeric status (no retry-after header).
const copilot = (status: number) => Object.assign(new Error('copilot error'), { status })

// Tiny pRetry backoff so tests stay fast; the 1s Copilot wait is mocked separately.
const fast = { minTimeout: 1, maxTimeout: 2 }

beforeEach(() => {
  vi.mocked(sleep).mockReset()
  vi.mocked(sleep).mockResolvedValue(undefined)
})

describe('withRetry — Copilot (Assembly) rate-limit backpressure', () => {
  it('waits ~1s on a Copilot 429, then retries to success', async () => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      return calls === 1 ? Promise.reject(copilot(429)) : Promise.resolve('ok')
    })

    const result = await withRetry(fn, [], fast)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(1000)
  })

  it('does not retry a non-retryable Copilot status (404)', async () => {
    const fn = vi.fn(() => Promise.reject(copilot(404)))

    await expect(withRetry(fn, [], fast)).rejects.toThrow('copilot error')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('defaults to 3 retries (4 attempts) when no retries option is given', async () => {
    const fn = vi.fn(() => Promise.reject(copilot(429)))

    await expect(withRetry(fn, [], fast)).rejects.toThrow('copilot error')
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('honors a raised retries option (retries: 6 → 7 attempts)', async () => {
    const fn = vi.fn(() => Promise.reject(copilot(429)))

    await expect(withRetry(fn, [], { ...fast, retries: 6 })).rejects.toThrow('copilot error')
    expect(fn).toHaveBeenCalledTimes(7)
    // Waited before each of the 6 retries, but not before the final give-up.
    expect(vi.mocked(sleep)).toHaveBeenCalledTimes(6)
  })

  it('does not apply the fixed 1s Copilot wait to a Dropbox 429', async () => {
    // Dropbox 429 must not trigger the Copilot 1s wait.
    const dbxError = new DropboxResponseError(429, { get: () => null }, { error_summary: 'rate' })
    const fn = vi.fn(() => Promise.reject(dbxError))

    await expect(withRetry(fn, [], fast)).rejects.toBeInstanceOf(DropboxResponseError)
    expect(vi.mocked(sleep)).not.toHaveBeenCalledWith(1000)
    expect(fn.mock.calls.length).toBeGreaterThan(1)
  })
})

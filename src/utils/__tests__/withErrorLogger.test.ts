import { describe, expect, it, vi } from 'vitest'

// Stub the Trigger SDK logger for this unit test.
vi.mock('@trigger.dev/sdk', () => ({
  ApiError: class ApiError extends Error {},
  logger: { error: vi.fn() },
}))

const { withErrorLogging } = await import('@/utils/withErrorLogger')

describe('withErrorLogging', () => {
  it('returns the wrapped function result on success', async () => {
    await expect(withErrorLogging({ id: 1 }, () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('rethrows the error after logging it', async () => {
    const err = new Error('boom')
    await expect(
      withErrorLogging({ id: 1 }, () => {
        throw err
      }),
    ).rejects.toBe(err)
  })
})

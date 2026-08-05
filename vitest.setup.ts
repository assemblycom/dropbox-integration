import { afterEach, vi } from 'vitest'
import { applyPlaceholderServerEnv } from './test/support/placeholder-env'

// Provide placeholder env vars so server-only modules that validate via Zod
// at import time don't blow up during tests. Tests must not rely on these
// values for behavioral assertions — they exist solely to satisfy schema parse.
applyPlaceholderServerEnv()
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'

// Safety net: if a test froze time via useFakeClock() and forgot to restore(),
// reset to real timers so it can't leak into the next test. A no-op when timers
// were never faked.
afterEach(() => {
  vi.useRealTimers()
})

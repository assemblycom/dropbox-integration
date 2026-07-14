import { applyPlaceholderServerEnv } from './test/support/placeholder-env'

// Provide placeholder env vars so server-only modules that validate via Zod
// at import time don't blow up during tests. Tests must not rely on these
// values for behavioral assertions — they exist solely to satisfy schema parse.
applyPlaceholderServerEnv()
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'

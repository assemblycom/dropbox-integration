import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Integration tests run against a real Postgres (Testcontainers). Kept in a
// separate project from the unit run so `pnpm test` stays fast and container-free.
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Same stub the unit config uses — `server-only` throws on import outside
      // Next's bundler.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    setupFiles: ['./test/integration/setup.ts'],
    server: {
      // `copilot-node-sdk` is a pure-ESM package whose dist does an internal
      // directory import (`../codegen/api`, resolved to its `index.js` only by
      // bundler-style resolution). Node's native ESM loader can't resolve that
      // when Vite externalizes the package, so force it through Vite's own
      // resolver instead.
      deps: { inline: ['copilot-node-sdk'] },
    },
    // One container, one shared DB — run files serially so truncate-between-tests
    // isolation is safe.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run pulls the postgres image
  },
})

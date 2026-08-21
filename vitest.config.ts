import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // `server-only` always throws on import; Next.js's bundler normally swaps
      // it for an empty module on the server. Vitest has no equivalent, so we
      // alias to a local empty stub.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.test.ts'],
    // Integration tests run in a separate project (vitest.integration.config.ts)
    // against a real Postgres container — keep them out of the fast unit run.
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    server: {
      // Force @assembly-js/node-sdk through Vite's resolver (Node ESM can't resolve its dist directory import).
      deps: { inline: ['@assembly-js/node-sdk'] },
    },
  },
})

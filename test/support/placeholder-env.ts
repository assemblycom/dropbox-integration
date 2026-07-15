// Placeholder server env so Zod-validated `server-only` modules import in tests.
// Most values just satisfy `ServerEnvSchema`. Two affect behaviour: COPILOT_ENV
// (Copilot SDK apiKey-trust) and DROPBOX_API_URL (the MSW content host).
// DATABASE_URL is set per-run elsewhere (unit stubs it; integration uses Testcontainers).
export function applyPlaceholderServerEnv() {
  // Copilot SDK trusts the supplied apiKey (skips token decryption) only when
  // COPILOT_ENV is 'local'/'__SECRET_STAGING__'. Vitest doesn't load `.env`.
  process.env.COPILOT_ENV ??= 'local'
  process.env.COPILOT_API_KEY ??= 'test-copilot-api-key'
  process.env.DROPBOX_APP_KEY ??= 'test-dropbox-app-key'
  process.env.DROPBOX_APP_SECRET ??= 'test-dropbox-app-secret'
  process.env.DROPBOX_REDIRECT_URI ??= 'https://test.example.com/callback'
  process.env.DROPBOX_SCOPES ??= 'files.content.read files.content.write'
  process.env.DROPBOX_API_URL ??= 'https://content.dropboxapi.com'
  process.env.WEBHOOK_CATCHUP_CRON ??= '*/5 * * * *'
}

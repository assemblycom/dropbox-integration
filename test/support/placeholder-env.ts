// Placeholder server env so Zod-validated `server-only` modules import cleanly in
// tests. Values are never asserted on — they only satisfy `ServerEnvSchema`
// (src/config/server.env.ts). DATABASE_URL is intentionally NOT set here: the
// unit run stubs it, the integration run points it at the Testcontainers DB.
export function applyPlaceholderServerEnv() {
  process.env.COPILOT_API_KEY ??= 'test-copilot-api-key'
  process.env.DROPBOX_APP_KEY ??= 'test-dropbox-app-key'
  process.env.DROPBOX_APP_SECRET ??= 'test-dropbox-app-secret'
  process.env.DROPBOX_REDIRECT_URI ??= 'https://test.example.com/callback'
  process.env.DROPBOX_SCOPES ??= 'files.content.read files.content.write'
  process.env.DROPBOX_API_URL ??= 'https://api.dropboxapi.com'
  process.env.WEBHOOK_CATCHUP_CRON ??= '*/5 * * * *'
}

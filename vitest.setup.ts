// Provide placeholder env vars so server-only modules that validate via Zod
// at import time don't blow up during tests. Tests must not rely on these
// values for behavioral assertions — they exist solely to satisfy schema parse.
process.env.COPILOT_API_KEY ??= 'test-copilot-api-key'
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.DROPBOX_APP_KEY ??= 'test-dropbox-app-key'
process.env.DROPBOX_APP_SECRET ??= 'test-dropbox-app-secret'
process.env.DROPBOX_REDIRECT_URI ??= 'https://test.example.com/callback'
process.env.DROPBOX_SCOPES ??= 'files.content.read files.content.write'
process.env.DROPBOX_API_URL ??= 'https://api.dropboxapi.com'
process.env.CRON_SECRET ??= 'test-cron-secret'
process.env.WEBHOOK_CATCHUP_CRON ??= '*/5 * * * *'

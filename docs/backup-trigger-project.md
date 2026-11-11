# Running against a backup Trigger.dev project

By default the Next app sends every task trigger to the Trigger.dev project that
`TRIGGER_SECRET_KEY` belongs to. Setting one optional variable reroutes **all** triggers
from the Next app to a second project, without touching the primary key.

| Variable | Where | Effect |
| --- | --- | --- |
| `TRIGGER_BACKUP_SECRET_KEY` | Vercel (the Next app only) | When set, every trigger goes to the project this secret key belongs to. When unset or blank, nothing changes. |

`src/lib/triggerClient.ts` calls the SDK's `configure({ accessToken })` when the variable is
set, and every file that triggers a task imports it. Each cold start logs one line,
`Trigger.dev client mode: primary` or `backup` (never the key), so the logs show which
project is active.

Notes:

- The API URL is not overridden. It still comes from `TRIGGER_API_URL` (default
  `https://api.trigger.dev`), so both projects must live on the same Trigger.dev host.
- Tasks run inside whichever project executes them, so the task runtime needs no change. Do
  not set `TRIGGER_BACKUP_SECRET_KEY` in the Trigger.dev project's own environment variables.
- Deploy the tasks to the new project first. `trigger.config.ts` reads `TRIGGER_PROJECT_ID`
  from the environment, so this only needs the GitHub secrets `TRIGGER_PROJECT_ID` and
  `TRIGGER_ACCESS_TOKEN` swapped for the new project's values, then a run of the deploy
  workflow. The new project also needs the same environment variables as the old one
  (Dropbox, database, Assembly keys, etc.).

## Testing on a Vercel preview

1. Give the preview its own **non-production** `DATABASE_URL`. `scripts/build/build.sh` (the
   Vercel `buildCommand`) runs `pnpm drizzle-kit migrate` on every build, previews included.
   A preview built with the production `DATABASE_URL` migrates production. Either use a
   separate database for previews or skip the migrate step for previews (not implemented
   here; for example gate it on `VERCEL_ENV != preview`).
2. Set `TRIGGER_BACKUP_SECRET_KEY` on the preview to a key from a Trigger.dev DEV or separate
   project, and deploy the tasks to that project.
3. Check the preview's logs for `Trigger.dev client mode: backup`.
4. Trigger a sync with a test Dropbox account and Assembly channel. Runs should appear only in
   the new project's dashboard and none in the old one.

## Rollback

Unset `TRIGGER_BACKUP_SECRET_KEY` and redeploy. Triggers go back to the project behind
`TRIGGER_SECRET_KEY`.

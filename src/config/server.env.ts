import { TriggerMachineSchema } from '@/trigger/type'
import 'server-only'

import { z } from 'zod'

// Env modes where the SDK authorizes with the workspace-scoped key (no token).
const ASSEMBLY_KEYLESS_ENV_MODES = ['local', '__SECRET_STAGING__']

const ServerEnvSchema = z
  .object({
    COPILOT_API_KEY: z.string().min(1),
    DATABASE_URL: z.url(),
    DROPBOX_APP_KEY: z.string().min(1),
    DROPBOX_APP_SECRET: z.string().min(1),
    DROPBOX_REDIRECT_URI: z.url(),
    DROPBOX_SCOPES: z.string().min(1),
    DROPBOX_API_URL: z.url(),
    TRIGGER_MACHINE: TriggerMachineSchema,
    WEBHOOK_CATCHUP_CRON: z.string().min(1),
    ASSEMBLY_ENV: z.string().optional(),
    COPILOT_ENV: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const envMode = val.ASSEMBLY_ENV ?? val.COPILOT_ENV
    if (!envMode || !ASSEMBLY_KEYLESS_ENV_MODES.includes(envMode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['COPILOT_ENV'],
        message:
          'COPILOT_ENV (or ASSEMBLY_ENV) must be "local". Set it in every runtime (Vercel, Trigger.dev).',
      })
    }
  })

const env = ServerEnvSchema.parse(process.env)
export default env

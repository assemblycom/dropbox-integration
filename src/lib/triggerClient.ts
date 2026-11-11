import { configure } from '@trigger.dev/sdk/v3'
import env from '@/config/server.env'
import logger from '@/lib/logger'

export type TriggerClientMode = 'primary' | 'backup'

// Import this module (for its side effect) from every file that triggers a task, so no
// trigger call can bypass the override. Tasks themselves run inside whichever Trigger.dev
// project executes them and need nothing here. The SDK keeps one process-wide client
// config, so re-running this is harmless (the first registration wins).
export function configureTriggerClient(
  backupSecretKey: string | undefined = env.TRIGGER_BACKUP_SECRET_KEY,
): TriggerClientMode {
  // Unset (or blank) leaves the SDK on TRIGGER_SECRET_KEY, exactly as before.
  if (!backupSecretKey) return 'primary'

  configure({ accessToken: backupSecretKey })
  return 'backup'
}

// Only the mode is logged, never key material, so logs show which project is active.
logger.info(`Trigger.dev client mode: ${configureTriggerClient()}`)

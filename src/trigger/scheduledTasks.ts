import { schedules } from '@trigger.dev/sdk/v3'
import { and, eq } from 'drizzle-orm'
import env from '@/config/server.env'
import db from '@/db'
import { dropboxConnections } from '@/db/schema/dropboxConnections.schema'
import logger from '@/lib/logger'
import { processDropboxChanges } from '@/trigger/processFileSync'

export const pendingWebhookCatchUp = schedules.task({
  id: 'pending-webhook-catch-up',
  cron: env.WEBHOOK_CATCHUP_CRON,
  run: async () => {
    logger.info('Catch-up cron: triggering sync for all pending webhooks')

    const pendingConnections = await db
      .select({ accountId: dropboxConnections.accountId })
      .from(dropboxConnections)
      .where(and(eq(dropboxConnections.pendingWebhook, true), eq(dropboxConnections.status, true)))

    if (pendingConnections.length === 0) return

    logger.info(
      `Catch-up cron: triggering sync for ${pendingConnections.length} account(s) with pending webhooks`,
    )

    await Promise.all(
      pendingConnections
        .filter((c): c is { accountId: string } => c.accountId !== null)
        .map(({ accountId }) =>
          processDropboxChanges.trigger(accountId, { concurrencyKey: accountId }),
        ),
    )
  },
})

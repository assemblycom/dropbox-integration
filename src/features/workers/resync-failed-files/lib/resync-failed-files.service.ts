import { and, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import db from '@/db'
import logger from '@/lib/logger'
import { resyncFailedFilesInAssembly } from '@/trigger/processFileSync'
import type { FailedSyncWorkspaceMap } from '../utils/types'

export const MAX_ATTEMPTS = 10
export const BACKOFF_INTERVAL_MINUTES = 5

export class ResyncService {
  /** Returns rows with an active tombstone, under the attempts cap, and past the per-attempt backoff window. */
  findFailedSyncs() {
    return db.query.fileFolderSync.findMany({
      where: (t) =>
        and(
          isNull(t.deletedAt),
          isNotNull(t.pendingAction),
          lt(t.pendingActionAttempts, MAX_ATTEMPTS),
          or(
            isNull(t.pendingActionLastAttemptAt),
            lt(
              t.pendingActionLastAttemptAt,
              sql`NOW() - (INTERVAL '1 minute' * ${BACKOFF_INTERVAL_MINUTES} * GREATEST(${t.pendingActionAttempts}, 1))`,
            ),
          ),
        ),
    })
  }

  async resyncFailedFiles() {
    const failedSyncs = await this.findFailedSyncs()

    logger.info('ResyncService#resyncFailedFiles :: total failed syncs', failedSyncs.length)

    const byPortal: FailedSyncWorkspaceMap = failedSyncs.reduce(
      (acc: FailedSyncWorkspaceMap, row) => {
        if (!acc[row.portalId]) acc[row.portalId] = []
        acc[row.portalId].push(row)
        return acc
      },
      {},
    )

    for (const [portalId, rows] of Object.entries(byPortal)) {
      await resyncFailedFilesInAssembly.trigger({ portalId, failedSyncs: rows })
      logger.info(
        `ResyncService#resyncFailedFiles :: enqueued portal=${portalId} rows=${rows.length}`,
      )
    }
  }
}

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import httpStatus from 'http-status'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import APIError from '@/errors/APIError'
import type User from '@/lib/copilot/models/User.model'
import logger from '@/lib/logger'
import {
  resyncFailedFilesAndMasterSync,
  resyncFailedFilesInAssembly,
} from '@/trigger/processFileSync'
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

  async resyncFailedFilesForChannel(
    channelSyncId: string,
    user: User,
  ): Promise<{ pendingCount: number }> {
    const portalId = user.portalId

    const channel = await db.query.channelSync.findFirst({
      where: (t, { eq }) =>
        and(eq(t.id, channelSyncId), eq(t.portalId, portalId), isNull(t.deletedAt)),
    })
    if (!channel) {
      throw new APIError('Channel mapping not found', httpStatus.NOT_FOUND)
    }

    const connection = await db.query.dropboxConnections.findFirst({
      where: (t, { eq }) => and(eq(t.portalId, portalId), eq(t.status, true)),
    })
    // rootNamespaceId is nullable for personal (non-Business) Dropbox accounts.
    // DropboxClient accepts null and skips the namespace header.
    if (!connection?.refreshToken || !connection?.accountId) {
      throw new APIError('Dropbox connection not found', httpStatus.NOT_FOUND)
    }

    const resetRows = await db
      .update(fileFolderSync)
      .set({
        pendingActionAttempts: 0,
        pendingActionLastAttemptAt: null,
      })
      .where(
        and(
          eq(fileFolderSync.portalId, portalId),
          eq(fileFolderSync.channelSyncId, channelSyncId),
          isNotNull(fileFolderSync.pendingAction),
          isNull(fileFolderSync.deletedAt),
        ),
      )
      .returning()

    // Mark the channel as resyncing so the UI shows "Resyncing..." and the
    // button stays disabled across reloads. Cleared by the orchestrator's
    // finally block, or by the catch below if trigger() itself fails.
    await db
      .update(channelSync)
      .set({ resyncingAt: new Date() })
      .where(eq(channelSync.id, channelSyncId))

    try {
      await resyncFailedFilesAndMasterSync.trigger(
        {
          portalId,
          channelSyncId,
          failedSyncs: resetRows,
          bidirectionalPayload: {
            dbxRootPath: channel.dbxRootPath,
            assemblyChannelId: channel.assemblyChannelId,
            connectionToken: {
              refreshToken: connection.refreshToken,
              accountId: connection.accountId,
              rootNamespaceId: connection.rootNamespaceId,
            },
            user,
          },
        },
        { concurrencyKey: channelSyncId },
      )
    } catch (error) {
      // The orchestrator never started — its finally block won't run. Clear
      // resyncingAt now so the channel doesn't get stuck in the UI.
      await db
        .update(channelSync)
        .set({ resyncingAt: null })
        .where(eq(channelSync.id, channelSyncId))
      throw error
    }

    logger.info('ResyncService#resyncFailedFilesForChannel :: enqueued manual resync', {
      portalId,
      channelSyncId,
      pendingCount: resetRows.length,
    })

    return { pendingCount: resetRows.length }
  }
}

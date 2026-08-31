import { and, eq } from 'drizzle-orm'
import type { Dropbox } from 'dropbox'
import z from 'zod'
import env from '@/config/server.env'
import db from '@/db'
import { type ChannelSyncSelectType, channelSync } from '@/db/schema/channelSync.schema'
import {
  type DropboxConnectionTokens,
  dropboxConnections,
} from '@/db/schema/dropboxConnections.schema'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type { DropboxFileListFolderResultEntries } from '@/features/sync/types'
import {
  isDbxCursorResetError,
  isDbxRootMovedError,
} from '@/features/webhook/dropbox/utils/dbxCursorErrors'
import { getDropboxChanges } from '@/features/webhook/dropbox/utils/getDropboxChanges'
import { generateToken } from '@/lib/copilot/generateToken'
import User from '@/lib/copilot/models/User.model'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import logger from '@/lib/logger'
import { withRetry } from '@/lib/withRetry'
import { handleChannelFileChanges, processDropboxChanges } from '@/trigger/processFileSync'

const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

export class DropboxWebhook {
  async handleDropboxEvents(accounts: string[]) {
    for (const account of accounts) {
      const connection = await db.query.dropboxConnections.findFirst({
        where: (t, { eq, and }) => and(eq(t.accountId, account), eq(t.status, true)),
        columns: { id: true, pendingWebhook: true, lastWebhookSyncStartedAt: true },
      })

      if (!connection) continue

      // Skip if already pending — cron will handle it
      if (connection.pendingWebhook) {
        logger.info(`Webhook skipped for account ${account}, already has pending webhook`)
        continue
      }

      // Debounce: if the account was synced recently, defer to cron
      const debounceThreshold = new Date(Date.now() - DEBOUNCE_WINDOW_MS)
      const recentlySynced =
        connection.lastWebhookSyncStartedAt &&
        connection.lastWebhookSyncStartedAt >= debounceThreshold

      if (recentlySynced) {
        await db
          .update(dropboxConnections)
          .set({ pendingWebhook: true })
          .where(eq(dropboxConnections.id, connection.id))
        logger.info(`Webhook debounced for account ${account}, marked as pending`)
      } else {
        await processDropboxChanges.trigger(account, { concurrencyKey: account })
      }
    }
  }

  async fetchDropBoxChanges(accountId: string) {
    const connection = await this.getActiveConnection(accountId)

    if (!connection || !connection.refreshToken) {
      logger.error(
        `DropboxWebhook#fetchDropboxChanges :: Connection is not valid for Dropbox accountId: ${accountId}`,
      )
      return
    }

    const { portalId, initiatedBy, refreshToken, rootNamespaceId } = connection

    const connectionToken = {
      refreshToken,
      accountId,
      rootNamespaceId,
    }
    const token = generateToken(env.COPILOT_API_KEY, {
      workspaceId: portalId,
      internalUserId: initiatedBy,
    })

    const user = await User.authenticate(token)
    const mapFilesService = new MapFilesService(user, connectionToken)

    const channels = await mapFilesService.getAllChannelMaps(
      and(eq(channelSync.dbxAccountId, accountId), eq(channelSync.status, true)),
    )

    const conditions = and(
      eq(dropboxConnections.accountId, accountId),
      eq(dropboxConnections.portalId, connection.portalId),
    )
    // Clear pending webhook flag before syncing all channels for this account

    await db
      .update(dropboxConnections)
      .set({ pendingWebhook: false, lastWebhookSyncStartedAt: new Date() })
      .where(conditions)

    const dbxClient = new DropboxClient(refreshToken, rootNamespaceId).getDropboxClient()
    for (const channel of channels) {
      await this.processChannelChanges(channel, dbxClient, mapFilesService, user, connectionToken)
    }

    // update last webhook synced at
    await db.update(dropboxConnections).set({ lastWebhookSyncedAt: new Date() }).where(conditions)
  }

  // Refactor below code. Move the function to DropboxClient file and call it from here.
  async getDropboxFileMetadata(filePath: string, dbxClient: Dropbox) {
    return await withRetry((path: string) => dbxClient.filesGetMetadata({ path }), [filePath], {
      minTimeout: 3000,
      maxTimeout: 12000,
    })
  }

  // Root moved: find its new path by id, reset the cursor, and save both.
  private async recoverMovedRoot(
    channel: ChannelSyncSelectType,
    mapFilesService: MapFilesService,
    dbxClient: Dropbox,
  ) {
    logger.info(
      `WebhookService#recoverMovedRoot :: Root path moved, recovering by id. Channel: ${channel.id}`,
    )
    const response = await this.getDropboxFileMetadata(
      z.string().parse(channel.dbxRootId),
      dbxClient,
    )
    const newPath = z.string().parse(response.result.path_display)
    const cursorData = await dbxClient.filesListFolderGetLatestCursor({
      path: newPath,
      recursive: true,
    })
    await mapFilesService.updateChannelMapById(
      { dbxRootPath: newPath, dbxCursor: cursorData.result.cursor },
      channel.id,
    )
  }

  // Cursor is stale but the folder is fine: get a fresh cursor at the same path.
  private async recoverResetCursor(
    channel: ChannelSyncSelectType,
    mapFilesService: MapFilesService,
    dbxClient: Dropbox,
  ) {
    logger.info(
      `WebhookService#recoverResetCursor :: Cursor reset, refreshing. Channel: ${channel.id}`,
    )
    await this.getAndUpdateDropboxCursor({
      dbxClient,
      mapFilesService,
      channelSyncId: channel.id,
      dbxRootPath: channel.dbxRootPath,
    })
  }

  private async getAndUpdateDropboxCursor({
    dbxClient,
    mapFilesService,
    channelSyncId,
    dbxRootPath,
  }: {
    dbxClient: Dropbox
    mapFilesService: MapFilesService
    channelSyncId: string
    dbxRootPath: string
  }) {
    const dbxCursor = (
      await dbxClient.filesListFolderGetLatestCursor({
        path: dbxRootPath,
        recursive: true,
      })
    ).result.cursor
    await mapFilesService.updateChannelMapById(
      {
        dbxCursor,
      },
      channelSyncId,
    )
    return dbxCursor
  }

  private async processChannelChanges(
    channel: ChannelSyncSelectType,
    dbxClient: Dropbox,
    mapFilesService: MapFilesService,
    user: User,
    connectionToken: DropboxConnectionTokens,
  ) {
    logger.log(`WebhookService#processChannelChanges. ChannelId: ${channel.id}`)
    const { id: channelSyncId, dbxRootPath, assemblyChannelId, dbxCursor } = channel
    let hasMore = true
    let currentCursor = dbxCursor ?? ''

    try {
      if (!currentCursor)
        currentCursor = await this.getAndUpdateDropboxCursor({
          dbxClient,
          mapFilesService,
          channelSyncId,
          dbxRootPath,
        })

      const allChanges: DropboxFileListFolderResultEntries = []

      while (hasMore) {
        const dbxChanges = await getDropboxChanges(
          currentCursor,
          dbxRootPath,
          dbxClient,
          mapFilesService,
          channelSyncId,
        )
        if (!dbxChanges) break

        const { entries, newCursor, hasMore: more } = dbxChanges

        allChanges.push(...entries)
        currentCursor = newCursor
        hasMore = more
      }

      if (allChanges.length > 0) {
        const result = await handleChannelFileChanges.triggerAndWait(
          {
            files: allChanges,
            channelSyncId,
            dbxRootPath,
            assemblyChannelId,
            user,
            connectionToken,
          },
          { concurrencyKey: channelSyncId },
        )
        // Don't advance the cursor if change processing failed, or these deltas move
        // past the cursor and are never re-fetched. Throwing lets the run retry from
        // the same cursor.
        if (!result.ok) {
          throw new Error(`handleChannelFileChanges failed for channel ${channelSyncId}`, {
            cause: result.error,
          })
        }
      }

      // Stamp lastSyncedAt only when the channel had changes.
      await mapFilesService.updateChannelMapById(
        { dbxCursor: currentCursor, ...(allChanges.length > 0 && { lastSyncedAt: new Date() }) },
        channelSyncId,
      )
    } catch (error) {
      // Recover the two known cursor failures; let anything else propagate.
      if (isDbxRootMovedError(error)) {
        await this.recoverMovedRoot(channel, mapFilesService, dbxClient)
      } else if (isDbxCursorResetError(error)) {
        await this.recoverResetCursor(channel, mapFilesService, dbxClient)
      } else {
        throw error
      }
    }
  }

  private async getActiveConnection(accountId: string) {
    return await db.query.dropboxConnections.findFirst({
      where: (dropboxConnections, { eq, and }) =>
        and(eq(dropboxConnections.status, true), eq(dropboxConnections.accountId, accountId)),
      columns: {
        portalId: true,
        initiatedBy: true,
        refreshToken: true,
        rootNamespaceId: true,
      },
    })
  } // should have been resuable but this is only needed while consuming webhook events from dropbox.
}

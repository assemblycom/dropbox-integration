import { and, eq } from 'drizzle-orm'
import { type Dropbox, DropboxResponseError } from 'dropbox'
import httpStatus from 'http-status'
import z from 'zod'
import env from '@/config/server.env'
import db from '@/db'
import { type ChannelSyncSelectType, channelSync } from '@/db/schema/channelSync.schema'
import {
  type DropboxConnectionTokens,
  dropboxConnections,
} from '@/db/schema/dropboxConnections.schema'
import APIError from '@/errors/APIError'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type { DropboxFileListFolderResultEntries } from '@/features/sync/types'
import { getDropboxChanges } from '@/features/webhook/dropbox/utils/getDropboxChanges'
import { generateToken } from '@/lib/copilot/generateToken'
import User from '@/lib/copilot/models/User.model'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import logger from '@/lib/logger'
import { handleChannelFileChanges, processDropboxChanges } from '@/trigger/processFileSync'

const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export class DropboxWebhook {
  async handleDropboxEvents(accounts: string[]) {
    for (const account of accounts) {
      const connection = await db.query.dropboxConnections.findFirst({
        where: (t, { eq, and }) => and(eq(t.accountId, account), eq(t.status, true)),
        columns: { id: true, pendingWebhook: true, lastWebhookSyncedAt: true },
      })

      if (!connection) continue

      // Skip if already pending — cron will handle it
      if (connection.pendingWebhook) {
        console.info(`Webhook skipped for account ${account}, already has pending webhook`)
        continue
      }

      // Debounce: if the account was synced recently, defer to cron
      const debounceThreshold = new Date(Date.now() - DEBOUNCE_WINDOW_MS)
      const recentlySynced =
        connection.lastWebhookSyncedAt && connection.lastWebhookSyncedAt >= debounceThreshold

      if (recentlySynced) {
        await db
          .update(dropboxConnections)
          .set({ pendingWebhook: true })
          .where(eq(dropboxConnections.id, connection.id))
        console.info(`Webhook debounced for account ${account}, marked as pending`)
      } else {
        await processDropboxChanges.trigger(account, { concurrencyKey: account })
      }
    }
  }

  async fetchDropBoxChanges(accountId: string) {
    const connection = await this.getActiveConnection(accountId)

    if (!connection || !connection.refreshToken) {
      console.error(
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

    const dbxClient = new DropboxClient(refreshToken, rootNamespaceId).getDropboxClient()
    for (const channel of channels) {
      const proceed = await this.handleDbxRootPathMove(channel, mapFilesService, dbxClient)
      proceed &&
        (await this.processChannelChanges(
          channel,
          dbxClient,
          mapFilesService,
          user,
          connectionToken,
        ))
    }

    // Clear pending webhook flag after all channels for this account are processed
    await db
      .update(dropboxConnections)
      .set({ pendingWebhook: false, lastWebhookSyncedAt: new Date() })
      .where(
        and(
          eq(dropboxConnections.accountId, accountId),
          eq(dropboxConnections.portalId, connection.portalId),
        ),
      )
  }

  async getDropboxFileMetadata(filePath: string, dbxClient: Dropbox) {
    return await dbxClient.filesGetMetadata({
      path: filePath,
    })
  }

  async handleDbxRootPathMove(
    channel: ChannelSyncSelectType,
    mapFilesService: MapFilesService,
    dbxClient: Dropbox,
  ): Promise<boolean> {
    try {
      console.info(
        `WebhookService#handleDbxRootPathMove. Root path: ${channel.dbxRootPath}. Assembly file channel ID: ${channel.assemblyChannelId} Checking if the root path exists...`,
      )
      const response = await this.getDropboxFileMetadata(channel.dbxRootPath, dbxClient)
      if (response.result) return true
      throw new APIError('Root path not found', httpStatus.NOT_FOUND)
    } catch (error: unknown) {
      logger.error(
        'WebhookService#handleDbxRootPathMove :: Error handling dbx root path move',
        error,
      )
      if (error instanceof DropboxResponseError && error.status === 409) {
        console.info(
          'WebhookService#handleDbxRootPathMove :: Root path not found',
          channel.dbxRootPath,
        )
        const response = await this.getDropboxFileMetadata(
          z.string().parse(channel.dbxRootId),
          dbxClient,
        )
        const cursorData = await dbxClient.filesListFolderGetLatestCursor({
          path: z.string().parse(response.result.path_display),
          recursive: true,
        })
        await mapFilesService.updateChannelMapById(
          {
            dbxRootPath: response.result.path_display,
            dbxCursor: cursorData.result.cursor,
          },
          channel.id,
        )
        return false
      }
      throw error
    }
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
    console.info(
      `webhookService#processChannelChanges. ChannelId: ${channel.id} ${JSON.stringify(channel)}`,
    )
    const { id: channelSyncId, dbxRootPath, assemblyChannelId, dbxCursor } = channel
    let hasMore = true
    let currentCursor = dbxCursor ?? ''
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
      if (!dbxChanges) continue

      const { entries, newCursor, hasMore: more } = dbxChanges

      allChanges.push(...entries)
      currentCursor = newCursor
      hasMore = more
    }

    if (allChanges.length > 0) {
      await handleChannelFileChanges.trigger({
        files: allChanges,
        channelSyncId,
        dbxRootPath,
        assemblyChannelId,
        user,
        connectionToken,
      })
    }

    await mapFilesService.updateChannelMapById(
      { dbxCursor: currentCursor, lastSyncedAt: new Date() },
      channelSyncId,
    )
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

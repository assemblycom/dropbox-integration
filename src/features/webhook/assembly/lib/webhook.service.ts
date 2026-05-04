import { and, eq } from 'drizzle-orm'
import z from 'zod'
import { ObjectType, type ObjectTypeValue } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import APIError from '@/errors/APIError'
import { AssemblyWebhookRecordService } from '@/features/sync/lib/AssemblyWebhookRecord.service'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type { AssemblyToDropboxSyncFilesPayload } from '@/features/sync/types'
import {
  type AssemblyWebhookEvent,
  AssemblyWebhookSchema,
  DISPATCHABLE_HANDLEABLE_EVENT,
} from '@/features/webhook/assembly/utils/types'
import type User from '@/lib/copilot/models/User.model'
import { type CopilotFileRetrieve, CopilotFileWithObjectSchema } from '@/lib/copilot/types'
import AuthenticatedDropboxService from '@/lib/dropbox/AuthenticatedDropbox.service'
import logger from '@/lib/logger'
import {
  deleteAssemblyFileInDropbox,
  syncAssemblyFileToDropbox,
  updateAssemblyFileInDropbox,
} from '@/trigger/processFileSync'

const SYNCABLE_OBJECT_TYPES: readonly string[] = [ObjectType.FILE, ObjectType.FOLDER]

export class AssemblyWebhookService extends AuthenticatedDropboxService {
  readonly mapFilesService: MapFilesService
  constructor(user: User, connectionToken: DropboxConnectionTokens) {
    super(user, connectionToken)
    this.mapFilesService = new MapFilesService(user, connectionToken)
  }

  parseWebhook(body: unknown): AssemblyWebhookEvent {
    const webhookEvent = AssemblyWebhookSchema.safeParse(body)
    logger.info('AssemblyWebhookService#parseWebhook :: Parsed webhook event', webhookEvent)
    if (!webhookEvent.success) {
      throw new APIError('Failed to parse webhook event')
    }
    return webhookEvent.data
  }

  async checkNonDuplicateWebhookRecord(webhookEvent: AssemblyWebhookEvent) {
    const payload = {
      portalId: this.user.portalId,
      action: z.enum(Object.values(DISPATCHABLE_HANDLEABLE_EVENT)).parse(webhookEvent.eventType),
      assemblyChannelId: webhookEvent.data.channelId,
      fileId: webhookEvent.data.id,
      triggeredAt: webhookEvent.data.createdAt ? new Date(webhookEvent.data.createdAt) : new Date(),
    }
    const webhookRecordService = new AssemblyWebhookRecordService(this.user, this.connectionToken)
    return await webhookRecordService.getOrCreateWebhookRecord(payload)
  }

  validateHandleableEvent(
    webhookEvent: AssemblyWebhookEvent,
  ): DISPATCHABLE_HANDLEABLE_EVENT | null {
    const eventType = webhookEvent.eventType as DISPATCHABLE_HANDLEABLE_EVENT
    const isValidWebhook =
      [
        DISPATCHABLE_HANDLEABLE_EVENT.FileCreated,
        DISPATCHABLE_HANDLEABLE_EVENT.FileDeleted,
        DISPATCHABLE_HANDLEABLE_EVENT.FileUpdated,
        DISPATCHABLE_HANDLEABLE_EVENT.FolderCreated,
        DISPATCHABLE_HANDLEABLE_EVENT.FolderDeleted,
        DISPATCHABLE_HANDLEABLE_EVENT.FolderUpdated,
      ].includes(eventType) &&
      webhookEvent.data.object &&
      SYNCABLE_OBJECT_TYPES.includes(webhookEvent.data.object) // avoid non-syncable object types like 'link'

    // if (isValidWebhook) {
    //   const record = await this.checkNonDuplicateWebhookRecord(webhookEvent)
    //   isValidWebhook = record.isCreated
    // }

    return isValidWebhook ? eventType : null
  }

  async handleFileCreated(webhookEvent: AssemblyWebhookEvent) {
    logger.info('AssemblyWebhookService#handleFileCreated :: Handling file created')

    const channel = await this.mapFilesService.getAllChannelMaps(
      and(
        eq(channelSync.assemblyChannelId, webhookEvent.data.channelId),
        eq(channelSync.status, true),
      ),
    )
    if (!channel.length) return

    const { dbxRootPath, id: channelSyncId } = channel[0]
    logger.info(
      'AssemblyWebhookService#handleFileCreated :: Found channel',
      channel,
      'syncing to',
      dbxRootPath,
    )

    const file = webhookEvent.data
    const filteredEntries = await this.mapFilesService.checkAndFilterAssemblyFiles(
      [file],
      dbxRootPath,
      webhookEvent.data.channelId,
    )
    logger.info('AssemblyWebhookService#handleFileCreated :: Filtered entries', filteredEntries)

    if (filteredEntries.length) {
      // refresh dropbox access token
      await this.dbxClient.dbxAuthClient.refreshAccessToken(this.connectionToken.refreshToken)

      await syncAssemblyFileToDropbox.batchTrigger(filteredEntries)
      await this.updateLastSynced(channelSyncId)
    }
  }

  async handleFileDeleted(webhookEvent: AssemblyWebhookEvent) {
    logger.info('AssemblyWebhookService#handleFileDeleted :: Handling file deleted')

    const file = webhookEvent.data
    const channel = await this.mapFilesService.getAllChannelMaps(
      and(
        eq(channelSync.assemblyChannelId, webhookEvent.data.channelId),
        eq(channelSync.status, true),
      ),
    )
    if (!channel.length) return

    const { dbxRootPath, assemblyChannelId, id: channelSyncId } = channel[0]
    logger.info(
      'AssemblyWebhookService#handleFileDeleted :: Found channel',
      channel,
      'syncing to',
      dbxRootPath,
    )

    const user = this.user
    const connectionToken = this.connectionToken
    if (file) {
      const payload: AssemblyToDropboxSyncFilesPayload = {
        file: file as CopilotFileRetrieve & { object: ObjectTypeValue },
        opts: {
          dbxRootPath,
          assemblyChannelId,
          channelSyncId,
          user,
          connectionToken,
        },
      }

      await deleteAssemblyFileInDropbox.trigger(payload)
      await this.updateLastSynced(channelSyncId) // this updates the last synced timestamp for the channel. This runs before
    }
  }

  async handleFileUpdated(webhookEvent: AssemblyWebhookEvent) {
    logger.info('AssemblyWebhookService#handleFileUpdated :: Handling file updated')

    const file = webhookEvent.data
    const channel = await this.mapFilesService.getAllChannelMaps(
      and(
        eq(channelSync.assemblyChannelId, webhookEvent.data.channelId),
        eq(channelSync.status, true),
      ),
    )
    if (!channel.length) return

    const { dbxRootPath, assemblyChannelId, id: channelSyncId } = channel[0]
    logger.info(
      'AssemblyWebhookService#handleFileUpdated :: Found channel',
      channel,
      'syncing to',
      dbxRootPath,
    )

    const user = this.user
    const connectionToken = this.connectionToken
    if (file) {
      // refresh dropbox access token
      await this.dbxClient.dbxAuthClient.refreshAccessToken(this.connectionToken.refreshToken)

      const payload: AssemblyToDropboxSyncFilesPayload = {
        file: CopilotFileWithObjectSchema.parse(file),
        opts: {
          dbxRootPath,
          assemblyChannelId,
          channelSyncId,
          user,
          connectionToken,
        },
      }

      await updateAssemblyFileInDropbox.trigger(payload)
      await this.updateLastSynced(channelSyncId)
    }
  }

  private async updateLastSynced(channelSyncId: string) {
    logger.info('AssemblyWebhookService#updateLastSynced :: Updating last synced timestamp to now')

    await this.mapFilesService.updateChannelMapById(
      {
        lastSyncedAt: new Date(),
      },
      channelSyncId,
    )
  }
}

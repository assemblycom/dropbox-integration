import httpStatus from 'http-status'
import { type NextRequest, NextResponse } from 'next/server'
import z from 'zod'
import db from '@/db'
import APIError from '@/errors/APIError'
import DropboxConnectionsService from '@/features/auth/lib/DropboxConnections.service'
import { AssemblyWebhookService } from '@/features/webhook/assembly/lib/webhook.service'
import { DISPATCHABLE_HANDLEABLE_EVENT } from '@/features/webhook/assembly/utils/types'
import User from '@/lib/copilot/models/User.model'
import logger from '@/lib/logger'
import { sleep } from '@/utils/sleep'

export const handleWebhookEvent = async (req: NextRequest) => {
  // Read the body before any awaits so the upstream connection isn't torn down
  // (sleep + auth + DB lookup) while we still have an unread request stream.
  const rawBody = await req.json()
  const token = req.nextUrl.searchParams.get('token')

  await sleep(800) // prevent ping-pong case of webhooks

  const user = await User.authenticate(token)

  const dropboxConnectionService = new DropboxConnectionsService(user)
  const connection = await dropboxConnectionService.getConnectionForWorkspace()

  if (!connection.status) {
    console.info(`Sync is not enabled for this workspace. Skipping webhook event`)
    return NextResponse.json({})
  }

  if (!connection.refreshToken) throw new APIError('No refresh token found', httpStatus.NOT_FOUND)
  if (!connection.accountId) throw new APIError('No accountId found', httpStatus.NOT_FOUND)

  const assemblyWebhookService = new AssemblyWebhookService(user, {
    refreshToken: connection.refreshToken,
    accountId: connection.accountId,
    rootNamespaceId: connection.rootNamespaceId,
  })
  const webhookEvent = assemblyWebhookService.parseWebhook(rawBody)
  logger.info(`Event triggered. ${JSON.stringify(webhookEvent)}`)

  const eventType = assemblyWebhookService.validateHandleableEvent(webhookEvent)
  if (!eventType) {
    return NextResponse.json({})
  }

  const existingFile = await db.query.fileFolderSync.findFirst({
    where: (fileFolderSync, { eq }) =>
      eq(fileFolderSync.assemblyFileId, z.string().parse(webhookEvent.data.id)),
  })

  logger.info('AssemblyWebhookService#handleWebhookEvent :: Existing file', existingFile)

  switch (eventType) {
    case DISPATCHABLE_HANDLEABLE_EVENT.FileCreated:
    case DISPATCHABLE_HANDLEABLE_EVENT.FolderCreated:
      if (!existingFile) {
        logger.info('AssemblyWebhookService#handleWebhookEvent :: File does not exist, creating')
        await assemblyWebhookService.handleFileCreated(webhookEvent)
      }
      break
    case DISPATCHABLE_HANDLEABLE_EVENT.FileUpdated:
    case DISPATCHABLE_HANDLEABLE_EVENT.FolderUpdated:
      if (webhookEvent.data.previousAttributes) {
        //doing this check because copilot.uploadFile method also triggers a file.updated webhook but without previousAttributes.
        await assemblyWebhookService.handleFileUpdated(webhookEvent)
      }
      break
    default:
      if (existingFile) {
        //only proceed with deleting file if there is existing row in the filefoldersync table.
        await assemblyWebhookService.handleFileDeleted(webhookEvent)
      }
  }

  return NextResponse.json({ message: `${eventType} webhook request handled successfully` })
}

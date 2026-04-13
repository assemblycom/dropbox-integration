import { and, eq } from 'drizzle-orm'
import z from 'zod'
import env from '@/config/server.env'
import db from '@/db'
import { type FileSyncSelectType, fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import APIError from '@/errors/APIError'
import { SyncService } from '@/features/sync/lib/Sync.service'
import { DropboxFileListFolderSingleEntrySchema } from '@/features/sync/types'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import { generateToken } from '@/lib/copilot/generateToken'
import User from '@/lib/copilot/models/User.model'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'

export const syncFailedFilesToAssembly = async (
  portalId: string,
  failedSyncs: FileSyncSelectType[],
) => {
  const dropboxConnection = await getDropboxConnection(portalId)
  if (!dropboxConnection) {
    console.warn('Dropbox account not found for portal:', portalId)
    return null
  }

  const { user, copilotApi, dbxClient, connectionToken, syncService } =
    await initializeSyncDependencies(dropboxConnection, portalId)

  for (const failedSync of failedSyncs) {
    await processFailedSync(failedSync, copilotApi, dbxClient, syncService, user, connectionToken)
  }
}

const getDropboxConnection = async (portalId: string) => {
  const connection = await db.query.dropboxConnections.findFirst({
    where: (dropboxConnections, { eq }) =>
      and(eq(dropboxConnections.portalId, portalId), eq(dropboxConnections.status, true)),
  })

  if (!connection?.refreshToken || !connection?.accountId) {
    console.error('⚠️ Dropbox connection not found for portal:', portalId)
    return null
  }

  return connection
}

const initializeSyncDependencies = async (
  dropboxConnection: NonNullable<Awaited<ReturnType<typeof getDropboxConnection>>>,
  portalId: string,
) => {
  const { refreshToken, rootNamespaceId, accountId, initiatedBy } = dropboxConnection

  if (!refreshToken || !accountId || !rootNamespaceId) {
    throw new APIError(`Dropbox connection not found for portal: ${portalId}`, 404)
  }

  const token = generateToken(env.COPILOT_API_KEY, {
    workspaceId: portalId,
    internalUserId: initiatedBy,
  })

  const user = await User.authenticate(token)
  const copilotApi = new CopilotAPI(token)
  const dbxClient = new DropboxClient(refreshToken, rootNamespaceId)

  const connectionToken = {
    refreshToken,
    accountId,
    rootNamespaceId,
  }

  const syncService = new SyncService(user, connectionToken)

  return { user, copilotApi, dbxClient, connectionToken, syncService }
}

const processFailedSync = async (
  failedSync: FileSyncSelectType,
  copilotApi: CopilotAPI,
  dbxClient: DropboxClient,
  syncService: SyncService,
  user: Awaited<ReturnType<typeof User.authenticate>>,
  connectionToken: { refreshToken: string; accountId: string; rootNamespaceId: string },
) => {
  const fileId = z.string().parse(failedSync.assemblyFileId)
  const file = await copilotApi.retrieveFile(fileId)

  // Only proceed if file is missing or pending in Assembly
  if (file && file.status !== 'pending') return

  const fileInDropbox = await getFileFromDropbox(dbxClient, failedSync.dbxFileId ?? '')
  // Guard against non-file entries: a mapped dbxFileId could resolve to a folder
  // or deleted entry after a Dropbox rename/delete-and-recreate. Only resync files.
  if (!fileInDropbox || fileInDropbox['.tag'] !== 'file') return

  const channelSync = await db.query.channelSync.findFirst({
    where: (channelSync, { eq }) => eq(channelSync.id, failedSync.channelSyncId),
  })

  if (!channelSync) return

  // Sync file from Dropbox to Assembly
  const payload = {
    entry: DropboxFileListFolderSingleEntrySchema.parse(fileInDropbox),
    opts: {
      dbxRootPath: channelSync.dbxRootPath,
      assemblyChannelId: channelSync.assemblyChannelId,
      channelSyncId: channelSync.id,
      user,
      connectionToken,
    },
  }

  await syncService.syncDropboxFilesToAssembly(payload)
  await db.delete(fileFolderSync).where(eq(fileFolderSync.id, failedSync.id))
}

const getFileFromDropbox = async (dbxClient: DropboxClient, dropboxFileId: string) => {
  if (!dropboxFileId) return null

  const dropboxClient = dbxClient.getDropboxClient()

  try {
    const fileMetadata = await dropboxClient.filesGetMetadata({ path: dropboxFileId })
    return fileMetadata.result
  } catch (_err) {
    return null
  }
}

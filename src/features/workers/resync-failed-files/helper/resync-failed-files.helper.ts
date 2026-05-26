import { and } from 'drizzle-orm'
import { DropboxResponseError } from 'dropbox'
import env from '@/config/server.env'
import db from '@/db'
import { PendingAction, PendingActionTarget } from '@/db/constants'
import type { FileSyncSelectType } from '@/db/schema/fileFolderSync.schema'
import APIError from '@/errors/APIError'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { SyncService } from '@/features/sync/lib/Sync.service'
import { DropboxFileListFolderSingleEntrySchema } from '@/features/sync/types'
import { CopilotAPI, isCopilotApiError } from '@/lib/copilot/CopilotAPI'
import { generateToken } from '@/lib/copilot/generateToken'
import User from '@/lib/copilot/models/User.model'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import logger from '@/lib/logger'
import { normalizeError } from '@/utils/normalizeError'

type PortalDeps = {
  user: Awaited<ReturnType<typeof User.authenticate>>
  copilotApi: CopilotAPI
  dbxClient: DropboxClient
  connectionToken: { refreshToken: string; accountId: string; rootNamespaceId: string }
  syncService: SyncService
  mapFilesService: MapFilesService
}

/** Entry point for the scheduled sweep — per-row errors are recorded, never rethrown. */
export const retryFailedSyncsForPortal = async (portalId: string, rows: FileSyncSelectType[]) => {
  const connection = await getDropboxConnection(portalId)
  if (!connection) {
    logger.warn('retryFailedSyncsForPortal :: dropbox connection missing for portal', {
      portalId,
    })
    return
  }

  const deps = await initializeSyncDependencies(connection, portalId)

  for (const failedSync of rows) {
    try {
      await retrySingleSync(failedSync, deps)
    } catch (error) {
      const message = normalizeError(error)
      await deps.mapFilesService.markFailure(failedSync.id, message)
      logger.error('retryFailedSyncsForPortal :: row failed', {
        portalId,
        rowId: failedSync.id,
        action: failedSync.pendingAction,
        target: failedSync.pendingActionTarget,
        message,
      })
    }
  }
}

// biome-ignore lint/suspicious/useAwait: async wraps sync throws into rejected promises for safe Promise.all consumers
const retrySingleSync = async (failedSync: FileSyncSelectType, deps: PortalDeps): Promise<void> => {
  const target = failedSync.pendingActionTarget
  switch (failedSync.pendingAction) {
    case PendingAction.DELETE:
      if (target === PendingActionTarget.ASSEMBLY) return retryDeleteInAssembly(failedSync, deps)
      if (target === PendingActionTarget.DROPBOX) return retryDeleteInDropbox(failedSync, deps)
      break
    case PendingAction.CREATE:
      if (target === PendingActionTarget.DROPBOX) return retryCreateInDropbox(failedSync, deps)
      if (target === PendingActionTarget.ASSEMBLY) return retryCreateInAssembly(failedSync, deps)
      break
  }

  throw new Error(
    `retrySingleSync: unrecognised (action=${failedSync.pendingAction}, target=${target}) on row ${failedSync.id}`,
  )
}

const retryDeleteInAssembly = async (failedSync: FileSyncSelectType, deps: PortalDeps) => {
  const { copilotApi, mapFilesService } = deps

  await mapFilesService.markAttempt(
    failedSync.id,
    PendingAction.DELETE,
    PendingActionTarget.ASSEMBLY,
  )

  if (!failedSync.assemblyFileId) {
    logger.warn('retryDeleteInAssembly :: row has no assemblyFileId, soft-deleting', {
      rowId: failedSync.id,
    })
    await mapFilesService.markDeleted(failedSync.id)
    return
  }

  try {
    await copilotApi.deleteFile(failedSync.assemblyFileId)
  } catch (error) {
    if (isCopilotApiError(error) && error.status === 404) {
      await mapFilesService.markDeleted(failedSync.id)
      return
    }
    throw error
  }

  await mapFilesService.markDeleted(failedSync.id)
}

const retryDeleteInDropbox = async (failedSync: FileSyncSelectType, deps: PortalDeps) => {
  const { dbxClient, mapFilesService } = deps

  await mapFilesService.markAttempt(
    failedSync.id,
    PendingAction.DELETE,
    PendingActionTarget.DROPBOX,
  )

  if (!failedSync.itemPath) {
    logger.warn('retryDeleteInDropbox :: row has no itemPath, soft-deleting', {
      rowId: failedSync.id,
    })
    await mapFilesService.markDeleted(failedSync.id)
    return
  }

  const channelSync = await db.query.channelSync.findFirst({
    where: (channelSync, { eq }) => eq(channelSync.id, failedSync.channelSyncId),
  })
  if (!channelSync) {
    logger.warn('retryDeleteInDropbox :: channelSync missing, soft-deleting row', {
      rowId: failedSync.id,
    })
    await mapFilesService.markDeleted(failedSync.id)
    return
  }

  const dbxFullPath = `${channelSync.dbxRootPath}${failedSync.itemPath}`

  try {
    await dbxClient.getDropboxClient().filesDeleteV2({ path: dbxFullPath })
  } catch (error) {
    if (error instanceof DropboxResponseError && error.status === 409) {
      const summary = (error.error as { error_summary?: string })?.error_summary
      if (typeof summary === 'string' && summary.startsWith('path_lookup/not_found')) {
        await mapFilesService.markDeleted(failedSync.id)
        return
      }
    }
    throw error
  }

  await mapFilesService.markDeleted(failedSync.id)
}

const retryCreateInDropbox = async (failedSync: FileSyncSelectType, deps: PortalDeps) => {
  const { syncService, copilotApi, mapFilesService } = deps

  await mapFilesService.markAttempt(
    failedSync.id,
    PendingAction.CREATE,
    PendingActionTarget.DROPBOX,
  )

  if (!failedSync.assemblyFileId) {
    await mapFilesService.markFailure(
      failedSync.id,
      'retryCreateInDropbox: row missing assemblyFileId',
    )
    return
  }

  if (!failedSync.itemPath) {
    await mapFilesService.markFailure(failedSync.id, 'retryCreateInDropbox: row missing itemPath')
    return
  }

  const channelSync = await db.query.channelSync.findFirst({
    where: (channelSync, { eq }) => eq(channelSync.id, failedSync.channelSyncId),
  })
  if (!channelSync) {
    await mapFilesService.markFailure(failedSync.id, 'retryCreateInDropbox: channelSync missing')
    return
  }

  let file: Awaited<ReturnType<typeof copilotApi.retrieveFile>>
  try {
    file = await copilotApi.retrieveFile(failedSync.assemblyFileId)
  } catch (error) {
    if (isCopilotApiError(error) && error.status === 404) {
      await mapFilesService.markDeleted(failedSync.id)
      return
    }
    throw error
  }

  if (file.status === 'pending') {
    await mapFilesService.markFailure(
      failedSync.id,
      'retryCreateInDropbox: assembly file still pending upload, will retry next sweep',
    )
    return
  }

  // Override file.path with the row's itemPath so the upload targets the originally-intended location.
  const itemPathRelative = failedSync.itemPath.replace(/^\//, '')
  const fileForUpload = { ...file, object: failedSync.object, path: itemPathRelative }

  await syncService.completePendingDropboxCreate({
    pendingRowId: failedSync.id,
    channelSyncId: failedSync.channelSyncId,
    dbxRootPath: channelSync.dbxRootPath,
    file: fileForUpload,
  })
}

const retryCreateInAssembly = async (failedSync: FileSyncSelectType, deps: PortalDeps) => {
  const { syncService, dbxClient, mapFilesService } = deps

  await mapFilesService.markAttempt(
    failedSync.id,
    PendingAction.CREATE,
    PendingActionTarget.ASSEMBLY,
  )

  if (!failedSync.dbxFileId) {
    await mapFilesService.markFailure(failedSync.id, 'retryCreateInAssembly: row missing dbxFileId')
    return
  }

  if (!failedSync.itemPath) {
    await mapFilesService.markFailure(failedSync.id, 'retryCreateInAssembly: row missing itemPath')
    return
  }

  const channelSync = await db.query.channelSync.findFirst({
    where: (channelSync, { eq }) => eq(channelSync.id, failedSync.channelSyncId),
  })
  if (!channelSync) {
    await mapFilesService.markFailure(failedSync.id, 'retryCreateInAssembly: channelSync missing')
    return
  }

  const dbxMeta = await getFileFromDropbox(dbxClient, failedSync.dbxFileId)
  if (!dbxMeta || dbxMeta['.tag'] !== 'file') {
    await mapFilesService.markDeleted(failedSync.id)
    return
  }

  // Bypass syncDropboxFilesToAssembly: it would no-op because insertCreatePending sees the existing row.
  const entry = DropboxFileListFolderSingleEntrySchema.parse(dbxMeta)
  await syncService.completePendingAssemblyCreate({
    pendingRowId: failedSync.id,
    itemPath: failedSync.itemPath,
    assemblyChannelId: channelSync.assemblyChannelId,
    channelSyncId: channelSync.id,
    entry,
  })
}

const getDropboxConnection = async (portalId: string) => {
  const connection = await db.query.dropboxConnections.findFirst({
    where: (dropboxConnections, { eq }) =>
      and(eq(dropboxConnections.portalId, portalId), eq(dropboxConnections.status, true)),
  })
  if (!connection?.refreshToken || !connection?.accountId) {
    logger.error('resync-failed-files.helper :: dropbox connection not found', { portalId })
    return null
  }
  return connection
}

const initializeSyncDependencies = async (
  dropboxConnection: NonNullable<Awaited<ReturnType<typeof getDropboxConnection>>>,
  portalId: string,
): Promise<PortalDeps> => {
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
  const connectionToken = { refreshToken, accountId, rootNamespaceId }
  const syncService = new SyncService(user, connectionToken)
  const mapFilesService = new MapFilesService(user, connectionToken)

  return { user, copilotApi, dbxClient, connectionToken, syncService, mapFilesService }
}

const getFileFromDropbox = async (dbxClient: DropboxClient, dropboxFileId: string) => {
  if (!dropboxFileId) return null
  try {
    return (await dbxClient.getDropboxClient().filesGetMetadata({ path: dropboxFileId })).result
  } catch (_err) {
    return null
  }
}

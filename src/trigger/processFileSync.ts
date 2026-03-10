import { logger, task } from '@trigger.dev/sdk/v3'
import { and, eq, isNotNull } from 'drizzle-orm'
import z from 'zod'
import env from '@/config/server.env'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { type FileSyncSelectType, fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { MAX_FILES_LIMIT } from '@/features/sync/constant'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { SyncService } from '@/features/sync/lib/Sync.service'
import {
  type AssemblyToDropboxSyncFilesPayload,
  type DropboxFileListFolderResultEntries,
  DropboxFileListFolderResultEntriesSchema,
  type DropboxToAssemblySyncFilesPayload,
  type WhereClause,
} from '@/features/sync/types'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { syncFailedFilesToAssembly } from '@/features/workers/resync-failed-files/helper/resync-failed-files.helper'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type User from '@/lib/copilot/models/User.model'
import { DropboxAuthClient } from '@/lib/dropbox/DropboxAuthClient'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import { withErrorLogging } from '@/utils/withErrorLogger'

type SyncTaskPayload = {
  dbxRootPath: string
  assemblyChannelId: string
  connectionToken: DropboxConnectionTokens
  user: User
}

type HandleChannelFilePayload = {
  files: DropboxFileListFolderResultEntries
  channelSyncId: string
  dbxRootPath: string
  assemblyChannelId: string
  user: User
  connectionToken: DropboxConnectionTokens
}

const machine = env.TRIGGER_MACHINE

export const processDropboxChanges = task({
  id: 'process-dropbox-changes',
  machine,
  queue: {
    name: 'process-dropbox-changes',
    concurrencyLimit: 1,
  },
  run: async (accountId: string) => {
    const dropboxWebhook = new DropboxWebhook()
    console.info(
      `processFileSync#processDropboxChanges, Process start for account ID: ${accountId}`,
    )
    await dropboxWebhook.fetchDropBoxChanges(accountId)
  },
})

export const bidirectionalMasterSync = task({
  id: 'bidirectional-master-sync',
  machine,
  run: async (payload: SyncTaskPayload) => {
    try {
      await initiateAssemblyToDropboxSync.triggerAndWait(payload)
      logger.info('\n\n Synced Assembly files to Dropbox \n\n')
      await initiateDropboxToAssemblySync.triggerAndWait(payload)
    } catch (error: unknown) {
      logger.error('processFileSync#bidirectionalMasterSync', { error })
    }
  },
})

export const initiateDropboxToAssemblySync = task({
  id: 'initiate-dropbox-to-assembly-sync',
  machine,
  run: async (payload: SyncTaskPayload) => {
    logger.info(
      'processFileSync#initiateDropboxToAssemblySync. Syncing files from Dropbox to Assembly',
    )
    const { dbxRootPath, assemblyChannelId, connectionToken, user } = payload
    const mapFilesService = new MapFilesService(user, connectionToken)

    // 1. get all the files folder from dropbox
    const dbx = new DropboxClient(connectionToken.refreshToken, connectionToken.rootNamespaceId)
    const dbxClient = dbx.getDropboxClient()

    let dbxFiles = await dbxClient.filesListFolder({
      path: dbxRootPath,
      recursive: true,
      limit: MAX_FILES_LIMIT,
      include_non_downloadable_files: false,
    })

    // 2. loop over the dropbox files
    while (dbxFiles.result.entries.length) {
      // refresh access token for every batch
      await dbx.dbxAuthClient.refreshAccessToken(connectionToken.refreshToken)

      const parsedDbxFiles = DropboxFileListFolderResultEntriesSchema.safeParse(
        dbxFiles.result.entries,
      )

      if (!parsedDbxFiles.success) {
        logger.error('Error parsing Dropbox files', { error: parsedDbxFiles.error })
        break
      }
      const parsedDbxEntries = parsedDbxFiles.data

      // check and filter out all the mapped files
      const filteredEntries = await mapFilesService.checkAndFilterDbxFiles(
        parsedDbxEntries,
        dbxRootPath,
        assemblyChannelId,
      )

      if (filteredEntries.length) {
        await syncDropboxFileToAssembly.batchTriggerAndWait(filteredEntries)
      }

      if (!dbxFiles.result.has_more) {
        // update channelSync with lastest cursor
        await mapFilesService.updateChannelMap(
          {
            dbxCursor: dbxFiles.result.cursor,
          },
          assemblyChannelId,
          dbxRootPath,
        )
        break
      }

      // continue pagination
      dbxFiles = await dbxClient.filesListFolderContinue({
        cursor: dbxFiles.result.cursor,
      })
    }

    await mapFilesService.updateChannelMap(
      {
        status: true,
        lastSyncedAt: new Date(),
        dbxCursor: dbxFiles.result.cursor,
      },
      assemblyChannelId,
      dbxRootPath,
    )
  },
})

export const syncDropboxFileToAssembly = task({
  id: 'sync-dropbox-file-to-assembly',
  machine,
  queue: {
    name: 'sync-dropbox-file-to-assembly',
    concurrencyLimit: 25,
  },
  retry: {
    maxAttempts: 3,
  },
  run: (payload: DropboxToAssemblySyncFilesPayload) => {
    logger.info('processFileSync#syncDropboxFileToAssembly')
    return withErrorLogging<DropboxToAssemblySyncFilesPayload>(payload, async () => {
      const { opts, entry } = payload
      const syncService = new SyncService(opts.user, opts.connectionToken)
      await syncService.syncDropboxFilesToAssembly({ entry, opts })
    })
  },
})

export const handleChannelFileChanges = task({
  id: 'handle-channel-file-changes',
  machine,
  queue: {
    name: 'handle-channel-file-changes',
    concurrencyLimit: 1,
  },
  run: async (payload: HandleChannelFilePayload) => {
    const { files, channelSyncId, dbxRootPath, assemblyChannelId, user, connectionToken } = payload

    // refresh dropbox access token
    const dbxAuth = new DropboxAuthClient()
    await dbxAuth.refreshAccessToken(connectionToken.refreshToken)

    const mapFilesService = new MapFilesService(user, connectionToken)
    const mappedFiles = await mapFilesService.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        isNotNull(fileFolderSync.dbxFileId),
      ) as WhereClause,
    )
    const mappedIds = mappedFiles.map((item) => z.string().parse(item.dbxFileId))
    const deletedIds: string[] = []

    // TODO: need to refactor this function

    /**
     * Deleted files are handled in batch, so filtering out deleted files
     */
    const deletedFiles = files
      .map((entry) => {
        if (entry['.tag'] === 'deleted' && mappedIds.includes(entry.id)) {
          deletedIds.push(entry.id)
          return {
            payload: {
              opts: {
                dbxRootPath,
                assemblyChannelId,
                channelSyncId,
                user,
                connectionToken,
              },
              entry,
            },
          }
        }
        return null
      })
      .filter((item) => !!item)

    const remainingIds = mappedIds.filter((id) => !deletedIds.includes(id))
    const newFileIds: string[] = []

    /**
     * Files which are new are also processed in batch, so filtering out new files
     */
    const newFiles = files
      .map((entry) => {
        if (entry['.tag'] !== 'deleted' && !remainingIds.includes(entry.id)) {
          newFileIds.push(entry.id)
          return {
            payload: {
              opts: {
                dbxRootPath,
                assemblyChannelId,
                channelSyncId,
                user,
                connectionToken,
              },
              entry,
            },
          }
        }
        return null
      })
      .filter((item) => !!item)

    /**
     * First create and then delete the files. This ensures the files safety.
     * This section should handle file rename, folder rename cases
     */
    if (newFiles.length) await syncDropboxFileToAssembly.batchTriggerAndWait(newFiles)
    if (deletedFiles.length) await deleteDropboxFileInAssembly.batchTriggerAndWait(deletedFiles)

    // Filtering out remaining files that are not new files and are not deleted. Only content updated files are handled below this.
    const remainingFiles = files.filter(
      (singleFile) => singleFile['.tag'] !== 'deleted' && !newFileIds.includes(singleFile.id),
    )

    if (remainingFiles.length) {
      for (const file of remainingFiles) {
        const existingFile = mappedFiles.find((item) => item.dbxFileId === file.id)

        if (existingFile?.contentHash && existingFile.contentHash !== file.content_hash) {
          await updateDropboxFileInAssembly.triggerAndWait({
            opts: {
              dbxRootPath,
              assemblyChannelId,
              channelSyncId,
              user,
              connectionToken,
            },
            entry: file,
          })
        }
      }
    }
  },
})

export const deleteDropboxFileInAssembly = task({
  id: 'delete-dropbox-file-in-assembly',
  queue: {
    name: 'delete-dropbox-file-in-assembly',
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: DropboxToAssemblySyncFilesPayload) => {
    const { opts, entry } = payload
    const { channelSyncId, user, connectionToken, dbxRootPath } = opts
    const syncService = new SyncService(user, connectionToken)
    await syncService.removeFileFromAssembly(channelSyncId, dbxRootPath, entry)
  },
})

export const updateDropboxFileInAssembly = task({
  id: 'update-dropbox-file-in-assembly',
  queue: {
    name: 'update-dropbox-file-in-assembly',
    concurrencyLimit: 5,
  },
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: DropboxToAssemblySyncFilesPayload) => {
    await deleteDropboxFileInAssembly.triggerAndWait(payload)
    await syncDropboxFileToAssembly.trigger(payload)
  },
})

export const initiateAssemblyToDropboxSync = task({
  id: 'initiate-assembly-to-dropbox-sync',
  machine,
  run: async (payload: SyncTaskPayload) => {
    logger.info(
      'processFileSync#initiateAssemblyToDropboxSync. Syncing files from Assembly to Dropbox',
    )

    const { user, connectionToken, dbxRootPath, assemblyChannelId } = payload
    const mapFilesService = new MapFilesService(user, connectionToken)
    const dbxAuth = new DropboxAuthClient()

    // 1. get al the files from the assembly
    const copilotApi = new CopilotAPI(payload.user.token)
    let files = await copilotApi.listFiles(payload.assemblyChannelId)

    while (files.data.length) {
      // refresh dropbox access token for every batch
      await dbxAuth.refreshAccessToken(connectionToken.refreshToken)

      // 2. check and filter out all the mapped files
      const filteredEntries = await mapFilesService.checkAndFilterAssemblyFiles(
        files.data,
        dbxRootPath,
        assemblyChannelId,
      )

      if (filteredEntries.length) {
        await syncAssemblyFileToDropbox.batchTriggerAndWait(filteredEntries)
      }

      if (!files.nextToken) {
        break
      }

      files = await copilotApi.listFiles(payload.assemblyChannelId, files.nextToken)
    }
  },
})

export const syncAssemblyFileToDropbox = task({
  id: 'sync-assembly-file-to-dropbox',
  machine,
  queue: {
    name: 'sync-assembly-file-to-dropbox',
    concurrencyLimit: 25,
  },
  retry: {
    maxAttempts: 3,
  },
  run: (payload: AssemblyToDropboxSyncFilesPayload) => {
    logger.info('processFileSync#syncAssemblyFileToDropbox')
    return withErrorLogging<AssemblyToDropboxSyncFilesPayload>(payload, async () => {
      const { opts, file } = payload
      const syncService = new SyncService(opts.user, opts.connectionToken)
      await syncService.syncAssemblyFilesToDropbox({ file, opts })
    })
  },
})

export const deleteAssemblyFileInDropbox = task({
  id: 'delete-assembly-file-in-dropbox',
  queue: {
    name: 'delete-assembly-file-in-dropbox',
    concurrencyLimit: 5,
  },
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: AssemblyToDropboxSyncFilesPayload) => {
    const { opts } = payload

    const syncService = new SyncService(opts.user, opts.connectionToken)
    await syncService.removeFileFromDropbox(payload)
  },
})

export const updateAssemblyFileInDropbox = task({
  id: 'update-assembly-file-in-dropbox',
  queue: {
    name: 'update-assembly-file-in-dropbox',
    concurrencyLimit: 5,
  },
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: AssemblyToDropboxSyncFilesPayload) => {
    await deleteAssemblyFileInDropbox.triggerAndWait(payload)
    await syncAssemblyFileToDropbox.trigger(payload)
  },
})

export const resyncFailedFilesInAssembly = task({
  id: 'resync-failed-files-in-assembly',
  machine,
  queue: {
    name: 'resync-failed-files-in-assembly',
    concurrencyLimit: 5,
  },
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: { portalId: string; failedSyncs: FileSyncSelectType[] }) => {
    const { portalId, failedSyncs } = payload
    await syncFailedFilesToAssembly(portalId, failedSyncs)
  },
})

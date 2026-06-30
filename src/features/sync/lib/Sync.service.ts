import { and, eq } from 'drizzle-orm'
import { DropboxResponseError, type files as dropboxFiles } from 'dropbox'
import httpStatus from 'http-status'
import fetch from 'node-fetch'
import z from 'zod'
import {
  ObjectType,
  type ObjectTypeValue,
  PendingAction,
  PendingActionTarget,
} from '@/db/constants'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import {
  type FileSyncCreateType,
  type FileSyncSelectType,
  fileFolderSync,
} from '@/db/schema/fileFolderSync.schema'
import APIError from '@/errors/APIError'
import { DBX_URL_PATH } from '@/features/sync/constant'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type {
  AssemblyToDropboxSyncFilesPayload,
  DropboxFileListFolderSingleEntry,
  DropboxToAssemblySyncFilesPayload,
  WhereClause,
} from '@/features/sync/types'
import { copilotBottleneck } from '@/lib/copilot/bottleneck'
import { CopilotAPI, isCopilotApiError } from '@/lib/copilot/CopilotAPI'
import type User from '@/lib/copilot/models/User.model'
import type { CopilotFileRetrieve } from '@/lib/copilot/types'
import AuthenticatedDropboxService from '@/lib/dropbox/AuthenticatedDropbox.service'
import logger from '@/lib/logger'
import { bidirectionalMasterSync } from '@/trigger/processFileSync'
import { appendDateTimeToFilePath, buildPathArray, getPathFromRoot } from '@/utils/filePath'
import { normalizeError } from '@/utils/normalizeError'

type LeafCreateParams = {
  assemblyChannelId: string
  itemPath: string
  channelSyncId: string
  entry: DropboxFileListFolderSingleEntry
}

type ExcludedDropboxToAssemblySyncPayload = Omit<DropboxToAssemblySyncFilesPayload, 'opts'> & {
  opts: Omit<DropboxToAssemblySyncFilesPayload['opts'], 'user' | 'connectionToken'>
}

type OriginalDropboxToAssemblySyncPayload = ExcludedDropboxToAssemblySyncPayload & {
  isRetry: false
  pendingRowId?: never
}

type RetryDropboxToAssemblySyncPayload = ExcludedDropboxToAssemblySyncPayload & {
  isRetry: true
  pendingRowId: string
}

type DiscriminatedDropboxToAssemblySyncParams =
  | OriginalDropboxToAssemblySyncPayload
  | RetryDropboxToAssemblySyncPayload

export class SyncService extends AuthenticatedDropboxService {
  readonly mapFilesService: MapFilesService

  constructor(user: User, connectionToken: DropboxConnectionTokens) {
    super(user, connectionToken)
    this.mapFilesService = new MapFilesService(user, connectionToken)
  }

  async calculateTotalFilesCount(assemblyChannelId: string, dbxRootPath: string, limit?: number) {
    logger.info(
      'SyncService#calculateTotalFilesCount :: Calculating total files count',
      assemblyChannelId,
      dbxRootPath,
    )
    const dbxFilesList = this.dbxClient.getAllFilesFolders(dbxRootPath, true, false, limit)
    const assemblyFilesList = this.user.copilot.listFiles(assemblyChannelId)
    const [dbxFiles, assemblyFiles] = await Promise.all([dbxFilesList, assemblyFilesList])
    const filteredAssemblyFiles = assemblyFiles.data.filter((file) => file.status !== 'pending')

    return dbxFiles.length + filteredAssemblyFiles.length - 1 // Note: subtract 1 to exclude the dbx root folder
  }

  async storeTotalFilesCount(assemblyChannelId: string, dbxRootPath: string) {
    const totalFilesCount = await this.calculateTotalFilesCount(assemblyChannelId, dbxRootPath)
    await this.mapFilesService.getOrCreateChannelMap({
      totalFilesCount,
      assemblyChannelId,
      dbxRootPath,
      dbxAccountId: this.connectionToken.accountId,
    })
  }

  private async handleChannelMap(assemblyChannelId: string, dbxRootPath: string) {
    logger.info(
      `SyncService#handleChannelMap :: handling channel map for channel ${assemblyChannelId} and root path ${dbxRootPath}`,
    )
    const dbxClient = this.dbxClient.getDropboxClient()

    const dbxResponse = await dbxClient.filesGetMetadata({
      path: dbxRootPath,
    })

    if (dbxResponse.result['.tag'] !== ObjectType.FOLDER)
      throw new APIError('Invalid root path', httpStatus.BAD_REQUEST)

    await this.mapFilesService.updateChannelMap(
      {
        dbxRootId: dbxResponse.result.id,
      },
      assemblyChannelId,
      dbxRootPath,
    )
  }

  async initiateSync(assemblyChannelId: string, dbxRootPath: string) {
    logger.info('SyncService#initiateSync :: Initiating sync', assemblyChannelId, dbxRootPath)

    // handle channel map and create channel with dbxRootPath and Id
    await this.handleChannelMap(assemblyChannelId, dbxRootPath)

    await bidirectionalMasterSync.trigger({
      dbxRootPath,
      assemblyChannelId,
      connectionToken: this.connectionToken,
      user: this.user,
    })
  }

  async syncDropboxFilesToAssembly({
    entry,
    opts,
    isRetry,
    pendingRowId,
  }: DiscriminatedDropboxToAssemblySyncParams) {
    logger.info(
      'SyncService#syncDropboxFilesToAssembly :: Syncing Dropbox files to Assembly for channel',
      opts.assemblyChannelId,
    )

    const { dbxRootPath, assemblyChannelId, channelSyncId } = opts
    const fileObjectType = entry['.tag']
    const basePath = entry.path_display.replace(dbxRootPath, '') // removes the base folder path
    const pathArray = buildPathArray(basePath) // to create a folders hierarchy if not exists

    const uploadPromises = []
    for (let i = 0; i < pathArray.length; i++) {
      const lastItem = i === pathArray.length - 1
      const itemPath = pathArray[i]

      logger.info(
        'SyncService#syncDropboxFilesToAssembly :: Syncing Dropbox files to Assembly for channel',
        opts.assemblyChannelId,
      )
      const uploadPayload = {
        assemblyChannelId,
        itemPath,
        lastItem,
        fileObjectType: fileObjectType as ObjectTypeValue,
        channelSyncId,
        entry,
        basePath,
        isRetry,
        pendingRowId,
      }
      const uploadFn = this.createAndUploadFileToAssembly.bind(this)

      if (!isRetry) {
        uploadPromises.push(
          copilotBottleneck.schedule(() => {
            return uploadFn(uploadPayload)
          }),
        )
      } else {
        // Retries are few and run in order (parent folders first), so skip the bottleneck.
        // todo: batch/throttle retry segments if volume grows.
        await uploadFn(uploadPayload)
      }
    }

    !isRetry && (await Promise.all(uploadPromises))
  }

  private async createAndUploadFileToAssembly(args: {
    assemblyChannelId: string
    itemPath: string
    lastItem: boolean
    fileObjectType: ObjectTypeValue
    channelSyncId: string
    entry: DropboxFileListFolderSingleEntry
    basePath: string
    isRetry?: boolean
    pendingRowId?: string
  }) {
    const {
      assemblyChannelId,
      itemPath,
      lastItem,
      fileObjectType,
      channelSyncId,
      entry,
      basePath,
      isRetry,
      pendingRowId,
    } = args
    logger.info(
      'SyncService#createAndUploadFileToAssembly :: Creating and uploading file to Assembly for channel',
      assemblyChannelId,
    )

    const isLeafFile = lastItem && fileObjectType === ObjectType.FILE
    if (isLeafFile) {
      // On retry the row already exists, so just create the file in assembly.
      !isRetry
        ? await this.createLeafFileInAssembly({
            assemblyChannelId,
            itemPath,
            channelSyncId,
            entry,
          })
        : await this.completePendingAssemblyCreate({
            pendingRowId: z.string().parse(pendingRowId),
            itemPath,
            assemblyChannelId,
            channelSyncId,
            entry,
          })
      return
    }

    await this.createFolderInAssembly({
      assemblyChannelId,
      itemPath,
      lastItem,
      tempFileType: lastItem ? fileObjectType : ObjectType.FOLDER,
      channelSyncId,
      entry,
      basePath,
    })
  }

  /** Create a leaf file in Assembly. If the path already has a row, re-sync only on content change. */
  private async createLeafFileInAssembly(params: LeafCreateParams): Promise<void> {
    const { itemPath, channelSyncId, entry } = params
    const pending = await this.insertLeafPending(channelSyncId, itemPath, entry.id)

    if (!pending) {
      await this.resyncLeafOnContentChange(params)
      return
    }

    await this.driveAssemblyCreate(pending.id, params)
  }

  /** Path already mapped: recreate the file in Assembly only when its content changed. */
  private async resyncLeafOnContentChange(params: LeafCreateParams): Promise<void> {
    const { itemPath, channelSyncId, entry } = params
    const existing = await this.mapFilesService.getDbxMappedFileFromPath(itemPath, channelSyncId)

    if (!existing) {
      // Insert lost the race, or the path's row isn't synced yet (no assemblyFileId).
      logger.info('SyncService#resyncLeafOnContentChange :: no synced row for path, skipping', {
        channelSyncId,
        itemPath,
        dbxFileId: entry.id,
      })
      return
    }

    // Recreate only on a confirmed change: both hashes present and differing. A missing
    // hash on either side gives no baseline, so skip (matches the existing update path).
    if (
      !entry.content_hash ||
      !existing.contentHash ||
      existing.contentHash === entry.content_hash
    ) {
      logger.info(
        'SyncService#resyncLeafOnContentChange :: content hash missing or unchanged, skipping',
        {
          channelSyncId,
          itemPath,
          dbxFileId: entry.id,
        },
      )
      return
    }

    logger.info('SyncService#resyncLeafOnContentChange :: content changed, recreating', {
      channelSyncId,
      itemPath,
      dbxFileId: entry.id,
    })

    // Delete the row we already resolved — no re-lookup, so the deletion can't silently miss.
    await this.removeAssemblyFileForRow(existing)
    const recreated = await this.insertLeafPending(channelSyncId, itemPath, entry.id)
    if (recreated) {
      await this.driveAssemblyCreate(recreated.id, params)
    } else {
      // A concurrent insert re-took the path; that worker will drive the create.
      logger.warn(
        'SyncService#resyncLeafOnContentChange :: path re-taken concurrently, leaving recreate to the other worker',
        {
          channelSyncId,
          itemPath,
          dbxFileId: entry.id,
        },
      )
    }
  }

  /** Insert a create-pending row for a leaf file. Null if the path is already taken. */
  private insertLeafPending(channelSyncId: string, itemPath: string, dbxFileId: string) {
    return this.mapFilesService.insertCreatePending({
      channelSyncId,
      itemPath,
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId,
    })
  }

  /** Run the Assembly create for a pending row; record failure if it throws. */
  private async driveAssemblyCreate(pendingRowId: string, params: LeafCreateParams): Promise<void> {
    const { assemblyChannelId, itemPath, channelSyncId, entry } = params
    try {
      await this.completePendingAssemblyCreate({
        pendingRowId,
        itemPath,
        assemblyChannelId,
        channelSyncId,
        entry,
      })
    } catch (error) {
      await this.mapFilesService.markFailure(pendingRowId, normalizeError(error))
      throw error
    }
  }

  /** Folder create: pre-check skips redundant creates, insertFileMap's onConflict is the race net (OUT-3800). */
  private async createFolderInAssembly(params: {
    assemblyChannelId: string
    itemPath: string
    lastItem: boolean
    tempFileType: ObjectTypeValue
    channelSyncId: string
    entry: DropboxFileListFolderSingleEntry
    basePath: string
  }): Promise<void> {
    const { assemblyChannelId, itemPath, lastItem, tempFileType, channelSyncId, entry, basePath } =
      params

    try {
      // A sibling may have already created this folder; skip the redundant create.
      const existingFolder = await this.mapFilesService.getDbxMappedFileFromPath(
        itemPath,
        channelSyncId,
      )
      if (existingFolder) {
        logger.info(
          'SyncService#createFolderInAssembly :: folder already mapped, skipping create',
          {
            channelSyncId,
            itemPath,
          },
        )
        // If this entry is the folder itself, make sure its dbxFileId is stamped.
        await this.handleFolderCreatedCase(
          lastItem,
          tempFileType,
          channelSyncId,
          basePath,
          entry.id,
        )
        return
      }

      const copilotApi = new CopilotAPI(this.user.token)
      const fileCreateResponse = await copilotApi.createFile(
        itemPath,
        assemblyChannelId,
        tempFileType,
      )
      const filePayload: FileSyncCreateType = {
        channelSyncId,
        itemPath,
        object: tempFileType,
        assemblyFileId: fileCreateResponse.id,
        portalId: this.user.portalId,
        dbxFileId: lastItem ? entry.id : null,
      }

      const inserted = await this.mapFilesService.insertFileMap(filePayload)

      if (inserted) {
        await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
      } else {
        // Insert lost the race. If this is the folder entry itself, stamp dbxFileId:
        // needed if the winner wrote null (intermediate segment), else a no-op.
        await this.handleFolderCreatedCase(
          lastItem,
          tempFileType,
          channelSyncId,
          basePath,
          entry.id,
        )
      }
    } catch (error: unknown) {
      if (
        isCopilotApiError(error) &&
        error.status === 400 &&
        error.body.message === 'Folder already exists'
      ) {
        console.info({ message: error.body.message, path: itemPath })
        await this.handleFolderCreatedCase(
          lastItem,
          tempFileType,
          channelSyncId,
          basePath,
          entry.id,
        )
        return
      }
      console.error(
        `SyncService#createFolderInAssembly. Upload failed. Channel ID: ${assemblyChannelId}. Path: ${itemPath}`,
      )
      throw error
    }
  }

  /** Drive a Dropbox→Assembly create against an existing pre-inserted row. Called by both syncDropboxFilesToAssembly's leaf branch and the sweeper's retryCreateInAssembly. */
  async completePendingAssemblyCreate(params: {
    pendingRowId: string
    itemPath: string
    assemblyChannelId: string
    channelSyncId: string
    entry: DropboxFileListFolderSingleEntry
  }): Promise<void> {
    const { pendingRowId, itemPath, assemblyChannelId, channelSyncId, entry } = params
    const copilotApi = new CopilotAPI(this.user.token)

    const fileCreateResponse = await copilotApi.createFile(
      itemPath,
      assemblyChannelId,
      ObjectType.FILE,
    )

    // Stamp assemblyFileId before the upload step so a concurrent Assembly
    // `file.created` echo webhook dedupes against this row instead of
    // re-creating the file in Dropbox (ping-pong).
    await this.mapFilesService.updateFileMap(
      { assemblyFileId: fileCreateResponse.id },
      eq(fileFolderSync.id, pendingRowId),
    )

    if (fileCreateResponse.uploadUrl) {
      await this.uploadFileInAssembly(entry.path_display, fileCreateResponse.uploadUrl, copilotApi)
    }

    await this.mapFilesService.markUpdated(pendingRowId, {
      assemblyFileId: fileCreateResponse.id,
      contentHash: entry.content_hash ?? null,
    })

    await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
  }

  /** Drive an Assembly→Dropbox create against an existing pre-inserted row. Called by both syncAssemblyFilesToDropbox and the sweeper's retryCreateInDropbox. */
  async completePendingDropboxCreate(params: {
    pendingRowId: string
    channelSyncId: string
    dbxRootPath: string
    file: CopilotFileRetrieve & { object: ObjectTypeValue }
  }): Promise<void> {
    const { pendingRowId, channelSyncId, dbxRootPath, file } = params

    const dbxFileInfo = await this.createAndUploadFileInDropbox(dbxRootPath, file.object, file)
    if (!dbxFileInfo) {
      throw new Error(
        `completePendingDropboxCreate: createAndUploadFileInDropbox returned undefined (file=${file.id}, type=${file.object})`,
      )
    }

    await this.mapFilesService.markUpdated(pendingRowId, {
      dbxFileId: dbxFileInfo.dbxFileId,
      contentHash: dbxFileInfo.contentHash ?? null,
    })

    await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
  }

  async removeFileFromAssembly(
    channelSyncId: string,
    dbxRootPath: string,
    entry: DropboxFileListFolderSingleEntry,
  ) {
    const mappedFile = await this.mapFilesService.getDbxMappedFile(
      entry.id,
      channelSyncId,
      getPathFromRoot(entry.path_display, dbxRootPath),
    )
    if (!mappedFile) return
    await this.removeAssemblyFileForRow(mappedFile)
  }

  /** Delete a resolved row's Assembly file and soft-delete the row. */
  private async removeAssemblyFileForRow(mappedFile: FileSyncSelectType) {
    if (!mappedFile.assemblyFileId) {
      logger.warn('removeAssemblyFileForRow :: row missing assemblyFileId, skipping', {
        rowId: mappedFile.id,
      })
      return
    }

    await this.mapFilesService.markAttempt(
      mappedFile.id,
      PendingAction.DELETE,
      PendingActionTarget.ASSEMBLY,
    )

    try {
      await this.deleteAssemblyFileQuietly(mappedFile.assemblyFileId)
      await this.mapFilesService.markDeleted(mappedFile.id)
    } catch (error) {
      await this.mapFilesService.markFailure(mappedFile.id, normalizeError(error))
      throw error
    }
  }

  async removeFileFromDropbox(payload: AssemblyToDropboxSyncFilesPayload) {
    const { file, opts } = payload
    const { channelSyncId, dbxRootPath } = opts

    const mappedFile = await this.mapFilesService.getAssemblyMappedFile(file.id, channelSyncId)
    if (!mappedFile) return
    if (!mappedFile.itemPath) {
      logger.warn('removeFileFromDropbox :: row missing itemPath, skipping', {
        rowId: mappedFile.id,
      })
      return
    }

    await this.mapFilesService.markAttempt(
      mappedFile.id,
      PendingAction.DELETE,
      PendingActionTarget.DROPBOX,
    )

    try {
      await this.deleteDropboxFileQuietly(`${dbxRootPath}${mappedFile.itemPath}`)
      await this.mapFilesService.markDeleted(mappedFile.id)
    } catch (error) {
      await this.mapFilesService.markFailure(mappedFile.id, normalizeError(error))
      throw error
    }
  }

  private async uploadFileInAssembly(dbxPath: string, uploadUrl: string, copilotApi: CopilotAPI) {
    logger.info('SyncService#uploadFileInAssembly :: Uploading file to Assembly', dbxPath)

    // Stream the file directly from Dropbox into Assembly's S3 upload URL.
    // `contentLength` comes from the download response headers, guaranteeing it
    // matches the exact bytes in the stream. Avoids the Dropbox SDK's
    // `filesDownload` which buffers the full file in memory (OOMs on videos).
    const { body: downloadBody, contentLength } = await this.dbxClient.downloadFile({
      urlPath: DBX_URL_PATH.fileDownload,
      filePath: dbxPath,
      rootNamespaceId: z.string().parse(this.connectionToken.rootNamespaceId),
      refreshToken: this.connectionToken.refreshToken,
    })
    logger.info('SyncService#uploadFileInAssembly :: Found downloadBody', Boolean(downloadBody))

    // upload file to assembly
    const fileUploadResp = await copilotApi.uploadFile(uploadUrl, contentLength, downloadBody)
    logger.info('SyncService#uploadFileInAssembly :: File uploaded to Assembly', dbxPath)

    if (fileUploadResp.status !== httpStatus.OK) {
      console.error({ error: await fileUploadResp.json() })
      throw new Error('SyncService#uploadFileInAssemnly. Failed to upload file to assembly')
    }
  }

  /**
   * purpose: checks if the item is last item of the folder heirarchy and the entry is a folder.
   * if yes, update the dbxFileId to the table
   */
  private async handleFolderCreatedCase(
    lastItem: boolean,
    tempFileType: ObjectTypeValue,
    channelSyncId: string,
    basePath: string,
    entryId: string,
  ) {
    if (lastItem && tempFileType === ObjectType.FOLDER) {
      const fileMapCondition = and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        eq(fileFolderSync.itemPath, basePath),
      ) as WhereClause
      try {
        logger.info(
          'SyncService#handleFolderCreatedCase :: Updating dbxFileId',
          entryId,
          fileMapCondition.getSQL(),
        )
      } catch (e) {
        logger.info(e)
      }

      // update the dbxFileId to the table
      await this.mapFilesService.updateFileMap(
        {
          dbxFileId: entryId,
        },
        fileMapCondition,
      )
    }
  }

  async syncAssemblyFilesToDropbox({ file, opts }: AssemblyToDropboxSyncFilesPayload) {
    const { channelSyncId, dbxRootPath } = opts

    const pending = await this.mapFilesService.insertCreatePending({
      channelSyncId,
      assemblyFileId: file.id,
      dbxFileId: null,
      itemPath: `/${file.path}`, //appending '/' to maintain consistency
      object: file.object,
      target: PendingActionTarget.DROPBOX,
    })

    if (!pending) {
      logger.info('syncAssemblyFilesToDropbox :: race lost, skipping', {
        channelSyncId,
        assemblyFileId: file.id,
      })
      return
    }

    try {
      await this.completePendingDropboxCreate({
        pendingRowId: pending.id,
        channelSyncId,
        dbxRootPath,
        file,
      })
    } catch (error) {
      await this.mapFilesService.markFailure(pending.id, normalizeError(error))
      throw error
    }
  }

  async createAndUploadFileInDropbox(
    dbxRootPath: string,
    fileType: ObjectTypeValue,
    file: CopilotFileRetrieve,
  ): Promise<{ dbxFileId: string; contentHash?: string } | undefined> {
    console.info(`SyncService#createAndUploadFileInDropbox. Channel ID: ${file.channelId}`)

    const dbxClient = this.dbxClient.getDropboxClient()
    const dbxFilePath = `${dbxRootPath}/${file.path}`
    logger.info('SyncService#createAndUploadFileInDropbox :: Found dbxFilePath', dbxFilePath)

    // 1. check if the file/folder exists. The try/catch is narrowed to JUST
    // this SDK call: a 409/not_found here means "doesn't exist yet, create
    // it". Wrapping the rename-then-reupload path below would misroute its
    // own 409s (e.g. parent folder missing during upload) into the create
    // branch and double-fire uploadFileInDropbox.
    let existing:
      | dropboxFiles.FileMetadataReference
      | dropboxFiles.FolderMetadataReference
      | dropboxFiles.DeletedMetadataReference
      | undefined

    try {
      const dbxResponse = await dbxClient.filesGetMetadata({ path: dbxFilePath })
      existing = dbxResponse.result
    } catch (error: unknown) {
      const dbxError =
        error instanceof DropboxResponseError
          ? (error.error as { error?: { path?: { '.tag'?: string } } } | undefined)
          : undefined
      const isNotFound =
        error instanceof DropboxResponseError &&
        error.status === 409 &&
        dbxError?.error?.path?.['.tag'] === 'not_found'
      if (!isNotFound) {
        console.error(`SyncService#createAndUploadFileInDropbox. Channel ID: ${file.channelId}`)
        throw error
      }
    }

    // 1.1 if folder exists, simply return the folder id
    if (existing?.['.tag'] === ObjectType.FOLDER) {
      logger.info('SyncService#createAndUploadFileInDropbox :: Folder exists', dbxFilePath)
      return { dbxFileId: existing.id }
    }

    // 1.2 if file exists, rename the existing file in Dropbox and re-upload
    if (existing?.['.tag'] === ObjectType.FILE) {
      const newFilePath = appendDateTimeToFilePath(dbxFilePath)
      logger.info(
        'SyncService#createAndUploadFileInDropbox :: Renaming file',
        dbxFilePath,
        newFilePath,
      )

      await dbxClient.filesMoveV2({
        from_path: dbxFilePath,
        to_path: newFilePath,
      })

      return await this.uploadFileInDropbox(file, dbxFilePath)
    }

    if (existing) {
      console.info(
        `SyncService#createAndUploadFileInDropbox. File exists but didn't received required file tag. Type: ${existing['.tag']}. Channel ID: ${file.channelId}`,
      )
      return
    }

    // 2. file doesn't exist, create the file/folder
    logger.info("SyncService#createAndUploadFileInDropbox :: File doesn't exist", dbxFilePath)
    if (fileType === ObjectType.FOLDER) {
      const folderCreateResponse = await dbxClient.filesCreateFolderV2({
        path: dbxFilePath,
      })
      logger.info('SyncService#createAndUploadFileInDropbox :: Folder created', dbxFilePath)
      return { dbxFileId: folderCreateResponse.result.metadata.id }
    }
    if (fileType === ObjectType.FILE) {
      logger.info('SyncService#createAndUploadFileInDropbox :: File created', dbxFilePath)
      return await this.uploadFileInDropbox(file, dbxFilePath)
    }
    console.info(
      `SyncService#createAndUploadFileInDropbox. File type out of bound. Type: ${fileType}. Channel ID: ${file.channelId}`,
    )
  }

  private async uploadFileInDropbox(file: CopilotFileRetrieve, path: string) {
    logger.info('SyncService#uploadFileInDropbox :: Uploading file to', path)
    if (file.downloadUrl) {
      // download file from Assembly
      const resp = await fetch(file.downloadUrl)
      // upload file to dropbox
      const dbxResponse = await this.dbxClient.uploadFile({
        urlPath: DBX_URL_PATH.fileUpload,
        filePath: path,
        body: resp.body,
        rootNamespaceId: z.string().parse(this.connectionToken.rootNamespaceId),
        refreshToken: this.connectionToken.refreshToken,
      })
      logger.info('SyncService#uploadFileInDropbox :: File uploaded to', path)
      return {
        dbxFileId: dbxResponse.id,
        contentHash: dbxResponse.contentHash,
      }
    }
    console.error(
      `SyncService#uploadFileInDropbox. Assembly file with Id: ${file.id} has no download url. Channel ID: ${file.channelId}`,
    )
    throw new Error('File not found')
  }

  async removeChannelSyncMapping(channelSyncId: string) {
    await this.mapFilesService.deleteChannelMapsByIds([channelSyncId])
  }

  private async deleteAssemblyFileQuietly(assemblyFileId: string) {
    const copilotApi = new CopilotAPI(this.user.token)
    try {
      await copilotApi.deleteFile(assemblyFileId)
    } catch (error) {
      if (isCopilotApiError(error) && error.status === 404) return
      throw error
    }
  }

  private async deleteDropboxFileQuietly(dbxFilePath: string) {
    try {
      await this.dbxClient.getDropboxClient().filesDeleteV2({ path: dbxFilePath })
    } catch (error) {
      if (
        error instanceof DropboxResponseError &&
        error.status === 409 &&
        (error.error as { error_summary?: string })?.error_summary?.startsWith(
          'path_lookup/not_found',
        )
      ) {
        return
      }
      throw error
    }
  }
}

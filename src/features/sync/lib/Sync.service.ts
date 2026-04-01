import { and, eq } from 'drizzle-orm'
import { DropboxResponseError } from 'dropbox'
import httpStatus from 'http-status'
import fetch from 'node-fetch'
import z from 'zod'
import { ObjectType, type ObjectTypeValue } from '@/db/constants'
import type { DropboxConnectionTokens } from '@/db/schema/dropboxConnections.schema'
import { type FileSyncCreateType, fileFolderSync } from '@/db/schema/fileFolderSync.schema'
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
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type User from '@/lib/copilot/models/User.model'
import type { CopilotFileRetrieve } from '@/lib/copilot/types'
import AuthenticatedDropboxService from '@/lib/dropbox/AuthenticatedDropbox.service'
import logger from '@/lib/logger'
import { bidirectionalMasterSync } from '@/trigger/processFileSync'
import { isAssemblyApiError } from '@/utils/assemblyError'
import { appendDateTimeToFilePath, buildPathArray, getPathFromRoot } from '@/utils/filePath'

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

  async syncDropboxFilesToAssembly({ entry, opts }: DropboxToAssemblySyncFilesPayload) {
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

      uploadPromises.push(
        copilotBottleneck.schedule(() => {
          logger.info(
            'SyncService#syncDropboxFilesToAssembly :: Syncing Dropbox files to Assembly for channel',
            opts.assemblyChannelId,
          )
          return this.createAndUploadFileToAssembly(
            assemblyChannelId,
            itemPath,
            lastItem,
            fileObjectType as ObjectTypeValue,
            channelSyncId,
            entry,
            basePath,
          )
        }),
      )
    }

    await Promise.all(uploadPromises)
  }

  async createAndUploadFileToAssembly(
    assemblyChannelId: string,
    itemPath: string,
    lastItem: boolean,
    fileObjectType: ObjectTypeValue,
    channelSyncId: string,
    entry: DropboxFileListFolderSingleEntry,
    basePath: string,
  ) {
    logger.info(
      'SyncService#createAndUploadFileToAssembly :: Creating and uploading file to Assembly for channel',
      assemblyChannelId,
    )
    const copilotApi = new CopilotAPI(this.user.token)
    const tempFileType = lastItem ? fileObjectType : ObjectType.FOLDER

    try {
      // create file/folder
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
      }

      const mappedFile = await this.mapFilesService.insertFileMap({
        ...filePayload,
        dbxFileId: lastItem ? entry.id : null,
      })

      if (fileObjectType === ObjectType.FILE && fileCreateResponse.uploadUrl && lastItem) {
        await this.uploadFileInAssembly(
          entry?.path_display,
          fileCreateResponse.uploadUrl,
          copilotApi,
        )
        await this.mapFilesService.updateFileMap(
          {
            contentHash: entry.content_hash,
          },
          eq(fileFolderSync.id, mappedFile.id),
        )
      }

      console.info(
        `SyncService#createAndUploadFileToAssembly. Channel ID: ${assemblyChannelId}. File upload success. Type: ${tempFileType}. File ID: ${filePayload.assemblyFileId}. Dbx fileId: ${lastItem ? entry.id : null}`,
      )
      await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
    } catch (error: unknown) {
      if (
        isAssemblyApiError(error) &&
        error.status === httpStatus.BAD_REQUEST &&
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
        `SyncService#createAndUploadFileToAssembly. Upload failed. Channel ID: ${assemblyChannelId}. Path: ${itemPath}`,
      )
      throw error
    }
  }

  async removeFileFromAssembly(
    channelSyncId: string,
    dbxRootPath: string,
    entry: DropboxFileListFolderSingleEntry,
  ) {
    const copilotApi = new CopilotAPI(this.user.token)
    const mappedFile = await this.mapFilesService.getDbxMappedFile(
      entry.id,
      channelSyncId,
      getPathFromRoot(entry.path_display, dbxRootPath), // the file path ensures the file to be deleted
    )
    logger.info(
      'SyncService#removeFileFromAssembly :: Removing file from Assembly for channel',
      channelSyncId,
    )

    if (!mappedFile) {
      return
    }
    if (mappedFile.assemblyFileId) {
      const deleteMappedFile = this.mapFilesService.deleteFileMap(mappedFile.id)
      const deleteFileInAssembly = copilotApi.deleteFile(mappedFile.assemblyFileId)
      await Promise.all([deleteMappedFile, deleteFileInAssembly])
    }
    logger.info(
      'SyncService#removeFileFromAssembly :: File removed from Assembly for channel',
      channelSyncId,
    )
  }

  async removeFileFromDropbox(payload: AssemblyToDropboxSyncFilesPayload) {
    try {
      const { file, opts } = payload
      const { channelSyncId } = opts
      const mappedFile = await this.mapFilesService.getAssemblyMappedFile(file.id, channelSyncId)
      if (!mappedFile) {
        return
      }
      const { dbxRootPath } = opts
      const dbxFilePath = `${dbxRootPath}${mappedFile.itemPath}`
      const dbxClient = this.dbxClient.getDropboxClient()

      await this.mapFilesService.deleteFileMap(mappedFile.id)
      await dbxClient.filesDeleteV2({ path: dbxFilePath })
      logger.info(
        'SyncService#removeFileFromDropbox :: File removed from Dropbox for channel',
        channelSyncId,
      )
    } catch (error: unknown) {
      if (error instanceof DropboxResponseError) {
        console.info({ err: error.error })
      } else {
        console.error('error : ', error)
      }
    }
  }

  private async uploadFileInAssembly(dbxPath: string, uploadUrl: string, copilotApi: CopilotAPI) {
    logger.info('SyncService#uploadFileInAssembly :: Uploading file to Assembly', dbxPath)

    const dbx = this.dbxClient.getDropboxClient()
    const fileMetaData = await dbx.filesDownload({ path: dbxPath }) // get metadata for the files
    logger.info('SyncService#uploadFileInAssembly :: File metadata downloaded', dbxPath)

    const downloadBody = await this.dbxClient.downloadFile({
      urlPath: DBX_URL_PATH.fileDownload,
      filePath: dbxPath,
      rootNamespaceId: z.string().parse(this.connectionToken.rootNamespaceId),
    })
    logger.info('SyncService#uploadFileInAssembly :: Found downloadBody', Boolean(downloadBody))

    // upload file to assembly
    const fileUploadResp = await copilotApi.uploadFile(
      uploadUrl,
      fileMetaData.result.size.toString(),
      downloadBody,
    )
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
    console.info(`SyncService#syncAssemblyFilesToDropbox. Channel ID: ${opts.assemblyChannelId}`)

    const { channelSyncId, dbxRootPath } = opts
    const filePayload = {
      channelSyncId,
      itemPath: `/${file.path}`, //appending '/' to maintain consistency
      object: file.object,
      portalId: this.user.portalId,
      assemblyFileId: file.id,
    }

    const dbxFileInfo = await this.createAndUploadFileInDropbox(dbxRootPath, file.object, file)
    await this.mapFilesService.insertFileMap({
      ...filePayload,
      ...dbxFileInfo,
    })
    console.info(
      `SyncService#syncAssemblyFilesToDropbox. Channel ID: ${opts.assemblyChannelId}. File upload success. Type: ${file.object}. File ID: ${filePayload.assemblyFileId}. Dbx fileId: ${dbxFileInfo?.dbxFileId}`,
    )
    await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
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

    // create file/folder
    try {
      // 1. check if the file/folder exists
      const dbxResponse = await dbxClient.filesGetMetadata({
        path: dbxFilePath,
      })
      // 1.1 if folder exists, simply return the folder id
      if (dbxResponse.result['.tag'] === ObjectType.FOLDER) {
        logger.info('SyncService#createAndUploadFileInDropbox :: Folder exists', dbxFilePath)
        return { dbxFileId: dbxResponse.result.id }
      } else if (dbxResponse.result['.tag'] === ObjectType.FILE) {
        // 1.2 if file exists, rename the existing file in Dropbox and create a new file
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
      console.info(
        `SyncService#createAndUploadFileInDropbox. File exists but didn't received required file tag. Type: ${dbxResponse.result['.tag']}. Channel ID: ${file.channelId}`,
      )
    } catch (error: unknown) {
      // 2. if doesn't exist, create the file/folder
      if (
        error instanceof DropboxResponseError &&
        error.status === 409 &&
        error.error.error.path['.tag'] === 'not_found'
      ) {
        logger.info("SyncService#createAndUploadFileInDropbox :: File doesn't exist", dbxFilePath)
        if (fileType === ObjectType.FOLDER) {
          const folderCreateResponse = await dbxClient.filesCreateFolderV2({
            path: dbxFilePath,
          })
          logger.info('SyncService#createAndUploadFileInDropbox :: Folder created', dbxFilePath)
          return { dbxFileId: folderCreateResponse.result.metadata.id }
        } else if (fileType === ObjectType.FILE) {
          logger.info('SyncService#createAndUploadFileInDropbox :: File created', dbxFilePath)
          return await this.uploadFileInDropbox(file, dbxFilePath)
        }
        console.info(
          `SyncService#createAndUploadFileInDropbox. File type out of bound. Type: ${fileType}. Channel ID: ${file.channelId}`,
        )
      }
      console.error(`SyncService#createAndUploadFileInDropbox. Channel ID: ${file.channelId}`)
      throw error
    }
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
    await this.mapFilesService.deleteChannelMapById(channelSyncId)
  }
}

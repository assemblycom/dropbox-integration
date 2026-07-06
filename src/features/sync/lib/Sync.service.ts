import { and, eq, isNotNull } from 'drizzle-orm'
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
import {
  appendDateTimeToFilePath,
  buildPathArray,
  composeChildPath,
  ensureLeadingSlash,
  findDisallowedChars,
  getBaseName,
  getParentPath,
  getPathFromRoot,
} from '@/utils/filePath'
import { normalizeError } from '@/utils/normalizeError'

type LeafCreateParams = {
  assemblyChannelId: string
  itemPath: string
  channelSyncId: string
  entry: DropboxFileListFolderSingleEntry
  // Pre-resolved Assembly path (parent's assemblyPath + leaf); override is used verbatim on resync.
  assemblyCreatePath: string
  assemblyPathOverride?: string
}

type CreateAndUploadFileToAssemblyArgs = {
  assemblyChannelId: string
  itemPath: string
  assemblyCreatePath: string
  lastItem: boolean
  fileObjectType: ObjectTypeValue
  channelSyncId: string
  entry: DropboxFileListFolderSingleEntry
  basePath: string
  isRetry?: boolean
  pendingRowId?: string
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
    const basePath = entry.path_display.replace(dbxRootPath, '')

    const pathArray = buildPathArray(basePath)

    // assemblyFileId is set on every synced folder; dbxFileId only once it syncs as its
    // own entry. resolvedByPath maps synced folders to their real (possibly diverged)
    // Assembly path so new segments chain off it without a per-segment DB lookup.
    const existingFolderRows = await this.mapFilesService.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        eq(fileFolderSync.object, ObjectType.FOLDER),
        isNotNull(fileFolderSync.assemblyFileId),
      ) as WhereClause,
    )
    const resolvedByPath = new Map<string, string | null>()
    const mappedFolderPaths = new Set<string>()
    for (const file of existingFolderRows) {
      if (!file.itemPathLower) continue
      resolvedByPath.set(file.itemPathLower, file.assemblyPath)
      if (file.dbxFileId) mappedFolderPaths.add(file.itemPathLower)
    }

    const uploadPayloads: CreateAndUploadFileToAssemblyArgs[] = []
    for (let i = 0; i < pathArray.length; i++) {
      const lastItem = i === pathArray.length - 1
      const itemPath = pathArray[i]
      const key = itemPath.toLowerCase()

      // Skip mapped folders, and synced folders unless this is their own entry (where they
      // still need handleFolderCreatedCase to stamp dbxFileId).
      if (mappedFolderPaths.has(key) || (resolvedByPath.has(key) && !lastItem)) {
        logger.info('SyncService#syncDropboxFilesToAssembly :: Skipping existing folder', {
          itemPath,
        })
        continue
      }

      const isLeafFile = lastItem && fileObjectType === ObjectType.FILE

      // Validate new folders only; leaf files are validated in createLeafFileInAssembly.
      if (!isLeafFile && !resolvedByPath.has(key)) {
        const disallowed = findDisallowedChars(getBaseName(itemPath), 'assembly')
        if (disallowed) {
          const message =
            'SyncService#syncDropboxFilesToAssembly :: Skipping entry with disallowed characters'
          logger.error(message, {
            channelSyncId,
            assemblyChannelId,
            path: basePath,
            segment: itemPath,
            disallowed,
            target: 'assembly',
          })
          // pendingRowId present ⇒ retry: record the terminal failure so it stops retrying.
          if (pendingRowId) {
            await this.mapFilesService.markFailure(pendingRowId, `${message} (${disallowed})`)
          }
          return
        }
      }

      // Existing synced folders carry their stored assemblyPath; new segments chain off
      // the parent's. (Backfill runs right after the migration, so a synced folder always
      // has an assemblyPath by the time we resolve here.)
      let assemblyCreatePath = resolvedByPath.get(key)
      if (assemblyCreatePath == null) {
        const parentPath = resolvedByPath.get(getParentPath(itemPath).toLowerCase())
        assemblyCreatePath = composeChildPath(parentPath, itemPath)
        resolvedByPath.set(key, assemblyCreatePath)
      }

      uploadPayloads.push({
        assemblyChannelId,
        itemPath,
        assemblyCreatePath,
        lastItem,
        fileObjectType: fileObjectType as ObjectTypeValue,
        channelSyncId,
        entry,
        basePath,
        isRetry,
        pendingRowId: isLeafFile ? pendingRowId : undefined,
      })
    }

    // Pre-resolved paths mean segments don't depend on each other's row, so they can run
    // concurrently (retries stay ordered).
    const uploadFn = this.createAndUploadFileToAssembly.bind(this)
    if (isRetry) {
      for (const payload of uploadPayloads) await uploadFn(payload)
    } else {
      await Promise.all(
        uploadPayloads.map((payload) => copilotBottleneck.schedule(() => uploadFn(payload))),
      )
    }
  }

  private async createAndUploadFileToAssembly(args: CreateAndUploadFileToAssemblyArgs) {
    const {
      assemblyChannelId,
      itemPath,
      assemblyCreatePath,
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
            assemblyCreatePath,
            channelSyncId,
            entry,
          })
        : await this.completePendingAssemblyCreate({
            pendingRowId: z.string().parse(pendingRowId),
            assemblyCreatePath,
            assemblyChannelId,
            channelSyncId,
            entry,
          })
      return
    }

    await this.createFolderInAssembly({
      assemblyChannelId,
      itemPath,
      assemblyCreatePath,
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
      // Already-synced path (incl. legacy invalid names): let resync decide, don't reject.
      await this.resyncLeafOnContentChange(params)
      return
    }

    // New file: skip if Assembly would reject the name, dropping the tombstone we inserted.
    const disallowed = findDisallowedChars(getBaseName(itemPath), 'assembly')
    if (disallowed) {
      logger.error(
        'SyncService#createLeafFileInAssembly :: Skipping new file with disallowed characters',
        { channelSyncId, itemPath, disallowed, target: 'assembly' },
      )
      await this.mapFilesService.deleteFileMap(pending.id)
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
      // Recreate at the existing Assembly path so a legacy invalid name still lands.
      await this.driveAssemblyCreate(recreated.id, {
        ...params,
        assemblyPathOverride: existing.assemblyPath ?? undefined,
      })
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
    const { assemblyChannelId, assemblyCreatePath, channelSyncId, entry, assemblyPathOverride } =
      params
    try {
      await this.completePendingAssemblyCreate({
        pendingRowId,
        assemblyCreatePath,
        assemblyChannelId,
        channelSyncId,
        entry,
        assemblyPathOverride,
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
    assemblyCreatePath: string
    lastItem: boolean
    tempFileType: ObjectTypeValue
    channelSyncId: string
    entry: DropboxFileListFolderSingleEntry
    basePath: string
  }): Promise<void> {
    const {
      assemblyChannelId,
      itemPath,
      assemblyCreatePath,
      lastItem,
      tempFileType,
      channelSyncId,
      entry,
      basePath,
    } = params

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
        assemblyCreatePath,
        assemblyChannelId,
        tempFileType,
      )
      const filePayload: FileSyncCreateType = {
        channelSyncId,
        itemPath,
        assemblyPath: ensureLeadingSlash(fileCreateResponse.path),
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
        // Row exists (concurrent winner) → just stamp dbxFileId. Otherwise recover the
        // folder's id + path from Assembly so children resolve under it, not a duplicate.
        const existing = await this.mapFilesService.getDbxMappedFileFromPath(
          itemPath,
          channelSyncId,
        )
        if (existing) {
          await this.handleFolderCreatedCase(
            lastItem,
            tempFileType,
            channelSyncId,
            basePath,
            entry.id,
          )
        } else {
          await this.recoverUnmappedAssemblyFolder({
            assemblyChannelId,
            itemPath,
            assemblyCreatePath,
            channelSyncId,
            tempFileType,
            lastItem,
            entry,
          })
        }
        return
      }
      console.error(
        `SyncService#createFolderInAssembly. Upload failed. Channel ID: ${assemblyChannelId}. Path: ${itemPath}`,
      )
      throw error
    }
  }

  /**
   * Folder exists in Assembly but we have no row for it. Find it by its resolved path
   * (no get-by-path API, so page listFiles) and insert a complete row.
   */
  private async recoverUnmappedAssemblyFolder(params: {
    assemblyChannelId: string
    itemPath: string
    assemblyCreatePath: string
    channelSyncId: string
    tempFileType: ObjectTypeValue
    lastItem: boolean
    entry: DropboxFileListFolderSingleEntry
  }): Promise<void> {
    const {
      assemblyChannelId,
      itemPath,
      assemblyCreatePath,
      channelSyncId,
      tempFileType,
      lastItem,
      entry,
    } = params
    const target = assemblyCreatePath.toLowerCase()
    const copilotApi = new CopilotAPI(this.user.token)

    let nextToken: string | undefined
    do {
      const page = await copilotApi.listFiles(assemblyChannelId, nextToken)
      const match = page.data.find(
        (f) =>
          f.object === ObjectType.FOLDER && ensureLeadingSlash(f.path).toLowerCase() === target,
      )
      if (match) {
        const inserted = await this.mapFilesService.insertFileMap({
          channelSyncId,
          itemPath,
          assemblyPath: ensureLeadingSlash(match.path),
          object: tempFileType,
          assemblyFileId: match.id,
          portalId: this.user.portalId,
          dbxFileId: lastItem ? entry.id : null,
        })
        // Insert lost the race to a concurrent recovery: don't double-count; just make
        // sure the winner's row gets this entry's dbxFileId stamped (if it's the leaf).
        if (inserted) {
          await this.mapFilesService.updateChannelMapSyncedFilesCount(channelSyncId)
        } else {
          await this.handleFolderCreatedCase(
            lastItem,
            tempFileType,
            channelSyncId,
            itemPath,
            entry.id,
          )
        }
        return
      }
      nextToken = page.nextToken
    } while (nextToken)

    logger.error(
      'SyncService#recoverUnmappedAssemblyFolder :: folder reported existing but not found in Assembly',
      { channelSyncId, itemPath, assemblyCreatePath },
    )
  }

  /** Drive a Dropbox→Assembly create against an existing pre-inserted row. Called by both syncDropboxFilesToAssembly's leaf branch and the sweeper's retryCreateInAssembly. */
  async completePendingAssemblyCreate(params: {
    pendingRowId: string
    assemblyChannelId: string
    channelSyncId: string
    entry: DropboxFileListFolderSingleEntry
    // Pre-resolved Assembly path (parent's assemblyPath + leaf); override wins on resync.
    assemblyCreatePath: string
    assemblyPathOverride?: string
  }): Promise<void> {
    const {
      pendingRowId,
      assemblyChannelId,
      channelSyncId,
      entry,
      assemblyCreatePath,
      assemblyPathOverride,
    } = params
    const copilotApi = new CopilotAPI(this.user.token)

    const fileCreateResponse = await copilotApi.createFile(
      assemblyPathOverride ?? assemblyCreatePath,
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
      assemblyPath: ensureLeadingSlash(fileCreateResponse.path),
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

    // Skip files whose name segments contain characters Dropbox rejects.
    const disallowed = findDisallowedChars(file.path, 'dropbox')
    if (disallowed) {
      logger.error(
        'SyncService#syncAssemblyFilesToDropbox :: Skipping file with disallowed characters',
        {
          channelSyncId,
          assemblyFileId: file.id,
          path: file.path,
          disallowed,
          target: 'dropbox',
        },
      )
      return
    }

    const assemblyItemPath = `/${file.path}` // appending '/' to maintain consistency
    // The parent folder may live under a different Dropbox name (legacy sanitized),
    // so resolve the real Dropbox path instead of reusing the Assembly path verbatim.
    const dbxItemPath = await this.resolveDropboxItemPath(assemblyItemPath, channelSyncId)

    const pending = await this.mapFilesService.insertCreatePending({
      channelSyncId,
      assemblyFileId: file.id,
      dbxFileId: null,
      itemPath: dbxItemPath,
      assemblyPath: assemblyItemPath,
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
        // Create in Dropbox at the resolved path, not the raw Assembly path.
        file: { ...file, path: dbxItemPath.replace(/^\//, '') }, // Remove forward slash
      })
    } catch (error) {
      await this.mapFilesService.markFailure(pending.id, normalizeError(error))
      throw error
    }
  }

  /**
   * Recover the Dropbox path for an Assembly-side path. The parent folder may have
   * been stored in Dropbox under a different name (legacy sanitized), so look it up
   * by its assemblyPath and build the child under its Dropbox itemPath. Falls back
   * to the raw path for top-level items and non-divergent parents.
   */
  private async resolveDropboxItemPath(
    assemblyItemPath: string,
    channelSyncId: string,
  ): Promise<string> {
    const parentAssemblyPath = getParentPath(assemblyItemPath)
    if (
      parentAssemblyPath === '/' ||
      parentAssemblyPath === '.' ||
      parentAssemblyPath === assemblyItemPath
    ) {
      return assemblyItemPath
    }

    const parentRow = await this.mapFilesService.getMappedFolderByAssemblyPath(
      parentAssemblyPath,
      channelSyncId,
    )
    return composeChildPath(parentRow?.itemPath, assemblyItemPath)
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

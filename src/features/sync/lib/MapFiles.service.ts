import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import httpStatus from 'http-status'
import z from 'zod'
import { MAX_FETCH_COPILOT_RESOURCES } from '@/constants/limits'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import {
  type ChannelSyncCreateType,
  type ChannelSyncSelectType,
  type ChannelSyncUpdatePayload,
  channelSync,
} from '@/db/schema/channelSync.schema'
import {
  type FileSyncCreateType,
  type FileSyncSelectType,
  type FileSyncUpdatePayload,
  fileFolderSync,
} from '@/db/schema/fileFolderSync.schema'
import APIError from '@/errors/APIError'
import type {
  DropboxFileListFolderResultEntries,
  MapList,
  WhereClause,
} from '@/features/sync/types'
import {
  type CopilotFileList,
  FileChannelMembership,
  type UserCompanySelectorInputValue,
} from '@/lib/copilot/types'
import AuthenticatedDropboxService from '@/lib/dropbox/AuthenticatedDropbox.service'
import logger from '@/lib/logger'

export class MapFilesService extends AuthenticatedDropboxService {
  async getSingleFileMap(where: WhereClause): Promise<FileSyncSelectType | undefined> {
    logger.info('MapFilesService#getSingleFileMap :: Getting single file map where', where.getSQL())

    const results = await db.query.fileFolderSync.findFirst({
      where,
    })
    logger.info('MapFilesService#getSingleFileMap :: Found file map', results)
    return results
  }

  async getAllFileMaps(where: WhereClause): Promise<FileSyncSelectType[]> {
    logger.info('MapFilesService#getAllFileMaps :: Getting all file maps where', where.getSQL())

    const results = await db.query.fileFolderSync.findMany({
      where: (fileFolderSync, { eq }) =>
        and(
          where,
          eq(fileFolderSync.portalId, this.user.portalId),
          isNull(fileFolderSync.deletedAt),
        ),
    })
    logger.info('MapFilesService#getAllFileMaps :: Found file maps', results)
    return results
  }

  async insertFileMap(payload: FileSyncCreateType): Promise<FileSyncSelectType> {
    logger.info('MapFilesService#insertFileMap :: Inserting file map', payload)

    const [mappedFile] = await db.insert(fileFolderSync).values(payload).returning()
    logger.info('MapFilesService#insertFileMap :: Inserted file map', mappedFile)
    return mappedFile
  }

  async deleteFileMap(id: string): Promise<void> {
    logger.info('MapFilesService#deleteFileMap :: Deleting file map for', id)
    await db.delete(fileFolderSync).where(eq(fileFolderSync.id, id))
  }

  async updateFileMap(
    payload: FileSyncUpdatePayload,
    condition: WhereClause,
  ): Promise<FileSyncSelectType> {
    logger.info('MapFilesService#updateFileMap :: Updating file map', payload, condition.getSQL())

    const [connection] = await db
      .update(fileFolderSync)
      .set(payload)
      .where(and(eq(fileFolderSync.portalId, this.user.portalId), condition))
      .returning()
    logger.info('MapFilesService#updateFileMap :: Updated file map', connection)

    return connection
  }

  async getDbxMappedFile(dbxId: string, channelSyncId: string, path: string) {
    logger.info(
      'MapFilesService#getDbxMappedFile :: Getting dbx mapped file',
      dbxId,
      channelSyncId,
      path,
    )

    const [mappedFile] = await this.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        eq(fileFolderSync.dbxFileId, dbxId),
        eq(fileFolderSync.itemPath, path),
        isNotNull(fileFolderSync.assemblyFileId),
      ) as WhereClause,
    )
    logger.info('MapFilesService#getDbxMappedFile :: Got dbx mapped file', mappedFile)
    return mappedFile
  }

  async getAssemblyMappedFile(assemblyId: string, channelSyncId: string) {
    logger.info(
      'MapFilesService#getAssemblyMappedFile :: Getting assembly mapped file',
      assemblyId,
      channelSyncId,
    )

    const [mappedFile] = await this.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        eq(fileFolderSync.assemblyFileId, assemblyId),
        isNotNull(fileFolderSync.dbxFileId),
      ) as WhereClause,
    )
    logger.info('MapFilesService#getAssemblyMappedFile :: Got assembly mapped file', mappedFile)
    return mappedFile
  }

  async getDbxMappedFileIds(channelSyncId: string) {
    logger.info('MapFilesService#getDbxMappedFileIds :: Getting dbx mapped file ids', channelSyncId)

    const mappedFile = await this.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        isNotNull(fileFolderSync.dbxFileId),
        isNotNull(fileFolderSync.assemblyFileId),
      ) as WhereClause,
    )
    const results = mappedFile.map((file) => file.dbxFileId)
    logger.info('MapFilesService#getDbxMappedFileIds :: Got dbx mapped file ids', results)
    return results
  }

  async getDbxMappedFileFromPath(dbxPath: string, channelSyncId: string) {
    logger.info(
      'MapFilesService#getDbxMappedFileFromPath :: Getting dbx mapped file from path',
      dbxPath,
      channelSyncId,
    )

    const [mappedFile] = await this.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        eq(fileFolderSync.itemPath, dbxPath),
        isNotNull(fileFolderSync.assemblyFileId),
      ) as WhereClause,
    )
    logger.info(
      'MapFilesService#getDbxMappedFileFromPath :: Got dbx mapped file from path',
      mappedFile,
    )

    return mappedFile
  }

  async getAssemblyMappedFileIds(channelSyncId: string) {
    logger.info(
      'MapFilesService#getAssemblyMappedFileIds :: Getting assembly mapped file ids',
      channelSyncId,
    )

    const mappedFile = await this.getAllFileMaps(
      and(
        eq(fileFolderSync.channelSyncId, channelSyncId),
        isNotNull(fileFolderSync.assemblyFileId),
        isNotNull(fileFolderSync.dbxFileId),
      ) as WhereClause,
    )
    const results = mappedFile.map((file) => file.assemblyFileId)
    logger.info('MapFilesService#getAssemblyMappedFileIds :: Got assembly mapped file ids', results)
    return results
  }

  async getOrCreateChannelMap(
    payload: Omit<ChannelSyncCreateType, 'portalId'>,
  ): Promise<ChannelSyncSelectType> {
    logger.info('MapFilesService#getOrCreateChannelMap :: Getting or creating channel map', payload)

    let [channel] = await db
      .select()
      .from(channelSync)
      .where(
        and(
          eq(channelSync.portalId, this.user.portalId),
          or(
            eq(channelSync.assemblyChannelId, payload.assemblyChannelId),
            eq(channelSync.dbxRootPath, payload.dbxRootPath),
          ),
          isNull(channelSync.deletedAt),
        ),
      )
    logger.info('MapFilesService#getOrCreateChannelMap :: Got channel map', channel)
    if (!channel) {
      const newChannel = await db
        .insert(channelSync)
        .values({ ...payload, portalId: this.user.portalId, status: null })
        .returning()
      channel = newChannel[0]
      logger.info('MapFilesService#getOrCreateChannelMap :: Created channel map', channel)
    } else {
      if (
        channel.assemblyChannelId !== payload.assemblyChannelId ||
        channel.dbxRootPath !== payload.dbxRootPath
      )
        throw new APIError(
          'Mapping already exists for the given file channel or dropbox folder',
          httpStatus.BAD_REQUEST,
        )
    }

    return channel
  }

  async updateChannelMap(
    payload: ChannelSyncUpdatePayload,
    assemblyChannelId: string,
    dbxRootPath: string,
  ): Promise<ChannelSyncSelectType> {
    logger.info(
      'MapFilesService#updateChannelMap :: Updating channel map',
      payload,
      assemblyChannelId,
      dbxRootPath,
    )

    const [connection] = await db
      .update(channelSync)
      .set(payload)
      .where(
        and(
          eq(channelSync.portalId, this.user.portalId),
          eq(channelSync.dbxAccountId, this.connectionToken.accountId),
          eq(channelSync.assemblyChannelId, assemblyChannelId),
          eq(channelSync.dbxRootPath, dbxRootPath),
          isNull(channelSync.deletedAt),
        ),
      )
      .returning()
    logger.info('MapFilesService#updateChannelMap :: Updated channel map', connection)
    return connection
  }

  async updateChannelMapById(
    payload: ChannelSyncUpdatePayload,
    id: string,
  ): Promise<ChannelSyncSelectType> {
    logger.info('MapFilesService#updateChannelMapById :: Updating channel map', payload)

    const [connection] = await db
      .update(channelSync)
      .set(payload)
      .where(eq(channelSync.id, id))
      .returning()
    logger.info('MapFilesService#updateChannelMapById :: Updated channel map', connection)

    return connection
  }

  async updateChannelMapSyncedFilesCount(id: string) {
    logger.info(
      'MapFilesService#updateChannelMapSyncedFilesCount :: Updating channel map synced files count',
      id,
    )

    await db
      .update(channelSync)
      .set({
        syncedFilesCount: sql`${channelSync.syncedFilesCount} + 1`,
      })
      .where(eq(channelSync.id, id))
  }

  async deleteChannelMapsByIds(ids: string[]) {
    if (ids.length === 0) return

    logger.info('MapFilesService#deleteChannelMapsByIds :: Deleting channel maps', ids)

    await db.transaction(async (tx) => {
      const deletedAt = new Date()
      await tx
        .update(channelSync)
        .set({
          deletedAt,
          status: false,
        })
        .where(inArray(channelSync.id, ids))

      await tx
        .update(fileFolderSync)
        .set({
          deletedAt,
        })
        .where(inArray(fileFolderSync.channelSyncId, ids))
    })

    logger.info('MapFilesService#deleteChannelMapsByIds :: Deleted channel maps', ids)
  }

  async getAllChannelMaps(where?: WhereClause): Promise<ChannelSyncSelectType[]> {
    logger.info('MapFilesService#getAllChannelMaps :: Getting all channel maps', where?.getSQL())

    const results = await db.query.channelSync.findMany({
      where: (channelSync, { eq }) =>
        and(where, eq(channelSync.portalId, this.user.portalId), isNull(channelSync.deletedAt)),
      orderBy: [asc(channelSync.createdAt)],
    })

    logger.info('MapFilesService#getAllChannelMaps :: Got all channel maps', results)
    return results
  }

  /**
   * Returns unmapped Dropbox files
   */
  async checkAndFilterDbxFiles(
    parsedDbxEntries: DropboxFileListFolderResultEntries,
    dbxRootPath: string,
    assemblyChannelId: string,
  ) {
    logger.info(
      'MapFilesService#checkAndFilterDbxFiles :: Checking and filtering Dropbox files',
      parsedDbxEntries,
      dbxRootPath,
      assemblyChannelId,
    )

    const channelMap = await this.getOrCreateChannelMap({
      dbxAccountId: this.connectionToken.accountId,
      assemblyChannelId,
      dbxRootPath,
    })
    const fileIds = await this.getDbxMappedFileIds(channelMap.id)

    const processableEntries = parsedDbxEntries
      .map((entry) => {
        const fileObjectType = entry['.tag']
        if (
          (fileObjectType === ObjectType.FOLDER && entry.path_display !== dbxRootPath) ||
          (fileObjectType === ObjectType.FILE &&
            entry.content_hash &&
            !entry.path_display.endsWith('.paper')) // prevent files that are empty, has no content and has extention (.paper).
        ) {
          if (!fileIds.includes(entry.id))
            return {
              payload: {
                opts: {
                  dbxRootPath,
                  assemblyChannelId,
                  channelSyncId: channelMap.id,
                  user: this.user,
                  connectionToken: this.connectionToken,
                },
                entry,
              },
            }
        }
        return null
      })
      .filter((entry) => !!entry)

    logger.info('MapFilesService#checkAndFilterDbxFiles :: Processable entries', processableEntries)
    return processableEntries
  }

  /**
   * Returns unmapped Assembly files
   */
  async checkAndFilterAssemblyFiles(
    files: CopilotFileList['data'],
    dbxRootPath: string,
    assemblyChannelId: string,
  ) {
    logger.info(
      'MapFilesService#checkAndFilterAssemblyFiles :: Checking and filtering Assembly files',
      files,
      dbxRootPath,
      assemblyChannelId,
    )

    const channelMap = await this.getOrCreateChannelMap({
      dbxAccountId: this.connectionToken.accountId,
      assemblyChannelId,
      dbxRootPath,
    })
    const fileIds = await this.getAssemblyMappedFileIds(channelMap.id)

    const mappedEntries = files.map((file) => {
      if (file.status === 'pending') return null // pending records mean files are not uploaded yet to Assembly

      const fileType = file.object
      if (fileType === ObjectType.FILE || fileType === ObjectType.FOLDER) {
        if (!fileIds.includes(file.id))
          return {
            payload: {
              opts: {
                dbxRootPath,
                assemblyChannelId,
                channelSyncId: channelMap.id,
                user: this.user,
                connectionToken: this.connectionToken,
              },
              file: { ...file, object: fileType },
            },
          }
      }
      return null
    })
    const processableEntries = mappedEntries.filter((entry) => !!entry)
    logger.info(
      'MapFilesService#checkAndFilterAssemblyFiles :: Processable entries',
      processableEntries,
    )
    return processableEntries
  }

  async listFormattedChannelMap(): Promise<MapList[]> {
    const channelMaps = await this.getAllChannelMaps()
    if (channelMaps.length === 0) return []

    // Batch fetch all file channels in one API call
    const fileChannels = await this.copilot.listFileChannels({
      limit: MAX_FETCH_COPILOT_RESOURCES,
    })
    const fileChannelMap = new Map(fileChannels.map((fc) => [fc.id, fc]))

    // Collect unique company and client IDs from file channels that match our channel maps
    const companyIds = new Set<string>()
    const clientIds = new Set<string>()
    const staleChannelMapIds: string[] = []

    for (const channelMap of channelMaps) {
      const fc = fileChannelMap.get(channelMap.assemblyChannelId)
      if (!fc) {
        staleChannelMapIds.push(channelMap.id)
        continue
      }
      if (fc.companyId) companyIds.add(fc.companyId)
      if (fc.clientId) clientIds.add(fc.clientId)
    }

    // Batch fetch all companies and clients in parallel (2 API calls total)
    const [companiesResponse, clientsResponse] = await Promise.all([
      companyIds.size > 0
        ? this.copilot.getCompanies({ limit: MAX_FETCH_COPILOT_RESOURCES })
        : Promise.resolve({ data: [] }),
      clientIds.size > 0
        ? this.copilot.getClients({ limit: MAX_FETCH_COPILOT_RESOURCES })
        : Promise.resolve({ data: [] }),
    ])

    const companyMap = new Map((companiesResponse.data ?? []).map((c) => [c.id, c]))
    const clientMap = new Map((clientsResponse.data ?? []).map((c) => [c.id, c]))

    // Bulk soft-delete stale channel maps
    if (staleChannelMapIds.length > 0) {
      console.info('Soft delete channel maps and make them inactive: ', staleChannelMapIds)
      await this.deleteChannelMapsByIds(staleChannelMapIds)
    }

    // Format all channel maps locally using pre-fetched data
    const results: MapList[] = []
    for (const channelMap of channelMaps) {
      const formatted = this.formatChannelMapFromCache(
        channelMap,
        fileChannelMap,
        companyMap,
        clientMap,
      )
      if (formatted) results.push(formatted)
    }

    return results
  }

  private formatChannelMapFromCache(
    channelMap: ChannelSyncSelectType,
    fileChannelMap: Map<
      string,
      { id: string; membershipType: string; companyId?: string; clientId?: string }
    >,
    companyMap: Map<string, { id: string }>,
    clientMap: Map<string, { id: string }>,
  ): MapList | null {
    const fileChannel = fileChannelMap.get(channelMap.assemblyChannelId)
    if (!fileChannel) return null

    let fileChannelValue: UserCompanySelectorInputValue[]

    if (fileChannel.membershipType === FileChannelMembership.COMPANY) {
      if (!fileChannel.companyId) {
        console.error('Company id not found')
        return null
      }
      const company = companyMap.get(fileChannel.companyId)
      if (!company) {
        console.error('Company not found in batch response', fileChannel.companyId)
        return null
      }
      fileChannelValue = [{ id: company.id, companyId: company.id, object: 'company' as const }]
    } else {
      if (!fileChannel.clientId) {
        console.error('Client id not found')
        return null
      }
      const client = clientMap.get(fileChannel.clientId)
      if (!client) {
        console.error('Client not found in batch response', fileChannel.clientId)
        return null
      }
      fileChannelValue = [
        {
          id: client.id,
          companyId: z.string().parse(fileChannel.companyId),
          object: 'client' as const,
        },
      ]
    }

    const syncedPercentage = this.getSyncedPercentage(
      channelMap.status,
      channelMap.syncedFilesCount,
      channelMap.totalFilesCount,
    )

    return {
      id: channelMap.id,
      fileChannelValue,
      dbxRootPath: channelMap.dbxRootPath,
      status: channelMap.status,
      fileChannelId: fileChannel.id,
      lastSyncedAt: channelMap.lastSyncedAt,
      syncedPercentage,
    }
  }

  private getSyncedPercentage(
    status: boolean | null,
    syncedFilesCount: number,
    totalFilesCount: number,
  ) {
    switch (status) {
      case true:
        return 100
      case false:
        return 0
      default: {
        const calculatedPercentage = Math.floor((syncedFilesCount / totalFilesCount) * 100)
        return calculatedPercentage > 100 ? 100 : calculatedPercentage
      }
    }
  }
}

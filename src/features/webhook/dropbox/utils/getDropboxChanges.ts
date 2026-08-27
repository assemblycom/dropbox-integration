import type { Dropbox } from 'dropbox'
import type { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { DropboxFileListFolderResultEntriesSchema } from '@/features/sync/types'
import logger from '@/lib/logger'

export async function getDropboxChanges(
  cursor: string,
  rootPath: string,
  dbxClient: Dropbox,
  mapFilesService: MapFilesService,
  channelSyncId: string,
) {
  try {
    const response = await dbxClient.filesListFolderContinue({ cursor })

    const entriesWithId = (
      await Promise.all(
        response.result.entries.map(async (entry) => {
          if (entry['.tag'] === 'deleted') {
            const basePath = entry.path_display?.replace(rootPath, '')

            const mappedFile = await mapFilesService.getDbxMappedFileFromPath(
              basePath ?? '',
              channelSyncId,
            )
            if (!mappedFile) return null
            if (!mappedFile.dbxFileId) return null // todo: if id not found. Get the id
            return { ...entry, id: mappedFile.dbxFileId }
          }
          return entry
        }),
      )
    ).filter(Boolean)

    const parsed = DropboxFileListFolderResultEntriesSchema.safeParse(entriesWithId)

    if (!parsed.success) {
      logger.error('Invalid Dropbox response entries:', parsed.error)
      // return
      throw new Error('Invalid Dropbox entries format')
    }

    const filtered = parsed.data.filter((entry) =>
      entry.path_display.toLowerCase().startsWith(rootPath.toLowerCase()),
    )

    return {
      entries: filtered,
      newCursor: response.result.cursor,
      hasMore: response.result.has_more,
    }
  } catch (error) {
    logger.error('Error fetching Dropbox changes:', error)
    throw error
  }
}

import type { Dropbox, files } from 'dropbox'
import httpStatus from 'http-status'
import type { NextRequest } from 'next/server'
import z from 'zod'
import { MAX_FETCH_DBX_RESOURCES, MAX_FETCH_DBX_SEARCH_LIMIT } from '@/constants/limits'
import { DropboxClientType, ObjectType } from '@/db/constants'
import APIError from '@/errors/APIError'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import type { Folder } from '@/features/sync/types'
import AuthenticatedDropboxService from '@/lib/dropbox/AuthenticatedDropbox.service'
import logger from '@/lib/logger'
import { withRetry } from '@/lib/withRetry'
import { replaceSpecialCharactersWithSpace, splitPathAndFolder } from '@/utils/filePath'

export class DropboxService extends AuthenticatedDropboxService {
  async getFolderTree(req: NextRequest) {
    const search = req.nextUrl.searchParams.get('search')
    const dbxClient = this.dbxClient.getDropboxClient()

    if (search) return await this.searchForFolder({ dbxClient, search: decodeURIComponent(search) })

    // Now this call will be rooted in the Team Space
    const entries = await this.getFileEntriesFromDropbox({ dbxClient })

    logger.info('DropboxService#getFolderTree :: Fetched folder tree', entries)
    return this.buildFolderTree(entries)
  }

  private async getFileEntriesFromDropbox({
    dbxClient,
    path = '',
    recursive = false,
  }: {
    dbxClient: Dropbox
    path?: string
    recursive?: boolean
  }) {
    const dbxResponse = await dbxClient.filesListFolder({
      path, // "" is now the Team Space root, not the Member Folder
      recursive,
      limit: MAX_FETCH_DBX_RESOURCES,
      include_non_downloadable_files: false,
    })
    const entries = dbxResponse.result.entries || []

    if (dbxResponse.status !== httpStatus.OK) {
      throw new APIError('Cannot fetch the folders', dbxResponse.status)
    }
    return entries
  }

  private async searchChildrenFolders(
    folderResult: files.FolderMetadataReference,
    path: string,
    dbxClient: Dropbox,
  ) {
    logger.log('DropboxService#searchChildrenFolders :: Searching children folders')
    const isSharedFolder = !!folderResult.sharing_info?.shared_folder_id
    const prefixPath = isSharedFolder ? path : undefined

    // this step makes sure the team folder
    const tempDbxClient = isSharedFolder
      ? this.dbxClient.createDropboxClient(
          // create new Dropbox Client but not binded with class
          this.connectionToken.refreshToken,
          folderResult.sharing_info?.shared_folder_id,
          DropboxClientType.NAMESPACE_ID,
        )
      : dbxClient

    const entries = await this.getFileEntriesFromDropbox({
      dbxClient: tempDbxClient,
      recursive: true,
      ...(!isSharedFolder && { path: folderResult.path_display }),
    })
    return this.formatSubFolders(entries, prefixPath)
  }

  /**
   * Description: This function first searches for the term using filesSearchV2. This returns the exact folder.
   * To get the subfolder of the result folder, we use filesListFolder with the namespace_id of the result folder.
   */
  async _searchForFolder({ dbxClient, search }: { dbxClient: Dropbox; search: string }) {
    logger.log('DropboxService#getFolderTree :: Searching folder in Dropbox... Query: ', search)
    const sanitizedSearch = replaceSpecialCharactersWithSpace(search)
    if (!sanitizedSearch) return []

    const { path, folder: query } = splitPathAndFolder(sanitizedSearch)
    logger.log({ path, query })

    let tempPath = path
    let folderResult: files.FolderMetadataReference | undefined

    const formattedFolders: Partial<Folder>[] = []

    if (query !== '') {
      logger.log('DropboxService#searchForFolder :: Query is available. Searching for folder')
      const searchResponse = await dbxClient.filesSearchV2({
        query,
        options: {
          max_results: MAX_FETCH_DBX_SEARCH_LIMIT,
          path,
        },
      })

      if (searchResponse.status !== httpStatus.OK) {
        throw new APIError('Cannot fetch the folders', searchResponse.status)
      }
      const { folders, pathArray } = this.formatSearchResults(searchResponse.result.matches)
      if (!pathArray.length) return folders

      tempPath = pathArray[0]
      const matchMetadata = searchResponse.result.matches[0].metadata
      if (matchMetadata['.tag'] === 'other') return folders

      formattedFolders.push(...folders)
      const metadata = matchMetadata.metadata
      folderResult = metadata['.tag'] === ObjectType.FOLDER ? metadata : undefined
    } else {
      logger.log('DropboxService#searchForFolder :: Query is empty. Getting folder metadata')

      const metaDataResp = await dbxClient.filesGetMetadata({ path: tempPath })
      if (metaDataResp.status !== httpStatus.OK) {
        throw new APIError('Cannot fetch the folders', metaDataResp.status)
      }
      const metaResult = metaDataResp.result
      folderResult = metaResult['.tag'] === ObjectType.FOLDER ? metaResult : undefined
    }

    if (folderResult) {
      const childFolders = await this.searchChildrenFolders(folderResult, tempPath, dbxClient)
      formattedFolders.push(...childFolders)
    }

    // return unique array
    return [...new Map(formattedFolders.map((item) => [item.path, item])).values()]
  }

  private async buildFolderTree(entries: files.ListFolderResult['entries']): Promise<Folder[]> {
    const root: Folder[] = []
    const mapService = new MapFilesService(this.user, this.connectionToken)
    const mapList = (await mapService.getAllChannelMaps()).map(
      (channelMap) => channelMap.dbxRootPath,
    )

    const findOrCreate = (children: Folder[], path: string, label: string) => {
      let node = children.find((c) => c.path === path)
      if (!node) {
        node = { path, label, children: [] }
        children.push(node)
      }
      return node
    }

    logger.info('DropboxService#buildFolderTree :: Building folder tree', entries)
    for (const item of entries) {
      if (item['.tag'] === ObjectType.FOLDER) {
        // below condition is to make sure the map is one-to-one
        if (!item.path_display || mapList.includes(item.path_display)) continue

        const parts = item.path_display.split('/').filter(Boolean)
        let currentChildren: Folder[] = root
        let currentPath = ''

        if (!parts || parts.length === 0) continue

        for (const part of parts) {
          currentPath += `/${part}`
          const label = part
          const node = findOrCreate(currentChildren, currentPath, label)
          currentChildren = node?.children ?? []
        }
      }
    }

    logger.info('DropboxService#buildFolderTree :: Built folder tree', root)
    return root
  }

  private formatSubFolders(folders: files.ListFolderResult['entries'], rootPath?: string) {
    return folders
      .map((folder) => {
        if (folder['.tag'] === ObjectType.FOLDER) {
          const newPath = rootPath ? `${rootPath}${folder.path_display}` : folder.path_display
          const parsedPath = z.string().parse(newPath)
          return {
            path: parsedPath,
            label: parsedPath,
            children: [],
          }
        }
        return null
      })
      .filter((item) => item !== null)
  }

  private formatSearchResults(matches: files.SearchMatchV2[]) {
    const pathArray: string[] = []
    const folders = matches
      .map((match) => {
        if (match.metadata['.tag'] === 'other') return null

        const data = match.metadata.metadata
        if (data['.tag'] !== ObjectType.FOLDER) return null

        pathArray.push(z.string().parse(data.path_display))
        return {
          path: data.path_display,
          label: data.path_display,
          children: [],
        }
      })
      .filter((item) => item !== null)

    return { folders, pathArray }
  }

  private wrapWithRetry<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R> {
    return (...args: Args): Promise<R> =>
      withRetry(fn.bind(this), args, {
        minTimeout: 3000,
        // After a facter 2 exponential backoff [minTimeout * factor^(attemptNumber - 1)] timeout after 3 retries is 12 secs
        maxTimeout: 12000,
      })
  }

  searchForFolder = this.wrapWithRetry(this._searchForFolder)
}

import { Dropbox, type DropboxAuth, DropboxResponseError, type files } from 'dropbox'
import httpStatus from 'http-status'
import { camelKeys } from 'js-convert-case'
import fetch, { type Response as NodeFetchResponse } from 'node-fetch'
import env from '@/config/server.env'
import { MAX_FETCH_DBX_RESOURCES } from '@/constants/limits'
import { DropboxClientType, type DropboxClientTypeValue } from '@/db/constants'
import { DropboxAuthClient } from '@/lib/dropbox/DropboxAuthClient'
import { type DropboxFileMetadata, DropboxFileMetadataSchema } from '@/lib/dropbox/type'

import { withRetry } from '@/lib/withRetry'
import { dropboxArgHeader } from '@/utils/header'

export class DropboxClient {
  protected readonly clientInstance: Dropbox
  readonly dbxAuthClient: DropboxAuthClient

  constructor(
    refreshToken: string,
    rootNamespaceId?: string | null,
    type?: DropboxClientTypeValue,
  ) {
    this.dbxAuthClient = new DropboxAuthClient()
    this.clientInstance = this.createDropboxClient(refreshToken, rootNamespaceId, type)
  }

  /**
   * Function returns the instance of Dropbox client after checking and refreshing (if required) the access token
   * @returns instance of Dropbox client
   */
  createDropboxClient(
    refreshToken: string,
    rootNamespaceId?: string | null,
    type: DropboxClientTypeValue = DropboxClientType.ROOT,
  ): Dropbox {
    this.dbxAuthClient.authInstance.setRefreshToken(refreshToken)

    const options: { auth: DropboxAuth; refreshToken: string; pathRoot?: string } = {
      auth: this.dbxAuthClient.authInstance,
      refreshToken,
    }

    // If we have a root namespace, set the header
    if (rootNamespaceId) {
      options.pathRoot = JSON.stringify({
        '.tag': type,
        [type]: rootNamespaceId,
      })
    }

    return new Dropbox(options)
  }

  getDropboxClient(): Dropbox {
    return this.clientInstance
  }

  private async manualFetch(
    url: string,
    headers?: Record<string, string>,
    body?: NodeJS.ReadableStream | null,
    otherOptions?: Record<string, string>,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST',
  ) {
    return await fetch(url, {
      method,
      headers,
      body,
      ...otherOptions,
    })
  }

  // Dropbox content-endpoint errors carry their reason (e.g. `path/not_found`,
  // `path/restricted_content`) in the JSON response body, NOT in the headers.
  // We read it here so the thrown DropboxResponseError exposes the same
  // `error_summary` / `error` shape the SDK would have produced — without
  // this, every failure surfaces in Sentry as an opaque "Response failed with
  // a 4xx code" with no way to triage.
  private async buildDropboxResponseError(
    response: NodeFetchResponse,
    fallbackSummary: string,
  ): Promise<DropboxResponseError<unknown>> {
    const rawBody = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = rawBody ? JSON.parse(rawBody) : undefined
    } catch {
      parsed = undefined
    }

    const errorPayload =
      parsed && typeof parsed === 'object' && 'error_summary' in parsed
        ? parsed
        : { error_summary: rawBody || fallbackSummary, error: parsed }

    return new DropboxResponseError(response.status, response.headers, errorPayload)
  }

  async _getAllFilesFolders(
    rootPath: string,
    recursive: boolean = false,
    fetchAll: boolean = false,
    limit: number = MAX_FETCH_DBX_RESOURCES,
  ) {
    console.info(
      'DropboxClient#getAllFilesFolders :: Fetching all files and folders. Root path: ',
      rootPath,
    )
    const newLimit = limit > MAX_FETCH_DBX_RESOURCES ? MAX_FETCH_DBX_RESOURCES : limit

    const entries: files.ListFolderResult['entries'] = []
    let filesFolders = await this.clientInstance.filesListFolder({
      path: rootPath,
      recursive,
      limit: newLimit,
      include_non_downloadable_files: false,
      include_media_info: false,
    })
    entries.push(...filesFolders.result.entries)

    while (filesFolders.result.has_more && (fetchAll || entries.length < newLimit)) {
      const cursor = filesFolders.result.cursor
      filesFolders = await this.clientInstance.filesListFolderContinue({
        cursor,
      })
      entries.push(...filesFolders.result.entries)
    }
    console.info('DropboxClient#getAllFilesFolders :: Total entries', entries.length)

    return entries
  }

  async _downloadFile({
    urlPath,
    filePath,
    rootNamespaceId,
    refreshToken,
  }: {
    urlPath: string
    filePath: string
    rootNamespaceId: string
    refreshToken: string
  }): Promise<{ body: NodeJS.ReadableStream | null; contentLength: string }> {
    // Ensure a valid access token before the download. The DropboxAuth instance
    // is created per-task with only the refresh token set; without an explicit
    // refresh here, `getAccessToken()` returns undefined and Dropbox 400s.
    await this.dbxAuthClient.refreshAccessToken(refreshToken)

    const headers = {
      Authorization: `Bearer ${this.dbxAuthClient.authInstance.getAccessToken()}`,
      'Dropbox-API-Path-Root': dropboxArgHeader({
        '.tag': 'namespace_id',
        namespace_id: rootNamespaceId,
      }),
      'Dropbox-API-Arg': dropboxArgHeader({ path: filePath }),
    }
    const response = await this.manualFetch(`${env.DROPBOX_API_URL}${urlPath}`, headers)
    if (response.status !== httpStatus.OK) {
      throw await this.buildDropboxResponseError(
        response,
        `DropboxClient#downloadFile. Failed to download file: ${filePath}`,
      )
    }

    // Use the Content-Length from the download response as the upload size.
    // This is the exact byte count about to be streamed, guaranteed to match
    // what the upstream (S3) sees — unlike the size in `filesListFolder` entries,
    // which can diverge from the downloaded stream for certain file types.
    const contentLength = response.headers.get('content-length')
    if (!contentLength) {
      throw new Error(
        `DropboxClient#downloadFile. Missing Content-Length header for file: ${filePath}`,
      )
    }

    return { body: response.body, contentLength }
  }

  /**
   * Description: this function streams the file to Dropbox. @param body is the readable stream of the file.
   * For the stream to work we need to add the Content-Type: 'application/octet-stream' in the headers.
   */
  async _uploadFile({
    urlPath,
    filePath,
    body,
    rootNamespaceId,
    refreshToken,
  }: {
    urlPath: string
    filePath: string
    body: NodeJS.ReadableStream | null
    rootNamespaceId: string
    refreshToken: string
  }): Promise<DropboxFileMetadata> {
    // Explicit token refresh — mirrors `_downloadFile`. Previously relied on
    // an implicit refresh from a preceding SDK call (e.g. filesGetMetadata),
    // which is a fragile contract — any future caller reaching this method
    // without a prior SDK call would 400 on an unpopulated Bearer.
    await this.dbxAuthClient.refreshAccessToken(refreshToken)

    const args = {
      path: filePath,
      autorename: false,
      mode: 'add',
    }

    const headers = {
      Authorization: `Bearer ${this.dbxAuthClient.authInstance.getAccessToken()}`,
      'Dropbox-API-Path-Root': dropboxArgHeader({
        '.tag': 'namespace_id',
        namespace_id: rootNamespaceId,
      }),
      'Dropbox-API-Arg': dropboxArgHeader(args),
      'Content-Type': 'application/octet-stream',
    }
    const response = await this.manualFetch(`${env.DROPBOX_API_URL}${urlPath}`, headers, body)

    if (response.status !== httpStatus.OK) {
      throw await this.buildDropboxResponseError(
        response,
        `DropboxClient#uploadFile. Failed to upload file: ${filePath}`,
      )
    }
    return DropboxFileMetadataSchema.parse(camelKeys(await response.json()))
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

  getAllFilesFolders = this.wrapWithRetry(this._getAllFilesFolders)
  downloadFile = this.wrapWithRetry(this._downloadFile)
  uploadFile = this.wrapWithRetry(this._uploadFile)
}

import 'server-only'

import { assemblyApi, type AssemblyAPI as SDK } from '@assembly-js/node-sdk'
import fetch from 'node-fetch'
import env from '@/config/server.env'
import type { ObjectTypeValue } from '@/db/constants'
import { MAX_FILES_LIMIT } from '@/features/sync/constant'
import {
  type ClientResponse,
  ClientResponseSchema,
  ClientsResponseSchema,
  type CompaniesResponse,
  CompaniesResponseSchema,
  type CompanyResponse,
  CompanyResponseSchema,
  CopilotFileChannelListSchema,
  CopilotFileChannelRetrieveSchema,
  CopilotFileCreateSchema,
  type CopilotFileList,
  CopilotFileListSchema,
  type CopilotFileRetrieve,
  CopilotFileRetrieveSchema,
  type CopilotListArgs,
  type CreateFileType,
  type WorkspaceResponse,
  WorkspaceResponseSchema,
} from '@/lib/copilot/types'
import logger from '@/lib/logger'
import { withRetry } from '@/lib/withRetry'

// Structural shape of the SDK's `ApiError` (declared in
// `@assembly-js/node-sdk/dist/codegen/api/core/ApiError`). The class itself is not
// re-exported from the package's public entry point, so we identify it by
// shape instead of `instanceof` — that avoids reaching into `node_modules`
// internals, which would break on any minor SDK update. We check `url` +
// `statusText` + `body` together (all three sit on the SDK's `ApiError`
// class) so the guard can't accidentally match unrelated Error subclasses
// that happen to carry `status` (e.g. DropboxResponseError, our own APIError).
export type CopilotApiError = Error & {
  url: string
  status: number
  statusText: string
  body: { message?: string } & Record<string, unknown>
}

// SDK's file type enum. Our ObjectType has the same string values, so we cast.
type AssemblyCreateFileType = Parameters<SDK['createFile']>[0]['requestBody']['type']

export function isCopilotApiError(error: unknown): error is CopilotApiError {
  if (!(error instanceof Error)) return false
  const e = error as {
    url?: unknown
    status?: unknown
    statusText?: unknown
    body?: unknown
  }
  return (
    typeof e.url === 'string' &&
    typeof e.status === 'number' &&
    typeof e.statusText === 'string' &&
    typeof e.body === 'object' &&
    e.body !== null
  )
}

export class CopilotAPI {
  readonly assemblySdk: Promise<SDK>

  constructor(private readonly workspaceId: string) {
    this.assemblySdk = assemblyApi({ apiKey: `${this.workspaceId}/${env.COPILOT_API_KEY}` })
    // Swallow here so an unused instance can't throw an unhandled rejection.
    void this.assemblySdk.catch(() => undefined)
  }

  // NOTE: Any method prefixed with _ is a API method that doesn't implement retry & delay
  // NOTE: Any normal API method name implements `withRetry` with default config

  async _getWorkspace(): Promise<WorkspaceResponse> {
    logger.info('CopilotAPI#_getWorkspace')
    const sdk = await this.assemblySdk
    return WorkspaceResponseSchema.parse(await sdk.retrieveWorkspace())
  }

  async _getClient(id: string): Promise<ClientResponse> {
    logger.info('CopilotAPI#_getClient', id)
    const sdk = await this.assemblySdk
    return ClientResponseSchema.parse(await sdk.retrieveClient({ id }))
  }

  async _getClients(args: CopilotListArgs & { companyId?: string } = {}) {
    logger.info('CopilotAPI#_getClients', args)
    const sdk = await this.assemblySdk
    return ClientsResponseSchema.parse(await sdk.listClients(args))
  }

  async _getCompany(id: string): Promise<CompanyResponse> {
    logger.info('CopilotAPI#_getCompany', id)
    const sdk = await this.assemblySdk
    return CompanyResponseSchema.parse(await sdk.retrieveCompany({ id }))
  }

  async _getCompanies(
    args: CopilotListArgs & { isPlaceholder?: boolean } = {},
  ): Promise<CompaniesResponse> {
    logger.info('CopilotAPI#_getCompanies', args)
    const sdk = await this.assemblySdk
    return CompaniesResponseSchema.parse(await sdk.listCompanies(args))
  }

  async _createFile(
    path: string,
    channelId: string,
    fileType: ObjectTypeValue,
  ): Promise<CreateFileType> {
    // Names are validated upstream (SyncService); path passes through unchanged.
    logger.log(`CopilotAPI#_createFile. Path: ${path}`)
    const sdk = await this.assemblySdk
    const createFileResponse = await sdk.createFile({
      fileType,
      requestBody: {
        path,
        channelID: channelId,
        type: fileType as unknown as AssemblyCreateFileType,
      },
    })
    return CopilotFileCreateSchema.parse(createFileResponse)
  }

  /**
   * Description: this function streams the file to Assembly. @param body is the readable stream of the file.
   * Since assembly uploads the file to s3 bucket, we need to set the content length of the file.
   */
  async _uploadFile(url: string, contentLength: string, body: NodeJS.ReadableStream | null) {
    return await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': contentLength, // need to set the content length to stream the file to s3 bucket,
      },
      body,
    })
  }

  async _deleteFile(id: string) {
    const sdk = await this.assemblySdk
    return await sdk.deleteFile({ id })
  }

  async _listFiles(
    channelId: string,
    nextToken?: string,
    customLimit?: number,
  ): Promise<CopilotFileList> {
    const sdk = await this.assemblySdk
    const list = await sdk.listFiles({
      channelId,
      nextToken,
      limit: customLimit || MAX_FILES_LIMIT,
    })
    return CopilotFileListSchema.parse(list)
  }

  async _retrieveFile(id: string): Promise<CopilotFileRetrieve> {
    const sdk = await this.assemblySdk
    const file = await sdk.retrieveFile({ id })
    return CopilotFileRetrieveSchema.parse(file)
  }

  async _retrieveFileChannel(id: string) {
    const sdk = await this.assemblySdk
    const fileChannel = await sdk.retrieveFileChannel({ id })
    return CopilotFileChannelRetrieveSchema.parse(fileChannel)
  }

  async _listFileChannels(args: CopilotListArgs & { companyId?: string; clientId?: string } = {}) {
    const sdk = await this.assemblySdk
    const list = await sdk.listFileChannels(args)
    return CopilotFileChannelListSchema.parse(list.data)
  }

  private wrapWithRetry<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R> {
    // 6 retries so a 429 burst self-corrects here before task-level retry.
    return (...args: Args): Promise<R> => withRetry(fn.bind(this), args, { retries: 6 })
  }

  // Methods wrapped with retry
  getWorkspace = this.wrapWithRetry(this._getWorkspace)
  getClient = this.wrapWithRetry(this._getClient)
  getClients = this.wrapWithRetry(this._getClients)
  getCompany = this.wrapWithRetry(this._getCompany)
  getCompanies = this.wrapWithRetry(this._getCompanies)
  createFile = this.wrapWithRetry(this._createFile)
  uploadFile = this.wrapWithRetry(this._uploadFile)
  deleteFile = this.wrapWithRetry(this._deleteFile)
  listFiles = this.wrapWithRetry(this._listFiles)
  retrieveFile = this.wrapWithRetry(this._retrieveFile)
  retrieveFileChannel = this.wrapWithRetry(this._retrieveFileChannel)
  listFileChannels = this.wrapWithRetry(this._listFileChannels)
}

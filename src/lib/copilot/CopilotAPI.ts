import 'server-only'

import { assemblyApi, type AssemblyAPI as SDK } from '@assembly-js/node-sdk'
import fetch from 'node-fetch'
import z from 'zod'
import env from '@/config/server.env'
import { MAX_FETCH_COPILOT_RESOURCES } from '@/constants/limits'
import type { ObjectTypeValue } from '@/db/constants'
import { MAX_FILES_LIMIT } from '@/features/sync/constant'
import {
  type ClientRequest,
  type ClientResponse,
  ClientResponseSchema,
  ClientsResponseSchema,
  type CompaniesResponse,
  CompaniesResponseSchema,
  type CompanyCreateRequest,
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
  type CopilotPrice,
  CopilotPriceSchema,
  type CopilotProduct,
  CopilotProductSchema,
  type CreateFileType,
  type InternalUser,
  InternalUserSchema,
  type InternalUsersResponse,
  InternalUsersResponseSchema,
  type NotificationCreatedResponse,
  NotificationCreatedResponseSchema,
  type NotificationRequestBody,
  type Token,
  TokenSchema,
  type WorkspaceResponse,
  WorkspaceResponseSchema,
} from '@/lib/copilot/types'
import logger from '@/lib/logger'
import { withRetry } from '@/lib/withRetry'
import { sanitizeFileNameForAssembly } from '@/utils/filePath'

export class CopilotAPI {
  readonly copilot: SDK

  constructor(
    private readonly token: string,
    readonly customApiKey?: string,
  ) {
    this.copilot = assemblyApi({
      apiKey: customApiKey ?? env.COPILOT_API_KEY,
      token,
    })
  }

  // NOTE: Any method prefixed with _ is a API method that doesn't implement retry & delay
  // NOTE: Any normal API method name implements `withRetry` with default config

  // Get Token Payload from copilot request token
  async _getTokenPayload(): Promise<Token | null> {
    const getTokenPayload = this.copilot.getTokenPayload
    if (!getTokenPayload) {
      logger.error(
        `CopilotAPI#getTokenPayload | Could not parse token payload for token ${this.token}`,
      )
      return null
    }

    return TokenSchema.parse(await getTokenPayload())
  }

  async _getWorkspace(): Promise<WorkspaceResponse> {
    logger.info('CopilotAPI#_getWorkspace')
    return WorkspaceResponseSchema.parse(await this.copilot.retrieveWorkspace())
  }

  async _createClient(
    requestBody: ClientRequest,
    sendInvite: boolean = false,
  ): Promise<ClientResponse> {
    logger.info('CopilotAPI#_createClient', requestBody, sendInvite)
    return ClientResponseSchema.parse(await this.copilot.createClient({ sendInvite, requestBody }))
  }

  async _getClient(id: string): Promise<ClientResponse> {
    logger.info('CopilotAPI#_getClient', id)
    return ClientResponseSchema.parse(await this.copilot.retrieveClient({ id }))
  }

  async _getClients(args: CopilotListArgs & { companyId?: string } = {}) {
    logger.info('CopilotAPI#_getClients', args)
    return ClientsResponseSchema.parse(await this.copilot.listClients(args))
  }

  async _updateClient(id: string, requestBody: ClientRequest): Promise<ClientResponse> {
    logger.info('CopilotAPI#_updateClient', id)
    return ClientResponseSchema.parse(await this.copilot.updateClient({ id, requestBody }))
  }

  async _deleteClient(id: string) {
    logger.info('CopilotAPI#_deleteClient', id)
    return await this.copilot.deleteClient({ id })
  }

  async _createCompany(requestBody: CompanyCreateRequest) {
    logger.info('CopilotAPI#_createCompany', requestBody)
    return CompanyResponseSchema.parse(await this.copilot.createCompany({ requestBody }))
  }

  async _getCompany(id: string): Promise<CompanyResponse> {
    logger.info('CopilotAPI#_getCompany', id)
    return CompanyResponseSchema.parse(await this.copilot.retrieveCompany({ id }))
  }

  async _getCompanies(
    args: CopilotListArgs & { isPlaceholder?: boolean } = {},
  ): Promise<CompaniesResponse> {
    logger.info('CopilotAPI#_getCompanies', args)
    return CompaniesResponseSchema.parse(await this.copilot.listCompanies(args))
  }

  async _getCompanyClients(companyId: string): Promise<ClientResponse[]> {
    logger.info('CopilotAPI#_getCompanyClients', companyId)
    return (await this.getClients({ limit: 10000, companyId })).data || []
  }

  async _getInternalUsers(args: CopilotListArgs = {}): Promise<InternalUsersResponse> {
    logger.info('CopilotAPI#_getInternalUsers', args)
    return InternalUsersResponseSchema.parse(await this.copilot.listInternalUsers(args))
  }

  async _getInternalUser(id: string): Promise<InternalUser> {
    logger.info('CopilotAPI#_getInternalUser', id)
    return InternalUserSchema.parse(await this.copilot.retrieveInternalUser({ id }))
  }

  async _createNotification(
    requestBody: NotificationRequestBody,
  ): Promise<NotificationCreatedResponse> {
    logger.info('CopilotAPI#_createNotification', requestBody)
    const notification = await this.copilot.createNotification({ requestBody })
    return NotificationCreatedResponseSchema.parse(notification)
  }

  /**
   * Returns an object with product ID as key and product as value
   * @param productIds Products to get details for
   */
  async _getProducts(
    productIds: string[],
    args: CopilotListArgs = { limit: MAX_FETCH_COPILOT_RESOURCES },
  ): Promise<Record<string, CopilotProduct>> {
    const allProductsResponse = await this.copilot.listProducts(args)
    const allProducts = z.array(CopilotProductSchema).parse(allProductsResponse.data)

    return allProducts.reduce<Record<string, CopilotProduct>>((acc, product) => {
      if (productIds.includes(product.id)) {
        acc[product.id] = product
      }
      return acc
    }, {})
  }

  /**
   * Returns an object with price ID as key and price as value
   * @param priceIds Prices to get details for
   */
  async _getPrices(
    priceIds: string[],
    args = { limit: '10_000' },
  ): Promise<Record<string, CopilotPrice>> {
    const allPricesResponse = await this.copilot.listPrices(args)
    const allPrices = z.array(CopilotPriceSchema).parse(allPricesResponse.data)
    return allPrices.reduce<Record<string, CopilotPrice>>((acc, price) => {
      if (priceIds.includes(price.id)) {
        acc[price.id] = price
      }
      return acc
    }, {})
  }

  async _createFile(
    path: string,
    channelId: string,
    fileType: ObjectTypeValue,
  ): Promise<CreateFileType> {
    const saniztedPath = sanitizeFileNameForAssembly(path)
    console.info(`CopilotAPI#_createFile. Path: ${saniztedPath}`)

    const createFileResponse = await this.copilot.createFile({
      fileType,
      requestBody: {
        path: saniztedPath,
        channelId,
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
    return await this.copilot.deleteFile({ id })
  }

  async _listFiles(
    channelId: string,
    nextToken?: string,
    customLimit?: number,
  ): Promise<CopilotFileList> {
    const list = await this.copilot.listFiles({
      channelId,
      nextToken,
      limit: customLimit || MAX_FILES_LIMIT,
    })
    return CopilotFileListSchema.parse(list)
  }

  async _retrieveFile(id: string): Promise<CopilotFileRetrieve> {
    const file = await this.copilot.retrieveFile({ id })
    return CopilotFileRetrieveSchema.parse(file)
  }

  async _retrieveFileChannel(id: string) {
    const fileChannel = await this.copilot.retrieveFileChannel({ id })
    return CopilotFileChannelRetrieveSchema.parse(fileChannel)
  }

  async _listFileChannels(args: CopilotListArgs & { companyId?: string; clientId?: string } = {}) {
    const list = await this.copilot.listFileChannels(args)
    return CopilotFileChannelListSchema.parse(list.data)
  }

  private wrapWithRetry<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R> {
    return (...args: Args): Promise<R> => withRetry(fn.bind(this), args)
  }

  // Methods wrapped with retry
  getTokenPayload = this.wrapWithRetry(this._getTokenPayload)
  getWorkspace = this.wrapWithRetry(this._getWorkspace)
  createClient = this.wrapWithRetry(this._createClient)
  getClient = this.wrapWithRetry(this._getClient)
  getClients = this.wrapWithRetry(this._getClients)
  updateClient = this.wrapWithRetry(this._updateClient)
  deleteClient = this.wrapWithRetry(this._deleteClient)
  createCompany = this.wrapWithRetry(this._createCompany)
  getCompany = this.wrapWithRetry(this._getCompany)
  getCompanies = this.wrapWithRetry(this._getCompanies)
  getCompanyClients = this.wrapWithRetry(this._getCompanyClients)
  getInternalUsers = this.wrapWithRetry(this._getInternalUsers)
  getInternalUser = this.wrapWithRetry(this._getInternalUser)
  createNotification = this.wrapWithRetry(this._createNotification)
  getProductsById = this.wrapWithRetry(this._getProducts)
  getPricesById = this.wrapWithRetry(this._getPrices)
  createFile = this.wrapWithRetry(this._createFile)
  uploadFile = this.wrapWithRetry(this._uploadFile)
  deleteFile = this.wrapWithRetry(this._deleteFile)
  listFiles = this.wrapWithRetry(this._listFiles)
  retrieveFile = this.wrapWithRetry(this._retrieveFile)
  retrieveFileChannel = this.wrapWithRetry(this._retrieveFileChannel)
  listFileChannels = this.wrapWithRetry(this._listFileChannels)
}

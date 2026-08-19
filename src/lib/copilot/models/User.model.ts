import httpStatus from 'http-status'
import { z } from 'zod'
import APIError from '@/errors/APIError'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import type { Token } from '@/lib/copilot/types'
import { getAssemblyTokenPayload } from '@/lib/copilot/utils'
import logger from '@/lib/logger'

class User {
  internalUserId?: string
  readonly portalId: string
  readonly copilot: CopilotAPI

  constructor(
    public readonly token: string,
    tokenPayload: Token,
    copilot?: CopilotAPI,
  ) {
    this.internalUserId = tokenPayload.internalUserId
    this.portalId = tokenPayload.workspaceId
    this.copilot = copilot || new CopilotAPI(tokenPayload.workspaceId)
  }

  /**
   * Authenticates a Copilot user by token
   * @param token
   * @returns User instance modeled from the token payload
   * @throws APIError when the token is missing or cannot be decoded
   */
  static async authenticate(token?: unknown): Promise<User> {
    logger.info('User#authenticate :: Authenticating user', token)

    if (!token) {
      throw new APIError('Please provide a valid token', httpStatus.UNAUTHORIZED)
    }

    const tokenParsed = z.string().min(1).safeParse(token)

    if (!tokenParsed.success) {
      logger.info('User#authenticate :: Token parse error', tokenParsed.error)
      throw new APIError('Token parse error', httpStatus.UNAUTHORIZED)
    }

    const tokenPayload = await getAssemblyTokenPayload(tokenParsed.data)
    if (!tokenPayload) {
      throw new APIError('Unable to decode Copilot token payload', httpStatus.UNAUTHORIZED)
    }

    // SDK is built lazily, so auth errors surface on the first API call.
    return new User(tokenParsed.data, tokenPayload)
  }
}

export default User

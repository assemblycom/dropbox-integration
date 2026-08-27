import DropboxConnectionsService from '@/features/auth/lib/DropboxConnections.service'
import BaseService from '@/lib/copilot/services/base.service'
import { DropboxAuthClient } from '@/lib/dropbox/DropboxAuthClient'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import type { DropboxAuthResponseType } from '@/lib/dropbox/type'
import logger from '@/lib/logger'

class AuthService extends BaseService {
  async handleDropboxCallback(urlParams: Record<string, string | string[] | undefined>) {
    logger.info(
      'AuthService#handleDropboxCallback :: Handling Dropbox callback',
      this.user.internalUserId,
    )
    let tokenSet: DropboxAuthResponseType, rootNamespaceId: string

    try {
      const dbx = new DropboxAuthClient()
      tokenSet = await dbx.handleDropboxCallback(urlParams)

      // Need to get the user's account info to get the Team Root Namespace ID. This step makes sure we are accessing the root folder that includes both personal and team folder
      logger.log('AuthService#handleDropboxCallback :: Getting account info')
      const dbxClient = new DropboxClient(tokenSet.refreshToken).getDropboxClient()
      const accountInfo = await dbxClient.usersGetCurrentAccount()
      logger.log('AuthService#handleDropboxCallback :: Account info', accountInfo)

      // The root_namespace_id is strictly available on root_info
      rootNamespaceId = accountInfo.result.root_info?.root_namespace_id
    } catch (error) {
      logger.error('AuthService#handleDropboxCallback :: Error handling Dropbox callback:', error)
      throw new Error('Error handling Dropbox callback')
    }

    const dbxConnectionService = new DropboxConnectionsService(this.user)
    return await dbxConnectionService.updateConnectionForWorkspace({
      ...tokenSet,
      rootNamespaceId, // Save this to DB
      status: true,
    })
  }
}

export default AuthService

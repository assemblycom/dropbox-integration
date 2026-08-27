import { assemblyApi } from '@assembly-js/node-sdk'
import env from '@/config/server.env'
import { TokenSchema } from '@/lib/copilot/types'
import logger from '@/lib/logger'

export const buildClientName = (client: { givenName: string; familyName: string }) =>
  `${client.givenName} ${client.familyName}`

// Decodes a request token into its payload using the token-scoped SDK.
export async function getAssemblyTokenPayload(token: string) {
  const sdk = await assemblyApi({ apiKey: env.COPILOT_API_KEY, token })
  if (!sdk.getTokenPayload) {
    // Never log the raw token — it is a credential.
    logger.error('getAssemblyTokenPayload | cannot decode token')
    return null
  }
  return TokenSchema.parse(await sdk.getTokenPayload())
}

import { resolveConnection } from '../connection-resolver.service.js'
import { getAccessToken } from '../cx/token.service.js'
import { getChannelApp } from '../cx/apps.service.js'

/** Account-scoped, read-only access to Etsy Open API v3. Never logs credentials or response bodies. */
export async function etsyReader(accountId: string) {
  const connection = await resolveConnection({ accountId })
  if (connection.channelType !== 'ETSY') throw new Error('The selected account is not Etsy.')
  const identity = connection.identity as { extra?: { shopId?: string } } | null
  const shopId = String(identity?.extra?.shopId ?? '')
  if (!/^[1-9]\d*$/.test(shopId)) throw new Error('The Etsy account has no verified shop identity.')
  const app = await getChannelApp('ETSY', 'production')
  const get = async <T>(path: string): Promise<T> => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid Etsy resource path.')
    const token = await getAccessToken(accountId)
    const response = await fetch(`https://api.etsy.com/v3/application${path}`, {
      headers: { Accept: 'application/json', 'x-api-key': `${app.clientId}:${app.clientSecret}`, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`Etsy could not read this resource (HTTP ${response.status}).${response.status === 429 ? ' Retry after the Etsy rate limit resets.' : ''}`)
    return await response.json() as T
  }
  return { get, shopId }
}

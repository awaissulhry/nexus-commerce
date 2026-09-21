import { getAccessToken } from '../cx/token.service.js'
import { assertEtsyPath, etsyAccount, etsyOperation } from './account.js'

/** Account-scoped, read-only access to Etsy Open API v3. Never logs credentials or response bodies. */
export async function etsyReader(accountId: string) {
  // P4.6b — the account, the shop id and the x-api-key header now come from `account.ts`, which the
  // WRITE client uses too. Two builders of one header is how a channel's auth drifts in silence.
  const { shopId, apiKey } = await etsyAccount(accountId)
  const get = async <T>(path: string): Promise<T> => {
    assertEtsyPath(path)
    const token = await getAccessToken(accountId)
    // P1.2 — through the channel gateway (the account's state, rate bucket, call ledger).
    const { gatewayFetch } = await import('../gateway/gateway.js')
    const response = await gatewayFetch({
      channel: 'ETSY', operation: etsyOperation('GET', path), kind: 'read', connectionId: accountId,
      url: `https://api.etsy.com/v3/application${path}`, method: 'GET',
      headers: { 'x-api-key': apiKey }, auth: { token }, timeoutMs: 20_000,
    })
    if (!response.ok) throw new Error(`Etsy could not read this resource (HTTP ${response.status}).${response.status === 429 ? ' Retry after the Etsy rate limit resets.' : ''}`)
    return await response.json() as T
  }
  return { get, shopId }
}

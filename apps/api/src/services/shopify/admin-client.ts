import { resolveConnection } from '../connection-resolver.service.js'
import { getAccessToken, assertWritable } from '../cx/token.service.js'
import { shopifyShopDomain } from '../cx/connectors/shopify/auth.js'
import { acquireShopifyPublishToken, getShopifyPublishMode } from '../shopify-publish-gate.service.js'

export type ShopifyGraphql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>
export async function shopifyAdmin(accountId: string): Promise<{ graphql: ShopifyGraphql; domain: string }> {
  const connection = await resolveConnection({ accountId })
  if (connection.channelType !== 'SHOPIFY') throw new Error('The selected account is not Shopify.')
  const domain = shopifyShopDomain(connection.region)
  if (!domain) throw new Error('The Shopify account has no verified myshopify.com domain.')
  const graphql: ShopifyGraphql = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    if (/^\s*mutation\b/.test(query)) {
      await assertWritable(accountId)
      if (getShopifyPublishMode() !== 'live') throw new Error('Shopify writes are disabled by the server publish settings. The local preview is available.')
    }
    const acquired = await acquireShopifyPublishToken(domain)
    if (!acquired.ok) throw new Error(acquired.error)
    const token = await getAccessToken(accountId)
    // Mutations are not blindly retried after ambiguous network results. Product identity,
    // deterministic filenames and persisted checkpoints make an explicit retry reconcilable.
    const response = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60_000), redirect: 'error' })
    if (!response.ok) throw new Error(`Shopify request failed (HTTP ${response.status}). Retry after checking the account and request status.`)
    const result = await response.json() as { data?: T; errors?: { message: string }[] }
    if (result.errors?.length || !result.data) throw new Error(result.errors?.map(e => e.message).join('; ') ?? 'Shopify returned no data.')
    return result.data
  }
  return { graphql, domain }
}
export function assertShopifyResult<T extends { userErrors?: { field?: string[]; message: string }[] }>(payload: T | undefined, operation: string): T {
  if (!payload) throw new Error(`${operation} returned no result.`)
  if (payload.userErrors?.length) throw new Error(`${operation}: ${payload.userErrors.map(e => `${e.field?.join('.') ?? ''} ${e.message}`).join('; ')}`)
  return payload
}

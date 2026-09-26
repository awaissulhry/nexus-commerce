import { resolveConnection } from '../connection-resolver.service.js'
import { shopifyKind, shopifyTransport } from '../gateway/shopify.js'
import { SHOPIFY_API_VERSION } from './api-version.js'
import { getAccessToken, assertWritable } from '../cx/token.service.js'
import { shopifyShopDomain } from '../cx/connectors/shopify/auth.js'
import { acquireShopifyPublishToken, getShopifyPublishMode } from '../shopify-publish-gate.service.js'

export type ShopifyGraphql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>

/** The account's Admin GraphQL endpoint on the one API version Nexus speaks. */
async function adminEndpoint(accountId: string): Promise<{ domain: string; url: string }> {
  const connection = await resolveConnection({ accountId })
  if (connection.channelType !== 'SHOPIFY') throw new Error('The selected account is not Shopify.')
  const domain = shopifyShopDomain(connection.region)
  if (!domain) throw new Error('The Shopify account has no verified myshopify.com domain.')
  return { domain, url: `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json` }
}

export interface ShopifyGraphqlError { message: string; path?: Array<string | number>; extensions?: { code?: string } }
export interface ShopifyQueryCost {
  requestedQueryCost: number | null
  actualQueryCost: number | null
  throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } | null
}
export interface ShopifyReadResult<T> { data: T | null; errors: ShopifyGraphqlError[]; cost: ShopifyQueryCost | null }
export type ShopifyReadGraphql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<ShopifyReadResult<T>>

/** A document that could change something: a mutation or a subscription anywhere in it (comments ignored). */
function changesSomething(query: string): boolean {
  return /\b(mutation|subscription)\b/.test(query.replace(/#[^\n]*/g, ''))
}

/**
 * The read-only face of the admin client, for reports that must never change the shop. It refuses any
 * change document before anything is sent, and it returns what `shopifyAdmin` drops: GraphQL errors
 * next to partial data, and the query cost (`extensions.cost`), so a paginated reader can pace itself.
 * Same account, same endpoint, same gateway path (`kind: 'read'`), same local rate bucket.
 */
export async function shopifyAdminReader(accountId: string): Promise<{ read: ShopifyReadGraphql; domain: string }> {
  const { domain, url } = await adminEndpoint(accountId)
  const read: ShopifyReadGraphql = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ query, variables })
    if (changesSomething(query) || shopifyKind('POST', url, body) !== 'read') {
      throw new Error('Refused, nothing sent: this Shopify client only reads, and the document would change the shop.')
    }
    const acquired = await acquireShopifyPublishToken(domain)
    if (!acquired.ok) throw new Error(acquired.error)
    const token = await getAccessToken(accountId)
    const response = await shopifyTransport(accountId)(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body, signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Shopify request failed (HTTP ${response.status}). Retry after checking the account and request status.`)
    const result = await response.json() as { data?: T | null; errors?: ShopifyGraphqlError[]; extensions?: { cost?: Partial<ShopifyQueryCost> } }
    const cost = result.extensions?.cost
    return {
      data: result.data ?? null,
      errors: Array.isArray(result.errors) ? result.errors : [],
      cost: cost ? { requestedQueryCost: cost.requestedQueryCost ?? null, actualQueryCost: cost.actualQueryCost ?? null, throttleStatus: cost.throttleStatus ?? null } : null,
    }
  }
  return { read, domain }
}

export async function shopifyAdmin(accountId: string): Promise<{ graphql: ShopifyGraphql; domain: string }> {
  const { domain, url } = await adminEndpoint(accountId)
  const graphql: ShopifyGraphql = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    if (/^\s*mutation\b/.test(query)) {
      await assertWritable(accountId)
      // P1.4b — the listing publish mode governs listing writes. An order action (refund, cancel,
      // fulfilment) has its own switch at its caller (P0.1), the same rule the gateway applies.
      const action = shopifyKind('POST', url, JSON.stringify({ query })) === 'action'
      if (!action && getShopifyPublishMode() !== 'live') throw new Error('Shopify writes are disabled by the server publish settings. The local preview is available.')
    }
    const acquired = await acquireShopifyPublishToken(domain)
    if (!acquired.ok) throw new Error(acquired.error)
    const token = await getAccessToken(accountId)
    // Mutations are not blindly retried after ambiguous network results. Product identity,
    // deterministic filenames and persisted checkpoints make an explicit retry reconcilable.
    // P1.2 — through the channel gateway (the connected account; state, rate bucket, call ledger).
    const response = await shopifyTransport(accountId)(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Shopify request failed (HTTP ${response.status}). Retry after checking the account and request status.`)
    const result = await response.json() as { data?: T; errors?: { message: string }[] }
    if (result.errors?.length || !result.data) throw new Error(result.errors?.map(e => e.message).join('; ') ?? 'Shopify returned no data.')
    return result.data
  }
  return { graphql, domain }
}
/**
 * P3.2 — a Shopify `userErrors` failure, with the errors still readable.
 *
 * The thrown sentence is for the operator's queue row; `userErrors` is for the listing.
 * Flattening them into a string here was why a Shopify rejection could not be put on
 * its listing with Shopify's own field name attached.
 */
export interface ShopifyUserError { field?: string[]; message: string; code?: string }

export class ShopifyUserErrors extends Error {
  readonly userErrors: ShopifyUserError[]
  readonly operation: string
  constructor(operation: string, userErrors: ShopifyUserError[]) {
    super(`${operation}: ${userErrors.map(e => `${e.field?.join('.') ?? ''} ${e.message}`).join('; ')}`)
    this.name = 'ShopifyUserErrors'
    this.operation = operation
    this.userErrors = userErrors
  }
}

export function assertShopifyResult<T extends { userErrors?: ShopifyUserError[] }>(payload: T | undefined, operation: string): T {
  if (!payload) throw new Error(`${operation} returned no result.`)
  // The message is byte-for-byte what it was; only the type is richer, so every existing
  // caller that reads `error.message` is unaffected.
  if (payload.userErrors?.length) throw new ShopifyUserErrors(operation, payload.userErrors)
  return payload
}

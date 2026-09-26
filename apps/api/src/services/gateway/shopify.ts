/**
 * P1.2 — Shopify on the gateway: the read / write / action / setup rule for a Shopify call (REST or
 * GraphQL), and a `fetch`-shaped sender for the call sites that move onto the gateway unchanged.
 */
import { gatewayFetch, type GatewayBody, type GatewayRequest } from './gateway.js'
import { operationOfPath } from './channels.js'
import { accountOfToken } from './token-accounts.js'
import { graphqlDocumentInfo, graphqlRootField } from './graphql-root-field.js'
export { graphqlDocumentInfo, graphqlRootField } from './graphql-root-field.js'

/** REST: event subscriptions are connection setup; orders, fulfilments and refunds have their own switch. */
const SETUP_REST = /\/webhooks(\/|\.json)/
const ACTION_REST = /\/(orders|fulfillments|fulfillment_orders|refunds|transactions|returns)(\/|\.json)/
/** GraphQL mutations that change nothing on the shop. */
const READ_MUTATIONS = /^(stagedUploadsCreate|bulkOperationRunQuery|bulkOperationCancel)$/
const SETUP_MUTATIONS = /^(webhookSubscription|eventBridgeWebhookSubscription|pubSubWebhookSubscription)/
const ACTION_MUTATIONS = /^(fulfillment|order|refund|return|draftOrder|reverseDelivery|reverseFulfillment)/i

export function shopifyKind(method: string, url: string, body?: GatewayBody): GatewayRequest['kind'] {
  const path = new URL(url).pathname
  if (/\/graphql\.json$/.test(path)) {
    let query = ''
    try { query = typeof body === 'string' ? String(JSON.parse(body)?.query ?? '') : '' } catch { /* not JSON */ }
    // Every root field of every change in the document counts, not only the first (review of PR #54): one
    // listing write among harmless fields makes the whole document a write. A document that does not parse
    // is a change with no known field — a write (fail closed).
    const doc = graphqlDocumentInfo(query)
    if (doc.readOnly) return 'read'
    const changes = doc.fields.filter((field) => !READ_MUTATIONS.test(field))
    if (doc.fields.length > 0 && changes.length === 0) return 'read'
    if (changes.length === 0 || changes.some((field) => !SETUP_MUTATIONS.test(field) && !ACTION_MUTATIONS.test(field))) return 'write'
    if (changes.some((field) => ACTION_MUTATIONS.test(field))) return 'action'
    return 'setup'
  }
  if (method.toUpperCase() === 'GET') return 'read'
  if (SETUP_REST.test(path)) return 'setup'
  if (ACTION_REST.test(path)) return 'action'
  return 'write'
}

function headersRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [k, String(v)]))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

/**
 * A `fetch`-shaped sender for Shopify: a file moves its `fetch(url, init)` calls onto the gateway with
 * the same headers and body. The `X-Shopify-Access-Token` it sends is the token used. The account:
 * `connectionId`, else the one the token service handed the token out for, else — only when the token
 * IS the env credential (`SHOPIFY_ACCESS_TOKEN` / `SHOPIFY_ADMIN_API_TOKEN`) — an app-level call (the
 * legacy env paths have no account row; P1.4 moves them to the connected account). Any other token is
 * refused.
 */
export function shopifyTransport(connectionId: string | null, options: { appLevel?: boolean; operation?: string; maxTransientRetries?: number; max429Retries?: number; timeoutMs?: number } = {}) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = headersRecord(init.headers)
    let token: string | undefined
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-shopify-access-token') { token = headers[name]; delete headers[name] }
    }
    let body: GatewayBody = null
    if (typeof init.body === 'string' || init.body instanceof FormData || init.body instanceof Uint8Array) body = init.body
    else if (init.body !== undefined && init.body !== null) throw new Error('shopifyTransport: this body type does not go through the channel gateway; nothing was sent.')
    const url = String(input)
    const method = String(init.method ?? 'GET').toUpperCase() as GatewayRequest['method']
    const account = connectionId ?? (token ? accountOfToken(token) : null)
    const envCredential = !account && !!token && isShopifyEnvToken(token)
    return gatewayFetch({
      channel: 'SHOPIFY',
      operation: options.operation ?? shopifyOperation(method, url, body),
      kind: shopifyKind(method, url, body),
      connectionId: account,
      appLevel: options.appLevel || envCredential,
      url,
      method,
      headers,
      body,
      auth: token ? { token } : 'account',
      maxTransientRetries: options.maxTransientRetries,
      max429Retries: options.max429Retries,
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: init.signal,
    })
  }
}

/** The legacy env credential — the only token that may go out without an account. */
export function isShopifyEnvToken(token: string): boolean {
  return [process.env.SHOPIFY_ACCESS_TOKEN, process.env.SHOPIFY_ADMIN_API_TOKEN].some((env) => !!env && env === token)
}

/** Ledger name: the GraphQL root field (`graphql.productSet`), else method + path without ids. */
function shopifyOperation(method: string, url: string, body: GatewayBody): string {
  if (/\/graphql\.json$/.test(new URL(url).pathname) && typeof body === 'string') {
    try {
      const root = graphqlRootField(String(JSON.parse(body)?.query ?? ''))
      if (root.field) return `graphql.${root.field}`
    } catch { /* not JSON */ }
  }
  return operationOfPath(method, url)
}

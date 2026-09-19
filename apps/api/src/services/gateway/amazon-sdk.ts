/**
 * P1.2 — the Amazon SP-API SDK (`amazon-sp-api`) sends through the gateway.
 *
 * Every SDK instance is made in one place (`lib/amazon-sp-client.ts` `getAmazonSpClient`). The SDK
 * still builds each request (operation → method, path, query, body) and still shapes the answer
 * (payload, pagination, `CustomError`, its own QuotaExceeded wait-and-retry). Only its one send
 * function, `_request.api(token, params)`, is replaced: the built request goes through `gatewayCall`,
 * so every SDK call gets the account status check, the publish mode for writes, the rate bucket, the
 * error class and one ledger row. The SDK's token exchange (`_request.execute`) and its document
 * download / upload (pre-signed storage URLs, not the API) do not pass here.
 */
import { gatewayCall, gatewayFetch, type GatewayRequest } from './gateway.js'
import { operationOfPath } from './channels.js'

/**
 * SP-API operations sent as POST (or PUT / PATCH) that change nothing on the seller account. An
 * operation NOT in this list is a write — the safe side: in a dry run it is refused with a sentence
 * instead of sent.
 */
const READS_SENT_AS_WRITES = new Set([
  'getItemOffersBatch', 'getListingOffersBatch', 'getCompetitiveSummary', 'getFeaturedOfferExpectedPriceBatch',
  'getMyFeesEstimates', 'getMyFeesEstimateForASIN', 'getMyFeesEstimateForSKU',
  'getEligibleShipmentServices', 'getRates', 'getAdditionalInputs',
  'createReport', 'createQuery', 'createRestrictedDataToken',
  'validateContentDocumentAsinRelations',
])

/** SP-API paths that are connection plumbing (see GatewayRequest.kind 'setup'), not selling. */
const SETUP_PATHS = /^\/(notifications|applications)\//

/**
 * Read, write or setup, from the built request. A listings VALIDATION_PREVIEW changes nothing: a read.
 * Notification subscriptions / destinations and the app's own secret rotation: setup.
 */
export function amazonSdkKind(method: string, operation: string | undefined, query: Record<string, unknown> | undefined, path?: string): 'read' | 'write' | 'setup' {
  if (method.toUpperCase() === 'GET') return 'read'
  if (path && SETUP_PATHS.test(path)) return 'setup'
  if (operation && READS_SENT_AS_WRITES.has(operation)) return 'read'
  if (String(query?.mode ?? '').toUpperCase() === 'VALIDATION_PREVIEW') return 'read'
  return 'write'
}

function marketplaceOf(query: Record<string, unknown> | undefined): string | null {
  const ids = query?.marketplaceIds ?? query?.MarketplaceIds ?? query?.marketplaceId ?? query?.MarketplaceId
  const first = Array.isArray(ids) ? ids[0] : typeof ids === 'string' ? ids.split(',')[0] : null
  return typeof first === 'string' && first ? first : null
}

interface SdkRequest {
  api: (token: string, params: Record<string, any>) => Promise<unknown>
  _constructRequestOptions: (token: string, params: Record<string, any>) => { method: string; url: string; body: string | null; headers: Record<string, string | undefined> }
}

export class SdkShapeChanged extends Error {
  constructor() {
    super('amazon-sp-api changed: its request sender (_request.api / _constructRequestOptions) is not where the channel gateway expects it. Nothing was sent.')
    this.name = 'SdkShapeChanged'
  }
}

/**
 * Route one SDK instance's API calls through the gateway. Throws when the SDK no longer has the
 * send function this replaces — a silent bypass of the gateway is never the fallback.
 */
export function routeSdkThroughGateway(client: { _request?: unknown }, ctx: { connectionId: string | null }): void {
  const request = client._request as SdkRequest | undefined
  if (!request || typeof request.api !== 'function' || typeof request._constructRequestOptions !== 'function') throw new SdkShapeChanged()
  if ((request.api as { viaGateway?: boolean }).viaGateway) return
  const viaGateway = async (token: string, params: Record<string, any>) => {
    const built = request._constructRequestOptions(token, params)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(built.headers ?? {})) {
      // The gateway sets the token; fetch sets the host.
      if (value === undefined || value === null || /^(x-amz-access-token|host)$/i.test(name)) continue
      headers[name] = String(value)
    }
    const method = String(built.method).toUpperCase() as GatewayRequest['method']
    const operation = typeof params.operation === 'string' ? params.operation : operationOfPath(method, built.url)
    const res = await gatewayCall({
      channel: 'AMAZON_SP',
      operation,
      kind: amazonSdkKind(method, params.operation, params.query, new URL(built.url).pathname),
      connectionId: ctx.connectionId,
      appLevel: !ctx.connectionId,
      url: built.url,
      method,
      headers,
      body: built.body,
      auth: { token },
      marketplace: marketplaceOf(params.query),
      // The SDK waits the operation's restore rate and retries a QuotaExceeded itself.
      max429Retries: 0,
      timeoutMs: 60_000,
    })
    if (res.status === 0) {
      // No answer: the SDK's callers expect a network error, as from its own sender.
      throw Object.assign(new Error(`Amazon did not answer: ${res.text}`), { code: res.verdict?.errorClass === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET' })
    }
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: res.text, chunks: [Buffer.from(res.text)], request: { method, url: built.url } }
  }
  ;(viaGateway as { viaGateway?: boolean }).viaGateway = true
  request.api = viaGateway
}

/**
 * An app-level (grantless) SP-API call — the app's own token, no seller account: notification
 * destinations, a subscription removed by id. GET is a read; anything else is connection setup (sent
 * in every publish mode). Returns the channel's answer as a Response.
 */
export function amazonGrantlessFetch(input: { token: string; host: string; method: 'GET' | 'POST' | 'DELETE'; path: string; operation: string; body?: unknown }): Promise<Response> {
  return gatewayFetch({
    channel: 'AMAZON_SP',
    operation: input.operation,
    kind: input.method === 'GET' ? 'read' : 'setup',
    connectionId: null,
    appLevel: true,
    url: `https://${input.host}${input.path}`,
    method: input.method,
    headers: input.body === undefined ? {} : { 'content-type': 'application/json' },
    body: input.body === undefined ? null : JSON.stringify(input.body),
    auth: { token: input.token },
  })
}

/**
 * A seller-account SP-API call on the gateway: the account (named, or the one the resolver allows),
 * its region host and its token are resolved here, so a call site no longer fetches its own token.
 * `path` includes the query string. Read / write / setup from the request (see `amazonSdkKind`) unless
 * given. Returns the channel's answer as a Response.
 */
export async function amazonSellerFetch(input: {
  accountId?: string
  method?: GatewayRequest['method']
  path: string
  /** Stable name for the ledger; default: method + path without ids. */
  operation?: string
  body?: unknown
  headers?: Record<string, string>
  kind?: GatewayRequest['kind']
  idempotent?: boolean
  timeoutMs?: number
}): Promise<Response> {
  const { amazonAccount, getAmazonRegion } = await import('../../lib/amazon-sp-client.js')
  const account = await amazonAccount({ accountId: input.accountId })
  const url = `https://sellingpartnerapi-${await getAmazonRegion(account.id)}.amazon.com${input.path}`
  const method = input.method ?? 'GET'
  const parsed = new URL(url)
  const hasBody = input.body !== undefined && input.body !== null
  const operation = input.operation ?? operationOfPath(method, url)
  return gatewayFetch({
    channel: 'AMAZON_SP',
    operation,
    kind: input.kind ?? amazonSdkKind(method, operation, Object.fromEntries(parsed.searchParams), parsed.pathname),
    connectionId: account.id,
    url,
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(input.headers ?? {}) },
    body: hasBody ? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body)) : null,
    marketplace: (parsed.searchParams.get('marketplaceIds') ?? parsed.searchParams.get('marketplaceId') ?? parsed.searchParams.get('MarketplaceIds'))?.split(',')[0] ?? null,
    idempotent: input.idempotent ?? /^\/listings\//.test(parsed.pathname),
    timeoutMs: input.timeoutMs ?? 60_000,
  })
}

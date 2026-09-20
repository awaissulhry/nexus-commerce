/**
 * P1.2 — eBay on the gateway: the read / write / action / setup rule for an eBay REST call, and the send
 * helpers the call sites use. P1.5 — the market headers of a listing write come from the Marketplace row.
 */
import { gatewayFetch, type GatewayBody, type GatewayRequest } from './gateway.js'
import { operationOfPath } from './channels.js'
import { accountOfToken } from './token-accounts.js'

/** Connection plumbing (see GatewayRequest.kind 'setup'): event subscriptions, signing keys. */
const SETUP_PATHS = /^\/(commerce\/notification|developer\/key_management)\//
/** eBay POSTs that only read. */
const READ_POSTS = /\/(bulk_get_[a-z_]+|search[a-z_]*|translate|find)$/
/**
 * Actions with their own switch (GatewayRequest.kind 'action'): refunds, shipping fulfilments,
 * cancellations, returns, feedback, labels (NEXUS_ENABLE_EBAY_SHIP_CONFIRM, …_ORDER_CANCEL), and marketing —
 * promotions, markdowns, Promoted Listings (NEXUS_EBAY_MARKDOWN_LIVE, NEXUS_EBAY_VOLUME_LIVE, the ads gate).
 */
const ACTION_PATHS = /^\/(sell\/fulfillment|post-order|sell\/logistics|commerce\/feedback|sell\/marketing)\//

export function ebayKind(method: string, url: string): GatewayRequest['kind'] {
  if (method.toUpperCase() === 'GET') return 'read'
  const path = new URL(url).pathname
  if (SETUP_PATHS.test(path)) return 'setup'
  if (READ_POSTS.test(path)) return 'read'
  if (ACTION_PATHS.test(path)) return 'action'
  return 'write'
}

export interface EbayGatewayInput {
  connectionId: string | null
  url: string
  method?: GatewayRequest['method']
  headers?: Record<string, string>
  body?: GatewayBody
  /** Stable name for the ledger; default: method + path without ids. */
  operation?: string
  kind?: GatewayRequest['kind']
  marketplace?: string | null
  /** The token the call site already holds; default: the account's, from the token service. */
  token?: string
  appLevel?: boolean
  sign?: boolean
  idempotent?: boolean
  timeoutMs?: number
  modeAppliedByCaller?: boolean
  pushLock?: GatewayRequest['pushLock']
  writeTarget?: GatewayRequest['writeTarget']
  ledger?: GatewayRequest['ledger']
  maxTransientRetries?: number
  max429Retries?: number
  signal?: AbortSignal | null
}

/**
 * An eBay REST call on the gateway, answered as a `Response`. P1.5: a listing write gets its three market
 * headers from the Marketplace row (the call's own language kept only when it is one of the market's);
 * other calls keep what they send and get only what they leave out.
 */
export function ebayGatewayFetch(input: EbayGatewayInput): Promise<Response> {
  const method = input.method ?? 'GET'
  const headers = input.headers ?? {}
  const headerMarket = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-ebay-c-marketplace-id')?.[1]
  return gatewayFetch({
    channel: 'EBAY',
    operation: input.operation ?? operationOfPath(method, input.url),
    kind: input.kind ?? ebayKind(method, input.url),
    connectionId: input.connectionId,
    appLevel: input.appLevel,
    url: input.url,
    method,
    headers,
    body: input.body ?? null,
    auth: input.token ? { token: input.token } : 'account',
    marketplace: input.marketplace ?? headerMarket ?? null,
    sign: input.sign,
    idempotent: input.idempotent,
    timeoutMs: input.timeoutMs,
    modeAppliedByCaller: input.modeAppliedByCaller,
    pushLock: input.pushLock,
    writeTarget: input.writeTarget,
    ledger: input.ledger,
    maxTransientRetries: input.maxTransientRetries,
    max429Retries: input.max429Retries,
    signal: input.signal,
  })
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
 * A `fetch`-shaped sender bound to one eBay account: a file moves its `fetch(url, init)` calls onto the
 * gateway by calling this instead, with its headers, body and token unchanged. The `Authorization:
 * Bearer …` it already sends is the token used (none → the account's, from the token service). Bodies:
 * text, a form (URLSearchParams → text with its content type), a file upload (FormData / bytes); any
 * other kind is refused loudly rather than sent some other way.
 *
 * `maxTransientRetries: 0` for a file that has its own retry loop (no double retries); the default
 * timeout is long (120 s) because the calls it replaces had none.
 */
export function ebayTransport(connectionId: string | null, options: { appLevel?: boolean; maxTransientRetries?: number; max429Retries?: number; timeoutMs?: number } = {}) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = headersRecord(init.headers)
    let token: string | undefined
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() !== 'authorization') continue
      const bearer = /^Bearer\s+(.+)$/i.exec(headers[name])
      if (bearer) { token = bearer[1]; delete headers[name] }
    }
    let body: GatewayBody = null
    if (init.body instanceof URLSearchParams) {
      body = init.body.toString()
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    } else if (typeof init.body === 'string' || init.body instanceof FormData || init.body instanceof Uint8Array) {
      body = init.body
    } else if (init.body !== undefined && init.body !== null) {
      throw new Error('ebayTransport: this body type does not go through the channel gateway; nothing was sent.')
    }
    // A call site that holds only the token: the account the token service handed it out for.
    const account = connectionId ?? (!options.appLevel && token ? accountOfToken(token) : null)
    return ebayGatewayFetch({
      connectionId: account,
      appLevel: options.appLevel,
      url: String(input),
      method: String(init.method ?? 'GET').toUpperCase() as GatewayRequest['method'],
      headers,
      body,
      token,
      maxTransientRetries: options.maxTransientRetries,
      max429Retries: options.max429Retries,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: init.signal,
    })
  }
}

/** `fetch(url, init)` for one eBay account, through the gateway — the one-line form of `ebayTransport`. */
export function ebaySend(connectionId: string | null, input: string | URL, init: RequestInit = {}): Promise<Response> {
  return ebayTransport(connectionId)(input, init)
}

/**
 * A `fetch`-shaped sender for an eBay Trading (XML) call: the call name comes from its
 * `X-EBAY-API-CALL-NAME` header, the token stays where the call puts it (IAF header or the XML), and the
 * Trading Ack is read as the outcome. The account: `connectionId`, else the one the IAF token was handed
 * out for; neither → refused.
 */
export async function ebayTradingSend(connectionId: string | null, input: string | URL, init: RequestInit & { body: string }): Promise<Response> {
  const { tradingCallKind, tradingAnswerOk } = await import('../ebay-trading-api.service.js')
  const headers = headersRecord(init.headers)
  const header = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
  const callName = header('x-ebay-api-call-name') ?? 'Unknown'
  const iaf = header('x-ebay-api-iaf-token')
  return gatewayFetch({
    channel: 'EBAY',
    operation: `trading.${callName}`,
    kind: tradingCallKind(callName),
    connectionId: connectionId ?? (iaf ? accountOfToken(iaf) : null),
    url: String(input),
    method: 'POST',
    headers,
    body: init.body,
    auth: 'none',
    marketHeaders: 'caller',
    answerOk: tradingAnswerOk,
    timeoutMs: 120_000,
    signal: init.signal,
  })
}

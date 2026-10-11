/**
 * P1.2 — Amazon Ads on the gateway: a `fetch`-shaped sender for the Ads client and its probes.
 *
 * Every Ads change is an `action` (its own write gate decides: allowlist, caps, pins, the sandbox
 * switch); a GET, a POST …/list and a POST that only answers (ADS_READ_POSTS) is a read. The Ads client
 * keeps its own retry loop (429 / 423 / 5xx) and quota reservation, so its sender turns the gateway's
 * retries off.
 */
import { gatewayFetch, type GatewayRequest } from './gateway.js'
import { operationOfPath } from './channels.js'
import { accountOfToken } from './token-accounts.js'

/**
 * The Ads POSTs that only answer and change nothing, beside …/list: Amazon's suggested bids (theme-based bid
 * recommendations, ads-api-client.ts fetchThemeBidRecommendations). A read: the ledger says read, and a transient
 * failure may be repeated as a read's is (the Ads client's own loop does the repeating).
 */
export const ADS_READ_POSTS: ReadonlySet<string> = new Set(['/sp/targets/bid/recommendations'])

export function adsKind(method: string, url: string): GatewayRequest['kind'] {
  const m = method.toUpperCase()
  if (m === 'GET') return 'read'
  if (m !== 'POST') return 'action'
  const pathname = new URL(url).pathname
  return pathname.endsWith('/list') || ADS_READ_POSTS.has(pathname) ? 'read' : 'action'
}

export function adsTransport(connectionId: string | null, options: { appLevel?: boolean; operation?: string; maxTransientRetries?: number; max429Retries?: number; timeoutMs?: number } = {}) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) if (v !== undefined && v !== null) headers[k] = String(v)
    let token: string | undefined
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() !== 'authorization') continue
      const bearer = /^Bearer\s+(.+)$/i.exec(headers[name])
      if (bearer) { token = bearer[1]; delete headers[name] }
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new Error('adsTransport: only text bodies go through the channel gateway; nothing was sent.')
    }
    const url = String(input)
    const method = String(init.method ?? 'GET').toUpperCase() as GatewayRequest['method']
    const account = connectionId ?? (token ? accountOfToken(token) : null)
    return gatewayFetch({
      channel: 'AMAZON_ADS',
      operation: options.operation ?? operationOfPath(method, url),
      kind: adsKind(method, url),
      connectionId: account,
      appLevel: !account && !!options.appLevel,
      url,
      method,
      headers,
      body: (init.body as string | null | undefined) ?? null,
      auth: token ? { token } : 'account',
      maxTransientRetries: options.maxTransientRetries,
      max429Retries: options.max429Retries,
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: init.signal,
    })
  }
}

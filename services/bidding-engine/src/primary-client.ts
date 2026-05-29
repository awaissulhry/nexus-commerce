/**
 * Internal REST client to the primary Fastify app. This microservice never
 * touches the database directly — it reads bid contexts and writes back applied
 * results through two internal endpoints, authenticated with a shared token.
 *
 * Contract the primary app must expose (apps/api):
 *   GET  /internal/bidding/contexts?marketplace=&limit=   -> { contexts: BidContext[] }
 *   POST /internal/bidding/applied  { bridgeId, externalId, bidMinor, prevBidMinor, status }
 * Both require header `x-internal-token: <PRIMARY_API_TOKEN>`.
 */
import { config } from './config.js'
import type { BidContext } from './types.js'

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${config.primary.baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-internal-token': config.primary.token,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`primary ${path} -> ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export class PrimaryClient {
  /** Pull the targets eligible for re-bidding (the primary app does the joins). */
  async fetchContexts(opts: { marketplace?: string; limit?: number } = {}): Promise<BidContext[]> {
    const qs = new URLSearchParams()
    if (opts.marketplace) qs.set('marketplace', opts.marketplace)
    qs.set('limit', String(opts.limit ?? 500))
    const r = await call<{ contexts: BidContext[] }>(`/internal/bidding/contexts?${qs}`, { method: 'GET' })
    return r.contexts ?? []
  }

  /** Report the outcome so the primary app updates the local row + writes audit. */
  async reportApplied(payload: {
    bridgeId: string; externalId: string; bidMinor: number; prevBidMinor: number
    status: 'applied' | 'failed' | 'dry-run'
  }): Promise<void> {
    await call('/internal/bidding/applied', { method: 'POST', body: JSON.stringify(payload) })
  }
}

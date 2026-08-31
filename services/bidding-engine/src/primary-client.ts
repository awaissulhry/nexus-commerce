/**
 * Internal REST client to the primary Fastify app. This microservice never
 * touches the database directly — it reads bid contexts and writes back applied
 * results through two internal endpoints, authenticated with a shared token.
 *
 * Contract the primary app exposes (apps/api):
 *   GET  /api/internal/bidding/contexts?marketplace=&limit=  -> { contexts: BidContext[] }
 *   POST /api/internal/bidding/applied  { bridgeId, externalId, bidMinor, prevBidMinor, status }
 *
 * 🔴 The `/api` prefix is LOAD-BEARING. advertising.routes.ts is registered as
 * `app.register(advertisingRoutes, { prefix: '/api' })`, so the endpoints live
 * under /api — and the permissions manifest maps `/api/internal/bidding` too.
 * These paths were written without it and would have 404'd on the engine's
 * very first call; caught by running the contract locally (PH.4c) rather than
 * on a first deploy. PRIMARY_API_URL stays the bare origin.
 *
 * Both require header `x-internal-token`, whose value must equal the PRIMARY's
 * `NEXUS_INTERNAL_API_TOKEN` — the two processes name the same secret
 * differently (here it is PRIMARY_API_TOKEN), and a mismatch is a silent 401.
 */
import { config } from './config.js'
import type { BidContext } from './types.js'

/** See the header: the `/api` prefix is where advertising.routes.ts is mounted. */
const INTERNAL_PREFIX = '/api/internal/bidding'

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
    const r = await call<{ contexts: BidContext[] }>(`${INTERNAL_PREFIX}/contexts?${qs}`, { method: 'GET' })
    return r.contexts ?? []
  }

  /** Report the outcome so the primary app updates the local row + writes audit. */
  async reportApplied(payload: {
    bridgeId: string; externalId: string; bidMinor: number; prevBidMinor: number
    status: 'applied' | 'failed' | 'dry-run'
  }): Promise<void> {
    await call(`${INTERNAL_PREFIX}/applied`, { method: 'POST', body: JSON.stringify(payload) })
  }
}

/**
 * Meta ads step 2 — the read routes of Ads › Meta (meta-ads-read.routes.ts): each passes its query to the read service
 * (which holds every database call) and answers the service's refusal with its status and sentence; a bad cursor is a
 * 400; "Read now" takes no body. Read only: there is no route that changes Meta. Services stubbed; made-up ids only.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class MetaAdsReadError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
  return {
    MetaAdsReadError,
    overview: vi.fn(async (_q: unknown) => ({ totals: null }) as unknown),
    campaigns: vi.fn(async (_q: unknown) => ({ items: [] }) as unknown),
    days: vi.fn(async (_id: string, _q: unknown) => ({ days: [] }) as unknown),
    adSets: vi.fn(async (_q: unknown) => ({ items: [] }) as unknown),
    ads: vi.fn(async (_q: unknown) => ({ items: [] }) as unknown),
    read: vi.fn(async (_q: unknown) => ({ queued: true }) as unknown),
  }
})
vi.mock('../services/marketing/meta-ads/read.service.js', () => ({
  MetaAdsReadError: h.MetaAdsReadError, metaAdsOverview: h.overview, metaAdsCampaigns: h.campaigns, metaCampaignDays: h.days,
  metaAdsAdSets: h.adSets, metaAdsAds: h.ads, requestMetaAdsRead: h.read,
}))
// The money filter is the shared hook (lib/auth/field-filter tests); here it lets everything through.
vi.mock('../lib/auth/field-filter.js', () => ({ financialFilterHookWith: () => async (_req: unknown, _reply: unknown, payload: unknown) => payload }))

import metaAdsReadRoutes from './meta-ads-read.routes.js'
import { InvalidCursorError } from '../lib/pagination/cursor.js'

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(metaAdsReadRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { vi.clearAllMocks() })

describe('the read routes', () => {
  it('pass the query to the read service, empty values as null', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/meta-ads/overview?account=conn-1&from=2026-10-01&to=' })).statusCode).toBe(200)
    expect(h.overview).toHaveBeenLastCalledWith({ connectionId: 'conn-1', from: '2026-10-01', to: null })
    await app.inject({ method: 'GET', url: '/api/meta-ads/campaigns?status=ACTIVE&search=shoes&limit=50&cursor=c1' })
    expect(h.campaigns).toHaveBeenLastCalledWith({ connectionId: null, from: null, to: null, status: 'ACTIVE', search: 'shoes', limit: '50', cursor: 'c1' })
    await app.inject({ method: 'GET', url: '/api/meta-ads/campaigns/cmp-1/days?from=2026-10-01&to=2026-10-19' })
    expect(h.days).toHaveBeenLastCalledWith('cmp-1', { from: '2026-10-01', to: '2026-10-19' })
    await app.inject({ method: 'GET', url: '/api/meta-ads/adsets?campaign=120000000000101' })
    expect(h.adSets).toHaveBeenLastCalledWith(expect.objectContaining({ metaCampaignId: '120000000000101' }))
    await app.inject({ method: 'GET', url: '/api/meta-ads/ads?adset=120000000000201' })
    expect(h.ads).toHaveBeenLastCalledWith(expect.objectContaining({ metaAdSetId: '120000000000201' }))
  })
  it('a refusal keeps its status and sentence; a bad cursor is a 400', async () => {
    h.campaigns.mockRejectedValueOnce(new h.MetaAdsReadError(404, 'No Meta ad account is chosen for this business yet.'))
    const refused = await app.inject({ method: 'GET', url: '/api/meta-ads/campaigns' })
    expect(refused.statusCode).toBe(404)
    expect(refused.json()).toEqual({ error: 'No Meta ad account is chosen for this business yet.' })
    h.ads.mockRejectedValueOnce(new InvalidCursorError())
    expect((await app.inject({ method: 'GET', url: '/api/meta-ads/ads?cursor=broken' })).statusCode).toBe(400)
  })
  it('"Read now" is a POST with no body; nothing else here writes', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/meta-ads/sync?account=conn-1' })).json()).toEqual({ queued: true })
    expect(h.read).toHaveBeenLastCalledWith({ connectionId: 'conn-1' })
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/meta-ads/campaigns' })).statusCode, method).toBe(404)
    }
  })
})

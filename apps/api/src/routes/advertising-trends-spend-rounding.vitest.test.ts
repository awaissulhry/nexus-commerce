/**
 * AM-30 / AM-34 — `GET /advertising/trends`:
 *  · the window's spend is its micros summed and rounded ONCE. It used to add each day's already-rounded cents, so
 *    seven days of 0.4 cents read €0.00 while the campaign list (rounded per campaign) read €0.03;
 *  · `fresh=1` (the Ad Manager's "Refresh view") asks the read cache to skip its stored answer.
 * PGlite with the production schema; the ads read cache is a pass-through that records how it was asked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { lastCompleteDay } from '../services/ads-core/date-range.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const cacheCalls: Array<{ key: string; refresh: boolean }> = []
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (key: string, _ttl: number, work: () => Promise<unknown>, opts?: { refresh?: boolean }) => {
    cacheCalls.push({ key, refresh: opts?.refresh === true })
    return work()
  },
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const shift = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const LAST = lastCompleteDay()
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    // Seven days of 0.4 cents (4,000 micros) each: 2.8 cents in all.
    for (let i = 0; i < 7; i++) {
      await database.client.amazonAdsDailyPerformance.create({ data: {
        profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'DE', adProduct: 'SPONSORED_PRODUCTS',
        date: new Date(`${shift(LAST, -i)}T00:00:00Z`), entityId: 'EXT-R1', localEntityId: null, reportRunId: 'RUN-1', reportedAt: new Date(),
        impressions: 10, clicks: 1, costMicros: 4_000n, sales7dCents: 0, orders7d: 0,
      } as never })
    }
  })
  app = Fastify()
  app.addHook('preHandler', (_r, _p, done) => { withWorkspace(business, done) })
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

const trends = async (q: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/advertising/trends?${q}` })
  expect(r.statusCode).toBe(200)
  return r.json() as { rows: Array<{ adSpendCents: number }>; summary: { spendCents: number } }
}

describe('GET /advertising/trends — spend is rounded once, and a refresh skips the cache', () => {
  it('sums the window in micros and rounds once: seven days of 0.4 cents are 3 cents, not 0', async () => {
    const out = await trends(`startDate=${shift(LAST, -6)}&endDate=${LAST}&marketplace=DE`)
    expect(out.rows).toHaveLength(7)
    expect(out.rows.every((r) => r.adSpendCents === 0)).toBe(true) // each day on its own rounds to 0 cents
    expect(out.summary.spendCents).toBe(3) // was 0: the sum of the rounded days
  })

  it('fresh=1 asks the read cache to skip its stored answer; an ordinary read does not', async () => {
    cacheCalls.length = 0
    await trends(`startDate=${shift(LAST, -6)}&endDate=${LAST}&marketplace=DE`)
    await trends(`startDate=${shift(LAST, -6)}&endDate=${LAST}&marketplace=DE&fresh=1`)
    const trendCalls = cacheCalls.filter((c) => c.key.startsWith('trends:'))
    expect(trendCalls.map((c) => c.refresh)).toEqual([false, true])
    // One key for both, so the refreshed answer is what the next ordinary read gets.
    expect(trendCalls[0].key).toBe(trendCalls[1].key)
  })
})

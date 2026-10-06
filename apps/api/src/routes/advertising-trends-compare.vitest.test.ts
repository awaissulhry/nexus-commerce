/**
 * AM-16 — `GET /advertising/trends?compare=true` compares COMPLETE days on both sides.
 *
 * Daily performance is T+1, so a window that runs into today holds one day fewer of data than an equal block before
 * it. The window before used to be the full N days, so a flat account read about 1/N down on every change (the
 * Dashboard's 30-day tiles: −3.3 % when nothing moved). Now the window before has the same number of complete days,
 * and the response names both windows. PGlite with the production schema; the ads read cache is a pass-through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { lastCompleteDay } from '../services/ads-core/date-range.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
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
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const shift = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const LAST = lastCompleteDay()
const TODAY = shift(LAST, 1)
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    // A flat account: €1.00 every day for the last 20 complete days, and nothing yet for today (T+1).
    for (let i = 0; i < 20; i++) {
      await database.client.amazonAdsDailyPerformance.create({ data: {
        profileId: 'P1', currencyCode: 'EUR', entityType: 'CAMPAIGN', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS',
        date: new Date(`${shift(LAST, -i)}T00:00:00Z`), entityId: 'EXT-T1', localEntityId: null, reportRunId: 'RUN-1', reportedAt: new Date(),
        impressions: 100, clicks: 10, costMicros: 1_000_000n, sales7dCents: 400, orders7d: 1,
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
  const r = await app.inject({ method: 'GET', url: `/api/advertising/trends?${q}&compare=true` })
  expect(r.statusCode).toBe(200)
  return r.json() as { summary: { spendCents: number; orders: number }; previous: { spendCents: number; orders: number } | null; compare: unknown; range: { startDate: string; endDate: string } }
}

describe('GET /advertising/trends — a change compares complete days only', () => {
  it('a window ending today: a flat account reads flat, and the response names both windows', async () => {
    const out = await trends(`startDate=${shift(LAST, -6)}&endDate=${TODAY}`)
    expect(out.summary.spendCents).toBe(700)
    expect(out.previous?.spendCents).toBe(700) // was 800: eight days set against seven
    expect(out.compare).toEqual({
      current: { startDate: shift(LAST, -6), endDate: LAST },
      previous: { startDate: shift(LAST, -13), endDate: shift(LAST, -7) },
      todayLeftOut: true,
    })
  })

  it('"Last 7 days" is seven complete days ending yesterday, set against the seven before', async () => {
    const out = await trends('preset=last7')
    expect(out.range).toMatchObject({ startDate: shift(LAST, -6), endDate: LAST })
    expect([out.summary.spendCents, out.previous?.spendCents]).toEqual([700, 700])
    expect(out.compare).toMatchObject({ todayLeftOut: false })
  })

  it('today alone has no complete day: no change, rather than a made-up one', async () => {
    const out = await trends('preset=today')
    expect(out.previous).toBeNull()
    expect(out.compare).toBeNull()
  })
})

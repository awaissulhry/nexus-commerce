/**
 * CC-24 — an AI goal is claimed BEFORE anything is sent, so a second launch (a retry after a timeout, a second tab, the
 * dashboard's Launch) never builds a second scaffold beside the first. A launch the checks refuse sends nothing and
 * lets the claim go, so the goal can be launched once it is fixed. Sandbox mode on PGlite: nothing leaves Nexus.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('./ai-goal-suggest.service.js', () => ({ resolveGoalBids: async () => ({}) }))
vi.mock('./ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

import { materializeProductGoal, MaterializeError } from './ai-goal-materialize.service.js'

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)
const goal = (name: string) => inside(() => database.client.adProductGoal.create({ data: {
  name, aiTarget: 'SALES', budgetMode: 'SHARED', totalBudgetCents: 2000, marketplace: 'IT',
  products: [{ asin: 'B0CLAIM001', sku: 'CLAIM-SKU-1', budgetCents: 2000 }] as never,
} }))
const campaignsNamed = (prefix: string) => inside(() => database.client.campaign.count({ where: { name: { startsWith: prefix } } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => database.client.product.create({ data: { sku: 'CLAIM-SKU-1', name: 'Claim jacket', basePrice: '99.00', amazonAsin: 'B0CLAIM001' } }))
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('CC-24 — a goal is launched once', () => {
  it('🔴 two launches of one goal at the same moment build ONE scaffold; the other is told it is already launching', async () => {
    const g = await goal('Claim twice')
    const results = await Promise.allSettled([inside(() => materializeProductGoal(g.id)), inside(() => materializeProductGoal(g.id))])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    expect(refused).toBeInstanceOf(MaterializeError)
    expect(refused.statusCode).toBe(409)
    expect(await campaignsNamed('[AI] Claim twice')).toBe(2) // AUTO + PERF, once
    expect((await inside(() => database.client.adProductGoal.findUniqueOrThrow({ where: { id: g.id } }))).materializedAt).toBeInstanceOf(Date)
  })

  it('a launch after a finished one is refused too: the campaigns are never built twice', async () => {
    const g = await goal('Claim after')
    await inside(() => materializeProductGoal(g.id))
    await expect(inside(() => materializeProductGoal(g.id))).rejects.toMatchObject({ statusCode: 409 })
    expect(await campaignsNamed('[AI] Claim after')).toBe(2)
  })

  it('CC-13 — a launch the checks refuse (a name the market already uses) sends nothing and lets the claim go', async () => {
    await inside(() => database.client.campaign.create({ data: { name: '[AI] Claim refused - Auto', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } }))
    const g = await goal('Claim refused')
    await expect(inside(() => materializeProductGoal(g.id))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/IT already has a campaign named "\[AI\] Claim refused - Auto"/) })
    expect(await campaignsNamed('[AI] Claim refused')).toBe(1) // only the one that was already there
    expect((await inside(() => database.client.adProductGoal.findUniqueOrThrow({ where: { id: g.id } }))).materializedAt).toBeNull()
  })
})

/**
 * R8 (MCP full control, part 06) — POST /advertising/automation-rules/preview answers byte for byte as before its slug
 * dispatch moved into ads-rule-preview.service.ts (previewAdsRuleDraft), which Claude's preview-automation now shares.
 *
 * One draft per branch (placement, bid, share of voice, keyword tracker, budget, an engine-native draft, nothing) on a
 * real PostgreSQL (PGlite) with a campaign to reach. The snapshot beside this file was WRITTEN BY THE ROUTE BEFORE THE
 * MOVE and is read unchanged after it; only generated ids, timestamps and timings are normalised.
 *
 * One deliberate change since (ads wave 4c, F3): the share-of-voice branch lists its markets from the connections,
 * alphabetically (DE, ES, FR, IT), where a fixed list said IT, DE, ES, FR. Same four markets, same answers.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const ids = new Map<string, string>()
const normalise = (text: string) => text
  .replace(/\bc[a-z0-9]{24}\b/g, (id) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size + 1}>`), ids.get(id)!)))
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
  .replace(/\d{4}-\d{2}-\d{2}/g, '<day>')
  .replace(/"durationMs":\d+/g, '"durationMs":"<ms>"')

let app: FastifyInstance
beforeAll(async () => {
  database = await formulaDatabase()
  const { default: intel } = await import('./advertising-intel.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(intel, { prefix: '/api' })
  await app.ready()
  await withWorkspace(business, () => database.client.campaign.create({
    data: { name: 'PARITY CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1' },
  }))
  // Ads wave 4c (F3) — the share-of-voice branch reads the markets from the connections now, not a fixed four. Today's
  // four live accounts (ids made up), so the branch answers for the same four markets it always listed.
  for (const marketplace of ['IT', 'DE', 'ES', 'FR']) {
    await withWorkspace(business, () => database.client.amazonAdsConnection.create({
      data: { profileId: `TEST-PROFILE-${marketplace}`, marketplace, mode: 'production', isActive: true, writesEnabledAt: new Date('2026-01-01T00:00:00Z') },
    }))
  }
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('R8 — the draft preview route answers as before the move', () => {
  it('every branch of the dispatch', async () => {
    const drafts: unknown[] = [
      {},
      { actions: [{ type: 'budget', campaigns: [], op: 'incPct', value: 10 }], conditions: [{ conditions: [{ metric: 'ACOS', op: '>=', value: 40 }] }] },
      { actions: [{ type: 'placement', campaigns: [] }], conditions: [] },
      { actions: [{ type: 'bid', op: 'decPct', value: 10 }], conditions: [] },
      { actions: [{ type: 'sov' }], conditions: [] },
      { actions: [{ type: 'keyword-tracker' }], conditions: [] },
      { actions: [{ type: 'bid_down', percent: 10 }], conditions: [] },
    ]
    const answers: string[] = []
    for (const payload of drafts) {
      const res = await app.inject({ method: 'POST', url: '/api/advertising/automation-rules/preview', payload: payload as object })
      answers.push(`${res.statusCode} ${normalise(res.body)}`)
    }
    expect(answers.join('\n')).toMatchSnapshot()
  })
})

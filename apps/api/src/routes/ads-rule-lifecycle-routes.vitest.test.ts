/**
 * 4l (review 2.8, 2.11) — an approval re-checks the rule that proposed it; a scope change is audited.
 *
 * Before: POST /advertising/suggestions/:id/apply applied the stored action whatever had become of its rule — deleted,
 * switched Off, or edited so it no longer proposes that change — and PATCH /advertising/autonomy/rules/:id/scope
 * changed a rule's scope with no audit row. Pinned here, through the routes on a real PostgreSQL (PGlite): a stale
 * suggestion is refused with a sentence and stays pending; one the edited rule proposed again since applies, and still
 * reaches its handler as a person's approval (4e `operatorApproved`); a scope change writes who and before → after,
 * and that row is what makes an older proposal of the re-scoped rule stale.
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
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const applied: Array<{ ruleId: string; operatorApproved: boolean }> = []

let app: FastifyInstance
let campaignId = ''
const ask = async (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: { 'x-actor-id': 'lifecycle-person' } })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}
const rule = (name: string, extra: Record<string, unknown> = {}) => inside(() => database.client.automationRule.create({
  data: { domain: 'advertising', name, trigger: 'SCHEDULE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', conditions: [], actions: [{ type: 'lc_ok', value: 3 }], ...extra } as never,
}))
const suggestion = (ruleId: string, lastSeenAt = new Date(Date.now() - 60_000)) => inside(() => database.client.adsRuleSuggestion.create({
  data: { ruleId, ruleName: 'TEST lifecycle rule', trigger: 'SCHEDULE', marketplace: 'IT', entityType: 'CAMPAIGN', entityId: campaignId, proposedAction: { type: 'lc_ok', value: 3 }, proposedKey: 'lc_ok:3', lastSeenAt },
}))
const statusOf = (id: string) => inside(async () => (await database.client.adsRuleSuggestion.findUnique({ where: { id } }))?.status)
const apply = (id: string) => ask('POST', `/api/advertising/suggestions/${id}/apply`, {})

beforeAll(async () => {
  database = await formulaDatabase()
  const { ACTION_HANDLERS } = await import('../services/automation-rule.service.js')
  // A handler only this file uses: applying exercises the decide path and nothing of Amazon's.
  ACTION_HANDLERS.lc_ok = (async (action: { type: string }, _ctx: unknown, meta: { ruleId: string; operatorApproved?: boolean }) => {
    applied.push({ ruleId: meta.ruleId, operatorApproved: meta.operatorApproved === true })
    return { type: action.type, ok: true, output: { applied: 'lifecycle' } }
  }) as never
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  campaignId = (await inside(() => database.client.campaign.create({
    data: { name: 'TEST LIFECYCLE CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-LC-1' },
  }))).id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('4l (review 2.8) — approving re-checks the rule', () => {
  it('a suggestion of a rule that still proposes it applies, as a person’s approval (control)', async () => {
    const r = await rule('TEST lifecycle rule')
    const s = await suggestion(r.id)
    expect(await apply(s.id)).toMatchObject({ status: 200, body: { ok: true } })
    expect(applied.at(-1)).toEqual({ ruleId: r.id, operatorApproved: true })
    expect(await statusOf(s.id)).toBe('applied')
  })

  it('🔴 a rule switched Off: refused with a sentence, nothing applied, the row stays pending', async () => {
    const r = await rule('TEST rule switched off')
    const s = await suggestion(r.id)
    expect((await ask('PATCH', `/api/advertising/autonomy/rules/${r.id}`, { level: 'OFF' })).status).toBe(200)
    const before = applied.length
    expect(await apply(s.id)).toEqual({
      status: 200,
      body: { ok: false, refused: true, error: 'This change can no longer be applied: TEST rule switched off is Off, and a rule that is Off changes nothing. Switch it back on; if the change still holds, it will propose it again.' },
    })
    expect(applied.length).toBe(before)
    expect(await statusOf(s.id)).toBe('pending')
  })

  it('🔴 a deleted rule: refused', async () => {
    const r = await rule('TEST rule deleted')
    const s = await suggestion(r.id)
    expect((await ask('DELETE', `/api/advertising/automation-rules/${r.id}`)).status).toBe(200)
    expect((await apply(s.id)).body).toEqual({ ok: false, refused: true, error: 'This change can no longer be applied: the rule that proposed it (TEST lifecycle rule) was deleted. Dismiss it.' })
    expect(await statusOf(s.id)).toBe('pending')
  })

  it('🔴 a rule edited after it proposed this: refused until it proposes it again, then it applies', async () => {
    const r = await rule('TEST rule edited')
    const s = await suggestion(r.id)
    expect((await ask('PATCH', `/api/advertising/automation-rules/${r.id}`, { actions: [{ type: 'lc_ok', value: 9 }] })).status).toBe(200)
    expect((await apply(s.id)).body).toEqual({
      ok: false, refused: true,
      error: 'This change cannot be applied now: TEST rule edited was edited (actions) after it proposed this, and it has not proposed it again since. If the edited rule still wants this change, it will propose it on its next run.',
    })
    // The edited rule's next run proposes the same change again (the evaluator stamps lastSeenAt).
    await inside(() => database.client.adsRuleSuggestion.update({ where: { id: s.id }, data: { lastSeenAt: new Date(Date.now() + 1_000) } }))
    expect((await apply(s.id)).body).toMatchObject({ ok: true })
  })

  it('an edit that does not change what the rule proposes (a rename, a cap) leaves its proposals approvable (control)', async () => {
    const r = await rule('TEST rule renamed')
    const s = await suggestion(r.id)
    expect((await ask('PATCH', `/api/advertising/automation-rules/${r.id}`, { name: 'TEST rule renamed again', maxExecutionsPerDay: 4 })).status).toBe(200)
    expect((await apply(s.id)).body).toMatchObject({ ok: true })
  })
})

describe('4l (review 2.11) — a scope change is audited', () => {
  it('🔴 writes who and each changed scope field before → after; an older proposal of the re-scoped rule is then stale', async () => {
    const r = await rule('TEST rule re-scoped')
    const s = await suggestion(r.id)
    expect(await ask('PATCH', `/api/advertising/autonomy/rules/${r.id}/scope`, { scopeMarketplace: 'IT' })).toMatchObject({ status: 200, body: { ok: true, scopeMarketplace: 'IT' } })
    const rows = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityType: 'RULE', entityId: r.id } }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: 'user:lifecycle-person', actionType: 'update_rule',
      payloadBefore: { scopeMarketplace: null }, payloadAfter: { scopeMarketplace: 'IT' },
      evidence: { metric: 'operator_rule_edit', note: 'TEST rule re-scoped: scope scopeMarketplace any → IT' },
    })
    expect((await apply(s.id)).body).toMatchObject({ ok: false, refused: true, error: expect.stringContaining('was edited (scope)') })
  })

  it('a scope request that changes nothing writes no row (control)', async () => {
    const r = await rule('TEST rule same scope', { scopeMarketplace: 'IT' })
    expect((await ask('PATCH', `/api/advertising/autonomy/rules/${r.id}/scope`, { scopeMarketplace: 'IT' })).status).toBe(200)
    expect(await inside(() => database.client.advertisingActionLog.count({ where: { entityType: 'RULE', entityId: r.id } }))).toBe(0)
  })
})

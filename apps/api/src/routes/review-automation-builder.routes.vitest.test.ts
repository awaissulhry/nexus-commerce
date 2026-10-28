/**
 * Reviews › Settings › Automations › Edit — the rules builder's read and save of a review automation, through the real
 * route plugin and real SQL (PGlite with the production schema and policies); nothing leaves this machine.
 *
 *   read     the template as the builder shows it, with the themes, the markets reviews are counted in and the whole
 *            products to pick (a size names its parent); 404 for an ads rule
 *   save     trigger settings and action round-trip: what was saved reads back, the stored conditions match the spike
 *            check's alerts as they say (the evaluator's own contexts), on / off and trial run are never touched, the
 *            list says what it does now, and an audit row names the person; refusals in words; a save of nothing
 *            writes nothing; a rule changed since it was read is refused; a save needs a signed-in person
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { evaluateConditions, type ConditionsPayload } from '../services/automation/conditions-tree.js'

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
    redis: { connection: null },
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const APLUS = 'Create A+ module from review spike'

describe('the rules builder edits a review automation', () => {
  let app: FastifyInstance
  let signedIn = true
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api${url}`, ...(payload !== undefined ? { payload: payload as object } : {}) })
    return { status: response.statusCode, body: JSON.parse(response.body || '{}') }
  }
  let ruleId = ''

  beforeAll(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-jacket', sku: 'TEST-JKT', name: 'Test jacket', basePrice: 10, isParent: true } as never })
      await c.product.create({ data: { id: 'test-jacket-m', sku: 'TEST-JKT-M', name: 'Test jacket M', basePrice: 10, parentId: 'test-jacket' } as never })
      await c.product.create({ data: { id: 'test-helmet', sku: 'TEST-HLM', name: 'Test helmet', basePrice: 10 } as never })
      const day = new Date('2026-10-20T00:00:00Z')
      await c.reviewCategoryRate.create({ data: { productId: 'test-jacket-m', marketplace: 'DE', category: 'FIT_SIZING', date: day, total: 4, negative: 3 } as never })
      await c.reviewCategoryRate.create({ data: { productId: 'test-helmet', marketplace: 'IT', category: 'COMFORT', date: day, total: 2, negative: 1 } as never })
      const spike = (id: string, productId: string, marketplace: string, category: string, spikeMultiplier: number) => c.reviewSpike.create({
        data: { id, productId, marketplace, category, spikeMultiplier, rate7dNumerator: 3, rate7dDenominator: 4, rate28dNumerator: 3, rate28dDenominator: 12, status: 'OPEN' } as never,
      })
      await spike('spike-fit', 'test-jacket-m', 'DE', 'FIT_SIZING', 3.5)
      await spike('spike-slow', 'test-jacket-m', 'DE', 'FIT_SIZING', 2.2)
      await spike('spike-helmet', 'test-helmet', 'IT', 'COMFORT', 4)
      await c.automationRule.create({ data: { id: 'ads-rule', name: 'Bid rule', domain: 'advertising', trigger: 'SCHEDULE' } })
    })
    const { default: reviewsRoutes } = await import('./reviews.routes.js')
    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      if (signedIn) (request as unknown as { authUser: unknown }).authUser = { id: 'test-user', email: 'person@example.test' }
      withWorkspace(business, done)
    })
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
    expect((await call('POST', '/reviews/automation-rules/seed-templates')).status).toBe(200)
    const list = await call('GET', '/reviews/automation-rules')
    ruleId = list.body.items.find((r: { name: string }) => r.name === APLUS).id
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await database?.close()
  })

  it('the list: an unchanged template carries no words of its own (the page words it)', async () => {
    const list = await call('GET', '/reviews/automation-rules')
    expect(list.status).toBe(200)
    expect(list.body.items).toHaveLength(3)
    for (const item of list.body.items) expect(item.words).toBeNull()
  })

  it('reads the template as the builder shows it, with what to pick', async () => {
    const read = await call('GET', `/reviews/automation-rules/${ruleId}`)
    expect(read.status).toBe(200)
    expect(read.body.view).toEqual({ name: APLUS, themes: [], minMultiplier: 2.5, families: [], market: null, does: 'aplus', tellTeam: true, message: 'A+ module draft generated from review spike — review execution log', maxPerDay: 10 })
    expect(read.body).toMatchObject({ kept: [], whenHeld: null, thenHeld: null, rule: { id: ruleId, enabled: false, dryRun: true } })
    expect(read.body.spikeCheck).toMatchObject({ multiplier: 2, recentDays: 7, baselineDays: 28 })
    expect(read.body.options.themes[0]).toEqual({ value: 'FIT_SIZING', label: 'Fit & sizing' })
    expect(read.body.options.markets).toEqual([{ value: 'DE', label: 'Germany' }, { value: 'IT', label: 'Italy' }])
    // A size's reviews name its whole product; the size itself is not offered.
    expect(read.body.options.products).toEqual([
      { value: 'test-helmet', label: 'Test helmet', sku: 'TEST-HLM' },
      { value: 'test-jacket', label: 'Test jacket', sku: 'TEST-JKT' },
    ])
    expect((await call('GET', '/reviews/automation-rules/ads-rule')).status).toBe(404)
  })

  it('saves the trigger settings and the action; they read back, match as they say, and leave on / off and trial run alone', async () => {
    const before = await call('GET', `/reviews/automation-rules/${ruleId}`)
    const save = await call('PUT', `/reviews/automation-rules/${ruleId}`, {
      ...before.body.view, themes: ['FIT_SIZING'], minMultiplier: 3, families: ['test-jacket'], market: 'DE',
      does: 'bullets', tellTeam: true, message: 'Sizes run small: new bullets drafted', maxPerDay: 5, updatedAt: before.body.rule.updatedAt,
    })
    expect(save.status).toBe(200)
    expect(save.body).toMatchObject({ ok: true, changed: ['themes', 'how fast', 'products', 'market', 'action', 'what the team is told', 'runs a day'], rule: { enabled: false, dryRun: true } })
    expect(save.body.words).toMatch(/^When complaints about fit & sizing rise 3 times faster than usual or more for the product picked in Germany, the AI drafts five new bullet points/)

    const after = await call('GET', `/reviews/automation-rules/${ruleId}`)
    expect(after.body.view).toEqual({ name: APLUS, themes: ['FIT_SIZING'], minMultiplier: 3, families: ['test-jacket'], market: 'DE', does: 'bullets', tellTeam: true, message: 'Sizes run small: new bullets drafted', maxPerDay: 5 })

    const row = await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(row).toMatchObject({ enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'DE', maxExecutionsPerDay: 5, trigger: 'REVIEW_SPIKE_DETECTED' })
    expect(row.description).toBe(save.body.words)
    expect(row.actions).toEqual([
      { type: 'update_product_bullets_from_review', reason: 'Review spike — regenerate bullets to address customer concern' },
      { type: 'notify', target: 'operator', message: 'Sizes run small: new bullets drafted' },
    ])

    // The evaluator's own contexts: the fast fit spike on a size of the jacket in Germany matches; the slow one and the
    // helmet (another product, another market) do not.
    const { buildReviewSpikeContexts } = await import('../jobs/review-rule-evaluator.job.js')
    const contexts = await inside(() => buildReviewSpikeContexts())
    const fit = contexts.find((x) => x.spike.id === 'spike-fit')!
    expect(fit.product).toMatchObject({ id: 'test-jacket-m', familyId: 'test-jacket' })
    const matched = contexts.filter((x) => (row.scopeMarketplace == null || row.scopeMarketplace === x.marketplace) && evaluateConditions(row.conditions as ConditionsPayload, x))
    expect(matched.map((x) => x.spike.id)).toEqual(['spike-fit'])

    const list = await call('GET', '/reviews/automation-rules')
    expect(list.body.items.find((r: { id: string }) => r.id === ruleId).words).toBe(save.body.words)
    const audit = await inside(() => database.client.auditLog.findFirst({ where: { entityType: 'AutomationRule', entityId: ruleId } }))
    expect(audit).toMatchObject({ userId: 'test-user', action: 'update', metadata: { domain: 'reviews', via: 'rules builder' } })
  })

  it('a save of nothing writes nothing; a rule changed since it was read is refused; refusals in words', async () => {
    const read = await call('GET', `/reviews/automation-rules/${ruleId}`)
    const same = await call('PUT', `/reviews/automation-rules/${ruleId}`, { ...read.body.view, updatedAt: read.body.rule.updatedAt })
    expect(same.body).toMatchObject({ ok: true, changed: [] })
    expect((await call('GET', `/reviews/automation-rules/${ruleId}`)).body.rule.updatedAt).toBe(read.body.rule.updatedAt)

    const stale = await call('PUT', `/reviews/automation-rules/${ruleId}`, { ...read.body.view, name: 'Renamed', updatedAt: '2020-01-01T00:00:00.000Z' })
    expect(stale).toMatchObject({ status: 409, body: { error: 'conflict', message: 'This automation changed while you were editing it. Reload, then make your change again.' } })

    const bad = await call('PUT', `/reviews/automation-rules/${ruleId}`, { ...read.body.view, families: ['test-jacket-m'] })
    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid', message: 'A picked product is not in Nexus as a whole product. Pick the products from the list.' } })
    const market = await call('PUT', `/reviews/automation-rules/${ruleId}`, { ...read.body.view, market: 'FR' })
    expect(market).toMatchObject({ status: 400, body: { message: 'Pick the market from the list.' } })
    expect((await call('PUT', '/reviews/automation-rules/ads-rule', read.body.view)).status).toBe(404)
  })

  it('a save needs a signed-in person', async () => {
    const read = await call('GET', `/reviews/automation-rules/${ruleId}`)
    signedIn = false
    try {
      expect((await call('PUT', `/reviews/automation-rules/${ruleId}`, { ...read.body.view, name: 'Nobody' })).status).toBe(403)
    } finally {
      signedIn = true
    }
  })
})

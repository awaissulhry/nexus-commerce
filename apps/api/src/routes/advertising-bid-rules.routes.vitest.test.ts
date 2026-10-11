/**
 * Bid page — the bid-rules routes on a real PostgreSQL (PGlite), business profiles ON:
 *
 *   list      the brain first, then the bid rules of the market asked (other markets counted, never listed; budget rules
 *             never); each with its honest mode (the dial, the allowlist, the graduation gate) whose holds carry a chip label
 *             and a reason naming the campaigns, scope with true totals, 7-day changes and numbers, its runs (next, first,
 *             then, the schedule in words) and the effect; totals
 *   history   a rule's changes with keyword, ad group, campaign, portfolio, from → to, who and the undo handle
 *   preview   an unsaved builder rule: what it would change now, held by the brain or the gate; nothing written
 *   archive   inert and out of the list's live rows, runs and changes kept; idempotent; reversible at Off
 *   business  another business's rule reads as not found on every route
 *   money     a person without ad-spend money gets the answers minus exactly the money keys
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'bid_rules_routes_alpha'
const B = 'bid_rules_routes_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const dayAgo = (days: number) => { const d = ago(days); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) }

let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
const ids: Record<string, string> = {}
const inA = <T>(fn: () => Promise<T>) => withWorkspace(business(A), fn)
const db = () => database.client as any

/** A builder Bid rule's body: Clicks ≥ 1 → set the bid to €0.60 on the picked campaigns. */
const builderBody = (campaigns: string[], extra: Record<string, unknown> = {}) => ({
  actions: [{ type: 'bid', windowDays: 14, control: 'manual', campaigns: campaigns.map((id) => ({ id })), ...extra }],
  conditions: [{ conditions: [{ metric: 'Clicks', op: 'gte', value: '1' }], action: { op: 'set', value: '0.60' } }],
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await inA(async () => {
    const c = db()
    await seedAdsFixture(c)
    await c.campaign.update({ where: { id: 'c-it' }, data: { portfolioId: 'pf-jackets' } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'pf-jackets', name: 'Jackets IT' } })

    // R1 — a builder Bid rule on Ask (PROPOSE), IT, picked c-it and c-off; old enough and run enough for the gate.
    const r1 = await c.automationRule.create({
      data: {
        name: 'Bids to a test bid', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE',
        scopeMarketplace: 'IT', evaluationCount: 40, matchCount: 3, createdAt: ago(30), lastEvaluatedAt: ago(0.1), ...builderBody(['c-it', 'c-off']),
      },
    })
    ids.r1 = r1.id
    // R2 — an engine rule on Auto, bound to the campaign that is not on the allowlist.
    const r2 = await c.automationRule.create({
      data: {
        name: 'Cut wasted spend', domain: 'advertising', trigger: 'KEYWORD_WASTED_SPEND', enabled: true, dryRun: false, autonomyLevel: 'AUTO',
        scopeMarketplace: 'IT', scopeCampaignId: 'c-off', conditions: [], actions: [{ type: 'bid_down', percent: 20 }], createdAt: ago(40), evaluationCount: 50, matchCount: 5,
      },
    })
    ids.r2 = r2.id
    // R3 — new, Off; R4 — a UK bid rule; R5 — a budget rule (never on the Bid page).
    ids.r3 = (await c.automationRule.create({ data: { name: 'New rule', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: false, dryRun: true, autonomyLevel: 'OFF', scopeMarketplace: 'IT', ...builderBody(['c-it']) } })).id
    ids.r4 = (await c.automationRule.create({ data: { name: 'UK bids', domain: 'advertising', trigger: 'KEYWORD_HIGH_ACOS', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'UK', conditions: [], actions: [{ type: 'bid_down', percent: 10 }] } })).id
    ids.r5 = (await c.automationRule.create({ data: { name: 'Budget rule', domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', conditions: [], actions: [{ type: 'adjust_ad_budget' }] } })).id

    // What R1 did: a bid change 20 days ago (the effect's anchor) and one 2 hours ago (undoable), each a history row with
    // its operation row; one write the gate refused 3 days ago.
    const actor = `automation:${ids.r1}`
    const change = async (target: string, campaignId: string, from: number, to: number, at: Date, status = 'SUCCESS') => {
      await c.campaignBidHistory.create({ data: { entityType: 'AD_TARGET', entityId: target, campaignId, field: 'bid', oldValue: String(from), newValue: String(to), changedAt: at, changedBy: actor } })
      return (await c.advertisingActionLog.create({ data: { userId: actor, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: target, payloadBefore: { bidCents: from }, payloadAfter: { bidCents: to }, amazonResponseStatus: status, createdAt: at } })).id
    }
    await change('t-it', 'c-it', 40, 45, ago(20))
    ids.undo = await change('t-it', 'c-it', 45, 60, new Date(Date.now() - 2 * 3_600_000))
    await c.advertisingActionLog.create({ data: { userId: actor, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-off', payloadBefore: { bidCents: 30 }, payloadAfter: { bidCents: 60, error: 'not on the allowlist' }, amazonResponseStatus: 'SKIPPED', createdAt: ago(3) } })

    // Its runs: two ticks in 7 days, one of which asked the bid brain; one ask waiting, one applied by a person.
    await c.automationRuleExecution.create({ data: { ruleId: ids.r1, triggerData: {}, actionResults: [{ type: 'bid_apply', ok: true, output: { wouldChange: '45¢ → 60¢' } }], dryRun: true, status: 'DRY_RUN', startedAt: ago(2) } })
    await c.automationRuleExecution.create({ data: { ruleId: ids.r1, triggerData: {}, actionResults: [{ type: 'bid_apply', ok: true, output: { dryRun: true, bidBrain: { directives: 1, sample: [] } } }], dryRun: true, status: 'DRY_RUN', startedAt: ago(1) } })
    await c.adsRuleSuggestion.create({ data: { ruleId: ids.r1, entityType: 'AD_TARGET', entityId: 't-low', proposedAction: { type: 'bid_apply' }, proposedKey: 'bid_apply:set:60', status: 'pending' } })
    await c.adsRuleSuggestion.create({ data: { ruleId: ids.r1, entityType: 'AD_TARGET', entityId: 't-it', proposedAction: { type: 'bid_apply' }, proposedKey: 'bid_apply:set:60', status: 'applied', decidedAt: new Date(Date.now() - 2 * 3_600_000 - 60_000), decidedBy: 'user:owner-1' } })

    // Performance of t-it: one day before the anchor, one after; and the clicks the preview's 14-day window reads.
    const perf = (date: Date, clicks: number, spendCents: number, salesCents: number, orders: number) => c.amazonAdsDailyPerformance.create({
      data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'AD_TARGET', entityId: 'EXT-t-it', localEntityId: 't-it', clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders, reportedAt: new Date() },
    })
    await perf(dayAgo(25), 10, 400, 1000, 1)
    await perf(dayAgo(15), 10, 200, 1000, 1)
    await c.amazonAdsDailyPerformance.create({
      data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(12), entityType: 'AD_TARGET', entityId: 'EXT-t-off', localEntityId: 't-off', clicks: 4, costMicros: 1_000_000n, currencyCode: 'EUR', sales7dCents: 0, orders7d: 0, reportedAt: new Date() },
    })

    // The bid brain decided in shadow for c-it this week.
    await c.bidBrainDecision.create({
      data: {
        runId: 'bid-rules-run', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: 'c-it', adGroupId: 'g-c-it', targetId: 't-it',
        action: 'write', layer: 'goal', currentCents: 45, decidedCents: 50, goalBidCents: 50, aim: '0.2000', bandLo: '0.1500', bandHi: '0.2500',
        expectedAcos: '0.1800', confidence: '0.5000', dataDay: dayAgo(8), why: 'goal: made up',
      },
    })
  })
  await withWorkspace(business(B), async () => {
    ids.other = (await db().automationRule.create({ data: { name: 'Other business rule', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', ...builderBody(['c-x']) } })).id
  })
  const { default: routes } = await import('./advertising-bid-rules.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    withWorkspace(business(A), done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, headers: { 'x-actor-id': 'owner-1' } })
const row = (body: { rules: Array<{ id: string }> }, id: string) => body.rules.find((r) => r.id === id) as any
/** A hold without its reason (the reasons are checked where they say which campaigns). */
const chip = (h: { kind: string; label: string } | null) => (h ? { kind: h.kind, label: h.label } : null)
const chips = (m: any) => ({ ...m, heldBy: chip(m.heldBy), also: m.also.map(chip), autoLocked: chip(m.autoLocked) })
const LOCKED_WHY = 'Not on the live-change list, bids held by hand, or the account takes no changes'

describe('GET /api/advertising/bid-rules', () => {
  it('the brain first, then the bid rules of the market; other markets counted, budget rules never listed', async () => {
    const res = await get('/api/advertising/bid-rules?market=IT')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(body.market).toBe('IT')
    expect(body.rules[0]).toMatchObject({ id: 'brain', kind: 'brain', name: 'Brain' })
    const listed = body.rules.map((r: { id: string }) => r.id)
    expect(listed).toEqual(expect.arrayContaining([ids.r1, ids.r2, ids.r3]))
    expect(listed).not.toContain(ids.r4)
    expect(listed).not.toContain(ids.r5)
    expect(listed).not.toContain(ids.other)
    expect(body.totals).toMatchObject({ rules: 3, on: 2, otherMarkets: 1, archived: 0, waiting: 1 })
    // Every market: the UK rule is listed too — held: Amazon's bid limits are not checked for UK, so the gate refuses.
    const every = (await get('/api/advertising/bid-rules')).json()
    expect(every.rules.map((r: { id: string }) => r.id)).toContain(ids.r4)
    expect(row(every, ids.r4).mode).toEqual({
      set: 'ASK', acts: 'ASK', also: [], autoLocked: expect.anything(),
      heldBy: { kind: 'gate', label: 'Market not set up', reason: 'Nexus does not know Amazon\'s bid limits in this market yet, so it changes nothing there: UK exact.' },
    })
  })

  it('a rule on Ask: its sentence, scope, 7-day changes and numbers, and its effect', async () => {
    const r1 = row((await get('/api/advertising/bid-rules?market=IT')).json(), ids.r1)
    expect(r1.sentence).toBe('If clicks ≥ 1 over 14 d → bid €0.60')
    expect(r1.market).toBe('IT')
    // Ask as set; the Manual belt keeps it there; c-off is locked; Auto is allowed (the gate is open).
    expect(r1.mode).toEqual({ set: 'ASK', acts: 'ASK', heldBy: null, also: [{ kind: 'allowlist', label: '1 campaign locked', reason: `${LOCKED_WHY}: Italy not allowlisted.` }], autoLocked: null })
    expect(r1.scope).toMatchObject({ all: false, product: null, counts: { campaigns: 2, portfolios: 1, adGroups: 0 } })
    expect(r1.scope.campaigns.map((c: { id: string }) => c.id).sort()).toEqual(['c-it', 'c-off'])
    expect(r1.scope.portfolios).toEqual([{ id: 'pf-jackets', name: 'Jackets IT', href: '/marketing/ads/portfolios/pf-jackets' }])
    expect(r1.changed7d).toEqual({
      portfolios: [{ id: 'pf-jackets', name: 'Jackets IT', href: '/marketing/ads/portfolios/pf-jackets' }],
      campaigns: [{ id: 'c-it', name: 'Italy exact', href: '/marketing/ads/campaigns/c-it' }],
      adGroups: [{ id: 'g-c-it', name: 'group c-it', href: '/marketing/ads/campaigns/c-it/ad-groups/g-c-it' }],
      bids: 1, keywords: 1, counts: { portfolios: 1, campaigns: 1, adGroups: 1 },
    })
    expect(r1.last7d).toEqual({ runs: 2, asks: 2, applied: 1, written: 1, brainInputs: 1, refused: 1 })
    expect(r1.waiting).toBe(1)
    // It has run (no first run to say) and stores no schedule: the engine's 15-minute tick.
    expect(r1).toMatchObject({ nextRunAt: expect.any(String), firstRunAt: null, thenRunAt: null, schedule: 'Every 15 min' })
    expect(r1.effect).toMatchObject({
      keywords: 1, tooEarly: 0, currency: 'EUR',
      before: { clicks: 10, orders: 1, spendCents: 400, salesCents: 1000, acosPct: 40 },
      after: { clicks: 10, orders: 1, spendCents: 200, salesCents: 1000, acosPct: 20 },
      window: { lookbackDays: 30, maxDays: 14, minDays: 3 },
    })
  })

  it('honest mode: Auto held by the account dial (Ask me), then by the allowlist once the dial is Auto; a new rule cannot go Auto yet', async () => {
    let body = (await get('/api/advertising/bid-rules?market=IT')).json()
    expect(chips(row(body, ids.r2).mode)).toEqual({ set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'Account: Ask me' }, also: [{ kind: 'allowlist', label: 'Campaigns locked' }], autoLocked: null })
    expect(row(body, ids.r2).mode.heldBy.reason).toBe('The account\'s ads mode is Ask me, so every change waits for you.')
    expect(row(body, ids.r2).sentence).toBe('If spend, no sales → bid −20 %')
    // R15 — an Off rule has no Auto lock: no "Turn on first" chip (the mode list offers Auto only to a rule that runs).
    expect(row(body, ids.r3).mode).toMatchObject({ set: 'OFF', acts: 'OFF', heldBy: null, autoLocked: null })
    expect(row(body, ids.r3)).toMatchObject({ nextRunAt: null, firstRunAt: null, thenRunAt: null })
    await inA(() => db().adsAutomationState.update({ where: { id: 'singleton' }, data: { autonomy: 'AUTO' } }))
    try {
      body = (await get('/api/advertising/bid-rules?market=IT')).json()
      expect(row(body, ids.r2).mode).toMatchObject({ set: 'AUTO', acts: 'WATCH', heldBy: { kind: 'allowlist', label: 'Campaigns locked' } })
      expect(body.totals).toMatchObject({ auto: 0, held: 1 })
    } finally {
      await inA(() => db().adsAutomationState.update({ where: { id: 'singleton' }, data: { autonomy: 'SUGGEST' } }))
    }
  })

  it('a whole-market rule never run: the true total of its campaigns (the lists stop at 100), its first run, then its schedule', async () => {
    const extra = Array.from({ length: 101 }, (_, i) => ({
      id: `c-many-${i}`, name: `Many ${String(i).padStart(3, '0')}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-c-many-${i}`,
      dailyBudget: '5.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
    }))
    const schedule = { frequency: 'Daily', everyN: '', interval: 'Weeks', onDay: 'Monday', time: '06:00', timezone: 'cet' }
    const rule = await inA(async () => {
      await db().campaign.createMany({ data: extra })
      return db().automationRule.create({ data: { name: 'Whole market probe', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: true, autonomyLevel: 'OBSERVE', scopeMarketplace: 'IT', ...builderBody([], { schedule }) } })
    })
    try {
      const inMarket = await inA(() => db().campaign.count({ where: { marketplace: 'IT', status: { not: 'ARCHIVED' } } }))
      expect(inMarket).toBeGreaterThan(100)
      const probe = row((await get('/api/advertising/bid-rules?market=IT')).json(), rule.id)
      expect(probe.scope.all).toBe(true)
      expect(probe.scope.campaigns).toHaveLength(100)
      expect(probe.scope.counts.campaigns).toBe(inMarket)
      // Never run: its first run is the next tick, said apart from its schedule, and the run after it follows the schedule.
      // Its builder control is Manual: on Watch it asks (the rule's own belt).
      expect(probe.mode).toMatchObject({ set: 'WATCH', acts: 'ASK', heldBy: { kind: 'manual', label: 'Rule asks first' } })
      expect(probe.schedule).toBe('Daily · 06:00 · Rome')
      expect(probe.firstRunAt).toBe(probe.nextRunAt)
      expect(new Date(probe.nextRunAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000)
      expect(new Date(probe.thenRunAt).getTime()).toBeGreaterThan(new Date(probe.firstRunAt).getTime() + 11 * 3_600_000)
    } finally {
      await inA(async () => {
        await db().automationRule.delete({ where: { id: rule.id } })
        await db().campaign.deleteMany({ where: { id: { startsWith: 'c-many-' } } })
      })
    }
  })

  it('the brain row: shadow, what it decided for, its run', async () => {
    const brain = row((await get('/api/advertising/bid-rules?market=IT')).json(), 'brain')
    expect(brain.mode).toMatchObject({ set: 'WATCH' })
    expect(brain).toMatchObject({ sentence: 'Bids to the ACoS goal', schedule: 'Every 6 h', nextRunAt: expect.any(String), firstRunAt: null, thenRunAt: null })
    expect(brain.scope.campaigns.map((c: { id: string }) => c.id)).toEqual(['c-it'])
    expect(brain.last7d).toMatchObject({ runs: 1, asks: 0 })
    expect(brain.archived).toBe(false)
  })
})

describe('GET /api/advertising/bid-rules/:id/history', () => {
  it('each change with its keyword, ad group, campaign, portfolio, from → to, who and the undo handle', async () => {
    const res = await get(`/api/advertising/bid-rules/${ids.r1}/history?days=7`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ id: ids.r1, name: 'Bids to a test bid', days: 7 })
    const change = body.changes.find((c: { target: { id: string } | null }) => c.target?.id === 't-it')
    expect(change).toMatchObject({
      target: { id: 't-it', name: 'race jacket', href: '/marketing/ads/campaigns/c-it/ad-groups/g-c-it' },
      adGroup: { id: 'g-c-it', name: 'group c-it' },
      campaign: { id: 'c-it', name: 'Italy exact' },
      portfolio: { id: 'pf-jackets', name: 'Jackets IT' },
      field: 'bid', fromCents: 45, toCents: 60,
      // R10 — the person is "You", as on the bids side.
      who: { kind: 'person', id: 'owner-1', name: 'You' },
      changeId: ids.undo, undoBlocked: null,
    })
    // The 20-day-old change is outside 7 days; 30 days reads it.
    expect(body.changes.filter((c: { target: { id: string } | null }) => c.target?.id === 't-it')).toHaveLength(1)
    const month = (await get(`/api/advertising/bid-rules/${ids.r1}/history?days=30`)).json()
    expect(month.changes.filter((c: { target: { id: string } | null }) => c.target?.id === 't-it')).toHaveLength(2)
    expect(month.changes.find((c: { fromCents?: number }) => c.fromCents === 40)).toMatchObject({ who: { kind: 'rule', id: ids.r1 }, changeId: null })
  })

  it('its own changes, however many changes other writers made since', async () => {
    const since = Date.now() - 3_600_000
    await inA(() => db().campaignBidHistory.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({ entityType: 'AD_TARGET', entityId: 't-it', campaignId: 'c-it', field: 'bid', oldValue: '45', newValue: '46', changedAt: new Date(since + i * 1_000), changedBy: 'automation:another-writer' })),
    }))
    try {
      const body = (await get(`/api/advertising/bid-rules/${ids.r1}/history?days=30`)).json()
      expect(body.changes.filter((c: { target: { id: string } | null }) => c.target?.id === 't-it').map((c: { fromCents: number; toCents: number }) => [c.fromCents, c.toCents])).toEqual([[45, 60], [40, 45]])
    } finally {
      await inA(() => db().campaignBidHistory.deleteMany({ where: { changedBy: 'automation:another-writer' } }))
    }
  })

  it('the brain\'s history answers (empty here); a bad query is a 400', async () => {
    const brain = await get('/api/advertising/bid-rules/brain/history')
    expect(brain.statusCode).toBe(200)
    expect(brain.json()).toMatchObject({ id: 'brain', name: 'Brain', changes: [] })
    expect((await get(`/api/advertising/bid-rules/${ids.r1}/history?days=0`)).statusCode).toBe(400)
    expect((await get(`/api/advertising/bid-rules/${ids.r5}/history`)).statusCode).toBe(404)
  })
})

describe('POST /api/advertising/bid-rules/preview', () => {
  it('an unsaved builder rule: what it would change now, and nothing is written', async () => {
    const before = await inA(async () => ({ rules: await db().automationRule.count(), runs: await db().automationRuleExecution.count(), asks: await db().adsRuleSuggestion.count(), bid: (await db().adTarget.findUnique({ where: { id: 't-it' } })).bidCents }))
    const res = await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      ruleId: null, saved: false, engine: 'draft', wouldChange: 1, brainInputs: 0, locked: 0, windowDays: 14,
      sample: [{ target: { id: 't-it', name: 'race jacket' }, adGroup: { id: 'g-c-it' }, campaign: { id: 'c-it', name: 'Italy exact' }, fromCents: 45, toCents: 60, held: null, heldBy: null }],
      holds: [],
    })
    const after = await inA(async () => ({ rules: await db().automationRule.count(), runs: await db().automationRuleExecution.count(), asks: await db().adsRuleSuggestion.count(), bid: (await db().adTarget.findUnique({ where: { id: 't-it' } })).bidCents }))
    expect(after).toEqual(before)
  })

  it('the body in one line: the same sentence the rules list says, saved or not, edited or not', async () => {
    const list = (await get('/api/advertising/bid-rules?market=IT')).json()
    const unsaved = (await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))).json()
    expect(unsaved.sentence).toBe('If clicks ≥ 1 over 14 d → bid €0.60')
    expect((await post('/api/advertising/bid-rules/preview', { ruleId: ids.r1 })).json().sentence).toBe(row(list, ids.r1).sentence)
    // An edit says the edited body.
    const edited = { ...builderBody(['c-it']), conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '20' }], action: { op: 'targetAcos', value: '20' } }] }
    expect((await post('/api/advertising/bid-rules/preview', { ruleId: ids.r1, ...edited })).json().sentence).toBe('If ACoS > 20 % over 14 d → bid toward 20 %')
    // A saved engine rule: its trigger, as the list says it.
    expect((await post('/api/advertising/bid-rules/preview', { ruleId: ids.r2 })).json().sentence).toBe(row(list, ids.r2).sentence)
  })

  it('a change the gate would refuse is held, not counted; a saved rule edited; an engine rule unsaved is refused', async () => {
    const locked = (await post('/api/advertising/bid-rules/preview', builderBody(['c-off']))).json()
    expect(locked).toMatchObject({ wouldChange: 0, locked: 1, sample: [{ target: { id: 't-off' }, fromCents: 30, toCents: 60, held: 'locked', heldBy: { kind: 'allowlist', label: 'Locked', reason: expect.stringMatching(/^This campaign takes no automatic change/) } }] })
    expect(locked.holds).toEqual([{
      held: 'locked', kind: 'allowlist', label: 'Locked', reason: locked.sample[0].heldBy.reason, count: 1,
      campaigns: [{ id: 'c-off', name: 'Italy not allowlisted', href: '/marketing/ads/campaigns/c-off' }],
    }])
    const saved = (await post('/api/advertising/bid-rules/preview', { ruleId: ids.r1 })).json()
    expect(saved).toMatchObject({ ruleId: ids.r1, saved: true, engine: 'draft', wouldChange: 1, locked: 1 })
    const edited = (await post('/api/advertising/bid-rules/preview', { ruleId: ids.r1, ...builderBody(['c-it']) })).json()
    expect(edited).toMatchObject({ ruleId: ids.r1, saved: false, wouldChange: 1, locked: 0 })
    expect((await post('/api/advertising/bid-rules/preview', { conditions: [], actions: [{ type: 'bid_down', percent: 10 }] })).statusCode).toBe(400)
    expect((await post('/api/advertising/bid-rules/preview', { conditions: [], actions: [{ type: 'adjust_ad_budget' }] })).statusCode).toBe(400)
    expect((await post('/api/advertising/bid-rules/preview', { ruleId: 'brain' })).statusCode).toBe(400)
    expect((await post('/api/advertising/bid-rules/preview', {})).statusCode).toBe(400)
  })

  it('a builder rule with no campaign picked previews its whole market, as the evaluator runs it', async () => {
    const res = await post('/api/advertising/bid-rules/preview', { ...builderBody([]), scopeMarketplace: 'IT' })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ wouldChange: 1, locked: 1, note: null })
    expect(body.sample.map((s: { target: { id: string }; held: string | null }) => [s.target.id, s.held])).toEqual([['t-it', null], ['t-off', 'locked']])
  })

  it('a saved engine rule previews through its Simulate', async () => {
    const res = await post('/api/advertising/bid-rules/preview', { ruleId: ids.r2 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ ruleId: ids.r2, saved: true, engine: 'simulate' })
  })

  /** A saved engine rule on c-it's clicked keyword (TARGET_PERFORMANCE: t-it), previewed through its Simulate, then removed. */
  const simulate = async (actions: object[], trigger = 'TARGET_PERFORMANCE', extra: Record<string, unknown> = {}) => {
    const rule = await inA(() => db().automationRule.create({ data: { name: 'Preview probe', domain: 'advertising', trigger, enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', scopeCampaignId: 'c-it', conditions: [], actions, ...extra } }))
    try {
      const res = await post('/api/advertising/bid-rules/preview', { ruleId: rule.id })
      expect(res.statusCode, res.body).toBe(200)
      return res.json()
    } finally {
      await inA(() => db().automationRule.delete({ where: { id: rule.id } }))
    }
  }

  it('each bid action type, read by its own dry run: bid_down, bid_up, bid_apply, lower_bid_to_floor', async () => {
    expect(await simulate([{ type: 'bid_down', percent: 20 }])).toMatchObject({ engine: 'simulate', wouldChange: 1, sample: [{ target: { id: 't-it' }, field: 'bid', fromCents: 45, toCents: 36, held: null }] })
    expect(await simulate([{ type: 'bid_up', percent: 20 }])).toMatchObject({ wouldChange: 1, sample: [{ target: { id: 't-it' }, fromCents: 45, toCents: 54 }] })
    expect(await simulate([{ type: 'bid_apply', op: 'set', value: 0.5 }])).toMatchObject({ wouldChange: 1, sample: [{ target: { id: 't-it' }, fromCents: 45, toCents: 50 }] })
    expect(await simulate([{ type: 'lower_bid_to_floor' }])).toMatchObject({ wouldChange: 1, unsampled: 0, sample: [{ target: { id: 't-it' }, field: 'bid', fromCents: 45, toCents: 5, held: null }] })
  })

  it('raise_bids_for_rank_defense counts its keywords; pause_target and enable_target say the state', async () => {
    // Every enabled keyword of c-it, counted by the handler without a list.
    expect(await simulate([{ type: 'raise_bids_for_rank_defense', percent: 20 }])).toMatchObject({ wouldChange: 3, unsampled: 3, sample: [] })
    expect(await simulate([{ type: 'pause_target' }])).toMatchObject({ wouldChange: 1, sample: [{ target: { id: 't-it' }, field: 'state', from: 'ENABLED', to: 'PAUSED', held: null }] })
    expect(await simulate([{ type: 'enable_target' }])).toMatchObject({ wouldChange: 0, noChange: 1, sample: [] })
    // The builder's Pause THEN runs pause_target's own handler, not bid_apply's.
    const pause = { ...builderBody(['c-it']), conditions: [{ conditions: [{ metric: 'Clicks', op: 'gte', value: '1' }], action: { op: 'pauseTarget' } }] }
    expect((await post('/api/advertising/bid-rules/preview', pause)).json()).toMatchObject({ wouldChange: 1, sample: [{ target: { id: 't-it' }, field: 'state', from: 'ENABLED', to: 'PAUSED' }] })
  })

  it('bid_to_target_acos: its own number and sample, the keywords it leaves to the brain, counted once whatever context repeats it', async () => {
    // The optimiser's dry-run answer, in its own shape (ads-bid-optimizer.service.ts): 7 bids, a sample of one, one keyword
    // left to the brain. A SCHEDULE rule on every market runs it once per market (IT, UK): the same account-wide answer.
    const { ACTION_HANDLERS } = await import('../services/automation-rule.service.js')
    await import('../services/advertising/ads-bid-optimizer.service.js')
    const real = ACTION_HANDLERS.bid_to_target_acos
    ACTION_HANDLERS.bid_to_target_acos = async (action) => ({ type: action.type, ok: true, output: { dryRun: true, wouldChange: 7, sample: [{ targetId: 't-it', currentBidCents: 45, proposedBidCents: 36 }], brainOwned: 1 } })
    try {
      const body = await simulate([{ type: 'bid_to_target_acos', targetAcos: 0.2 }], 'SCHEDULE', { scopeMarketplace: null, scopeCampaignId: null })
      expect(body.matched).toBe(2)
      expect(body).toMatchObject({ wouldChange: 7, unsampled: 6, brainInputs: 1, sample: [{ target: { id: 't-it' }, field: 'bid', fromCents: 45, toCents: 36, held: null }] })
    } finally {
      ACTION_HANDLERS.bid_to_target_acos = real
    }
  })
})

describe('another business', () => {
  it('its rule reads as not found on every route', async () => {
    expect((await get(`/api/advertising/bid-rules/${ids.other}/history`)).statusCode).toBe(404)
    expect((await post('/api/advertising/bid-rules/preview', { ruleId: ids.other })).statusCode).toBe(404)
    expect((await post(`/api/advertising/bid-rules/${ids.other}/archive`)).statusCode).toBe(404)
    expect((await post(`/api/advertising/bid-rules/${ids.other}/unarchive`)).statusCode).toBe(404)
    const still = await withWorkspace(business(B), () => db().automationRule.findUnique({ where: { id: ids.other } }))
    expect(still).toMatchObject({ domain: 'advertising', enabled: true })
  })
})

describe('money', () => {
  it('without ad-spend money: the answers minus exactly the money keys', async () => {
    const owner = {
      list: (await get('/api/advertising/bid-rules?market=IT')).json(),
      history: (await get(`/api/advertising/bid-rules/${ids.r1}/history`)).json(),
      preview: (await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))).json(),
    }
    permissions = { isOwner: false, permissions: new Set([FEATURES.adsView]) }
    try {
      const list = (await get('/api/advertising/bid-rules?market=IT')).json()
      const effect = row(list, ids.r1).effect
      expect(effect.before).toEqual({ clicks: 10, orders: 1 })
      expect(effect.after).toEqual({ clicks: 10, orders: 1 })
      expect(JSON.stringify(list)).not.toMatch(/"(spendCents|salesCents|acosPct|fromCents|toCents|bidCents)":/)
      const history = (await get(`/api/advertising/bid-rules/${ids.r1}/history`)).json()
      const { fromCents, toCents, ...rest } = owner.history.changes[0]
      expect(history.changes[0]).toEqual(rest)
      const preview = (await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))).json()
      expect(preview.sample[0]).toEqual({ target: owner.preview.sample[0].target, adGroup: owner.preview.sample[0].adGroup, campaign: owner.preview.sample[0].campaign, field: 'bid', held: null, heldBy: null })
      permissions = { isOwner: false, permissions: new Set([FEATURES.adsView, FIELDS.financialsAdspendView]) }
      expect(row((await get('/api/advertising/bid-rules?market=IT')).json(), ids.r1).effect).toEqual(row(owner.list, ids.r1).effect)
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

describe('a campaign the bid brain owns (server switch live, enrollment LIVE)', () => {
  it('a rule\'s bid action there is a brain input: held by the brain in the list, not counted as a change in the preview', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const enrollment = await inA(() => db().bidBrainEnrollment.create({ data: { campaignId: 'c-it', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:test' } }))
    try {
      const body = (await get('/api/advertising/bid-rules?market=IT')).json()
      expect(row(body, ids.r1).mode).toEqual({
        set: 'ASK', acts: 'ASK', autoLocked: null,
        heldBy: { kind: 'brain', label: 'Brain decides', reason: 'The brain sets the bids there, so this rule\'s change goes to the brain for 7 days: Italy exact.' },
        also: [{ kind: 'allowlist', label: '1 campaign locked', reason: `${LOCKED_WHY}: Italy not allowlisted.` }],
      })
      // The brain: enrolled live, held by the account dial (Ask me: its live writer writes nothing); it applies to c-it.
      expect(row(body, 'brain')).toMatchObject({ mode: { set: 'AUTO', acts: 'WATCH', heldBy: { kind: 'dial', label: 'Account: Ask me' } }, scope: { campaigns: [{ id: 'c-it' }] } })
      const preview = (await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))).json()
      expect(preview).toMatchObject({ wouldChange: 0, brainInputs: 1, sample: [{ target: { id: 't-it' }, held: 'brain', heldBy: { kind: 'brain', label: 'Brain decides' } }], holds: [{ held: 'brain', label: 'Brain decides', count: 1 }] })

      // The Owner's kill switch stops the brain's bids in IT: the rule's input there moves nothing, the brain is Off.
      const { forgetKills } = await import('../services/advertising/brain/kill-switch.js')
      const kill = await inA(() => db().adsBrainOverride.create({ data: { productId: '*', marketplace: 'IT', scope: 'KILL', campaignId: null, kind: 'KILL', key: 'bids', ref: '', value: { products: 'all' }, by: 'user:test', reason: 'test stop' } }))
      forgetKills()
      try {
        const killed = (await get('/api/advertising/bid-rules?market=IT')).json()
        expect(chips(row(killed, ids.r1).mode)).toEqual({ set: 'ASK', acts: 'ASK', heldBy: { kind: 'stopped', label: 'Brain off' }, also: [{ kind: 'allowlist', label: '1 campaign locked' }], autoLocked: null })
        expect(row(killed, ids.r1).mode.heldBy.reason).toBe('You stopped the brain\'s bids there, so nothing changes: Italy exact.')
        expect(row(killed, 'brain').mode).toMatchObject({ set: 'AUTO', acts: 'OFF', heldBy: { kind: 'stopped', label: 'Brain off' } })
        expect((await post('/api/advertising/bid-rules/preview', builderBody(['c-it']))).json()).toMatchObject({ wouldChange: 0, brainInputs: 0, locked: 1, sample: [{ held: 'brainStopped', heldBy: { label: 'Brain off' } }], holds: [{ held: 'brainStopped', label: 'Brain off', count: 1 }] })
      } finally {
        await inA(() => db().adsBrainOverride.delete({ where: { id: kill.id } }))
        forgetKills()
      }
    } finally {
      await inA(() => db().bidBrainEnrollment.delete({ where: { id: enrollment.id } }))
      vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    }
  })
})

describe('POST /api/advertising/bid-rules/:id/archive and /unarchive', () => {
  it('archive: inert and Off, runs and changes kept, waiting asks expired, brain inputs ended, queued writes cancelled; idempotent; audited', async () => {
    const directive = await inA(() => db().bidDirective.create({ data: { campaignId: 'c-it', targetId: 't-it', kind: 'CEILING', valueCents: 50, source: `rule:${ids.r1}`, until: new Date(Date.now() + 3 * DAY) } }))
    // A write of the rule still queued, inside its hold: not sent yet.
    const queue = await inA(() => db().outboundSyncQueue.create({
      data: {
        targetChannel: 'AMAZON', targetRegion: 'IT', syncStatus: 'PENDING', syncType: 'AD_BID_UPDATE', holdUntil: new Date(Date.now() + 5 * 60_000), externalListingId: 'EXT-t-low',
        payload: { entityType: 'AD_TARGET', entityId: 't-low', externalId: 'EXT-t-low', marketplace: 'IT', actor: `automation:${ids.r1}`, reason: 'test', fieldChanges: [{ field: 'bid', oldValue: '3', newValue: '60' }] },
      },
    }))
    await inA(() => db().advertisingActionLog.create({ data: { userId: `automation:${ids.r1}`, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: 't-low', payloadBefore: { bidCents: 3 }, payloadAfter: { bidCents: 60 }, amazonResponseStatus: 'PENDING', outboundQueueId: queue.id } }))
    const res = await post(`/api/advertising/bid-rules/${ids.r1}/archive`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ id: ids.r1, name: 'Bids to a test bid', archived: true, level: 'OFF', already: false, expiredAsks: 1, endedBrainInputs: 1, cancelledWrites: 1 })
    const kept = await inA(async () => ({
      directive: await db().bidDirective.findUnique({ where: { id: directive.id } }),
      queue: await db().outboundSyncQueue.findUnique({ where: { id: queue.id } }),
      sentence: await (await import('../services/advertising/ads-suggestion-decide.service.js')).staleRuleSentence({ ruleId: ids.r1, ruleName: 'Bids to a test bid', lastSeenAt: new Date() }),
    }))
    // The brain input is kept, ended (its `until` now); the queued write cancelled; an ask of it says archived.
    expect(kept.directive.until.getTime()).toBeLessThanOrEqual(Date.now())
    expect(kept.queue.syncStatus).toBe('CANCELLED')
    expect(kept.sentence).toMatch(/is archived/)
    const stored = await inA(async () => ({
      rule: await db().automationRule.findUnique({ where: { id: ids.r1 } }),
      runs: await db().automationRuleExecution.count({ where: { ruleId: ids.r1 } }),
      changes: await db().advertisingActionLog.count({ where: { userId: `automation:${ids.r1}` } }),
      waiting: await db().adsRuleSuggestion.count({ where: { ruleId: ids.r1, status: 'pending' } }),
      audit: await db().advertisingActionLog.findFirst({ where: { entityType: 'RULE', entityId: ids.r1, actionType: 'archive_rule' } }),
    }))
    expect(stored.rule).toMatchObject({ domain: 'advertising-archived', enabled: false, autonomyLevel: 'OFF', dryRun: true })
    expect(stored).toMatchObject({ runs: 2, changes: 4, waiting: 0 })
    expect(stored.audit).toMatchObject({ userId: 'user:owner-1' })
    // Listed as archived, Off, nothing waiting; its history still answers.
    const body = (await get('/api/advertising/bid-rules?market=IT')).json()
    // Archived: Off with no hold and no Auto lock (the row says archived), no run ahead.
    expect(row(body, ids.r1)).toMatchObject({ archived: true, waiting: 0, mode: { set: 'OFF', acts: 'OFF', heldBy: null, also: [], autoLocked: null }, nextRunAt: null, firstRunAt: null })
    expect(body.totals).toMatchObject({ rules: 2, archived: 1, waiting: 0 })
    expect((await get(`/api/advertising/bid-rules/${ids.r1}/history?days=30`)).json().changes.length).toBeGreaterThan(0)
    // Again: nothing changes, and it says so.
    expect((await post(`/api/advertising/bid-rules/${ids.r1}/archive`)).json()).toMatchObject({ archived: true, already: true })
  })

  it('unarchive: back among the rules at Off; the brain cannot be archived', async () => {
    const res = await post(`/api/advertising/bid-rules/${ids.r1}/unarchive`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ archived: false, level: 'OFF', already: false })
    const rule = await inA(() => db().automationRule.findUnique({ where: { id: ids.r1 } }))
    expect(rule).toMatchObject({ domain: 'advertising', enabled: false, autonomyLevel: 'OFF' })
    expect(row((await get('/api/advertising/bid-rules?market=IT')).json(), ids.r1)).toMatchObject({ archived: false, mode: { set: 'OFF' } })
    expect((await post('/api/advertising/bid-rules/brain/archive')).statusCode).toBe(400)
    expect((await post(`/api/advertising/bid-rules/${ids.r5}/archive`)).statusCode).toBe(404)
  })
})

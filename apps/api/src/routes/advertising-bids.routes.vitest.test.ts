/**
 * Bid page (BAPI) — GET /api/advertising/bids on a real PostgreSQL (PGlite), business profiles ON, the bid brain's server
 * switch live:
 *
 *   owner     one owner per bid, each from the read its writer uses: a pin, a person's bid, the brain's enrollment (over
 *             the schedule left on its campaign), a rule at Auto by its scope, an hourly plan, auto-bid's scope with the
 *             Owner's target ACoS, nobody off the allowlist, outside Sponsored Products or with no target set
 *   bid       the night floor on now, the highest a click can cost, the brain's aim and what holds it, the last change and the
 *             changes of 7 days with the night floor and its give-back folded away, 7 days of results, the 7-day line
 *   filters   owner (a kind or an id) narrows the rows and not the totals; campaign, ad group, market, product, status
 *   business  another business's campaign, ad group or product is a 404; its bids never show
 *   money     a person without ad-spend money gets the answer minus exactly the money keys
 *   currency  each bid's market and currency (the market's ads account's, else the campaign's own); the totals' when one
 *   source    Claude's ad-targets owner (bid-grid.service.ts bidderByCampaign) names the brain where the brain owns the
 *             campaign, as the brain map does — not the schedule left on it
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'bapi_bids_alpha'
const B = 'bapi_bids_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const P = 'bapi-jacket'
const NOW = Date.now()
const DAY = 86_400_000
const HOUR = 3_600_000
const ago = (ms: number) => new Date(NOW - ms)
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await withWorkspace(business(A), async () => {
    const c = database.client as any
    await seedAdsFixture(c)
    const campaign = (id: string, extra: Record<string, unknown> = {}) => c.campaign.create({
      data: { id, name: `Italy ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
    })
    const group = (campaignId: string) => c.adGroup.create({ data: { id: `g-${campaignId}`, campaignId, name: `group ${campaignId}`, externalAdGroupId: `EXT-g-${campaignId}` } })
    const target = (id: string, campaignId: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) => c.adTarget.create({
      data: { id, adGroupId: `g-${campaignId}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}`, ...extra },
    })
    const log = (entityId: string, userId: string, from: number, to: number, at: Date, evidence?: unknown, status = 'SUCCESS') => c.advertisingActionLog.create({
      data: { userId, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId, payloadBefore: { bidCents: from }, payloadAfter: { bidCents: to }, createdAt: at, amazonResponseStatus: status, ...(evidence ? { evidence } : {}) },
    })

    // c-it: auto-bid moves it (Sponsored Products, allowlisted, the campaign's own target ACoS); up and down, top of search +100 %.
    await c.campaign.update({ where: { id: 'c-it' }, data: { portfolioId: 'PF-1', dynamicBidding: { targetAcos: 0.2, strategy: 'AUTO_FOR_SALES', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 100 }] } } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-1', name: 'Jacket portfolio' } })
    // t-it: an auto-bid write a newer one superseded before it was sent — never sent, so no change.
    await log('t-it', 'automation:auto-bid', 45, 50, ago(DAY), undefined, 'SUPERSEDED')
    // t-low: a person's own bid two days ago — auto-bid leaves it.
    await log('t-low', 'user:u1', 5, 3, ago(2 * DAY))
    await c.amazonAdsDailyPerformance.createMany({
      data: [
        { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: ago(2 * DAY), entityType: 'AD_TARGET', entityId: 'EXT-t-it', localEntityId: 't-it', clicks: 10, costMicros: BigInt(3_000_000), orders7d: 1, sales7dCents: 2000, currencyCode: 'EUR', reportedAt: ago(HOUR) },
        { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: ago(10 * DAY), entityType: 'AD_TARGET', entityId: 'EXT-t-it', localEntityId: 't-it', clicks: 50, costMicros: BigInt(9_000_000), orders7d: 0, sales7dCents: 0, currencyCode: 'EUR', reportedAt: ago(HOUR) },
      ],
    })
    await c.product.create({ data: { id: P, sku: 'BAPI-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: P, sku: 'BAPI-JACKET', asin: 'BAPITESTASIN' } })
    // A rule at Ask me on c-it: it asks, it does not write — auto-bid stays the owner.
    await c.automationRule.create({ data: { id: 'r-ask', name: 'Ask on Italy', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'PROPOSE', scopeCampaignId: 'c-it', actions: [{ type: 'bid_down', pct: 10 }] } })
    // A rule at Auto on c-it: auto-bid does not leave a bid a rule set — both write (contested); t-low's person hold
    // stops auto-bid, not the rule.
    await c.automationRule.create({ data: { id: 'r-it', name: 'Cut Italy', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'AUTO', scopeCampaignId: 'c-it', actions: [{ type: 'bid_down', pct: 10 }] } })

    // c-brain: the bid brain owns it LIVE — over the schedule still on it. Night floor 18 → 2 and back to 15.
    await c.rankScheduleGroup.create({ data: { id: 'grp-1', name: 'Jacket plan', marketplace: 'IT' } })
    await campaign('c-brain')
    await group('c-brain')
    await target('t-brain', 'c-brain', 'jacket men', 15)
    await c.bidBrainEnrollment.create({ data: { campaignId: 'c-brain', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:u1' } })
    await c.adSchedule.create({ data: { id: 's-brain', campaignId: 'c-brain', name: 'old schedule', defaultTargetKey: 'top', groupId: 'grp-1' } })
    await log('t-brain', 'automation:auto-bid', 20, 18, ago(8 * DAY))
    await log('t-brain', 'automation:bid-brain', 18, 2, ago(30 * HOUR), { brain: { layer: 'min_bid_hour' } })
    await log('t-brain', 'automation:bid-brain', 2, 15, ago(22 * HOUR), { brain: { layer: 'restore' } })
    await c.bidBrainDecision.create({
      data: {
        runId: 'bapi-run', mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-brain', adGroupId: 'g-c-brain', targetId: 't-brain',
        action: 'hold', layer: 'band', currentCents: 15, decidedCents: 15, goalBidCents: 19, dataDay: ago(2 * DAY), why: 'in band: a made-up why', createdAt: ago(HOUR),
      },
    })

    // t-undo (c-brain): auto-undo put back a brain change and pins it (UNDO_PIN): the brain's pin layer is auto-undo's, not a person's.
    await target('t-undo', 'c-brain', 'jacket kids', 12)
    await c.bidHold.create({ data: { campaignId: 'c-brain', targetId: 't-undo', kind: 'UNDO_PIN', by: 'auto-undo', until: new Date(NOW + 3 * DAY) } })
    await c.bidBrainDecision.create({
      data: {
        runId: 'bapi-run', mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-brain', adGroupId: 'g-c-brain', targetId: 't-undo',
        action: 'hold', layer: 'pin', currentCents: 12, decidedCents: 12, goalBidCents: 14, dataDay: ago(2 * DAY), why: 'pin: a made-up why', createdAt: ago(HOUR),
      },
    })

    // c-seed (the audit case): auto-bid is set up to move it (the campaign's own target), but its only writer in 7 days was
    // an Ask-me rule whose ask a person approved — the write carries the rule's actor.
    await campaign('c-seed', { dynamicBidding: { targetAcos: 0.25 } })
    await group('c-seed')
    await target('t-seed', 'c-seed', 'moto jacket', 34)
    await c.automationRule.create({ data: { id: 'r-seed', name: 'Seed — lower bids', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'PROPOSE', scopeCampaignId: 'c-seed', actions: [{ type: 'bid_down', pct: 15 }] } })
    await log('t-seed', 'automation:r-seed', 40, 34, ago(2 * DAY))

    // c-plan: an hourly plan holds it (a goal-mode schedule of a group), its night floor on now: 12 → 2 two hours ago.
    await campaign('c-plan', { bidsSuppressedAt: ago(2 * HOUR), bidsSuppressedBy: 'automation:rank-defend-s-plan', bidsSuppressedFloorCents: 2 })
    await group('c-plan')
    await target('t-plan', 'c-plan', 'jacket women', 2, { suppressedFromBidCents: 12 })
    await c.adSchedule.create({ data: { id: 's-plan', campaignId: 'c-plan', name: 'IT jacket', defaultTargetKey: 'top', groupId: 'grp-1' } })
    await log('t-plan', 'automation:rank-defend-s-plan', 12, 2, ago(2 * HOUR))
    // A rank-defense raise at Auto on c-plan: it leaves a campaign Rank & Dayparting holds (rankOwnedSkip) — no second writer.
    await c.automationRule.create({ data: { id: 'r-defend', name: 'Defend rank', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'AUTO', scopeCampaignId: 'c-plan', actions: [{ type: 'raise_bids_for_rank_defense', percent: 20 }] } })

    // c-both: an hourly plan and a rule at Auto that cuts bids — a rule does not skip a plan's campaign: both write.
    await campaign('c-both')
    await group('c-both')
    await target('t-both', 'c-both', 'jacket deal', 25)
    await c.adSchedule.create({ data: { id: 's-both', campaignId: 'c-both', name: 'IT deal', defaultTargetKey: 'top', groupId: 'grp-1' } })
    await c.automationRule.create({ data: { id: 'r-both', name: 'Cut deals', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'AUTO', scopeCampaignId: 'c-both', actions: [{ type: 'bid_down', pct: 10 }] } })

    // c-rule: a rule at Auto that cuts bids, scoped to it.
    // Down only, product pages +200 % above top of search +50 %: the ceiling is the highest lane's (ad-targets' effectiveMaxCpc).
    await campaign('c-rule', { dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 200 }] } })
    await group('c-rule')
    await target('t-rule', 'c-rule', 'jacket sale', 30)
    await c.automationRule.create({ data: { id: 'r-bid', name: 'Lower bids on waste', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'AUTO', scopeCampaignId: 'c-rule', actions: [{ type: 'bid_down', pct: 10 }] } })
    await log('t-rule', 'automation:r-bid', 33, 30, ago(3 * DAY))

    // A paused campaign: not a live bid.
    await campaign('c-paused', { status: 'PAUSED' })
    await group('c-paused')
    await target('t-paused', 'c-paused', 'old jacket', 20)

    // c-se (paused, so only status=all shows it): Sweden's ads account bills in kronor; the campaign's column kept the
    // schema's EUR default — the account's currency wins.
    await campaign('c-se', { status: 'PAUSED', marketplace: 'SE', name: 'Sweden c-se' })
    await group('c-se')
    await target('t-se', 'c-se', 'jacka', 900)
    await c.amazonAdsConnection.create({ data: { profileId: 'P-SE-TEST', marketplace: 'SE', region: 'EU', mode: 'production', isActive: true } })
    await c.amazonAdsProfile.create({ data: { profileId: 'P-SE-TEST', marketplace: 'SE', currencyCode: 'SEK' } })
  })
  await withWorkspace(business(B), async () => {
    const c = database.client as any
    await c.product.create({ data: { id: 'bapi-other-jacket', sku: 'BAPI-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await c.campaign.create({ data: { id: 'b-camp', name: 'Other business', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-b-camp', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
    await c.adGroup.create({ data: { id: 'b-group', campaignId: 'b-camp', name: 'other group', externalAdGroupId: 'EXT-b-group' } })
    await c.adTarget.create({ data: { id: 'b-target', adGroupId: 'b-group', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'other jacket', bidCents: 40, externalTargetId: 'EXT-b-target' } })
  })
  const { default: routes } = await import('./advertising-bids.routes.js')
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

const get = (query = '') => app.inject({ method: 'GET', url: `/api/advertising/bids${query ? `?${query}` : ''}` })
type Row = Record<string, any>
const byTarget = (rows: Row[]) => new Map(rows.map((r) => [r.targetId, r]))

describe('GET /api/advertising/bids — one owner per bid', () => {
  it('each bid\'s owner is the writer that really moves it', async () => {
    const res = await get()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const owners = Object.fromEntries(res.json().rows.map((r: Row) => [r.targetId, `${r.owner.kind}:${r.owner.name}`]))
    expect(owners).toEqual({
      't-it': 'ENGINE:Auto-bid', 't-sup': 'ENGINE:Auto-bid', 't-low': 'PERSON:You', 't-seed': 'RULE:Seed — lower bids', 't-pin': 'PERSON:You',
      't-uk': 'NONE:Nobody', 't-off': 'NONE:Nobody', 't-sb': 'NONE:Nobody',
      't-brain': 'BRAIN:Brain', 't-undo': 'BRAIN:Brain', 't-plan': 'PLAN:Jacket plan', 't-rule': 'RULE:Lower bids on waste', 't-both': 'PLAN:Jacket plan',
    })
    const rows = byTarget(res.json().rows)
    expect(rows.get('t-plan').owner.id).toBe('grp-1')
    expect(rows.get('t-rule').owner.id).toBe('r-bid')
    expect(rows.get('t-brain').owner.id).toBe('brain')
    expect(res.json().totals).toMatchObject({ bids: 13, shown: 13, owners: { BRAIN: 2, RULE: 2, PLAN: 2, PERSON: 2, ENGINE: 2, NONE: 3 }, nightFloor: 1, changed7d: 4, truncated: false })
  })

  it('two writers on one bid are said, never hidden: the one that writes most owns it, the other is named', async () => {
    const rows = byTarget((await get()).json().rows)
    expect(rows.get('t-both').owner).toEqual({ kind: 'PLAN', name: 'Jacket plan', id: 'grp-1', contested: true, alsoWrites: [{ kind: 'RULE', name: 'Cut deals', id: 'r-both' }] })
    expect(rows.get('t-it').owner).toEqual({ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid', contested: true, alsoWrites: [{ kind: 'RULE', name: 'Cut Italy', id: 'r-it' }] })
    // The person set t-low (auto-bid leaves it); the rule at Auto has not written it but may: the person owns it, the rule
    // is said. A rank-defense raise leaves the plan's campaign.
    expect(rows.get('t-low').owner).toEqual({ kind: 'PERSON', name: 'You', id: 'you', contested: true, alsoWrites: [{ kind: 'RULE', name: 'Cut Italy', id: 'r-it' }] })
    expect(rows.get('t-plan').owner).toEqual({ kind: 'PLAN', name: 'Jacket plan', id: 'grp-1', contested: false, alsoWrites: [] })
  })

  it('a brain bid: its aim, what holds it, one change for the night floor and its give-back, the 7-day line', async () => {
    const row = byTarget((await get()).json().rows).get('t-brain')
    expect(row).toEqual({
      targetId: 't-brain', text: 'jacket men', match: 'EXACT', portfolio: null,
      campaign: { id: 'c-brain', name: 'Italy c-brain', href: '/marketing/ads/campaigns/c-brain' },
      adGroup: { id: 'g-c-brain', name: 'group c-brain', href: '/marketing/ads/campaigns/c-brain/ad-groups/g-c-brain' },
      market: 'IT', currency: 'EUR',
      owner: { kind: 'BRAIN', name: 'Brain', id: 'brain', contested: false, alsoWrites: [] },
      bidNow: 15, nightFloor: false, maxCpc: 15, brainAim: 19, heldBy: { kind: 'in_band', label: 'In band' },
      lastChange: { from: 18, to: 15, at: ago(22 * HOUR).toISOString(), by: { kind: 'BRAIN', name: 'Brain', id: 'brain' } },
      delivery: 'live',
      changes7d: 1, d7: { clicks: 0, orders: 0, spend: 0, acosPct: null }, spark: [18, 18, 18, 18, 18, 18, 15],
      // KAPI-B — no goal or max of its own; the bid brain runs it.
      goal: null, auto: 'AUTO', autoWhy: null, brainProductId: null,
    })
  })

  it('the audit case: an Ask-me rule\'s approved ask was the only writer in 7 days — it owns the bid, auto-bid is said', async () => {
    const row = byTarget((await get()).json().rows).get('t-seed')
    expect(row.owner).toEqual({ kind: 'RULE', name: 'Seed — lower bids', id: 'r-seed', contested: true, alsoWrites: [{ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' }] })
    expect(row.lastChange).toMatchObject({ from: 40, to: 34, by: { kind: 'RULE', name: 'Seed — lower bids', id: 'r-seed' } })
  })

  it('who sets it never contradicts the last change: a writer of the last 7 days is the owner or named beside it', async () => {
    const rows: Row[] = (await get('status=all')).json().rows
    const recent = rows.filter((r) => r.lastChange && Date.parse(r.lastChange.at) >= NOW - 7 * DAY)
    expect(recent.length).toBeGreaterThan(3)
    const same = (a: Row, b: Row) => a.kind === b.kind && a.id === b.id
    for (const r of recent) expect([r.owner, ...r.owner.alsoWrites].some((w) => same(w, r.lastChange.by)), r.targetId).toBe(true)
  })

  it('a bid auto-undo pinned: the brain\'s hold reads Auto-undo, not You', async () => {
    const row = byTarget((await get()).json().rows).get('t-undo')
    expect(row).toMatchObject({ owner: { kind: 'BRAIN' }, brainAim: 14, heldBy: { kind: 'auto_undo', label: 'Auto-undo' } })
  })

  it('a plan bid at the night floor now: no change counted, the line keeps the bid it gives back', async () => {
    const row = byTarget((await get()).json().rows).get('t-plan')
    expect(row).toMatchObject({ bidNow: 2, nightFloor: true, maxCpc: 2, lastChange: null, changes7d: 0, spark: [12, 12, 12, 12, 12, 12, 12], brainAim: null, heldBy: null })
  })

  it('an auto-bid bid: 7 days of results, the highest a click can cost, its portfolio', async () => {
    const rows = byTarget((await get()).json().rows)
    expect(rows.get('t-it')).toMatchObject({
      bidNow: 45, maxCpc: 180, d7: { clicks: 10, orders: 1, spend: 300, acosPct: 15 }, changes7d: 0, lastChange: null,
      portfolio: { id: 'PF-1', name: 'Jacket portfolio', href: '/marketing/ads/portfolios/PF-1' },
    })
    expect(rows.get('t-rule').lastChange).toMatchObject({ from: 33, to: 30, by: { kind: 'RULE', name: 'Lower bids on waste' } })
    // The highest placement's ceiling, as Claude's ad-targets says it (effectiveMaxCpc): 30 × 3, not the top lane's 30 × 1.5.
    expect(rows.get('t-rule').maxCpc).toBe(90)
    expect(rows.get('t-low').lastChange).toMatchObject({ from: 5, to: 3, by: { kind: 'PERSON', name: 'You' } })
  })
})

describe('filters', () => {
  const ids = async (query: string) => (await get(query)).json().rows.map((r: Row) => r.targetId).sort()
  it('owner narrows the rows (a kind in any case, or an id), never the totals', async () => {
    expect(await ids('owner=BRAIN')).toEqual(['t-brain', 't-undo'])
    expect(await ids('owner=rule')).toEqual(['t-rule', 't-seed'])
    expect(await ids('owner=r-bid')).toEqual(['t-rule'])
    expect(await ids('owner=you')).toEqual(['t-low', 't-pin'])
    expect(await ids('owner=auto-bid')).toEqual(['t-it', 't-sup'])
    const res = (await get('owner=PLAN')).json()
    expect(res.totals).toMatchObject({ bids: 13, shown: 2, owners: { PLAN: 2, NONE: 3 } })
  })

  it('campaign, ad group, market, product and status', async () => {
    expect(await ids('campaignId=c-it')).toEqual(['t-it', 't-low', 't-sup'])
    expect(await ids('adGroupId=g-c-brain')).toEqual(['t-brain', 't-undo'])
    expect(await ids('campaignId=c-brain&adGroupId=g-c-brain')).toEqual(['t-brain', 't-undo'])
    expect(await ids('market=uk')).toEqual(['t-uk'])
    expect(await ids(`productId=${P}`)).toEqual(['t-it', 't-low', 't-sup'])
    const all = byTarget((await get('status=all')).json().rows)
    expect(all.get('t-paused').owner).toEqual({ kind: 'NONE', name: 'Nobody', id: null, contested: false, alsoWrites: [] })
    expect(all.has('t-neg')).toBe(false)
  })

  it('a query it does not take is a 400 in words', async () => {
    const unknown = await get('foo=1')
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error).toMatch(/Unrecognized key/i)
    expect((await get('status=paused')).statusCode).toBe(400)
  })
})

describe('another business', () => {
  it('its campaign, ad group or product is not found (404); its bids never show', async () => {
    for (const query of ['campaignId=b-camp', 'adGroupId=b-group', 'productId=bapi-other-jacket', 'campaignId=c-it&adGroupId=g-c-brain']) {
      const res = await get(query)
      expect(res.statusCode, query).toBe(404)
      expect(res.json().error).toMatch(/^No (campaign|ad group|product) /)
    }
    expect((await get()).json().rows.map((r: Row) => r.targetId)).not.toContain('b-target')
  })
})

describe('money', () => {
  it('without ad-spend money: the answer minus exactly the money keys; with it: everything', async () => {
    permissions = { isOwner: false, permissions: new Set() }
    try {
      const res = (await get('owner=BRAIN')).json()
      const row = res.rows.find((r: Row) => r.targetId === 't-brain')
      for (const key of ['bidNow', 'maxCpc', 'brainAim', 'spark']) expect(row, key).not.toHaveProperty(key)
      expect(row.lastChange).toEqual({ at: ago(22 * HOUR).toISOString(), by: { kind: 'BRAIN', name: 'Brain', id: 'brain' } })
      expect(row.d7).toEqual({ clicks: 0, orders: 0 })
      expect(res.totals.d7).toEqual({ clicks: 10, orders: 1 })
      expect(row).toMatchObject({ owner: { kind: 'BRAIN' }, nightFloor: false, heldBy: { kind: 'in_band' }, changes7d: 1 })
      // The order does not give the spend ranking away: by campaign, ad group and words.
      expect((await get()).json().rows.map((r: Row) => r.targetId)).toEqual(['t-sb', 't-both', 't-undo', 't-brain', 't-plan', 't-rule', 't-seed', 't-low', 't-sup', 't-it', 't-off', 't-pin', 't-uk'])
      permissions = { isOwner: false, permissions: new Set([FIELDS.financialsAdspendView]) }
      const full = (await get('owner=BRAIN')).json().rows.find((r: Row) => r.targetId === 't-brain')
      // With the money: what costs first.
      expect((await get()).json().rows[0].targetId).toBe('t-it')
      expect(full).toMatchObject({ bidNow: 15, maxCpc: 15, brainAim: 19, lastChange: { from: 18, to: 15 }, d7: { spend: 0 } })
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

describe('market and currency', () => {
  it('each bid says its market and currency: the market\'s ads account\'s, else the campaign\'s own', async () => {
    const rows = byTarget((await get('status=all')).json().rows)
    expect(rows.get('t-it')).toMatchObject({ market: 'IT', currency: 'EUR' })
    expect(rows.get('t-brain')).toMatchObject({ market: 'IT', currency: 'EUR' })
    // No profile currency for UK here: the campaign's own (GBP).
    expect(rows.get('t-uk')).toMatchObject({ market: 'UK', currency: 'GBP' })
    // The account bills kronor; the campaign's column holds the schema's EUR default.
    expect(rows.get('t-se')).toMatchObject({ market: 'SE', currency: 'SEK' })
  })

  it('the totals say the currency when every bid shares one, else null', async () => {
    expect((await get()).json().totals.currency).toBeNull()
    expect((await get('market=IT')).json().totals.currency).toBe('EUR')
    expect((await get('market=UK')).json().totals.currency).toBe('GBP')
    expect((await get('market=SE&status=all')).json().totals.currency).toBe('SEK')
    // Nothing in scope: no currency.
    expect((await get('market=SE')).json().totals).toMatchObject({ bids: 0, currency: null })
  })

  it('without ad-spend money the market and currency stay (they are no amount)', async () => {
    permissions = { isOwner: false, permissions: new Set() }
    try {
      const res = (await get('market=UK')).json()
      expect(res.rows[0]).toMatchObject({ market: 'UK', currency: 'GBP' })
      expect(res.rows[0]).not.toHaveProperty('bidNow')
      expect(res.totals.currency).toBe('GBP')
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

describe('permission', () => {
  it('a read that needs ads.view (the manifest), never the /bid rule\'s bid editing', async () => {
    const { permissionForRoute } = await import('../lib/auth/permissions-manifest.js')
    expect(permissionForRoute('GET', '/api/advertising/bids')).toBe('ads.view')
  })
})

describe('a person\'s bids, read for the page\'s bids only', () => {
  it('personBidTargetIds({ targetIds }) reads only those bids\' changes (none: nothing read)', async () => {
    const { personBidTargetIds } = await import('../services/advertising/bid-grid.service.js')
    const inA = <T,>(work: () => Promise<T>) => withWorkspace(business(A), work)
    expect([...(await inA(() => personBidTargetIds({ targetIds: ['t-it', 't-brain'] })))]).toEqual([])
    expect([...(await inA(() => personBidTargetIds({ targetIds: ['t-low', 't-it', 't-low'] })))]).toEqual(['t-low'])
    expect([...(await inA(() => personBidTargetIds({ targetIds: [] })))]).toEqual([])
    expect([...(await inA(() => personBidTargetIds()))]).toEqual(['t-low'])
  })
})

describe('the source of the two owners', () => {
  it('Claude\'s ad-targets owner names the brain where the brain owns the campaign, the schedule elsewhere', async () => {
    const { bidderByCampaign } = await import('../services/advertising/bid-grid.service.js')
    const bidders = await withWorkspace(business(A), () => bidderByCampaign())
    expect(bidders.get('c-brain')).toEqual({ kind: 'brain', name: null })
    expect(bidders.get('c-plan')).toEqual({ kind: 'schedule', name: 'Jacket plan' })
  })
})

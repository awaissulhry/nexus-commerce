/**
 * ADS AUTONOMY W1-3 — the strategy writer (write.ts). Values are made up (public repo).
 *
 *   judging   every RaiseRule, as the design's table (§3.3) states it: raise, lower or same, on the value in force
 *   plan      the level a field may sit on, whole groups, a floor above the ceiling in force refused; each field judged on
 *             the value in force at the scope before and after (a removed row by what it falls back to); a stale
 *             expectVersion is a 409; nothing to change is refused
 *   apply     the row and ONE version row (direction, via, approvalId, actor, stepUpAt) in one transaction; a row that
 *             moved since the plan is a conflict; a raise is never written without the time its code was confirmed
 *   terms     the market's protected terms (AdKeywordProtection) added and removed, each with its ads audit row
 *   campaigns clearCampaignTargets clears the own targets that shadow the strategy (other dynamicBidding keys kept), and
 *             judges each against what the campaign aims at afterwards; restoreCampaignTargets puts them back
 *   undo      undoArgsOf → plan → apply puts the row, the terms and the targets back exactly
 *   money     changes are keyed by registry or column name, labels carry no amount; the history read strips the money
 *   business  another business neither sees nor changes this one's rows (row-level security, profiles ON)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { financialPayloadCopy } from '../../../lib/auth/field-filter.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { STRATEGY_FIELDS, STRATEGY_MONEY, type RaiseRule, type StrategyFieldKey } from './fields.js'
import {
  applyStrategyPlan,
  judgeChange,
  judgeTargets,
  planStrategyChange,
  strategyStateNow,
  undoArgsOf,
  type StrategyPlan,
  type StrategyWriter,
} from './write.js'
import { readStrategy } from './read.js'

const A = 'w1_write_alpha'
const B = 'w1_write_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { cat: '', parent: '', v: '', q: '', c1: '', c2: '', c3: '', g1: '', g2: '' }
const SCREEN: StrategyWriter = { via: 'screen', actor: 'Test person', actorUserId: 'u-test', approvalId: null, stepUpAt: null, updatedBy: 'user:u-test' }
const CODED: StrategyWriter = { ...SCREEN, stepUpAt: new Date('2026-10-06T08:00:00Z') }

type Json = Record<string, any>
async function planned(args: Record<string, unknown>): Promise<StrategyPlan> {
  const out = await planStrategyChange(args)
  if ('error' in out) throw new Error(`refused: ${out.error}`)
  return out.plan
}
async function refusal(args: Record<string, unknown>) {
  const out = await planStrategyChange(args)
  if (!('error' in out)) throw new Error('not refused')
  return out
}
async function saved(args: Record<string, unknown>, writer = SCREEN) {
  const plan = await planned(args)
  const out = await applyStrategyPlan(plan, plan.direction === 'raise' ? { ...writer, stepUpAt: writer.stepUpAt ?? CODED.stepUpAt } : writer)
  if ('error' in out) throw new Error(`not applied: ${out.error}`)
  return { plan, out }
}
const it_ = (args: Record<string, unknown>) => ({ channel: 'AMAZON', market: 'IT', ...args })
const rowOf = (level: string, scopeId = '*') => db().adsStrategy.findFirst({ where: { market: 'IT', level, scopeId } })
const versionsOf = (strategyId: string) => db().adsStrategyVersion.findMany({ where: { strategyId }, orderBy: { version: 'asc' } })
const targetOf = async (campaignId: string) => ((await db().campaign.findUniqueOrThrow({ where: { id: campaignId } })).dynamicBidding as Json | null)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.cat = (await c.category.create({ data: { slug: 'w13-cat', name: { en: { name: 'Test jackets' } } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.cat, descendantId: ids.cat, depth: 0 } })
    ids.parent = (await c.product.create({ data: { sku: 'TEST-W13-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v = (await c.product.create({ data: { sku: 'TEST-W13-V1', name: 'Test variation', basePrice: '10.00', parentId: ids.parent } })).id
    ids.q = (await c.product.create({ data: { sku: 'TEST-W13-Q', name: 'Test standalone', basePrice: '10.00' } })).id
    await c.productCategory.create({ data: { productId: ids.parent, categoryId: ids.cat, isPrimary: true } })
    const campaign = (name: string, dynamicBidding: object | null) =>
      c.campaign.create({ data: { name, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date(), ...(dynamicBidding ? { dynamicBidding } : {}) } as never })
    // c1 aims lower than the market will (25 %), c2 higher (40 %); c3 has no target of its own.
    ids.c1 = (await campaign('Test campaign low', { targetAcos: 0.25, maxBidChangePct: 15 })).id
    ids.g1 = (await c.adGroup.create({ data: { campaignId: ids.c1, name: 'Test ad group low' } })).id
    await c.adProductAd.create({ data: { adGroupId: ids.g1, productId: ids.v, asin: 'B0TESTW131' } })
    ids.c2 = (await campaign('Test campaign high', { targetAcos: 0.4 })).id
    ids.g2 = (await c.adGroup.create({ data: { campaignId: ids.c2, name: 'Test ad group high' } })).id
    await c.adProductAd.create({ data: { adGroupId: ids.g2, productId: ids.q, asin: 'B0TESTW132' } })
    ids.c3 = (await campaign('Test campaign none', null)).id
  })
  await inB(async () => {
    await db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'BRAVO market (IT)', maxBidCents: 777, updatedBy: 'user:bravo' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

// ── judging ───────────────────────────────────────────────────────────────────────────────────────

describe('judging a change (design §3.3)', () => {
  const judge = (rule: RaiseRule, key: StrategyFieldKey, before: unknown, after: unknown, fallbackTargetPct = 30) =>
    judgeChange(rule, key, before, after, { fallbackTargetPct })

  it('every settable field has the rule the design names', () => {
    const rules = Object.fromEntries(STRATEGY_FIELDS.filter((f) => !f.derivedFrom).map((f) => [f.key, f.raise]))
    expect(rules).toEqual({
      goal: 'any', goalNote: 'never', target: 'target', monthlySpendCapCents: 'up', minBidCents: 'floor', maxBidCents: 'up',
      maxChangePct: 'up', maxActionsPerRun: 'up', protect: 'unprotect', harvest: 'loosen', negate: 'loosen', stop: 'pause',
      claudeAutonomy: 'autonomy', reviewEveryDays: 'up',
    })
  })

  it.each([
    // a ceiling or a cap: up, or cleared to none, loosens; down, or a new one, tightens
    ['up', 'maxBidCents', 100, 120, 'raise'], ['up', 'maxBidCents', 120, 100, 'lower'], ['up', 'maxBidCents', 100, null, 'raise'],
    ['up', 'monthlySpendCapCents', null, 5000, 'lower'], ['up', 'maxChangePct', 20, 20, 'same'], ['up', 'reviewEveryDays', 7, 14, 'raise'],
    // a floor: up, or a new one, forces spend
    ['floor', 'minBidCents', 10, 20, 'raise'], ['floor', 'minBidCents', null, 10, 'raise'], ['floor', 'minBidCents', 20, 10, 'lower'], ['floor', 'minBidCents', 10, null, 'lower'],
    // protection: true → false or cleared loosens
    ['unprotect', 'protect', true, false, 'raise'], ['unprotect', 'protect', true, null, 'raise'], ['unprotect', 'protect', null, true, 'lower'], ['unprotect', 'protect', false, null, 'same'],
    // any change of a goal; never for the why
    ['any', 'goal', null, 'LAUNCH', 'raise'], ['any', 'goal', 'LAUNCH', 'PROFIT', 'raise'], ['never', 'goalNote', 'a', 'b', 'same'],
  ] as Array<[RaiseRule, StrategyFieldKey, unknown, unknown, string]>)('%s %s: %o → %o is %s', (rule, key, before, after, expected) => {
    expect(judge(rule, key, before, after)).toBe(expected)
  })

  it('a target: up, a kind switch, or a fall-back to a higher value raises; a new target is judged against the fallback', () => {
    const acos = (pct: number) => ({ targetKind: 'ACOS', targetPct: pct })
    expect(judge('target', 'target', acos(25), acos(30))).toBe('raise')
    expect(judge('target', 'target', acos(25), acos(20))).toBe('lower')
    expect(judge('target', 'target', acos(25), { targetKind: 'TACOS', targetPct: 10 })).toBe('raise')
    expect(judge('target', 'target', acos(25), null, 30)).toBe('raise') // cleared: falls back to 30 %
    expect(judge('target', 'target', acos(35), null, 30)).toBe('lower')
    expect(judge('target', 'target', null, acos(35), 30)).toBe('raise') // a first target above what is aimed at today
    expect(judge('target', 'target', null, acos(20), 28)).toBe('lower') // below the account default
  })

  it('harvest and negate: less evidence, a higher ceiling, any window change, or the group going raises', () => {
    const h = (minOrders: number, minClicks: number, maxAcosPct: number | null, windowDays = 60) => ({ harvestMinOrders: minOrders, harvestMinClicks: minClicks, harvestMaxAcosPct: maxAcosPct, harvestWindowDays: windowDays })
    expect(judge('loosen', 'harvest', h(3, 7, 40), h(2, 7, 40))).toBe('raise')
    expect(judge('loosen', 'harvest', h(3, 7, 40), h(3, 7, null))).toBe('raise')
    expect(judge('loosen', 'harvest', h(3, 7, 40), h(3, 7, 40, 30))).toBe('raise')
    expect(judge('loosen', 'harvest', h(3, 7, 40), h(4, 9, 30))).toBe('lower')
    expect(judge('loosen', 'harvest', h(3, 7, null), h(3, 7, 50))).toBe('lower')
    expect(judge('loosen', 'harvest', null, h(3, 7, 40))).toBe('lower')
    expect(judge('loosen', 'harvest', h(3, 7, 40), null)).toBe('raise')
    const n = (minClicks: number, minSpendCents: number, maxOrders: number, windowDays = 30) => ({ negateMinClicks: minClicks, negateMinSpendCents: minSpendCents, negateMaxOrders: maxOrders, negateWindowDays: windowDays })
    expect(judge('loosen', 'negate', n(15, 1000, 0), n(10, 1000, 0))).toBe('raise')
    expect(judge('loosen', 'negate', n(15, 1000, 0), n(15, 1000, 1))).toBe('raise')
    expect(judge('loosen', 'negate', n(15, 1000, 0), n(15, 1000, 0, 60))).toBe('raise')
    expect(judge('loosen', 'negate', n(15, 1000, 0), n(20, 1500, 0))).toBe('lower')
  })

  it('a stop: a pause or a higher stop bid raises (no group = low bids at 2¢)', () => {
    const stop = (method: string, bid: number | null) => ({ stopMethod: method, stopBidCents: bid })
    expect(judge('pause', 'stop', stop('LOW_BIDS', 5), stop('LOW_BIDS', 10))).toBe('raise')
    expect(judge('pause', 'stop', stop('LOW_BIDS', 10), null)).toBe('lower')
    expect(judge('pause', 'stop', null, stop('LOW_BIDS', null))).toBe('same')
    expect(judge('pause', 'stop', stop('LOW_BIDS', 5), stop('PAUSE', 5))).toBe('raise')
  })

  it("Claude's autonomy: a level up, or an action left out (the strategy no longer narrows it), raises", () => {
    expect(judge('autonomy', 'claudeAutonomy', { bid: 'ask' }, { bid: 'confirm' })).toBe('raise')
    expect(judge('autonomy', 'claudeAutonomy', { bid: 'ask' }, null)).toBe('raise')
    expect(judge('autonomy', 'claudeAutonomy', null, { bid: 'ask' })).toBe('lower')
    expect(judge('autonomy', 'claudeAutonomy', { bid: 'ask', negative: 'auto' }, { bid: 'off', negative: 'auto' })).toBe('lower')
    expect(judge('autonomy', 'claudeAutonomy', { bid: 'ask' }, { bid: 'off', negative: 'confirm' })).toBe('lower')
  })

  it("a campaign's own target cleared or put back: raise when anything it may aim at afterwards beats anything before", () => {
    expect(judgeTargets([25], [30, 30])).toBe('raise')
    expect(judgeTargets([40], [30, 30])).toBe('lower')
    expect(judgeTargets([20, 30], [25])).toBe('raise')
    expect(judgeTargets([30], [30])).toBe('same')
  })
})

// ── plan and apply ────────────────────────────────────────────────────────────────────────────────

describe('a change planned and saved', () => {
  it('a first market row: new limits lower; the row and one version row, with who and how', async () => {
    await inA(async () => {
      const { plan, out } = await saved(it_({ level: 'market', values: { maxBidCents: 150, maxChangePct: 20, monthlySpendCapCents: 900000 }, reason: 'test start' }))
      expect(plan.direction).toBe('lower')
      expect(plan.preview).toMatchObject({ version: { from: 0, to: 1 }, direction: 'lower', raises: [], stepUp: null, reachesAmazon: false, scope: { level: 'MARKET', scopeId: '*', label: 'IT market' } })
      // W1-6 — the budget engine reads the market cap; the bid band and step are stored and shown only (until W1-5).
      expect(plan.preview.liveEffect).toContain('no engine or rule reads them yet')
      expect(plan.preview.liveEffect).toContain('Monthly spend cap binds at once')
      expect(plan.preview.notReadYet).toEqual(expect.arrayContaining(['maxBidCents', 'target']))
      expect(out).toMatchObject({ ok: true, version: 1, direction: 'lower' })
      const row = (await rowOf('MARKET'))!
      expect(row).toMatchObject({ version: 1, maxBidCents: 150, maxChangePct: 20, monthlySpendCapCents: 900000, updatedBy: 'user:u-test', label: 'IT market' })
      const [version] = await versionsOf(row.id)
      expect(version).toMatchObject({ version: 1, op: 'set', direction: 'lower', via: 'screen', approvalId: null, actor: 'Test person', actorUserId: 'u-test', stepUpAt: null, reason: 'test start' })
      expect((version.changes as Json[]).map((c) => [c.field, c.from, c.to, c.direction])).toEqual([
        ['monthlySpendCapCents', null, 900000, 'lower'], ['maxBidCents', null, 150, 'lower'], ['maxChangePct', null, 20, 'lower'],
      ])
      expect((version.values as Json).maxBidCents).toBe(150)
    })
  })

  it('a raise is judged on the value in force and never written without the time its code was confirmed', async () => {
    await inA(async () => {
      // No account default: a first target is judged against the bid optimiser's 30 %; 35 % raises.
      expect((await planned(it_({ level: 'market', values: { target: { kind: 'ACOS', pct: 30 } } }))).changes[0]).toMatchObject({ field: 'target', direction: 'same' })
      const plan = await planned(it_({ level: 'market', values: { maxBidCents: 180, target: { kind: 'ACOS', pct: 35 } }, expectVersion: 1 }))
      expect(plan.direction).toBe('raise')
      expect(plan.preview.raises).toEqual(['Target', 'Highest bid (cents)'])
      expect(plan.preview.stepUp).toMatchObject({ what: 'raises the ads strategy', raises: ['Target', 'Highest bid (cents)'], needs: expect.stringContaining('settings.security.manage') })
      await expect(applyStrategyPlan(plan, SCREEN)).rejects.toThrow(/authenticator code/)
      const out = await applyStrategyPlan(plan, CODED)
      expect(out).toMatchObject({ ok: true, version: 2, direction: 'raise' })
      const row = (await rowOf('MARKET'))!
      expect((await versionsOf(row.id))[1]).toMatchObject({ version: 2, direction: 'raise', stepUpAt: CODED.stepUpAt })
    })
  })

  it('a stale expectVersion is a 409, and a row that moved after the plan is a conflict: nothing is saved', async () => {
    await inA(async () => {
      expect(await refusal(it_({ level: 'market', values: { maxChangePct: 15 }, expectVersion: 1 }))).toMatchObject({ status: 409, code: 'version_moved' })
      const first = await planned(it_({ level: 'market', values: { maxChangePct: 15 } }))
      const second = await planned(it_({ level: 'market', values: { maxChangePct: 10 } }))
      expect(await applyStrategyPlan(first, SCREEN)).toMatchObject({ ok: true, version: 3 })
      expect(await applyStrategyPlan(second, SCREEN)).toMatchObject({ ok: false, status: 409, code: 'version_moved' })
      expect((await rowOf('MARKET'))!).toMatchObject({ version: 3, maxChangePct: 15 })
      expect(await versionsOf((await rowOf('MARKET'))!.id)).toHaveLength(3)
    })
  })

  it('a field on a level that cannot hold it, a half group, a floor above the ceiling in force, nothing to change: refused in words', async () => {
    await inA(async () => {
      expect((await refusal(it_({ level: 'product', productId: ids.q, values: { maxActionsPerRun: 5 } }))).error).toBe('maxActionsPerRun cannot be set on a product row (only on a market row).')
      expect((await refusal(it_({ level: 'market', values: { protect: true } }))).error).toContain('protect cannot be set on a market row')
      expect((await refusal(it_({ level: 'market', values: { harvest: { minOrders: 2 } } }))).status).toBe(400)
      expect((await refusal(it_({ level: 'market', values: { stop: { method: 'PAUSE' } } }))).status).toBe(400)
      // The market's highest bid is 180: a product floor of 200 would sit above it.
      expect((await refusal(it_({ level: 'product', productId: ids.q, values: { minBidCents: 200 } }))).error).toContain('lowest bid in force here would be above the highest bid')
      expect((await refusal(it_({ level: 'market', values: { maxChangePct: 15 } }))).error).toContain('Nothing would change')
      // A monthly cap of 0 reads as "no cap" to the engines: refused at every level, in words.
      for (const scope of [{ level: 'market' }, { level: 'category', categoryId: ids.cat }, { level: 'product', productId: ids.q }]) {
        expect(await refusal(it_({ ...scope, values: { monthlySpendCapCents: 0 } }))).toMatchObject({
          status: 400, error: "monthlySpendCapCents: 0 would mean 'no cap' (as on the Budget Manager); leave it empty for no cap, or use a stop for an immediate stop.",
        })
      }
      expect((await refusal(it_({ level: 'category', categoryId: 'no-such' }))).status).toBe(404)
      expect((await refusal(it_({ level: 'product', sku: 'NO-SUCH-SKU' }))).error).toBe('Product not found')
      expect((await refusal(it_({ level: 'market', productId: ids.q }))).status).toBe(400)
      expect((await refusal({ channel: 'AMAZON', market: 'IT ALY', level: 'market', values: { maxChangePct: 5 } })).error).toContain('one Amazon market code')
    })
  })

  it('a product row is judged on what is in force there; removing it is judged by what it falls back to', async () => {
    await inA(async () => {
      // The market aims at 35 %: a product target of 20 % lowers; removing the row falls back to 35 % — a raise.
      const set = await saved(it_({ level: 'product', sku: 'TEST-W13-Q', values: { target: { kind: 'ACOS', pct: 20 }, goal: 'PROFIT' } }))
      expect(set.plan.changes.find((c) => c.field === 'target')).toMatchObject({
        from: null, to: { targetKind: 'ACOS', targetPct: 20 }, effectiveFrom: { targetKind: 'ACOS', targetPct: 35 }, effectiveTo: { targetKind: 'ACOS', targetPct: 20 }, direction: 'lower',
      })
      expect(set.plan.direction).toBe('raise') // a goal set is a raise (no clear direction)
      const removed = await planned(it_({ level: 'product', productId: ids.q, op: 'remove' }))
      expect(removed.changes.find((c) => c.field === 'target')).toMatchObject({ direction: 'raise', effectiveTo: { targetKind: 'ACOS', targetPct: 35 } })
      expect(removed.preview.version).toEqual({ from: 1, to: null })
      const out = await applyStrategyPlan(removed, CODED)
      expect(out).toMatchObject({ ok: true, version: 2 })
      expect(await rowOf('PRODUCT', ids.q)).toBeNull()
      const history = await db().adsStrategyVersion.findMany({ where: { level: 'PRODUCT', scopeId: ids.q }, orderBy: { version: 'asc' } })
      expect(history.map((v) => [v.version, v.op, v.values == null])).toEqual([[1, 'set', false], [2, 'remove', true]])
    })
  })
})

describe('protected terms and campaign targets', () => {
  it("the market's protected terms: added (lower) and removed (raise), each with its ads audit row", async () => {
    await inA(async () => {
      const add = await saved(it_({ level: 'market', protectedTerms: { add: [{ term: '  Test   Brand ', matchType: 'CONTAINS' }] } }))
      expect(add.plan.direction).toBe('lower')
      expect(add.plan.preview.liveEffect).toContain('binds at once')
      const term = await db().adKeywordProtection.findFirstOrThrow({ where: { term: 'test brand', marketplace: 'IT' } })
      expect(term).toMatchObject({ mode: 'WHITELIST', matchType: 'CONTAINS', campaignId: null })
      expect(await db().advertisingActionLog.count({ where: { actionType: 'add_keyword_protection', entityId: term.id } })).toBe(1)
      expect((await refusal(it_({ level: 'market', protectedTerms: { add: [{ term: 'test brand' }] } }))).error).toContain('already protected')
      expect((await refusal(it_({ level: 'product', productId: ids.q, protectedTerms: { add: [{ term: 'x' }] } }))).error).toContain('use level market')

      const remove = await planned(it_({ level: 'market', protectedTerms: { remove: ['TEST BRAND'] } }))
      expect(remove.direction).toBe('raise')
      expect(remove.changes).toEqual([expect.objectContaining({ field: 'protectedTerms', term: 'test brand', matchType: 'CONTAINS', from: true, to: false, direction: 'raise' })])
      // Undo of the removal puts the term back with its match type.
      const out = await applyStrategyPlan(remove, CODED)
      if ('error' in out) throw new Error(out.error)
      expect(await db().adKeywordProtection.count({ where: { term: 'test brand' } })).toBe(0)
      const back = await saved(undoArgsOf(out.before, out.after))
      expect(back.plan.direction).toBe('lower')
      expect(await db().adKeywordProtection.findFirst({ where: { term: 'test brand' } })).toMatchObject({ matchType: 'CONTAINS' })
    })
  })

  it('clearCampaignTargets clears every own target that shadows the market, judges each, keeps the other settings; undo puts them back', async () => {
    await inA(async () => {
      const plan = await planned(it_({ level: 'market', clearCampaignTargets: true }))
      // The market aims at 35 %: c1 (25 %) would aim higher afterwards — a raise; c2 (40 %) lower.
      const byCampaign = Object.fromEntries(plan.changes.filter((c) => c.campaignId).map((c) => [c.campaign, [c.from, c.to, c.direction]]))
      expect(byCampaign).toEqual({ 'Test campaign low': [25, null, 'raise'], 'Test campaign high': [40, null, 'lower'] })
      expect(plan.preview.shadowedCount).toBe(2)
      expect(plan.preview.liveEffect).toContain("Clearing 2 campaign's own target ACoS")
      expect(plan.raises).toEqual(["Campaign's own target ACoS (%): Test campaign low"])
      const out = await applyStrategyPlan(plan, CODED)
      if ('error' in out) throw new Error(out.error)
      expect(await targetOf(ids.c1)).toEqual({ maxBidChangePct: 15 })
      expect(await targetOf(ids.c2)).toEqual({})
      expect(await db().advertisingActionLog.count({ where: { actionType: 'set_campaign_goal', entityId: { in: [ids.c1, ids.c2] } } })).toBe(2)
      expect(out.before.campaignTargets).toEqual({ [ids.c1]: 0.25, [ids.c2]: 0.4 })

      const undo = undoArgsOf(out.before, out.after)
      expect(undo).toMatchObject({ level: 'market', op: 'set', restoreCampaignTargets: expect.arrayContaining([{ campaignId: ids.c1, targetAcosPct: 25 }, { campaignId: ids.c2, targetAcosPct: 40 }]) })
      const back = await saved(undo)
      // Putting c2 back at 40 % lets it aim higher again: the undo of a lowering is a raise.
      expect(back.plan.direction).toBe('raise')
      expect(await targetOf(ids.c1)).toEqual({ maxBidChangePct: 15, targetAcos: 0.25 })
      expect(await targetOf(ids.c2)).toEqual({ targetAcos: 0.4 })
      expect(await strategyStateNow(out.before)).toEqual({ ...out.before, version: out.before.version + 2 })
    })
  })

  it('a campaign of another market, or one that does not exist, is not restored', async () => {
    await inA(async () => {
      expect((await refusal(it_({ level: 'market', restoreCampaignTargets: [{ campaignId: 'no-such', targetAcosPct: 30 }] }))).status).toBe(404)
      expect((await refusal(it_({ level: 'category', categoryId: ids.cat, clearCampaignTargets: true }))).error).toContain('use it with level market')
    })
  })
})

describe('undo, money and business', () => {
  it('undoArgsOf puts a category row back exactly, and a row it created is removed', async () => {
    await inA(async () => {
      const first = await saved(it_({ level: 'category', categoryId: ids.cat, values: { maxBidCents: 120, harvest: { minOrders: 3, minClicks: 8, maxAcosPct: null, windowDays: 60 }, claudeAutonomy: { bid: 'ask', negative: 'confirm' } } }))
      if ('error' in first.out) throw new Error('not applied')
      const second = await saved(it_({ level: 'category', categoryId: ids.cat, values: { harvest: null, claudeAutonomy: { bid: 'ask' } } }))
      if ('error' in second.out) throw new Error('not applied')
      // harvest cleared and an autonomy key dropped (negative is no longer narrowed): both raise.
      expect(second.plan.changes.map((c) => [c.field, c.direction])).toEqual([['harvest', 'raise'], ['claudeAutonomy', 'raise']])
      // What Claude may do alone is read at once, by Claude's door (W1-8): the live effect says so.
      expect(second.plan.preview.liveEffect).toContain("What Claude may do alone binds at once: read by Claude's door")
      expect(second.plan.preview.readBy.claudeAutonomy).toEqual([expect.stringContaining("Claude's door")])
      const undo = await saved(undoArgsOf(second.out.before, second.out.after))
      expect(undo.plan.direction).toBe('lower')
      expect((await strategyStateNow(second.out.before)).values).toEqual(second.out.before.values)
      const created = undoArgsOf(first.out.before, first.out.after)
      expect(created).toMatchObject({ op: 'remove', level: 'category', categoryId: ids.cat })
    })
  })

  it('changes are keyed by registry or column name, labels carry no amount, and the history read strips the money', async () => {
    await inA(async () => {
      await saved(it_({ level: 'market', values: { minBidCents: 7, target: { kind: 'ACOS', pct: 22 } } }))
      const row = (await rowOf('MARKET'))!
      const last = (await versionsOf(row.id)).at(-1)!
      const changes = last.changes as Json[]
      expect(changes.map((c) => c.field)).toEqual(['target', 'minBidCents'])
      for (const c of changes) expect(c.label).not.toMatch(/\d/)
      const read = await readStrategy({ market: 'IT', view: 'history', limit: 1 })
      if ('error' in read) throw new Error(read.error)
      const hidden = JSON.stringify(financialPayloadCopy(read.data, { isOwner: false, permissions: new Set() }, STRATEGY_MONEY))
      expect(hidden).not.toContain('"targetPct":')
      expect(hidden).not.toContain('"minBidCents":')
      expect(hidden).toContain('"targetKind":"ACOS"')
      const shown = JSON.stringify(financialPayloadCopy(read.data, { isOwner: false, permissions: new Set([FIELDS.financialsAdspendView]) }, STRATEGY_MONEY))
      expect(shown).toContain('"targetPct":22')
    })
  })

  it("another business neither sees this one's rows nor finds its category", async () => {
    await inB(async () => {
      expect((await refusal(it_({ level: 'category', categoryId: ids.cat, values: { maxBidCents: 1 } }))).status).toBe(404)
      const plan = await planned(it_({ level: 'market', values: { maxBidCents: 700 } }))
      expect(plan.preview.version).toEqual({ from: 1, to: 2 })
      expect(plan.changes).toEqual([expect.objectContaining({ field: 'maxBidCents', from: 777, to: 700, direction: 'lower' })])
      expect(plan.preview.shadowedCount).toBe(0)
    })
  })
})

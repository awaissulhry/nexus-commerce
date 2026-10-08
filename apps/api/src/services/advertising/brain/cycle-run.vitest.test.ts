/**
 * ONE BRAIN AB-14 — the product cycle's run (brain/cycle-run.ts) on PGlite (the production schema), each lever's module a
 * recorder that answers what the test says — so the cycle itself is what is checked:
 *
 *   off        NEXUS_ADS_BRAIN_CYCLE off (the default): nothing read, nothing written, no module called
 *   order      per market, step by step: every product's state, the market's term ledger once, then negatives, harvest,
 *              money, bids, hours
 *   change set every step of a product runs inside its change set: a write packed there carries it (packEvidence)
 *   sees       a step gets what its earlier steps decided: the money step's raise holds reach the bids
 *   idempotent a rerun on the same data day runs no step again and writes nothing; the hourly state pass that decides
 *              nothing new writes nothing either
 *   failure    an acting step that fails blocks every later step; a step in shadow that fails blocks only what reads it
 *              (negatives → harvest: the pair is never half applied); the next tick tries what did not end, at most 3
 *              runs a data day
 *   when       a new data day from 05:55 UTC (at once for a product never run); never a data day older than the newest
 *              cycle; a cycle another run holds is left
 *   report     stored on the cycle and read through the ads-brain view report; the hourly pass adds what it did as "later"
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})

const { runCycleTick } = await import('./cycle-run.js')
const { changeSetIdOf, raiseHoldsFor, CYCLE_STEPS } = await import('./cycle.js')
const { brainCycleStamp, packEvidence } = await import('../ads-evidence.js')
const { settledEnd } = await import('../ads-settled-window.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
type Outcome = import('./cycle.js').StepOutcome
type Step = import('./cycle.js').CycleStep
type Ctx = import('./cycle-steps.js').StepContext
type Row = Record<string, any>

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const at = (iso: string) => new Date(iso)
const dayOf = (now: Date) => settledEnd('SPONSORED_PRODUCTS', { now }).until.toISOString().slice(0, 10)
const T1 = at('2026-10-09T06:55:00Z')
const hoursAfter = (d: Date, n: number) => new Date(d.getTime() + n * 3_600_000)

// The recorder: every call in order, the change set it ran in, and what it answers.
interface Call { step: Step; productId: string; market: string; changeSetId: string | null; stampStep: string | null; packed: string | null; seen?: Record<string, string> }
const h = { calls: [] as Call[], answer: {} as Partial<Record<Step, (ctx: Ctx) => Outcome>> }
const done = (why: string): Outcome => ({ status: 'done', why })
function recorder(step: Exclude<Step, 'terms'>) {
  return async (ctx: Ctx): Promise<Outcome> => {
    const stamp = brainCycleStamp()
    const call: Call = { step, productId: ctx.productId, market: ctx.market, changeSetId: stamp?.changeSetId ?? null, stampStep: stamp?.step ?? null, packed: packEvidence(null)?.cycle?.changeSetId ?? null }
    if (step === 'bids') call.seen = Object.fromEntries(raiseHoldsFor(ctx.records, new Set(ctx.own.keys())))
    h.calls.push(call)
    return (h.answer[step] ?? (() => done(`${step} ran`)))(ctx)
  }
}
const runners = {
  state: recorder('state'), negatives: recorder('negatives'), harvest: recorder('harvest'), money: recorder('money'), bids: recorder('bids'), hours: recorder('hours'),
  terms: async (market: string, ctxs: readonly Ctx[]) => {
    h.calls.push({ step: 'terms', productId: ctxs.map((c) => c.productId).join('+'), market, changeSetId: brainCycleStamp()?.changeSetId ?? null, stampStep: null, packed: null })
    return new Map(ctxs.map((c) => [c.productId, h.answer.terms ? h.answer.terms(c) : done('terms ran')]))
  },
}
const tick = (now: Date) => inside(() => runCycleTick({ now, runners }))
const cycles = () => inside(() => (database.client as any).adsBrainCycle.findMany({ orderBy: [{ productId: 'asc' }, { marketplace: 'asc' }, { dataDay: 'asc' }] })) as Promise<Row[]>
const cycleOf = async (productId: string, market: string) => (await cycles()).filter((r) => r.productId === productId && r.marketplace === market)
const statuses = (row: Row) => Object.fromEntries(CYCLE_STEPS.map((s) => [s, row.steps?.[s]?.status ?? null]))
const callsFor = (productId: string, market: string) => h.calls.filter((c) => c.market === market && c.productId.split('+').includes(productId)).map((c) => c.step)
const report = (args: Record<string, unknown>) => inside(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'report', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Row; error?: string }>
const failFor = (productId: string, market: string, why: string, otherwise: (ctx: Ctx) => Outcome = () => done('ran')) => (ctx: Ctx): Outcome =>
  (ctx.productId === productId && ctx.market === market ? { status: 'failed', why } : otherwise(ctx))

async function seed() {
  const db = database.client as any
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  const campaign = async (id: string, name: string, market: string, adProductId: string, asin: string) => {
    await db.campaign.create({ data: { id, name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: market, externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: at('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
    await db.adGroup.create({ data: { id: `g-${id}`, campaignId: id, name: `group ${id}`, externalAdGroupId: `EXT-g-${id}` } })
    await db.adProductAd.create({ data: { adGroupId: `g-${id}`, productId: adProductId, asin } })
  }
  await product('jacket', 'CYC-JACKET', { isParent: true, name: 'Jacket' })
  await product('jacket-m', 'CYC-JACKET-M', { parentId: 'jacket', amazonAsin: 'B0CYCJACKM' })
  await product('helmet', 'CYC-HELMET', { isParent: true, name: 'Helmet' })
  await product('helmet-m', 'CYC-HELMET-M', { parentId: 'helmet', amazonAsin: 'B0CYCHELMM' })
  await campaign('c-jacket-it', 'Jacket exact', 'IT', 'jacket-m', 'B0CYCJACKM')
  await campaign('c-jacket-de', 'Jacket DE', 'DE', 'jacket-m', 'B0CYCJACKM')
  await campaign('c-helmet-it', 'Helmet exact', 'IT', 'helmet-m', 'B0CYCHELMM')
  for (const [productId, marketplace] of [['jacket', 'IT'], ['helmet', 'IT'], ['jacket', 'DE']]) await db.adsBrainEnrollment.create({ data: { productId, marketplace, enrolledBy: 'user:owner', updatedBy: 'user:owner' } })
}
const setLevel = (productId: string, market: string, lever: string, value: string) =>
  inside(() => (database.client as any).adsBrainOverride.create({ data: { productId, marketplace: market, scope: 'PRODUCT', kind: 'LEVEL', key: lever, ref: '', value, by: 'user:owner', reason: 'test' } }))
const insertCycle = (productId: string, market: string, dataDay: string, extra: Record<string, unknown> = {}) =>
  inside(() => (database.client as any).adsBrainCycle.create({ data: { productId, marketplace: market, dataDay: new Date(`${dataDay}T00:00:00Z`), changeSetId: changeSetIdOf(productId, market, dataDay), status: 'DONE', attempts: 1, steps: {}, ...extra } }))
const clearCycles = () => inside(() => (database.client as any).adsBrainCycle.deleteMany({}))
const nextDay = (day: string, n = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(seed)
}, 120_000)
afterAll(async () => { await database?.close() })
beforeEach(async () => {
  h.calls = []
  h.answer = {}
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
  await clearCycles()
  await inside(() => (database.client as any).adsBrainOverride.deleteMany({}))
})

describe('AB-14 — the product cycle', () => {
  it('off (the default): nothing read, nothing written, no module called — every lever keeps its own cron', async () => {
    const r = await tick(T1)
    expect(r).toMatchObject({ ran: false, cycles: [], statePasses: [], pruned: 0, why: expect.stringMatching(/off \(NEXUS_ADS_BRAIN_CYCLE\)/) })
    expect(h.calls).toEqual([])
    expect(await cycles()).toEqual([])
  })

  it('order: market by market, step by step — each product\'s state, the market\'s ledger once, then negatives, harvest, money, bids, hours', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    const day = dayOf(T1)
    const r = await tick(T1)
    expect(r).toMatchObject({ ran: true, dataDay: day, left: [] })
    expect(h.calls.map((c) => `${c.market}:${c.step}:${c.productId}`)).toEqual([
      'DE:state:jacket', 'DE:terms:jacket', 'DE:negatives:jacket', 'DE:harvest:jacket', 'DE:money:jacket', 'DE:bids:jacket', 'DE:hours:jacket',
      'IT:state:helmet', 'IT:state:jacket', 'IT:terms:helmet+jacket', 'IT:negatives:helmet', 'IT:negatives:jacket', 'IT:harvest:helmet', 'IT:harvest:jacket',
      'IT:money:helmet', 'IT:money:jacket', 'IT:bids:helmet', 'IT:bids:jacket', 'IT:hours:helmet', 'IT:hours:jacket',
    ])
    const rows = await cycles()
    expect(rows.map((x) => [x.productId, x.marketplace, x.status, x.attempts, x.changeSetId])).toEqual([
      ['helmet', 'IT', 'DONE', 1, changeSetIdOf('helmet', 'IT', day)], ['jacket', 'DE', 'DONE', 1, changeSetIdOf('jacket', 'DE', day)], ['jacket', 'IT', 'DONE', 1, changeSetIdOf('jacket', 'IT', day)],
    ])
    expect(rows.every((x) => x.leaseUntil === null && x.finishedAt !== null)).toBe(true)
    expect(statuses(rows[2])).toEqual(Object.fromEntries(CYCLE_STEPS.map((s) => [s, 'done'])))
    expect(r.cycles.map((c) => [c.market, c.productId, c.status])).toEqual([['DE', 'jacket', 'DONE'], ['IT', 'helmet', 'DONE'], ['IT', 'jacket', 'DONE']])
  })

  it('one change set: every step of a product runs inside its own, and a write packed there carries it; the ledger (shadow, market-wide) inside none', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    const day = dayOf(T1)
    await tick(T1)
    for (const c of h.calls.filter((x) => x.step !== 'terms')) {
      const id = changeSetIdOf(c.productId, c.market, day)
      expect([c.changeSetId, c.stampStep, c.packed], `${c.market} ${c.step} ${c.productId}`).toEqual([id, c.step, id])
    }
    expect(h.calls.filter((x) => x.step === 'terms').map((x) => x.changeSetId)).toEqual([null, null])
    expect(brainCycleStamp()).toBeNull()
  })

  it('each step sees what the earlier steps decided: the money step\'s raise holds reach the bids, on its own campaigns only', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.answer.money = (ctx) => ({ status: 'done', why: 'brake hold_raises', holds: [...ctx.own.keys()].map((id) => [id, 'the money brake (hold_raises) holds every raise'] as [string, string]) })
    await tick(T1)
    const bids = h.calls.filter((c) => c.step === 'bids')
    expect(bids.map((c) => [c.market, c.productId, c.seen])).toEqual([
      ['DE', 'jacket', { 'c-jacket-de': 'the product cycle\'s money (campaign budgets and the portfolio cap) step: the money brake (hold_raises) holds every raise' }],
      ['IT', 'helmet', { 'c-helmet-it': 'the product cycle\'s money (campaign budgets and the portfolio cap) step: the money brake (hold_raises) holds every raise' }],
      ['IT', 'jacket', { 'c-jacket-it': 'the product cycle\'s money (campaign budgets and the portfolio cap) step: the money brake (hold_raises) holds every raise' }],
    ])
  })

  it('idempotent: a rerun on the same data day runs no step again and writes nothing — the hourly state pass decided nothing new', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    await tick(T1)
    const before = await cycles()
    h.calls = []
    const r = await tick(hoursAfter(T1, 1))
    expect(r.cycles).toEqual([])
    expect(h.calls.map((c) => [c.step, c.market, c.productId, c.changeSetId])).toEqual([
      ['state', 'DE', 'jacket', before[1].changeSetId], ['state', 'IT', 'helmet', before[0].changeSetId], ['state', 'IT', 'jacket', before[2].changeSetId],
    ])
    expect(r.statePasses.map((p) => p.stored)).toEqual([false, false, false])
    expect(await cycles()).toEqual(before)
    // And again in the same hour: the same.
    await tick(hoursAfter(T1, 1.5))
    expect(await cycles()).toEqual(before)
  })

  it('an acting step that fails blocks every later step; the next tick tries it and what waited — only that', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    await setLevel('jacket', 'IT', 'state', 'AUTO')
    h.answer.state = failFor('jacket', 'IT', 'the state run failed: database away')
    await tick(T1)
    expect(callsFor('jacket', 'IT')).toEqual(['state'])
    const [failed] = await cycleOf('jacket', 'IT')
    expect(failed).toMatchObject({ status: 'PARTIAL', attempts: 1, leaseUntil: null })
    expect(statuses(failed)).toEqual({ state: 'failed', terms: 'blocked', negatives: 'blocked', harvest: 'blocked', money: 'blocked', bids: 'blocked', hours: 'blocked' })
    expect(failed.steps.state).toMatchObject({ acts: true, attempt: 1 })
    expect(failed.steps.money.why).toMatch(/^waits for stops and state: stops and state acts on this product \(PROPOSE or AUTO\) and failed/)
    expect((await cycleOf('helmet', 'IT'))[0].status).toBe('DONE')
    expect(failed.report.problems[0]).toMatch(/^stops and state failed: the state run failed: database away/)
    // The next tick: the state works now — the jacket's cycle runs what did not end; the others only their hourly state.
    h.calls = []
    h.answer = {}
    const r = await tick(hoursAfter(T1, 1))
    expect(callsFor('jacket', 'IT')).toEqual(['state', 'terms', 'negatives', 'harvest', 'money', 'bids', 'hours'])
    expect(h.calls.filter((c) => c.productId !== 'jacket' || c.market !== 'IT').map((c) => c.step)).toEqual(['state', 'state'])
    expect(r.cycles.map((c) => [c.productId, c.market, c.status, c.attempt])).toEqual([['jacket', 'IT', 'DONE', 2]])
    const [again] = await cycleOf('jacket', 'IT')
    expect(again).toMatchObject({ status: 'DONE', attempts: 2 })
    expect(again.steps.state.attempt).toBe(2)
  })

  it('a step in shadow that fails blocks only what reads it: negatives → harvest (the pair), never the money or the bids', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.answer.negatives = failFor('helmet', 'IT', 'the run failed for it: timeout')
    h.answer.money = failFor('jacket', 'IT', 'the money plan failed: no market')
    await tick(T1)
    expect(statuses((await cycleOf('helmet', 'IT'))[0])).toEqual({ state: 'done', terms: 'done', negatives: 'failed', harvest: 'blocked', money: 'done', bids: 'done', hours: 'done' })
    expect((await cycleOf('helmet', 'IT'))[0].steps.harvest.why).toMatch(/^waits for negatives: it reads what negatives decides/)
    expect(statuses((await cycleOf('jacket', 'IT'))[0])).toEqual({ state: 'done', terms: 'done', negatives: 'done', harvest: 'done', money: 'failed', bids: 'done', hours: 'done' })
    expect(callsFor('helmet', 'IT')).not.toContain('harvest')
    // Acting money that fails holds the bids (budget before bid).
    await clearCycles()
    await setLevel('jacket', 'IT', 'budgets', 'AUTO')
    h.calls = []
    await tick(T1)
    expect(statuses((await cycleOf('jacket', 'IT'))[0])).toMatchObject({ money: 'failed', bids: 'blocked', hours: 'blocked' })
    expect(callsFor('jacket', 'IT')).toEqual(['state', 'terms', 'negatives', 'harvest', 'money'])
  })

  it('at most 3 runs a data day: then the cycle stays PARTIAL and only the hourly state pass runs', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    await setLevel('jacket', 'IT', 'state', 'AUTO')
    h.answer.state = failFor('jacket', 'IT', 'the state run failed: still away')
    for (let i = 0; i < 4; i++) await tick(hoursAfter(T1, i))
    const [row] = await cycleOf('jacket', 'IT')
    expect(row).toMatchObject({ status: 'PARTIAL', attempts: 3 })
    expect(h.calls.filter((c) => c.productId === 'jacket' && c.market === 'IT').map((c) => c.step)).toEqual(['state', 'state', 'state', 'state'])
    expect(row.report.headline).toMatch(/cycle not finished \(run 3 of 3\)/)
  })

  it('when: a never-run product at once; then a new data day only from 05:55 UTC; never an older data day; a held cycle is left', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    const early = at('2026-10-08T03:55:00Z')
    const d0 = dayOf(early)
    await tick(early) // never run: at once, whatever the hour
    expect((await cycles()).map((r) => [r.productId, r.marketplace, r.dataDay.toISOString().slice(0, 10)])).toEqual([['helmet', 'IT', d0], ['jacket', 'DE', d0], ['jacket', 'IT', d0]])
    // The next night, before 05:00 UTC: a new data day, but only the hourly state pass (in yesterday's change set).
    const night = at('2026-10-09T03:55:00Z')
    const d1 = dayOf(night)
    expect(d1).toBe(nextDay(d0))
    h.calls = []
    await tick(night)
    expect((await cycles()).length).toBe(3)
    expect(h.calls.map((c) => [c.step, c.changeSetId])).toEqual([['state', changeSetIdOf('jacket', 'DE', d0)], ['state', changeSetIdOf('helmet', 'IT', d0)], ['state', changeSetIdOf('jacket', 'IT', d0)]])
    // A cycle another run holds is left; a newer cycle than the data day (the facts moved back) is never followed by an older one.
    await insertCycle('helmet', 'IT', d1, { status: 'RUNNING', leaseUntil: hoursAfter(night, 3) })
    await insertCycle('jacket', 'DE', nextDay(d1))
    h.calls = []
    const r = await tick(at('2026-10-09T05:55:00Z'))
    expect(r.cycles.map((c) => [c.productId, c.market])).toEqual([['jacket', 'IT']])
    expect(r.left).toEqual([{ productId: 'helmet', market: 'IT', why: 'another run holds its cycle' }])
    expect((await cycleOf('jacket', 'DE')).map((x) => x.dataDay.toISOString().slice(0, 10))).toEqual([d0, nextDay(d1)])
    expect(h.calls.filter((c) => c.market === 'DE').map((c) => [c.step, c.changeSetId])).toEqual([['state', changeSetIdOf('jacket', 'DE', nextDay(d1))]])
  })

  it('the report: stored on the cycle, read through the ads-brain view report; the hourly pass adds what it did, once', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.answer.money = () => ({ status: 'done', why: 'PROPOSE: brake none', waiting: [{ what: 'the portfolio cap', approvalId: 'appr-1' }], did: { lines: ['asked a person for the campaign budgets: raise 1'], money: { lines: ['The cap asked for: €100.00.'] } } })
    await tick(T1)
    const day = dayOf(T1)
    const [row] = await cycleOf('jacket', 'IT')
    expect(row.report).toMatchObject({ v: 1, productId: 'jacket', name: 'Jacket', market: 'IT', dataDay: day, status: 'DONE', waitsForOwner: [{ what: 'the portfolio cap', approvalId: 'appr-1' }] })
    expect(row.report.headline).toBe(`Jacket in IT, data day ${day}: cycle done — 7 levers decided, all in shadow or off; 1 request waiting for you.`)
    expect(row.report.money.lines).toContain('The cap asked for: €100.00.')
    expect(row.summary).toContain('Waiting for you: the portfolio cap (approval appr-1).')
    expect(row.summary).not.toMatch(/€/)
    // Read by Claude: the view, a variation naming its parent.
    const view = await report({ market: 'IT', productId: 'jacket-m' })
    expect(view.ok).toBe(true)
    expect(view.data).toMatchObject({ view: 'report', switch: 'on', scope: { productId: 'jacket', market: 'IT', askedFor: 'jacket-m' }, dataDay: day, status: 'DONE', changeSetId: changeSetIdOf('jacket', 'IT', day), summary: row.summary })
    expect(view.data!.steps.map((s: Row) => [s.step, s.status])).toEqual(CYCLE_STEPS.map((s) => [s, 'done']))
    const market = await report({ market: 'IT' })
    expect(market.data!.products.map((p: Row) => [p.productId, p.status, p.waiting])).toEqual([['helmet', 'DONE', 1], ['jacket', 'DONE', 1]])
    expect((await report({ market: 'IT', productId: 'jacket', day: '2026-01-01' })).data).toMatchObject({ report: null, why: 'no cycle ran for data day 2026-01-01' })
    expect((await report({})).error).toMatch(/name the market/)
    // The hourly pass that decides something: added as "later", once.
    h.answer = { state: (ctx) => (ctx.productId === 'jacket' && ctx.market === 'IT' ? { status: 'done', why: 'AUTO: pause 1', did: { lines: ['Jacket exact: pause queued — out of stock'], counts: { pause: 1, stored: 1, acted: 1 } } } : done('nothing new')) }
    await tick(hoursAfter(T1, 2))
    await tick(hoursAfter(T1, 3))
    const [later] = await cycleOf('jacket', 'IT')
    expect(later.report.later).toEqual([{ at: hoursAfter(T1, 2).toISOString(), line: 'stops and state: Jacket exact: pause queued — out of stock' }])
    expect(later.summary).toMatch(/\nLater \(08:55 UTC\): stops and state: Jacket exact: pause queued — out of stock$/)
    expect((await cycleOf('helmet', 'IT'))[0].report.later).toEqual([])
  })

  it('the view with the cycle off, or a product not enrolled, says why there is no report', async () => {
    expect((await report({ market: 'IT', productId: 'jacket' })).data).toMatchObject({ switch: 'off', report: null, why: expect.stringMatching(/the product cycle is off/) })
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    expect((await report({ market: 'FR', productId: 'jacket' })).data).toMatchObject({ report: null, why: expect.stringMatching(/not enrolled in the brain in this market/) })
    expect((await report({ market: 'IT', productId: 'jacket' })).data).toMatchObject({ report: null, why: expect.stringMatching(/no cycle has run for it yet/) })
  })
})

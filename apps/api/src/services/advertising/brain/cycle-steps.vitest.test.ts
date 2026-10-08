/**
 * ONE BRAIN AB-14 — each step of the product cycle (brain/cycle-steps.ts), its lever's module a stub: the step runs the
 * module for ONE product (the term ledger for its market), says off / skipped / failed / done in the module's own words,
 * and hands on what the later steps need — a pause or a budget cut holds the bid raises only where its lever acts, in
 * shadow it is a clash when the bids raise there; the bids get the product's own campaigns and those holds; requests that
 * wait for a person are named. Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  state: vi.fn(),
  loadTermsMarket: vi.fn(),
  decideMarket: vi.fn(),
  storeLedger: vi.fn(async () => ({ created: 2, changed: 0, unchanged: 1, removed: 0 })),
  storeLeads: vi.fn(async () => ({ created: 0, changed: 0, unchanged: 0, removed: 0 })),
  negatives: vi.fn(),
  money: vi.fn(),
  newestMoney: vi.fn(async () => new Map()),
  bids: vi.fn(),
  bidMode: 'shadow' as 'off' | 'shadow' | 'live',
  hours: vi.fn(),
  harvest: vi.fn(),
  halfDone: vi.fn(async () => 0),
  lastProposal: null as null | { id: string; status: string; approvalId: string | null; why: string },
  daily: [] as Array<{ date: Date; currencyCode: string; _sum: { costMicros: bigint; sales7dCents: number; orders7d: number } }>,
}))
vi.mock('./state-run.js', () => ({ runStateBrainOnce: m.state }))
vi.mock('./terms-shadow.js', () => ({ loadTermsMarket: m.loadTermsMarket, decideMarket: m.decideMarket, storeLedger: m.storeLedger, storeLeads: m.storeLeads }))
vi.mock('./negatives-run.js', () => ({ runNegativesOnce: m.negatives }))
vi.mock('./budget-shadow.js', () => ({ runMoneyShadowOnce: m.money, newestMoneyDecisions: m.newestMoney }))
vi.mock('../bid-brain/shadow.js', () => ({ runShadowOnce: m.bids, bidBrainMode: () => m.bidMode }))
vi.mock('./hours-proposal.js', () => ({ runHoursOnce: m.hours }))
vi.mock('./harvest-run.js', () => ({ runHarvestOnce: m.harvest }))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainHourProposal: { findFirst: vi.fn(async () => m.lastProposal) },
    adsBrainHarvest: { count: m.halfDone },
    amazonAdsDailyPerformance: { groupBy: vi.fn(async () => m.daily) },
  },
}))

import { bidsStep, harvestStep, harvestStepOf, hoursStep, moneyStep, negativesStep, readMoneyInOut, stateStep, termsStep, type StepContext, type TickFacts } from './cycle-steps.js'
import { CYCLE_STEPS, type CycleStep, type StepRecord } from './cycle.js'

const NOW = new Date('2026-10-09T06:55:00Z')
const OBSERVE = { negatives: { effective: 'OBSERVE' }, harvest: { effective: 'OBSERVE' } }
const due = (productId: string, levers: Record<string, { effective: string }> = OBSERVE) => ({ productId, market: 'IT', settings: { levers } as never })
const tickOf = (over: Partial<TickFacts> = {}): TickFacts => ({
  now: NOW, dataDay: '2026-10-02',
  stateWatch: new Map([['IT|jacket', { productId: 'jacket', market: 'IT', level: 'OBSERVE' as const }]]),
  moneyWatch: new Map([['IT|jacket', { productId: 'jacket', market: 'IT', level: 'OBSERVE' as const }]]),
  termsDue: [due('jacket')],
  ...over,
})
const noneAct = Object.fromEntries(CYCLE_STEPS.map((s) => [s, false])) as Record<CycleStep, boolean>
const ctxOf = (over: Partial<StepContext> = {}): StepContext => ({
  productId: 'jacket', market: 'IT', key: 'IT|jacket', changeSetId: 'cyc-IT-2026-10-02-jacket',
  own: new Map([['c1', 'Jacket exact'], ['c2', 'Jacket broad']]), records: {}, acts: noneAct, tick: tickOf(), ...over,
})
const rec = (over: Partial<StepRecord>): StepRecord => ({ status: 'done', why: 'w', acts: false, attempt: 1, at: NOW.toISOString(), ...over })

beforeEach(() => { vi.clearAllMocks(); m.bidMode = 'shadow'; m.lastProposal = null; m.daily = [] })

describe('AB-14 — ① stops and state', () => {
  it('off when the product and its campaigns do not watch the state lever: the module is never called', async () => {
    expect(await stateStep(ctxOf({ tick: tickOf({ stateWatch: new Map() }) }))).toMatchObject({ status: 'off', why: expect.stringMatching(/state lever is OFF/) })
    expect(m.state).not.toHaveBeenCalled()
  })

  it('the module for the product alone; an acting pause holds the bid raises, a shadow pause is only noted, a request waits', async () => {
    m.state.mockResolvedValue({
      runId: 'bs-1', ran: true, why: '', failed: [], pruned: 0,
      campaigns: [
        { campaignId: 'c1', productId: 'jacket', market: 'IT', action: 'pause', outcome: 'queued', stored: 'change', why: 'out of stock for 10 days' },
        { campaignId: 'c2', productId: 'jacket', market: 'IT', action: 'pause', outcome: 'asked', stored: 'change', why: 'out of stock for 10 days', approvalId: 'appr-9' },
        { campaignId: 'c3', productId: 'jacket', market: 'IT', action: 'pause', outcome: 'shadow', stored: null, why: 'out of stock' },
        { campaignId: 'c4', productId: 'jacket', market: 'IT', action: 'keep', outcome: 'none', stored: null, why: 'serving' },
      ],
    })
    const out = await stateStep(ctxOf())
    expect(m.state).toHaveBeenCalledWith({ now: NOW, products: [{ productId: 'jacket', market: 'IT', level: 'OBSERVE' }] })
    expect(out).toMatchObject({ status: 'done', runId: 'bs-1', why: 'OBSERVE: pause 3, keep 1' })
    expect(out.holds).toEqual([['c1', 'it pauses Jacket exact (queued)'], ['c2', 'it pauses Jacket broad (asked)']])
    expect(out.did!.shadowHolds).toEqual([['c3', 'the state step (shadow) would pause c3']])
    expect(out.waiting).toEqual([{ what: 'pause Jacket broad', approvalId: 'appr-9' }])
    expect(out.did!.counts).toMatchObject({ pause: 3, keep: 1, stored: 2, acted: 2 })
    expect(out.did!.lines[0]).toBe('Jacket exact: pause queued — out of stock for 10 days')
  })

  it('a product the module failed for is a failed step, in its words', async () => {
    m.state.mockResolvedValue({ runId: 'bs-2', ran: true, why: '', campaigns: [], pruned: 0, failed: [{ productId: 'jacket', market: 'IT', error: 'no family root' }] })
    expect(await stateStep(ctxOf())).toEqual({ status: 'failed', why: 'the state run failed: no family root', runId: 'bs-2' })
  })
})

describe('AB-14 — ② the term ledger, per market', () => {
  const facts = { dataDay: new Date('2026-10-02T00:00:00Z'), windowDays: 60, products: new Map([['jacket', {}], ['helmet', {}]]) }
  const decision = (state: string, clashes = 0) => ({ state, clashes: Array.from({ length: clashes }, () => ({})) })

  it('every due product of the market decides together; each running product\'s ledger stored under its change set, the leads once', async () => {
    m.loadTermsMarket.mockResolvedValue(facts)
    m.decideMarket.mockReturnValue({ byProduct: new Map([['jacket', [decision('TARGETED'), decision('WATCH', 1)]], ['helmet', [decision('WATCH')]]]), leads: new Map([['race jacket', {}]]) })
    const tick = tickOf({ termsDue: [due('jacket'), due('helmet'), due('boots')] })
    const out = await termsStep('IT', [ctxOf({ tick }), ctxOf({ productId: 'boots', key: 'IT|boots', changeSetId: 'cyc-IT-2026-10-02-boots', tick }), ctxOf({ productId: 'gloves', key: 'IT|gloves', tick })])
    expect(m.loadTermsMarket).toHaveBeenCalledWith('IT', tick.termsDue, NOW)
    expect(m.storeLedger).toHaveBeenCalledTimes(1)
    expect(m.storeLedger).toHaveBeenCalledWith(expect.objectContaining({ productId: 'jacket', market: 'IT', runId: 'cyc-IT-2026-10-02-jacket', windowDays: 60 }))
    expect(m.storeLeads).toHaveBeenCalledWith({ market: 'IT', leads: expect.any(Map), runId: 'cyc-IT-2026-10-02', now: NOW })
    expect(out.get('jacket')).toMatchObject({ status: 'done', why: 'SHADOW: 2 terms decided (TARGETED 1, WATCH 1)', did: { counts: { TARGETED: 1, WATCH: 1, created: 2 } } })
    expect(out.get('jacket')!.did!.lines[1]).toMatch(/^the ledger removes 1 clash/)
    expect(out.get('boots')).toMatchObject({ status: 'skipped', why: expect.stringMatching(/no Sponsored Products campaign of its own/) })
    expect(out.get('gloves')).toMatchObject({ status: 'off' })
  })

  it('the market could not be read: every running product failed; nothing due: nothing read', async () => {
    m.loadTermsMarket.mockRejectedValue(new Error('timeout'))
    expect((await termsStep('IT', [ctxOf()])).get('jacket')).toEqual({ status: 'failed', why: 'the term ledger could not read IT: timeout' })
    m.loadTermsMarket.mockClear()
    expect((await termsStep('IT', [ctxOf({ tick: tickOf({ termsDue: [] }) })])).get('jacket')).toMatchObject({ status: 'off' })
    expect(m.loadTermsMarket).not.toHaveBeenCalled()
  })
})

describe('AB-14 — ③ negatives and ④ harvest', () => {
  it('negatives: off below OBSERVE; the module for the product alone; the day\'s change plan waits for a person', async () => {
    expect(await negativesStep(ctxOf({ tick: tickOf({ termsDue: [due('jacket', { negatives: { effective: 'OFF' }, harvest: { effective: 'OBSERVE' } })] }) }))).toMatchObject({ status: 'off' })
    m.negatives.mockResolvedValue({ ran: true, why: '', runId: 'neg-1', products: 1, markets: ['IT'], planned: 3, byStatus: { PROPOSED: 2, SHADOW: 1 }, stored: {}, proposed: ['appr-3'], skipped: [], pruned: 0 })
    const out = await negativesStep(ctxOf())
    expect(m.negatives).toHaveBeenCalledWith({ now: NOW, due: { due: true, why: 'the product cycle', products: [due('jacket')] } })
    expect(out).toMatchObject({ status: 'done', runId: 'neg-1', waiting: [{ what: 'the day\'s negatives (one change plan)', approvalId: 'appr-3' }] })
    m.negatives.mockResolvedValue({ ran: true, why: '', runId: 'neg-2', planned: 0, byStatus: {}, proposed: [], skipped: [{ productId: 'jacket', market: 'IT', why: 'the run failed for it: timeout' }] })
    expect(await negativesStep(ctxOf())).toMatchObject({ status: 'failed', why: 'the run failed for it: timeout' })
    m.negatives.mockResolvedValue({ ran: true, why: '', runId: 'neg-3', planned: 0, byStatus: {}, proposed: [], skipped: [{ productId: 'jacket', market: 'IT', why: 'no Sponsored Products campaign of its own in this market' }] })
    expect(await negativesStep(ctxOf())).toMatchObject({ status: 'skipped' })
  })

  it('harvest: the module for the product alone after its negatives; off below OBSERVE; a pair left half done a clash', async () => {
    const summary = { ran: true, why: '', runId: 'hv-1', decided: { pairs: 1, newCampaigns: 0, held: 0 }, acted: { logged: 1, proposed: 0, written: 0, campaignsProposed: 0 }, pending: { synced: 0, completed: 0, retried: 0, judged: 0, undoProposed: 0 }, skipped: [] }
    const run = vi.fn(async () => summary)
    const half = vi.fn(async () => 1)
    const out = await harvestStepOf(run, half)(ctxOf())
    expect(run).toHaveBeenCalledWith({ now: NOW, due: { due: true, why: 'the product cycle', products: [due('jacket')] } })
    expect(half).toHaveBeenCalledWith('jacket', 'IT')
    expect(out).toMatchObject({ status: 'done', runId: 'hv-1', did: { lines: ['harvest: pairs 1, logged 1 (shadow: nothing at Amazon)'], clashes: [expect.stringMatching(/^1 harvest pair half done/)] } })
    expect(await harvestStepOf(run)(ctxOf())).not.toHaveProperty('did.clashes')
    expect(await harvestStepOf(run)(ctxOf({ tick: tickOf({ termsDue: [due('jacket', { negatives: { effective: 'OBSERVE' }, harvest: { effective: 'OFF' } })] }) }))).toMatchObject({ status: 'off' })
    run.mockResolvedValueOnce({ ...summary, skipped: [{ productId: 'jacket', market: 'IT', why: 'the run failed for it: timeout' }] })
    expect(await harvestStepOf(run)(ctxOf())).toMatchObject({ status: 'failed' })
    // Wired: AB-11's own run, and its HALF_DONE harvests of the product counted.
    m.harvest.mockResolvedValue(summary)
    m.halfDone.mockResolvedValue(0)
    expect(await harvestStep(ctxOf())).toMatchObject({ status: 'done', runId: 'hv-1' })
    expect(m.halfDone).toHaveBeenCalledWith({ where: { productId: 'jacket', marketplace: 'IT', status: 'HALF_DONE' } })
  })
})

describe('AB-14 — ⑤ money: budget before bid', () => {
  const plan = (brake: string, lower: string[] = []) => ({
    brake: { level: brake, why: 'pace' }, why: 'the month on pace', currency: 'EUR',
    campaigns: [{ campaignId: 'c1', action: lower.includes('c1') ? 'lower' : 'keep' }, { campaignId: 'c2', action: lower.includes('c2') ? 'lower' : 'keep' }],
    counts: { raise: 0, lower: lower.length, keep: 2 - lower.length, hold: 0, ladder: 0 },
    pace: { spentNowCents: 0, projectedCents: 0, pacePct: 50 }, envelope: { cents: 1000 },
    actions: { proposals: [{ kind: 'portfolioCap', key: 'pf-1', approvalId: 'appr-cap', status: 'pending', fresh: true, why: '' }, { kind: 'budgets', key: 'c9', approvalId: 'old', status: 'approved', fresh: false, why: '' }] },
  })
  const moneyRun = (mode?: string) => ({ runId: 'bm-1', ran: true, why: '', failed: [], pruned: 0, products: [{ productId: 'jacket', market: 'IT', stored: 'change', brake: 'hold_raises', pacePct: 96, why: 'p', ...(mode ? { mode } : {}) }] })

  it('off without the budgets lever; failed and skipped in the module\'s words', async () => {
    expect(await moneyStep(ctxOf({ tick: tickOf({ moneyWatch: new Map() }) }))).toMatchObject({ status: 'off' })
    m.money.mockResolvedValue({ runId: 'bm-0', ran: true, why: '', products: [], pruned: 0, failed: [{ market: 'IT', error: 'IT is not a market code' }] })
    expect(await moneyStep(ctxOf())).toMatchObject({ status: 'failed', why: 'the money plan failed: IT is not a market code' })
    m.money.mockResolvedValue({ runId: 'bm-0', ran: true, why: '', failed: [], pruned: 0, products: [{ productId: 'jacket', market: 'IT', stored: null, brake: 'none', pacePct: null, why: 'the product has no family root here: nothing planned' }] })
    expect(await moneyStep(ctxOf())).toMatchObject({ status: 'skipped' })
  })

  it('acting: the brake that holds raises holds every own campaign\'s bids; the request waiting is named', async () => {
    m.money.mockResolvedValue(moneyRun('PROPOSE'))
    m.newestMoney.mockResolvedValue(new Map([['jacket', { plan: plan('hold_raises') }]]))
    const out = await moneyStep(ctxOf({ acts: { ...noneAct, money: true } }))
    expect(m.money).toHaveBeenCalledWith({ now: NOW, products: [{ productId: 'jacket', market: 'IT', level: 'OBSERVE' }] })
    expect(out.holds).toEqual([['c1', 'the money brake (hold_raises) holds every raise'], ['c2', 'the money brake (hold_raises) holds every raise']])
    expect(out.waiting).toEqual([{ what: 'the portfolio cap', approvalId: 'appr-cap' }])
    expect(out.did!.money!.lines[0]).toBe('the month on pace')
  })

  it('acting: a campaign whose budget steps down holds its own bid raises; in shadow the same is only noted', async () => {
    m.money.mockResolvedValue(moneyRun())
    m.newestMoney.mockResolvedValue(new Map([['jacket', { plan: plan('none', ['c2']) }]]))
    expect((await moneyStep(ctxOf({ acts: { ...noneAct, money: true } }))).holds).toEqual([['c2', 'its budget steps down today: a bid raise would fight the cut']])
    const shadow = await moneyStep(ctxOf())
    expect(shadow.holds).toBeUndefined()
    expect(shadow.did!.shadowHolds).toEqual([['c2', 'the money step (shadow): its budget steps down today: a bid raise would fight the cut']])
    expect(shadow.did!.lines[0]).toMatch(/^shadow — would set the campaign budgets: lower 1, keep 1/)
  })
})

describe('AB-14 — ⑥ bids', () => {
  const market = (over: Record<string, unknown> = {}) => ({ runId: 'bb-1', mode: 'shadow', pruned: 0, markets: [{ market: 'IT', decided: 6, stored: 6, byAction: { write: 3, hold: 3 }, byLayer: {}, brakes: [], ...over }] })

  it('off with the bid brain off; skipped with no own campaign or outside the bid brain\'s markets', async () => {
    m.bidMode = 'off'
    expect(await bidsStep(ctxOf())).toMatchObject({ status: 'off' })
    m.bidMode = 'shadow'
    expect(await bidsStep(ctxOf({ own: new Map() }))).toMatchObject({ status: 'skipped' })
    m.bids.mockResolvedValue({ runId: 'bb-0', mode: 'shadow', markets: [], pruned: 0 })
    expect(await bidsStep(ctxOf({ market: 'FR', key: 'FR|jacket' }))).toMatchObject({ status: 'skipped', why: expect.stringMatching(/does not decide FR today/) })
    m.bids.mockResolvedValue(market({ error: 'boom' }))
    expect(await bidsStep(ctxOf())).toMatchObject({ status: 'failed', why: 'the bid run failed: boom' })
  })

  it('the bid brain on the product\'s own campaigns in its market, with the holds of the earlier steps as raise caps', async () => {
    m.bids.mockResolvedValue(market({ moves: { raise: 2, lower: 1, raisedBy: { c1: 1, c2: 1 } } }))
    const records = { money: rec({ acts: true, holds: [['c1', 'the money brake (hold_raises) holds every raise']] }) }
    const out = await bidsStep(ctxOf({ records }))
    expect(m.bids).toHaveBeenCalledWith({ clockNow: NOW, scope: { campaignIds: new Set(['c1', 'c2']), market: 'IT' }, raiseCaps: new Map([['c1', 'the product cycle\'s money (campaign budgets and the portfolio cap) step: the money brake (hold_raises) holds every raise']]) })
    expect(out).toMatchObject({ status: 'done', runId: 'bb-1', why: 'SHADOW: 6 keywords decided — would raise 2, would lower 1', did: { counts: { decided: 6, raise: 2, lower: 1 } } })
    expect(out.did!.lines[0]).toBe('6 keywords decided on 2 own campaigns: would raise 2, would lower 1, hold 3 (shadow: nothing at Amazon)')
  })

  it('a step in shadow that would hold raises where the bids raised: a clash in the report', async () => {
    m.bids.mockResolvedValue(market({ owned: 2, moves: { raise: 1, lower: 0, raisedBy: { c2: 1 } } }))
    const records = { money: rec({ did: { lines: [], shadowHolds: [['c2', 'the money step (shadow): its budget steps down today: a bid raise would fight the cut']] } }) }
    const out = await bidsStep(ctxOf({ records }))
    expect(m.bids).toHaveBeenCalledWith({ clockNow: NOW, scope: { campaignIds: new Set(['c1', 'c2']), market: 'IT' } })
    expect(out.did!.clashes).toEqual(['the money step (shadow): its budget steps down today: a bid raise would fight the cut; the bids raised 1 keyword on Jacket broad — when money (campaign budgets and the portfolio cap) acts, those raises wait.'])
    expect(out.why).toMatch(/^LIVE on 2 campaigns/)
  })
})

describe('AB-14 — ⑦ hours, and the report\'s money', () => {
  it('failed, off, not due, and a painted plan waiting for the Owner', async () => {
    m.hours.mockResolvedValueOnce({ ran: true, failed: 1, off: 0, notDue: 0 })
    expect(await hoursStep(ctxOf())).toMatchObject({ status: 'failed' })
    m.hours.mockResolvedValueOnce({ ran: true, failed: 0, off: 1, notDue: 0 })
    expect(await hoursStep(ctxOf())).toMatchObject({ status: 'off' })
    m.hours.mockResolvedValueOnce({ ran: true, failed: 0, off: 0, notDue: 1 })
    expect(await hoursStep(ctxOf())).toMatchObject({ status: 'done', why: expect.stringMatching(/^not due/) })
    m.hours.mockResolvedValueOnce({ ran: true, failed: 0, off: 0, notDue: 0, proposed: 1, shadow: 0, noChange: 0, held: 0 })
    m.lastProposal = { id: 'hp-1', status: 'PROPOSED', approvalId: 'appr-h', why: 'Proposes 4 hours of "Jacket hours" for approval.' }
    const out = await hoursStep(ctxOf())
    expect(m.hours).toHaveBeenLastCalledWith({ now: NOW, productId: 'jacket', market: 'IT' })
    expect(out).toMatchObject({ status: 'done', runId: 'hp-1', waiting: [{ what: 'the painted hourly plan (apply-brain-hourly-plan)', approvalId: 'appr-h' }], why: 'researched, painted and asked for your approval' })
    expect(out.did!.money!.lines).toEqual(['The hourly plan: Proposes 4 hours of "Jacket hours" for approval.'])
  })

  it('ad sales against spend for the own campaigns: the data day and its week', async () => {
    m.daily = [
      { date: new Date('2026-10-02T00:00:00Z'), currencyCode: 'EUR', _sum: { costMicros: 10_000_000n, sales7dCents: 4000, orders7d: 1 } },
      { date: new Date('2026-10-01T00:00:00Z'), currencyCode: 'EUR', _sum: { costMicros: 5_000_000n, sales7dCents: 0, orders7d: 0 } },
    ]
    expect(await readMoneyInOut(['c1'], '2026-10-02', null, null)).toEqual({
      currency: 'EUR', day: { spendCents: 1000, salesCents: 4000, orders: 1 }, week: { spendCents: 1500, salesCents: 4000, orders: 1, days: 2 }, month: null,
    })
    m.daily = []
    expect(await readMoneyInOut(['c1'], '2026-10-02', null, null)).toBeNull()
    expect(await readMoneyInOut([], '2026-10-02', null, null)).toBeNull()
  })
})

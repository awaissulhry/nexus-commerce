/**
 * ONE BRAIN AB-14 — the product cycle, pure (brain/cycle.ts): the design's order, which step waits for which (what it
 * reads at any level; an earlier step that acts; never a step in shadow), the change set id, the holds handed to the bids,
 * and the day's product report (every amount under `money`, the summary without one).
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  buildReport, changeSetIdOf, CYCLE_STEPS, cycleStatusOf, moneyLines, raiseHoldsFor, readSteps, stepsToRun, waitsFor,
  type CycleStep, type ReportInput, type StepRecord, type StepRecords,
} from './cycle.js'

const NOW = new Date('2026-10-09T05:55:00Z')
const rec = (status: StepRecord['status'], over: Partial<StepRecord> = {}): StepRecord => ({ status, why: `${status} why`, acts: false, attempt: 1, at: NOW.toISOString(), ...over })
const noneAct = Object.fromEntries(CYCLE_STEPS.map((s) => [s, false])) as Record<CycleStep, boolean>
const acting = (...steps: CycleStep[]) => ({ ...noneAct, ...Object.fromEntries(steps.map((s) => [s, true])) }) as Record<CycleStep, boolean>

describe('AB-14 — the order', () => {
  it('stops and state, the term ledger, negatives before harvest, structure, money before bids, then hours and the bidding strategy (design §4)', () => {
    expect(CYCLE_STEPS).toEqual(['state', 'terms', 'negatives', 'harvest', 'structure', 'money', 'bids', 'hours', 'bidding'])
  })

  it('one change set per product × market × data day', () => {
    expect(changeSetIdOf('prod-1', 'IT', '2026-10-02')).toBe('cyc-IT-2026-10-02-prod-1')
    expect(changeSetIdOf('prod-1', 'DE', '2026-10-02')).not.toBe(changeSetIdOf('prod-1', 'IT', '2026-10-02'))
  })
})

describe('AB-14 — which step waits for which', () => {
  it('nothing ended yet: the first step runs, the next one too when nothing before it acts', () => {
    expect(waitsFor('state', {}, noneAct)).toBeNull()
    expect(waitsFor('terms', {}, noneAct)).toBeNull()
  })

  it('negatives and harvest read the term ledger at ANY level: a failed ledger blocks both, even all in shadow', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('failed') }
    expect(waitsFor('negatives', records, noneAct)).toMatchObject({ step: 'terms', why: expect.stringMatching(/reads what the term ledger decides.*failed/) })
    expect(waitsFor('harvest', records, noneAct)).toMatchObject({ step: 'terms' })
    // money and bids do not read the ledger, and nothing acts: they still run.
    expect(waitsFor('money', records, noneAct)).toBeNull()
    expect(waitsFor('bids', records, noneAct)).toBeNull()
  })

  it('harvest never runs after a failed negatives step: the harvest + negate pair is never half applied', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('done'), negatives: rec('failed') }
    expect(waitsFor('harvest', records, noneAct)).toMatchObject({ step: 'negatives', why: expect.stringMatching(/reads what negatives decides/) })
  })

  it('an earlier step that ACTS and failed holds every later step (a higher step fixes the facts for the lower ones)', () => {
    const records: StepRecords = { state: rec('failed', { acts: true }) }
    for (const s of ['terms', 'negatives', 'harvest', 'money', 'bids', 'hours'] as const) {
      expect(waitsFor(s, records, acting('state')), s).toMatchObject({ step: 'state', why: expect.stringMatching(/acts on this product.*failed/) })
    }
  })

  it('budget before bid: the money step acting and failed blocks the bids; in shadow its failure is only reported', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('done'), negatives: rec('off'), harvest: rec('off'), money: rec('failed') }
    expect(waitsFor('bids', records, acting('money'))).toMatchObject({ step: 'money' })
    expect(waitsFor('bids', records, noneAct)).toBeNull()
    expect(waitsFor('hours', records, noneAct)).toBeNull()
  })

  it('a blocked step that acts blocks the steps after it in turn; an ended step (done, off, skipped) never blocks', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('done'), negatives: rec('blocked', { acts: true }) }
    expect(waitsFor('money', records, acting('negatives'))).toMatchObject({ step: 'negatives' })
    for (const status of ['done', 'off', 'skipped'] as const) {
      expect(waitsFor('bids', { state: rec(status, { acts: true }), terms: rec(status), negatives: rec(status), harvest: rec(status), money: rec(status, { acts: true }) }, acting('state', 'money')), status).toBeNull()
    }
  })

  it('AB-16 — structure never holds the steps after it: every request it makes waits for a person, so its failure is only reported', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('done'), negatives: rec('done'), harvest: rec('done'), structure: rec('failed') }
    for (const s of ['money', 'bids', 'hours'] as const) expect(waitsFor(s, records, noneAct), s).toBeNull()
    // …and it runs after the harvest: a harvest that acts and failed holds it, as every step after an acting one.
    expect(waitsFor('structure', { state: rec('done'), terms: rec('done'), negatives: rec('done'), harvest: rec('failed', { acts: true }) }, acting('harvest'))).toMatchObject({ step: 'harvest' })
  })

  it('a retry runs only what did not end; the cycle is DONE only when every step ended', () => {
    const records: StepRecords = { state: rec('done'), terms: rec('done'), negatives: rec('failed'), harvest: rec('blocked'), structure: rec('done'), money: rec('done'), bids: rec('done'), hours: rec('off'), bidding: rec('off') }
    expect(stepsToRun(records)).toEqual(['negatives', 'harvest'])
    expect(cycleStatusOf(records)).toBe('PARTIAL')
    expect(cycleStatusOf({ ...records, negatives: rec('done'), harvest: rec('skipped') })).toBe('DONE')
    expect(stepsToRun({})).toEqual([...CYCLE_STEPS])
  })

  it('steps as stored: the well-formed ones only', () => {
    expect(readSteps({ state: rec('done'), terms: { status: 'done' }, bogus: rec('done') })).toEqual({ state: rec('done') })
    expect(readSteps(null)).toEqual({})
    expect(readSteps([rec('done')])).toEqual({})
  })
})

describe('AB-14 — what the earlier steps hold for the bids', () => {
  it('the holds of the steps before the bids, own campaigns only, joined when two hold one', () => {
    const records: StepRecords = {
      state: rec('done', { acts: true, holds: [['c1', 'it pauses Jacket exact (queued)']] }),
      money: rec('done', { acts: true, holds: [['c1', 'the money brake (hold_raises) holds every raise'], ['c2', 'its budget steps down today'], ['other', 'not mine']] }),
      hours: rec('done', { holds: [['c3', 'after the bids: never read']] }),
    }
    const holds = raiseHoldsFor(records, new Set(['c1', 'c2', 'c3']))
    expect([...holds.keys()].sort()).toEqual(['c1', 'c2'])
    expect(holds.get('c1')).toBe('the product cycle\'s stops and state step: it pauses Jacket exact (queued); the product cycle\'s money (campaign budgets and the portfolio cap) step: the money brake (hold_raises) holds every raise')
  })
})

describe('AB-14 — the day\'s product report', () => {
  const input = (over: Partial<ReportInput> = {}): ReportInput => ({
    productId: 'prod-1', name: 'Jacket', market: 'IT', dataDay: '2026-10-02', changeSetId: 'cyc-IT-2026-10-02-prod-1', status: 'DONE', attempts: 1, now: NOW,
    records: {
      state: rec('done', { why: 'OBSERVE: keep 2', did: { lines: ['Jacket exact: would pause (shadow) — out of stock'], shadowHolds: [['c1', 'the state step (shadow) would pause Jacket exact']] } }),
      terms: rec('done', { did: { lines: ['12 terms over 60 settled days: TARGETED 3, WATCH 9 (shadow: the ledger writes nothing at Amazon)'] } }),
      negatives: rec('done', { did: { lines: ['2 adds and retires planned: SHADOW 2 (shadow: nothing at Amazon)'] }, waiting: [] }),
      harvest: rec('off', { why: 'the harvest module is not in this build yet (AB-11)' }),
      structure: rec('done', { why: 'not the weekly day', did: { lines: ['structure: not the weekly day (Monday in the market\'s time zone): no new proposal'] } }),
      money: rec('done', { acts: true, waiting: [{ what: 'the portfolio cap', approvalId: 'appr-1' }], did: { lines: ['asked a person for the campaign budgets: raise 1'], money: { lines: ['The month is on pace: €100.00 of €400.00.'] } } }),
      bids: rec('done', { acts: true, did: { lines: ['20 keywords decided on 2 own campaigns: raise 3, lower 1, hold 16'], clashes: ['the state step (shadow) would pause Jacket exact; the bids raised 2 keywords on Jacket exact — when stops and state acts, those raises wait.'] } }),
      hours: rec('failed', { why: 'the hourly research failed for the product (logged)' }),
      bidding: rec('off', { why: 'the bidding-strategy lever is OFF' }),
    },
    excluded: null,
    holds: [{ lever: 'budgets', scope: 'campaign', campaignId: 'c2', ref: '', by: 'user:owner', at: '2026-10-01T10:00:00.000Z', reason: 'my own budget' }],
    moneyInOut: { currency: 'EUR', day: { spendCents: 1000, salesCents: 4000, orders: 1 }, week: { spendCents: 7000, salesCents: 20000, orders: 5, days: 7 }, month: { spentCents: 10000, envelopeCents: 40000, projectedCents: 36000, pacePct: 90, brake: 'none' } },
    later: [{ at: '2026-10-09T09:55:00.000Z', line: 'stops and state: Jacket exact: pause queued — out of stock' }],
    ...over,
  })

  it('what each lever did in order, what waits for the Owner, clashes, his locks, problems, later — and the money apart', () => {
    const { report } = buildReport(input())
    expect(report.levers.map((l) => [l.step, l.status, l.acts])).toEqual([['state', 'done', false], ['terms', 'done', false], ['negatives', 'done', false], ['harvest', 'off', false], ['structure', 'done', false], ['money', 'done', true], ['bids', 'done', true], ['hours', 'failed', false], ['bidding', 'off', false]])
    expect(report.waitsForOwner).toEqual([{ what: 'the portfolio cap', approvalId: 'appr-1' }])
    expect(report.clashes).toHaveLength(1)
    expect(report.heldByOwner).toEqual(['Locked by user:owner on 2026-10-01: the whole budgets lever on campaign c2 — "my own budget". The brain writes nothing there and only recommends.'])
    expect(report.problems).toEqual(['the hourly plan failed: the hourly research failed for the product (logged)'])
    expect(report.headline).toBe('Jacket in IT, data day 2026-10-02: cycle done — 6 levers decided, acting on money (campaign budgets and the portfolio cap), bids; 1 request waiting for you; 1 clash; 1 problem.')
    expect(report.money.lines).toEqual([
      '2026-10-02: ad sales €40.00 in, ad spend €10.00 out (ACoS 25 %, 1 order).',
      'The 7 settled days to 2026-10-02: ad sales €200.00 in, ad spend €70.00 out (ACoS 35 %, 5 orders).',
      'This month: €100.00 spent of the €400.00 monthly envelope, heading for €360.00 (pace 90 %); money brake: none.',
      'The month is on pace: €100.00 of €400.00.',
    ])
    expect(report.later).toHaveLength(1)
    expect(report.changeSetId).toBe('cyc-IT-2026-10-02-prod-1')
  })

  it('the summary says it in plain words, names the change set, and holds no amount', () => {
    const { summary } = buildReport(input())
    expect(summary).toContain('Stops and state: Jacket exact: would pause (shadow) — out of stock')
    expect(summary).toContain('Harvest (off): the harvest module is not in this build yet (AB-11)')
    expect(summary).toContain('Waiting for you: the portfolio cap (approval appr-1).')
    expect(summary).toContain('Held by your choices: Locked by user:owner')
    expect(summary).toContain('Later (09:55 UTC): stops and state: Jacket exact: pause queued — out of stock')
    expect(summary).toContain('Change set cyc-IT-2026-10-02-prod-1: every write of this cycle carries it.')
    expect(summary).not.toMatch(/€|\d+[.,]\d{2}/)
  })

  it('an excluded product, a cycle not finished, nothing waiting, no report row yet', () => {
    const { report, summary } = buildReport(input({ status: 'PARTIAL', attempts: 2, excluded: { by: 'the Owner\'s product override (user:owner, 2026-10-01)', reason: 'not now' }, holds: [], moneyInOut: null, later: [], records: { state: rec('off') } }))
    expect(report.headline).toMatch(/cycle not finished \(run 2 of 3\) — 0 levers decided, all in shadow or off; 0 requests waiting for you/)
    expect(report.heldByOwner[0]).toBe('The product is excluded from the brain by the Owner\'s product override (user:owner, 2026-10-01): "not now" — today\'s engines run it.')
    expect(report.money.lines).toEqual(['No ad report row for the product\'s own campaigns yet: ad sales and spend unknown.'])
    expect(summary).toContain('Nothing waits for you.')
    expect(report.levers.find((l) => l.step === 'bids')).toMatchObject({ status: 'blocked', did: ['not run yet'] })
  })

  it('money lines: no row for the data day, no envelope, no sales', () => {
    expect(moneyLines({ currency: 'EUR', day: null, week: { spendCents: 500, salesCents: 0, orders: 0, days: 3 }, month: { spentCents: 500, envelopeCents: null, projectedCents: null, pacePct: null, brake: 'none' } }, '2026-10-02')).toEqual([
      '2026-10-02: no ad report row for the product\'s own campaigns.',
      'The 3 settled days to 2026-10-02: ad sales €0.00 in, ad spend €5.00 out (ACoS no sales, 0 orders).',
      'This month: €5.00 spent (no monthly envelope set); money brake: none.',
    ])
  })
})

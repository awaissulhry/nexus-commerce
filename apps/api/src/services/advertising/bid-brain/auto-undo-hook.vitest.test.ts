/**
 * BID BRAIN BB-10 — the auto-undo hook and the brain's own raise cap (pure parts).
 *
 *   raise cap   a campaign whose projected spend this hour is above 1.5 × its 7-day same-hour average raises nothing:
 *               too few days or a tiny average judges nothing; the first minutes of an hour do not project a spike
 *   decide      a goal raise waits under the cap, a cut still goes
 *   placements  under the cap a lane may come down, never go up
 *   event       the run's queued bids (with their action-log rows) and placement writes, as the event carries them
 *   auto-undo   judges the brain's changes (an engine that decides by itself)
 */
import { describe, expect, it } from 'vitest'
import { spendGuardWhy } from './spend-guard.js'
import { decide, type Decision, type TargetFacts } from './decide.js'
import { placementPlan, type WriteReport, type PlacementReport } from './live-writer.js'
import { brainWriteRecords } from './shadow.js'
import { JUDGED_ENGINES } from '../ads-auto-undo.service.js'
import type { Lane } from './recipe.js'

describe('the raise cap: this hour against the same hour of the last 7 days', () => {
  const week = [100, 120, 80, 100, 110, 90, 100]
  it('caps when the hour heads above 1.5 × the average, and says by how much', () => {
    // 90¢ in 30 minutes heads for €1.80 against a 100¢ average.
    expect(spendGuardWhy({ spentCents: 90, minutesIntoHour: 30, sameHourCents: week })).toBe("this hour's spend heads for €1.80, more than 1.5 × its 7-day same-hour average €1.00")
    expect(spendGuardWhy({ spentCents: 70, minutesIntoHour: 30, sameHourCents: week })).toBeNull()
  })
  it('judges nothing on fewer than 3 days that spent, or an average under 20¢', () => {
    expect(spendGuardWhy({ spentCents: 500, minutesIntoHour: 30, sameHourCents: [100, 0, 0, 100, 0, 0, 0] })).toBeNull()
    expect(spendGuardWhy({ spentCents: 50, minutesIntoHour: 30, sameHourCents: [10, 12, 15, 9, 11] })).toBeNull()
  })
  it('review — the last full hour above 1.5 × its own same-hour average caps too (the :00 tick of a new hour sees ~0)', () => {
    expect(spendGuardWhy({ spentCents: 0, minutesIntoHour: 0, sameHourCents: week, previous: { spentCents: 200, sameHourCents: week } })).toBe('the last hour spent €2.00, more than 1.5 × its 7-day same-hour average €1.00')
    expect(spendGuardWhy({ spentCents: 0, minutesIntoHour: 0, sameHourCents: week, previous: { spentCents: 140, sameHourCents: week } })).toBeNull()
  })

  it('the first minutes of an hour project from 15 minutes at least', () => {
    // 30¢ after 5 minutes reads as 30 × 60 ÷ 15 = €1.20, not €3.60.
    expect(spendGuardWhy({ spentCents: 30, minutesIntoHour: 5, sameHourCents: week })).toBeNull()
    expect(spendGuardWhy({ spentCents: 40, minutesIntoHour: 5, sameHourCents: week })).toMatch(/heads for €1.60/)
  })
})

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  targetId: 't1', currentCents: 30,
  chain: [{ level: 'target', evidence: { clicks: 400, orders: 12, salesCents: 12 * 8000, costCents: 400 * 30 } }, { level: 'market', evidence: { clicks: 4000, orders: 120, salesCents: 120 * 8000, costCents: 4000 * 30 } }],
  goal: { target: { kind: 'ACOS', pct: 35 }, band: { loPct: 30, hiPct: 40 }, phase: null },
  limits: { maxChangePct: 25 }, dataDay: '2026-10-01', ...over,
})

describe('decide under the raise cap', () => {
  it('review — a held campaign: an in-band keyword does not move, and a raise waits inside the goal path', () => {
    // In band (expected ACoS inside 30–40 %): held or not, nothing moves — a hold is no freeze walking bids down.
    const inBand = facts({ currentCents: 84, servingCents: 30 })
    expect(decide(inBand)).toMatchObject({ action: 'hold', layer: 'band' })
    expect(decide({ ...inBand, raiseCap: 'the campaign is held by automation:auto-undo' })).toMatchObject({ action: 'hold', layer: 'band', bidCents: 84 })
    // Already stepped on this data day: still one step a day, held or not.
    const stepped = facts({ currentCents: 37, lastStep: { dataDay: '2026-10-01', fromCents: 30, toCents: 37 } })
    expect(decide({ ...stepped, raiseCap: 'held' })).toMatchObject({ action: 'hold', bidCents: 37 })
  })

  it('a goal raise waits and says why; a cut still goes', () => {
    const free = decide(facts())
    expect(free).toMatchObject({ action: 'write', layer: 'goal' })
    expect(free.bidCents).toBeGreaterThan(30)
    const capped = decide(facts({ raiseCap: "this hour's spend heads for €1.80" }))
    expect(capped).toMatchObject({ action: 'hold', layer: 'goal', bidCents: 30 })
    expect(capped.why).toMatch(/^goal: raise held — this hour's spend heads for €1.80; 30¢ → \d+¢ waits/)
    const cut = decide(facts({ currentCents: 200, raiseCap: 'spike' }))
    expect(cut.action).toBe('write')
    expect(cut.bidCents).toBeLessThan(200)
  })
})

describe('placements under the raise cap', () => {
  const lanes: Lane[] = [
    { lane: 'TOP_OF_SEARCH', planPct: 150, maxCpcCents: null, dynamic: 1 },
    { lane: 'REST_OF_SEARCH', planPct: 0, maxCpcCents: null, dynamic: 1 },
    { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: null, dynamic: 1 },
  ]
  it('a lane comes down, none goes up', () => {
    const p = placementPlan({ lanes, current: [{ placement: 'PLACEMENT_TOP', percentage: 100 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 30 }], maxBidCents: 20, raiseCap: 'spike' })!
    expect(p.adjustments).toEqual([
      { placement: 'PLACEMENT_TOP', percentage: 100 },
      { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 },
    ])
    expect(p.changes).toEqual([{ lane: 'rest-of-search', from: 30, to: 0, held: null }])
  })
})

describe('the run-completed event', () => {
  it('carries each queued bid with its action-log row and each placement write; nothing refused or deferred', () => {
    const d = (targetId: string, from: number, to: number) => ({ targetId, currentCents: from, bidCents: to }) as Decision
    const sent = { byTarget: new Map([['t1', { sent: 'queued', outboundQueueId: 'q1', actionLogId: 'l1' }], ['t2', { sent: 'refused', reason: 'no' }], ['t3', { sent: 'deferred', why: 'caps' }]]) } as unknown as WriteReport
    const placed = { byCampaign: new Map([['c1', { sent: 'written', changes: [] }], ['c2', { sent: 'refused', changes: [], reason: 'x' }]]) } as unknown as PlacementReport
    const campaignOf = (t: string) => (t === 't1' ? 'c1' : 'c2')
    expect(brainWriteRecords([d('t1', 30, 36), d('t2', 30, 40), d('t3', 30, 40)], sent, placed, campaignOf)).toEqual([
      { campaignId: 'c1', actionLogId: 'l1', entityId: 't1', field: 'bid', from: 30, to: 36 },
      { campaignId: 'c1', actionLogId: null, entityId: 'c1', field: 'placementBidding', from: null, to: null },
    ])
  })
})

describe('auto-undo', () => {
  it('judges the bid brain\'s changes as an engine\'s own decisions', () => {
    expect(JUDGED_ENGINES.has('bid-brain')).toBe(true)
  })
})

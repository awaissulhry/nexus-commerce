/**
 * 2c (review G.11) — "about N changes a day sent to Amazon", from the painted hour table. Pure: the week is walked with
 * the job's rules, and each case below is small enough to count by hand.
 */
import { describe, expect, it } from 'vitest'
import { addProjection, emptyProjection, projectRankWrites } from './rank-write-projection.js'
import type { RankTargetSpec, ScheduleWindow } from './rank-controller.js'

const spec = (over: Partial<RankTargetSpec> & { key: string }): RankTargetSpec => ({ placement: 'PLACEMENT_TOP', targetISPct: null, acosCapPct: null, maxCpcCents: null, biasPct: null, pause: false, allOut: false, ...over })
const TARGETS: Record<string, RankTargetSpec> = {
  top50: spec({ key: 'top50', biasPct: 50 }),
  top100: spec({ key: 'top100', biasPct: 100 }),
  minbid: spec({ key: 'minbid', pause: true, floorBidCents: 2 }),
  minbid5: spec({ key: 'minbid5', pause: true, floorBidCents: 5 }),
  minbidTop0: spec({ key: 'minbidTop0', pause: true, biasPct: 0 }),
  blend: spec({ key: 'blend', biasPct: 0, lanes: [{ placement: 'PLACEMENT_TOP', biasPct: 80 }, { placement: 'PLACEMENT_REST_OF_SEARCH', biasPct: 20 }] }),
  absolute: spec({ key: 'absolute', biasPct: 50, bidMode: 'absolute', bidValueCents: 60 }),
  delta: spec({ key: 'delta', biasPct: 50, bidMode: 'deltaPct', bidDeltaPct: 20 }),
}
const specFor = (k: string) => TARGETS[k] ?? null
const campaign = { adGroups: 1, targets: 9 } // 10 bids
const every = (startHour: number, endHour: number, targetKey: string): ScheduleWindow => ({ days: [], startHour, endHour, targetKey })
const project = (windows: ScheduleWindow[], defaultTargetKey: string | null, c = campaign) => projectRankWrites({ windows, defaultTargetKey, specFor, campaign: c })

describe('2c projectRankWrites — what the painted week asks Amazon for', () => {
  it('a plan that holds one value all week sends nothing once it is set', () => {
    expect(project([], 'top50')).toEqual({ perDay: 0, perWeek: 0, byKind: { restore: 0, suppress: 0, placement: 0, base: 0 }, keptServing: 0 })
  })

  it('a night Min bid floors every bid once and gives every bid back once, each day', () => {
    const p = project([every(0, 7, 'minbid')], 'top50')
    // 10 bids floored at 00:00 and 10 given back at 07:00, seven days. Placement stays at 50% (Min bid sets none).
    expect(p.byKind).toEqual({ restore: 70, suppress: 70, placement: 0, base: 0 })
    expect(p.perDay).toBe(20)
  })

  it('counts one change per placement switch at the painted hour boundaries', () => {
    const p = project([every(8, 12, 'top100'), every(18, 22, 'top100')], 'top50')
    expect(p.byKind.placement).toBe(4 * 7)
    expect(p.perDay).toBe(4)
  })

  it('a Min-bid target with its own placement adds one placement change on the way in and one on the way out', () => {
    const p = project([every(0, 6, 'minbidTop0')], 'top50')
    expect(p.byKind).toEqual({ restore: 70, suppress: 70, placement: 14, base: 0 })
  })

  it('moving between two Min-bid floors re-floors every bid', () => {
    const p = project([every(0, 4, 'minbid'), every(4, 8, 'minbid5')], 'top50')
    // In at 00:00 (10), re-floor at 04:00 (10), out at 08:00 (10).
    expect(p.byKind).toEqual({ restore: 70, suppress: 140, placement: 0, base: 0 })
  })

  it('scales with the bids a campaign holds and is nothing for a campaign with none', () => {
    expect(project([every(0, 7, 'minbid')], 'top50', { adGroups: 2, targets: 139 }).perDay).toBe(282)
    expect(project([every(0, 7, 'minbid')], 'top50', { adGroups: 0, targets: 0 }).perDay).toBe(0)
  })

  it('anti-flap: a day painted on and off Min bid three times floors only twice; the third block keeps serving', () => {
    const p = project([every(1, 3, 'minbid'), every(9, 11, 'minbid'), every(17, 19, 'minbid')], 'top50')
    expect(p.byKind.suppress).toBe(2 * 10 * 7)
    expect(p.byKind.restore).toBe(2 * 10 * 7)
    expect(p.keptServing).toBe(2 * 7) // the third block's two hours, every day
  })

  it('a blend is one placement change when it is entered and one when it is left', () => {
    const p = project([every(10, 14, 'blend')], 'top50')
    expect(p.byKind.placement).toBe(2 * 7)
  })

  it('base bids: absolute is set once and never reverted (nothing in a steady week); a ±% base bid moves every bid in and back out', () => {
    expect(project([every(10, 14, 'absolute')], 'top50').byKind).toEqual({ restore: 0, suppress: 0, placement: 0, base: 0 })
    // The ±% hours move all 10 bids and give them back at 16:00 (to 60¢), so the next day's absolute hours write nothing.
    expect(project([every(10, 14, 'absolute'), every(14, 16, 'delta')], 'top50').byKind).toEqual({ restore: 70, suppress: 0, placement: 0, base: 70 })
    expect(project([every(10, 14, 'delta')], 'top50').byKind).toEqual({ restore: 70, suppress: 0, placement: 0, base: 70 })
  })

  it('hours that hold nothing give back the floor, as the engine does', () => {
    const p = project([every(0, 6, 'minbid')], null)
    // Floored at 00:00, given back at 06:00 when no window and no baseline hold anything.
    expect(p.byKind).toEqual({ restore: 70, suppress: 70, placement: 0, base: 0 })
  })

  it('a deleted target counts as nothing held', () => {
    expect(project([every(0, 6, 'gone')], 'top50').perWeek).toBe(0)
  })

  it('weekday windows count only on their days', () => {
    const p = project([{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 7, targetKey: 'minbid' }], 'top50')
    expect(p.perWeek).toBe(5 * 20)
    expect(p.perDay).toBe(14) // 100 ÷ 7, rounded
  })

  it('adds campaigns into a plan total', () => {
    const total = addProjection(addProjection(emptyProjection(), project([every(0, 7, 'minbid')], 'top50')), project([every(8, 12, 'top100')], 'top50'))
    expect(total.perWeek).toBe(140 + 14)
    expect(total.perDay).toBe(22)
    expect(total.byKind).toEqual({ restore: 70, suppress: 70, placement: 14, base: 0 })
  })
})

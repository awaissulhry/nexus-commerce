import { describe, expect, it } from 'vitest'
import type { RowRisk } from '../work-orders/risk'
import { groupOf, groupsOf, requestsByKind, stageShareOf, tallyOf, WIP_STAGES, type OverviewFact } from './tally'

/**
 * B-PR-33 — the overview's sums, pure (./tally): a work order's pieces per WIP stage, a row's sums (and the Total), whose row a work
 * order counts in, and the requests per kind. Made-up numbers only.
 */

const NONE = { cut: null, bundled: null, sewn: null, finished: null }
const risk = (state: RowRisk['state'], blockedBy: RowRisk['blockedBy'] = null): RowRisk => ({ state, daysLate: state === 'LATE' ? 3 : null, plannedEnd: null, planAfterDue: false, raised: null, blockedBy })

const fact = (over: Partial<OverviewFact> & Pick<OverviewFact, 'id'>): OverviewFact => ({
  group: { kind: 'CUSTOMER', partyId: 'p-b' },
  status: 'DRAFT',
  pieces: 0,
  risk: risk('ON_TRACK'),
  waiting: null,
  gate: false,
  mixed: false,
  customerUrgent: false,
  share: {},
  sewingNotCounted: false,
  ...over,
})

describe('a work order’s pieces per WIP stage', () => {
  it('a draft is Not released, a released one Released, a held one On hold only — whatever its progress', () => {
    expect(stageShareOf({ status: 'DRAFT', pieces: 8, progress: null, atWorkshop: 0 }).share).toEqual({ NOT_RELEASED: 8 })
    expect(stageShareOf({ status: 'RELEASED', pieces: 8, progress: null, atWorkshop: 0 }).share).toEqual({ RELEASED: 8 })
    expect(stageShareOf({ status: 'ON_HOLD', pieces: 8, progress: { cut: 8, bundled: 8, sewn: 4, finished: 2 }, atWorkshop: 3 }).share).toEqual({ ON_HOLD: 8 })
    expect(stageShareOf({ status: 'COMPLETED', pieces: 8, progress: null, atWorkshop: 0 }).share).toEqual({})
  })

  it('a started one is split by its progress: cutting, sewing, at a workshop, quality, finished (they add up to its pieces)', () => {
    const { share, sewingNotCounted } = stageShareOf({ status: 'IN_PROGRESS', pieces: 20, progress: { cut: 14, bundled: 12, sewn: 8, finished: 5 }, atWorkshop: 2 })
    expect(share).toEqual({ CUTTING: 6, AT_WORKSHOP: 2, SEWING: 4, QUALITY: 3, FINISHED: 5 })
    expect(Object.values(share).reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(20)
    expect(sewingNotCounted).toBe(false)
  })

  it('a garment sewn or finished was cut; a finished one was sewn; nothing goes below 0 or above the pieces', () => {
    // No hide-cut part and no bundle (cut and bundled not counted), but the floor scanned 6 sewn and 4 finished.
    expect(stageShareOf({ status: 'IN_PROGRESS', pieces: 10, progress: { cut: null, bundled: null, sewn: 6, finished: 4 }, atWorkshop: 0 }).share).toEqual({ CUTTING: 4, AT_WORKSHOP: 0, SEWING: 0, QUALITY: 2, FINISHED: 4 })
    // More reported than ordered, more out than cut: clamped.
    expect(stageShareOf({ status: 'IN_PROGRESS', pieces: 5, progress: { cut: 9, bundled: 9, sewn: 2, finished: 7 }, atWorkshop: 50 }).share).toEqual({ CUTTING: 0, AT_WORKSHOP: 5, SEWING: 0, QUALITY: 0, FINISHED: 5 })
  })

  it('sewing the floor does not count is "—" (null), never a made-up 0; so is quality without the final step', () => {
    const notSewn = stageShareOf({ status: 'IN_PROGRESS', pieces: 10, progress: { cut: 10, bundled: 10, sewn: null, finished: null }, atWorkshop: 0 })
    expect(notSewn.share).toEqual({ CUTTING: 0, AT_WORKSHOP: 0, SEWING: null, QUALITY: null, FINISHED: null })
    expect(notSewn.sewingNotCounted).toBe(true)
    expect(stageShareOf({ status: 'IN_PROGRESS', pieces: 10, progress: { cut: 10, bundled: 10, sewn: 6, finished: null }, atWorkshop: 0 }).share).toMatchObject({ SEWING: 4, QUALITY: null, FINISHED: null })
    expect(stageShareOf({ status: 'IN_PROGRESS', pieces: 3, progress: null, atWorkshop: 0 }).share).toEqual({ CUTTING: 3, AT_WORKSHOP: 0, SEWING: null, QUALITY: null, FINISHED: null })
    expect(stageShareOf({ status: 'IN_PROGRESS', pieces: 3, progress: NONE, atWorkshop: 0 }).sewingNotCounted).toBe(true)
  })
})

describe('a row’s sums', () => {
  const facts: OverviewFact[] = [
    fact({ id: 'w1', status: 'DRAFT', pieces: 4, risk: risk('LATE'), waiting: { on: 'US', since: null }, share: { NOT_RELEASED: 4 } }),
    fact({ id: 'w2', status: 'ON_HOLD', pieces: 2, risk: risk('BLOCKED', 'HOLD'), waiting: { on: 'US', since: null }, share: { ON_HOLD: 2 } }),
    fact({ id: 'w3', status: 'DRAFT', pieces: 2, risk: risk('BLOCKED', 'CUSTOMER'), waiting: { on: 'BRAND', since: null }, gate: true, customerUrgent: true, share: { NOT_RELEASED: 2 } }),
    fact({ id: 'w4', status: 'IN_PROGRESS', pieces: 10, risk: risk('AT_RISK', 'MATERIAL'), waiting: { on: 'SUPPLIER', since: null }, share: { CUTTING: 0, AT_WORKSHOP: 0, SEWING: null, QUALITY: null, FINISHED: null }, sewingNotCounted: true }),
    fact({ id: 'w5', status: 'IN_PROGRESS', pieces: 6, risk: risk('LATE', 'HOLD'), waiting: { on: 'WORKSHOP', since: null }, share: { CUTTING: 1, AT_WORKSHOP: 2, SEWING: 1, QUALITY: 1, FINISHED: 1 } }),
  ]

  it('counts the work orders and pieces, each risk state, each wait and each block (whatever the state), customer urgency', () => {
    const tally = tallyOf(facts)
    expect(tally).toMatchObject({ workOrders: 5, pieces: 24, late: 2, atRisk: 1, blocked: 2, customerUrgent: 1 })
    expect(tally.waitingOn).toEqual({ BRAND: 1, SUPPLIER: 1, WORKSHOP: 1, US: 2 })
    // A late work order on hold counts as late AND blocked by its hold; the gate and the split are the overview's own.
    expect(tally.blockedBy).toEqual({ HOLD: 2, CUSTOMER: 1, MATERIAL: 1, GATE: 1, NEEDS_SPLIT: 0 })
  })

  it('WIP: a stage sums what is counted, is null only when nothing there is counted, and 0 when no work order is there', () => {
    const { wip } = tallyOf(facts)
    expect(wip.stages).toEqual({ NOT_RELEASED: 6, RELEASED: 0, CUTTING: 1, SEWING: 1, AT_WORKSHOP: 2, QUALITY: 1, FINISHED: 1, ON_HOLD: 2 })
    expect(wip.sewingNotCounted).toBe(1)
    const onlyNotCounted = tallyOf([facts[3]!])
    expect(onlyNotCounted.wip.stages).toMatchObject({ SEWING: null, QUALITY: null, FINISHED: null, CUTTING: 0, RELEASED: 0 })
    expect(Object.keys(tallyOf([]).wip.stages)).toEqual([...WIP_STAGES])
    expect(tallyOf([]).wip.stages.SEWING).toBe(0)
  })

  it('the Total is the sum of the rows (a mixed work order counts in its own row and in the Total)', () => {
    const mixed = fact({ id: 'w6', group: { kind: 'MIXED' }, mixed: true, pieces: 2, share: { NOT_RELEASED: 2 } })
    const all = [...facts, mixed]
    const rows = [...groupsOf(all).values()].map((entry) => tallyOf(entry.facts))
    const overall = tallyOf(all)
    expect(rows.reduce((sum, row) => sum + row.pieces, 0)).toBe(overall.pieces)
    expect(rows.reduce((sum, row) => sum + row.workOrders, 0)).toBe(overall.workOrders)
    expect(overall.blockedBy.NEEDS_SPLIT).toBe(1)
    expect([...groupsOf(all).keys()]).toEqual(['customer:p-b', 'MIXED'])
  })
})

describe('whose row a work order counts in', () => {
  it('its one customer; no customer with cells of customers = made before the rule (mixed); no customer at all = no customer', () => {
    expect(groupOf({ partyId: 'p-a', cellParties: ['p-a', 'p-a'] })).toEqual({ kind: 'CUSTOMER', partyId: 'p-a' })
    expect(groupOf({ partyId: null, cellParties: ['p-a', 'p-b'] })).toEqual({ kind: 'MIXED' })
    expect(groupOf({ partyId: null, cellParties: [null, null] })).toEqual({ kind: 'NO_CUSTOMER' })
  })
})

describe('the requests per kind', () => {
  it('open and countered apart, only the kinds that wait, in the kinds’ order', () => {
    const rows = [
      { kind: 'HOLD', status: 'OPEN' },
      { kind: 'CANCEL', status: 'OPEN' },
      { kind: 'HOLD', status: 'COUNTERED' },
      { kind: 'HOLD', status: 'OPEN' },
    ] as const
    expect(requestsByKind<'CHANGE' | 'CANCEL' | 'RUSH' | 'HOLD'>(rows, ['CHANGE', 'CANCEL', 'RUSH', 'HOLD'])).toEqual([
      { kind: 'CANCEL', open: 1, countered: 0 },
      { kind: 'HOLD', open: 2, countered: 1 },
    ])
  })
})

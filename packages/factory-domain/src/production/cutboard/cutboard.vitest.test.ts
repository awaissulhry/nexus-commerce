import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { yieldTotals } from '../yield/rules'
import { boardOrder, dayPlan, differencePct, garmentsCutWithin, inDayPlan, isLate, sharePct, type PlanOrder } from './board'
import { shadeSummary } from './shade'
import { cutSums, groupFigures, groupTotals, periodFrom, worstFirst } from './yield'

const day = '2026-11-20'
const range = { start: new Date('2026-11-19T23:00:00.000Z'), end: new Date('2026-11-20T23:00:00.000Z') }
const at = (iso: string) => new Date(iso)
const order = (over: Partial<PlanOrder> = {}): PlanOrder => ({
  kind: 'FABRIC',
  status: 'IN_PROGRESS',
  dueDate: day,
  createdAt: at('2026-11-18T08:00:00.000Z'),
  cutAt: null,
  cancelledAt: null,
  garments: 80,
  ratioSum: 8,
  cutLays: [],
  ...over,
})

describe('the cutting room board (MES-163)', () => {
  it('counts a fabric lay cut on the day by its plies and the ratio, a leather order whole when its ticket ended', () => {
    const fabric = order({ cutLays: [{ cutAt: at('2026-11-20T09:00:00.000Z'), plies: 6 }, { cutAt: at('2026-11-19T15:00:00.000Z'), plies: 4 }] })
    expect(garmentsCutWithin(fabric, range)).toBe(48)
    expect(garmentsCutWithin(order({ kind: 'LEATHER', garments: 3, cutAt: at('2026-11-20T10:00:00.000Z') }), range)).toBe(3)
    expect(garmentsCutWithin(order({ kind: 'LEATHER', garments: 3, cutAt: at('2026-11-19T10:00:00.000Z') }), range)).toBe(0)
  })

  it('plans the cut orders due by the day, less what they cut before it; cut ahead of the plan counts apart', () => {
    const plan = dayPlan(
      [
        // due today, 32 garments cut yesterday: 48 left for today, 48 cut today.
        order({ cutLays: [{ cutAt: at('2026-11-19T15:00:00.000Z'), plies: 4 }, { cutAt: at('2026-11-20T09:00:00.000Z'), plies: 6 }] }),
        // due yesterday, not started: 20 planned, nothing cut.
        order({ kind: 'LEATHER', status: 'RELEASED', dueDate: '2026-11-19', garments: 20 }),
        // due next week, cut today: ahead of the plan.
        order({ kind: 'LEATHER', status: 'CUT', dueDate: '2026-11-27', garments: 5, cutAt: at('2026-11-20T11:00:00.000Z') }),
        // cut before the day: not in it.
        order({ kind: 'LEATHER', status: 'CUT', dueDate: '2026-11-18', garments: 9, cutAt: at('2026-11-19T11:00:00.000Z') }),
        // cancelled, and without a due date: never planned.
        order({ status: 'CANCELLED', cancelledAt: at('2026-11-19T08:00:00.000Z') }),
        order({ dueDate: null }),
      ],
      day,
      range,
    )
    expect(plan).toEqual({ planned: 68, cut: 48, cutThatDay: 53, pct: 71 })
    expect(dayPlan([], day, range)).toEqual({ planned: 0, cut: 0, cutThatDay: 0, pct: null })
  })

  it('keeps out of a past day an order made after it', () => {
    expect(inDayPlan(order({ createdAt: at('2026-11-21T08:00:00.000Z') }), day, range)).toBe(false)
    expect(inDayPlan(order({ status: 'CANCELLED', cancelledAt: at('2026-11-21T08:00:00.000Z') }), day, range)).toBe(true)
  })

  it('lists cutting first, then released, then planned; earliest due first', () => {
    const rows = [
      { status: 'PLANNED', dueDate: '2026-11-19', number: 'CO-3' },
      { status: 'RELEASED', dueDate: null, number: 'CO-2' },
      { status: 'RELEASED', dueDate: '2026-11-22', number: 'CO-4' },
      { status: 'IN_PROGRESS', dueDate: '2026-11-25', number: 'CO-1' },
    ]
    expect([...rows].sort(boardOrder).map((row) => row.number)).toEqual(['CO-1', 'CO-4', 'CO-2', 'CO-3'])
    expect(isLate({ status: 'RELEASED', dueDate: '2026-11-19' }, day)).toBe(true)
    expect(isLate({ status: 'CUT', dueDate: '2026-11-19' }, day)).toBe(false)
  })

  it('says percentages of whole numbers and of lengths', () => {
    expect(sharePct(1, 3)).toBe(33)
    expect(sharePct(5, 0)).toBeNull()
    expect(differencePct(new Dec('12.6'), new Dec('12'))).toBe('5.0')
    expect(differencePct(new Dec('11.4'), new Dec('12'))).toBe('-5.0')
    expect(differencePct(new Dec('1'), new Dec('0'))).toBeNull()
  })
})

describe('the cutting and yield report (MES-302)', () => {
  it('sums cut vs ordered over known orders; a leather order waiting for its reconciliation stays out', () => {
    const sums = cutSums([
      [
        { ordered: 20, cut: 18, variance: true },
        { ordered: 40, cut: 36, variance: true },
      ],
      [{ ordered: 10, cut: 10, variance: false }],
      [
        { ordered: 1, cut: 1, variance: false },
        { ordered: 2, cut: null, variance: false },
      ],
    ])
    expect(sums).toEqual({ orders: 2, ordered: 70, cut: 64, difference: -6, pct: 91, waiting: 1, variances: 2 })
  })

  it('groups yield by lot and supplier, the percentages of the sums, worst first', () => {
    const rows = [
      { lot: 'L1', supplier: 'S1', totals: yieldTotals([{ used: '20', remnant: '0', pattern: '16', need: '18' }]) },
      { lot: 'L2', supplier: 'S1', totals: yieldTotals([{ used: '10', remnant: '1', pattern: '6', need: '8' }]) },
      { lot: 'L1', supplier: 'S1', totals: yieldTotals([{ used: '10', remnant: '0', pattern: '8', need: '9' }]) },
    ]
    const lots = groupTotals(rows, (row) => row.lot, (row) => row.totals)
    expect(lots.map((lot) => [lot.key, lot.rows.length, groupFigures(lot.totals).yieldPct])).toEqual([
      ['L1', 2, '80.00'],
      ['L2', 1, '60.00'],
    ])
    const suppliers = groupTotals(rows, (row) => row.supplier, (row) => row.totals)
    expect(groupFigures(suppliers[0]!.totals)).toMatchObject({ used: '40.0000', pattern: '30.0000', yieldPct: '75.00' })
    expect(worstFirst([{ name: 'A', yieldPct: '80.00' }, { name: 'B', yieldPct: null }, { name: 'C', yieldPct: '60.00' }]).map((row) => row.name)).toEqual(['C', 'A', 'B'])
  })

  it('counts a period back from its last day', () => {
    expect(periodFrom('2026-11-30', 30)).toBe('2026-11-01')
    expect(periodFrom('2026-11-30', 1)).toBe('2026-11-30')
  })
})

describe('one shade lot per order on the work order (SCM-206)', () => {
  it('says none, one or mixed; mixed or out of shade breaks the ORDER rule only', () => {
    expect(shadeSummary('ORDER', [])).toEqual({ verdict: 'NONE', breaksRule: false, outOfShade: false })
    expect(shadeSummary('ORDER', [{ key: 'L1|-', outOfShade: false }, { key: 'L1|-', outOfShade: false }])).toEqual({ verdict: 'ONE', breaksRule: false, outOfShade: false })
    expect(shadeSummary('ORDER', [{ key: 'L1|-', outOfShade: false }, { key: 'L2|-', outOfShade: false }]).breaksRule).toBe(true)
    expect(shadeSummary('ORDER', [{ key: 'L1|g:x', outOfShade: true }])).toEqual({ verdict: 'ONE', breaksRule: true, outOfShade: true })
    expect(shadeSummary('GARMENT', [{ key: 'L1|-', outOfShade: false }, { key: 'L2|-', outOfShade: false }])).toEqual({ verdict: 'MIXED', breaksRule: false, outOfShade: false })
  })
})

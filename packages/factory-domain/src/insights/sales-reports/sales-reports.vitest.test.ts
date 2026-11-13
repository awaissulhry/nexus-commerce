import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { SALES_REPORTS_ADDS, SALES_REPORTS_VIEW } from './permissions'
import {
  backlogFiguresOf,
  backlogGroupsOf,
  backlogWeekOf,
  backlogWeeksOf,
  bookedOnOf,
  horizonOf,
  intakeBucketsOf,
  intakeFold,
  medianOf,
  openValueOf,
  pctOf,
  quoteSpeedOf,
  returnGroupsOf,
  returnHeatmapOf,
  sizeOrder,
  valueFiguresOf,
  type BacklogPiece,
  type IntakeLine,
  type ReturnEntry,
} from './rules'

const TODAY = '2026-11-12' // a Thursday (ISO week 46)

describe('the permission', () => {
  it('is declared, read risk, and held by sales, finance and the production manager (office)', () => {
    expect(FACTORY_PERMISSIONS.get(SALES_REPORTS_VIEW)?.risk).toBe('read')
    expect(Object.keys(SALES_REPORTS_ADDS).sort()).toEqual(['finance', 'production_manager', 'sales'])
    for (const key of Object.keys(SALES_REPORTS_ADDS)) expect(templateOf(key)!.permissions, key).toContain(SALES_REPORTS_VIEW)
    for (const key of ['sales', 'finance']) expect(templateOf(key)!.permissions, key).toContain('orders.view')
    expect(templateOf('planner')!.permissions).not.toContain(SALES_REPORTS_VIEW)
    expect(templateOf('owner')!.permissions).toContain(SALES_REPORTS_VIEW)
  })
})

describe('money and figures', () => {
  it('sums per currency, the company first, never across', () => {
    expect(valueFiguresOf([{ currency: 'EUR', value: 100 }, { currency: 'EUR', value: 50 }], 'EUR')).toEqual({ byCurrency: [{ currency: 'EUR', value: 150 }], value: 150, currency: 'EUR', mixedCurrencies: false })
    const mixed = valueFiguresOf([{ currency: 'USD', value: 10 }, { currency: 'EUR', value: 20 }, { currency: 'CHF', value: 5 }], 'EUR')
    expect(mixed.byCurrency.map((entry) => entry.currency)).toEqual(['EUR', 'CHF', 'USD'])
    expect(mixed.value).toBeNull()
    expect(mixed.mixedCurrencies).toBe(true)
    expect(valueFiguresOf([], 'EUR')).toEqual({ byCurrency: [], value: 0, currency: 'EUR', mixedCurrencies: false })
  })

  it('a share, a median, the open part of a line', () => {
    expect(pctOf(1, 8)).toBe('12.5')
    expect(pctOf(3, 0)).toBeNull()
    expect(medianOf([])).toBeNull()
    expect(medianOf([5, 1, 3])).toBe(3)
    expect(medianOf([4, 1, 3, 10])).toBe(4)
    expect(openValueOf(10_000, 4, 1)).toBe(2500)
    expect(openValueOf(10_001, 3, 1)).toBe(3334)
    expect(openValueOf(10_000, 4, 4)).toBe(10_000)
    expect(openValueOf(10_000, 4, 0)).toBe(0)
  })
})

describe('order intake (SAL-105)', () => {
  const line = (orderId: string, bookedOn: string, over: Partial<IntakeLine> = {}): IntakeLine => ({ orderId, bookedOn, customer: 'C1', style: 'S1', season: 'none', pieces: 10, value: 1000, currency: 'EUR', ...over })

  it('weeks are ISO weeks clipped to the period; months by calendar', () => {
    expect(intakeBucketsOf({ from: '2026-11-01', to: '2026-11-12' }, 'week').map((bucket) => [bucket.key, bucket.from, bucket.to])).toEqual([
      ['2026-W44', '2026-11-01', '2026-11-01'],
      ['2026-W45', '2026-11-02', '2026-11-08'],
      ['2026-W46', '2026-11-09', '2026-11-12'],
    ])
    expect(intakeBucketsOf({ from: '2026-09-15', to: '2026-11-12' }, 'month').map((bucket) => bucket.key)).toEqual(['2026-09', '2026-10', '2026-11'])
  })

  it('folds by bucket and split, ranks by value only for a reader of amounts, counts orders once', () => {
    const buckets = intakeBucketsOf({ from: '2026-11-01', to: '2026-11-12' }, 'week')
    const lines = [line('O1', '2026-11-03', { style: 'S1', pieces: 10, value: 1000 }), line('O1', '2026-11-03', { style: 'S2', pieces: 5, value: 4000 }), line('O2', '2026-11-10', { customer: 'C2', style: 'S1', pieces: 30, value: 500 }), line('O2', '2026-11-10', { customer: 'C2', style: 'fees', pieces: 0, value: 100 })]
    const fold = intakeFold(lines, buckets, 'style', { byValue: true, companyCurrency: 'EUR' })
    expect(fold.all).toMatchObject({ orders: 2, pieces: 45, value: 5600 })
    expect(fold.buckets.map((bucket) => [bucket.key, bucket.figures.orders, bucket.figures.pieces])).toEqual([
      ['2026-W44', 0, 0],
      ['2026-W45', 1, 15],
      ['2026-W46', 1, 30],
    ])
    expect(fold.groups.map((group) => group.key)).toEqual(['S2', 'S1', 'fees'])
    expect(fold.groups.find((group) => group.key === 'S1')?.figures).toMatchObject({ orders: 2, pieces: 40, value: 1500 })
    expect(intakeFold(lines, buckets, 'style', { byValue: false, companyCurrency: 'EUR' }).groups.map((group) => group.key)).toEqual(['S1', 'S2', 'fees'])
    expect(intakeFold(lines, buckets, 'none', { byValue: true, companyCurrency: 'EUR' }).groups).toEqual([])
  })

  it('an order split off another is booked on its first order’s day', () => {
    const orders = new Map([
      ['A', { orderDate: '2026-10-20', splitFrom: null }],
      ['B', { orderDate: '2026-11-05', splitFrom: 'A' }],
      ['C', { orderDate: '2026-11-09', splitFrom: 'B' }],
      ['D', { orderDate: '2026-11-09', splitFrom: 'gone' }],
    ])
    expect(bookedOnOf('C', orders)).toBe('2026-10-20')
    expect(bookedOnOf('A', orders)).toBe('2026-10-20')
    expect(bookedOnOf('D', orders)).toBe('2026-11-09')
    expect(bookedOnOf('X', orders)).toBeNull()
  })
})

describe('the backlog by promise week (SAL-106)', () => {
  const piece = (promise: string | null, over: Partial<BacklogPiece> = {}): BacklogPiece => ({ orderId: 'O1', lineId: 'L1', customer: 'C1', style: 'S1', open: 10, value: 1000, currency: 'EUR', promise, ...over })

  it('the weeks run from the earliest promise to the latest, at least this week, folded beyond the limits', () => {
    const weeks = backlogWeeksOf([piece('2026-11-03'), piece('2026-11-20'), piece(null)], TODAY)
    expect(weeks.map((week) => [week.key, week.past, week.current])).toEqual([
      ['2026-W45', true, false],
      ['2026-W46', false, true],
      ['2026-W47', false, false],
      ['NONE', false, false],
    ])
    const far = backlogWeeksOf([piece('2026-01-05'), piece('2027-12-01')], TODAY, { weeksBack: 2, weeksAhead: 3 })
    expect(far[0]).toMatchObject({ key: 'EARLIER', to: '2026-10-25' })
    expect(far.at(-1)).toMatchObject({ key: 'LATER', from: '2026-12-07' })
    expect(far.filter((week) => week.kind === 'WEEK')).toHaveLength(6)
    expect(backlogWeekOf(far, '2026-01-05')).toBe('EARLIER')
    expect(backlogWeekOf(far, '2027-12-01')).toBe('LATER')
    expect(backlogWeekOf(far, '2026-11-12')).toBe('2026-W46')
    expect(backlogWeekOf(far, null)).toBe('NONE')
    expect(backlogWeeksOf([], TODAY).map((week) => week.key)).toEqual(['2026-W46'])
  })

  it('late is a promise before today; horizons and groups', () => {
    expect(['2026-11-11', '2026-11-12', '2026-11-15', '2026-11-16', '2026-12-13', '2026-12-14', null].map((day) => horizonOf(day, TODAY))).toEqual(['late', 'thisWeek', 'thisWeek', 'next4', 'next4', 'later', 'none'])
    const pieces = [piece('2026-11-10', { open: 4 }), piece('2026-11-13', { lineId: 'L2', open: 6, style: 'S2' }), piece(null, { orderId: 'O2', lineId: 'L3', customer: 'C2', open: 3, value: 9000 })]
    expect(backlogFiguresOf(pieces, TODAY, 'EUR')).toMatchObject({ orders: 2, lines: 3, pieces: 13, late: 4, value: 11_000 })
    const byCustomer = backlogGroupsOf(pieces, 'customer', TODAY, { byValue: true, companyCurrency: 'EUR' })
    expect(byCustomer.map((group) => group.key)).toEqual(['C2', 'C1'])
    expect(byCustomer[1]!.horizons).toEqual({ late: 4, thisWeek: 6, next4: 0, later: 0, none: 0 })
    expect(backlogGroupsOf(pieces, 'customer', TODAY, { byValue: false, companyCurrency: 'EUR' }).map((group) => group.key)).toEqual(['C1', 'C2'])
  })
})

describe('return reasons (SAL-458)', () => {
  const entry = (over: Partial<ReturnEntry>): ReturnEntry => ({ returnId: 'R1', lineId: 'L1', reason: 'SIZE', style: 'S1', colour: 'K1', size: 'M', customer: 'C1', pieces: 1, credited: null, ...over })

  it('groups by reason with pieces, returns and credits; the heatmap in wearing order', () => {
    const entries = [entry({ lineId: 'a', reason: 'SIZE', size: 'L', pieces: 2 }), entry({ lineId: 'b', reason: 'DEFECT', size: 'S', pieces: 1, credited: { currency: 'EUR', value: 5000 } }), entry({ returnId: 'R2', lineId: 'c', reason: 'SIZE', style: 'S2', size: '48', pieces: 3 }), entry({ returnId: 'R2', lineId: 'd', reason: 'SIZE', style: 'none', size: 'none', pieces: 1 })]
    const reasons = returnGroupsOf(entries, 'reason', 'EUR')
    expect(reasons.map((group) => [group.key, group.figures.pieces, group.figures.returns])).toEqual([
      ['SIZE', 6, 2],
      ['DEFECT', 1, 1],
    ])
    expect(reasons[1]!.figures.value).toBe(5000)
    const map = returnHeatmapOf(entries)
    expect(map.styles).toEqual(['S1', 'S2'])
    expect(map.sizes).toEqual(['S', 'L', '48'])
    expect(map.cells).toEqual([
      [1, 2, null],
      [null, null, 3],
    ])
    expect(['XL', '50', 'S', 'none', '46', 'Regular', 'M'].sort(sizeOrder)).toEqual(['S', 'M', 'XL', '46', '50', 'Regular', 'none'])
  })
})

describe('quote speed', () => {
  it('medians, the win rate of decided quotes (expired apart), the value won', () => {
    const speed = quoteSpeedOf(
      [
        { minutes: 120, fromInquiry: true },
        { minutes: 600, fromInquiry: false },
        { minutes: 300, fromInquiry: false },
      ],
      [
        { outcome: 'ACCEPTED', hours: 48, value: 100_000, currency: 'EUR' },
        { outcome: 'ACCEPTED', hours: 10, value: 50_000, currency: 'EUR' },
        { outcome: 'DECLINED', hours: 20, value: 70_000, currency: 'EUR' },
        { outcome: 'EXPIRED', hours: 500, value: 10_000, currency: 'EUR' },
      ],
      'EUR',
    )
    expect(speed).toMatchObject({ answered: 3, medianAnswerMinutes: 300, fromInquiries: 1, accepted: 2, declined: 1, expired: 1, winRatePct: '66.7', medianDecisionHours: 20 })
    expect(speed.won).toMatchObject({ value: 150_000, currency: 'EUR' })
    expect(quoteSpeedOf([], [{ outcome: 'EXPIRED', hours: null, value: 1, currency: 'EUR' }], 'EUR')).toMatchObject({ winRatePct: null, medianAnswerMinutes: null, medianDecisionHours: null })
  })
})

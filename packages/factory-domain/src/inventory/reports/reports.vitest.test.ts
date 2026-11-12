import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import {
  addLeather,
  AGE_BUCKETS,
  bucketOf,
  fifoSlices,
  figuresOf,
  flowOf,
  inReferenceUnit,
  isIdle,
  lastMonthOf,
  leatherFiguresOf,
  MATERIAL_TYPES,
  periodOf,
  periodProblems,
  slicesOf,
  type AgeingPosition,
} from './rules'
import { INVENTORY_REPORTS_ADDS, INVENTORY_REPORTS_VIEW } from './permissions'

const at = (day: string) => new Date(`${day}T10:00:00.000Z`)

describe('the period (the monthly stock review)', () => {
  it('defaults to this month so far; a lone end starts on the 1st of its month; last month', () => {
    expect(periodOf({}, '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' })
    expect(periodOf({ to: '2026-10-31' }, '2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(periodOf({ from: '2026-09-15' }, '2026-11-12')).toEqual({ from: '2026-09-15', to: '2026-11-12' })
    expect(lastMonthOf('2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(lastMonthOf('2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('refuses in words: backwards, after today, too long, before 2020, not a day', () => {
    const today = '2026-11-12'
    expect(periodProblems({ from: '2026-11-10', to: '2026-11-01' }, today)[0]!.message).toBe('The period ends before it starts.')
    expect(periodProblems({ from: '2026-11-01', to: '2026-11-13' }, today)[0]!.message).toMatch(/cannot end after today/)
    expect(periodProblems({ from: '2025-11-01', to: '2026-11-12' }, today)[0]!.message).toBe('A report covers at most 366 days.')
    expect(periodProblems({ from: '2019-12-31', to: '2020-01-31' }, today)[0]!.message).toBe('A report starts on 2020-01-01 or later.')
    expect(periodProblems({ from: '2026-13-01', to: '2026-11-12' }, today)[0]!.path).toBe('querystring/from')
    expect(periodProblems({ from: '2025-11-12', to: '2026-11-12' }, today)).toEqual([])
  })
})

describe('stock ageing', () => {
  it('the buckets of the design: 0–90, 91–180, 181–365, over a year', () => {
    expect([0, 90, 91, 180, 181, 365, 366, 1000].map(bucketOf)).toEqual(['d0to90', 'd0to90', 'd91to180', 'd91to180', 'd181to365', 'd181to365', 'overYear', 'overYear'])
    expect(AGE_BUCKETS).toHaveLength(4)
    expect(MATERIAL_TYPES[0]).toBe('LEATHER')
    expect(MATERIAL_TYPES.at(-1)).toBe('FINISHED')
  })

  it('first in, first out: what is on hand is the latest that came in; nothing dated is said apart', () => {
    const ins = [
      { at: at('2025-01-10'), quantity: '100' },
      { at: at('2026-06-01'), quantity: '40' },
      { at: at('2026-10-01'), quantity: '30' },
    ]
    const slices = fifoSlices('50', ins)
    expect(slices.map((slice) => [slice.at?.toISOString().slice(0, 10), slice.quantity.toString()])).toEqual([
      ['2026-10-01', '30'],
      ['2026-06-01', '20'],
    ])
    expect(fifoSlices('0', ins)).toEqual([])
    const short = fifoSlices('20', [{ at: at('2026-10-01'), quantity: '5' }])
    expect(short.map((slice) => [slice.at === null, slice.quantity.toString()])).toEqual([
      [false, '5'],
      [true, '15'],
    ])
  })

  it('a lot is as old as the lot; an untracked article is aged by its parts; the value shared by quantity, to the cent', () => {
    const lot: AgeingPosition = { itemId: 'i1', kind: 'LINING', uom: 'M', onHand: '120', value: 37_200, currency: 'EUR', lotSince: at('2025-10-01'), tracked: true, ins: [{ at: at('2026-11-01'), quantity: '120' }] }
    expect(slicesOf(lot, '2026-11-30').map((slice) => [slice.bucket, slice.days, slice.quantity.toString(), slice.value])).toEqual([['overYear', 425, '120', 37_200]])
    // A lot without a received day (opening stock): its first move into stock.
    expect(slicesOf({ ...lot, lotSince: null }, '2026-11-30')[0]).toMatchObject({ bucket: 'd0to90', days: 29 })
    const trims: AgeingPosition = {
      itemId: 'i2',
      kind: 'TRIM',
      uom: 'PCS',
      onHand: '3',
      value: 100,
      currency: 'EUR',
      lotSince: null,
      tracked: false,
      ins: [
        { at: at('2026-01-01'), quantity: '2' },
        { at: at('2026-09-01'), quantity: '2' },
      ],
    }
    const parts = slicesOf(trims, '2026-11-30')
    expect(parts.map((slice) => [slice.bucket, slice.quantity.toString(), slice.value])).toEqual([
      ['d0to90', '2', 67],
      ['d181to365', '1', 33],
    ])
    expect(parts.reduce((sum, slice) => sum + (slice.value ?? 0), 0)).toBe(100)
    expect(slicesOf({ ...trims, value: null }, '2026-11-30').every((slice) => slice.value === null)).toBe(true)
  })

  it('a group in one unit has shares and an average age; several units have neither; values per currency only', () => {
    const slices = [
      { slice: { bucket: 'd0to90' as const, days: 10, quantity: new Dec('30'), value: 3000 }, uom: 'M' as const, currency: 'EUR' },
      { slice: { bucket: 'overYear' as const, days: 400, quantity: new Dec('10'), value: 1000 }, uom: 'M' as const, currency: 'EUR' },
      { slice: { bucket: 'd0to90' as const, days: 5, quantity: new Dec('1000'), value: null }, uom: 'CM' as const, currency: null },
    ]
    const one = figuresOf(slices, 3)
    // 30 m + 10 m (= cm made metres: 10 m): 50 m in all.
    expect(one.whole.quantities).toEqual([{ uom: 'M', quantity: '50.0000' }])
    expect(one.buckets.d0to90).toEqual({ quantities: [{ uom: 'M', quantity: '40.0000' }], value: 3000, share: '80.0' })
    expect(one.buckets.overYear.share).toBe('20.0')
    expect(one.buckets.d91to180).toEqual({ quantities: [], value: 0, share: '0.0' })
    expect(one).toMatchObject({ averageDays: '87.0', oldestDays: 400, unvalued: 1, currency: 'EUR', mixedCurrencies: false, keys: 3 })
    expect(one.whole.value).toBe(4000)

    const mixed = figuresOf([...slices, { slice: { bucket: 'd91to180' as const, days: 100, quantity: new Dec('4'), value: 50 }, uom: 'PCS' as const, currency: 'CHF' }], 4)
    expect(mixed.whole.quantities).toEqual([
      { uom: 'M', quantity: '50.0000' },
      { uom: 'PCS', quantity: '4.0000' },
    ])
    expect(mixed.buckets.d0to90.share).toBeNull()
    expect(mixed.averageDays).toBeNull()
    expect(mixed).toMatchObject({ mixedCurrencies: true, currency: null })
    expect(mixed.whole.value).toBeNull()
    expect(mixed.buckets.d0to90.value).toBeNull()
  })

  it('units: a fixed factor only (ft² to m², a pair to two pieces), a unit of its own stays itself', () => {
    expect(inReferenceUnit('100', 'FT2').quantity.toFixed(4)).toBe('9.2903')
    expect(inReferenceUnit('3', 'PAIR')).toMatchObject({ uom: 'PCS' })
    expect(inReferenceUnit('3', 'PAIR').quantity.toString()).toBe('6')
    expect(inReferenceUnit('2', 'CONE')).toMatchObject({ uom: 'CONE' })
  })
})

describe('leather use', () => {
  it('each move counts by what it did; a reversal takes it back; cut = issued less what came back; it adds up', () => {
    expect(flowOf('RECEIPT')).toBe('received')
    expect(flowOf('LEATHER' as never)).toBe('other')
    expect(flowOf('TRANSFER_IN')).toBe('other')
    const figures = leatherFiguresOf(
      { quantity: '20', value: 2000 },
      [
        { reason: 'RECEIPT', direction: 'IN', quantity: '105', value: 44_100 },
        { reason: 'RECEIPT', direction: 'OUT', quantity: '5', value: -2_100 },
        { reason: 'ISSUE', direction: 'OUT', quantity: '60', value: -25_200 },
        { reason: 'ISSUE', direction: 'IN', quantity: '10', value: 4_200 },
        { reason: 'RETURN', direction: 'IN', quantity: '8', value: 3_360 },
        { reason: 'REMNANT', direction: 'IN', quantity: '12', value: 5_040 },
        { reason: 'SCRAP', direction: 'OUT', quantity: '4', value: -1_680 },
        { reason: 'ADJUSTMENT', direction: 'OUT', quantity: '1', value: -420 },
        { reason: 'OPENING', direction: 'IN', quantity: '3', value: 1_260 },
      ],
      { quantity: '98', value: 30_560 },
    )
    expect([figures.received, figures.issued, figures.returned, figures.remnant, figures.cut, figures.scrapped, figures.other].map((value) => value.toString())).toEqual(['100', '50', '8', '12', '30', '4', '2'])
    // 20 + 100 − 30 − 4 + 2 = 88: the end said 98, so it does not add up (a check, never assumed).
    expect(figures.addsUp).toBe(false)
    const right = leatherFiguresOf({ quantity: '20', value: 2000 }, [{ reason: 'RECEIPT', direction: 'IN', quantity: '10', value: 4_200 }, { reason: 'ISSUE', direction: 'OUT', quantity: '10', value: -4_200 }, { reason: 'REMNANT', direction: 'IN', quantity: '2', value: 840 }], { quantity: '22', value: 2_840 })
    expect(right).toMatchObject({ addsUp: true })
    expect(right.cut.toString()).toBe('8')
    expect(right.values).toEqual({ start: 2000, received: 4_200, cut: 3_360, scrapped: 0, end: 2_840 })
    expect(figures.values.received).toBe(42_000)
    expect(figures.values.scrapped).toBe(1_680)
    expect(figures.values.cut).toBe(25_200 - 4_200 - 3_360 - 5_040)
  })

  it('an article is its lots added; a group with nothing is idle', () => {
    const a = leatherFiguresOf({ quantity: '0', value: 0 }, [{ reason: 'RECEIPT', direction: 'IN', quantity: '10', value: 100 }], { quantity: '10', value: 100 })
    const b = leatherFiguresOf({ quantity: '5', value: 50 }, [{ reason: 'SCRAP', direction: 'OUT', quantity: '5', value: -50 }], { quantity: '0', value: 0 })
    const both = addLeather(a, b)
    expect([both.start, both.received, both.scrapped, both.end].map((value) => value.toString())).toEqual(['5', '10', '5', '10'])
    expect(both.addsUp).toBe(true)
    expect(both.values).toEqual({ start: 50, received: 100, cut: 0, scrapped: 50, end: 100 })
    expect(isIdle(leatherFiguresOf({ quantity: '0', value: 0 }, [], { quantity: '0', value: 0 }))).toBe(true)
    expect(isIdle(a)).toBe(false)
  })
})

describe('permissions', () => {
  it('inventory.reports.view, given to the warehouse, the buyer, the planner, the production manager and finance', () => {
    expect(INVENTORY_REPORTS_VIEW).toBe('inventory.reports.view')
    expect(Object.keys(INVENTORY_REPORTS_ADDS).sort()).toEqual(['buyer', 'finance', 'planner', 'production_manager', 'warehouse'])
  })
})

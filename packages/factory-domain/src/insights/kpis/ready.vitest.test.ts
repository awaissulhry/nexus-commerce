import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { applyCalc } from './calc'
import { grainsOfKpi, kpiFileProblems, permissionsOfKpi, type KpiFile } from './catalogue'
import { cutAreas, addAreas, yieldOfAreas } from './leather-yield'
import { familyOf, leadDays, leadSummary, orderShippedOn, quantile } from './lead-times'
import { addFigures, marginOf, shareOf } from './margin'
import { MEASURES, measureOf } from './measures'
import { completeOn, linePromises, otifByDay, otifOf, type OtifLine } from './otif'
import { kpiFileOf, KPI_CATALOGUE } from './registry'
import { coverDays, onTimePct, receivedOnTime, supplierDueOf } from './supplier-on-time'
import { ageBucketOf, ageDays, endedAt, inWorkAt, waitingSince } from './wip'

const sums = (entries: Record<string, string | null>) => new Map(Object.entries(entries).map(([key, value]) => [key, value === null ? null : new Dec(value)]))
const READY = ['delivery.otif', 'delivery.otif_current', 'sales.quote_to_order_days', 'delivery.order_to_ship_days', 'production.order_to_start_days', 'production.wip_pieces', 'production.wip_age_days', 'production.leather_yield', 'sales.margin_quoted', 'sales.margin_actual', 'purchasing.supplier_on_time']

describe('the ready KPIs on the one layer (B-W2b-429)', () => {
  it('are sound files, each with a drill to its records, never a measure of a person', () => {
    for (const key of READY) {
      const file = kpiFileOf(key)
      expect(file, key).not.toBeNull()
      expect(kpiFileProblems(file!), key).toEqual([])
      expect(file!.drill?.kind, key).toBe('LIST')
      expect(file!.drill && file!.drill.kind === 'LIST' ? file!.drill.api : '', key).toMatch(/^\/insights\/kpis\/drills\/[a-z-]+$/)
    }
    expect(KPI_CATALOGUE.length).toBe(19)
    for (const measure of MEASURES) expect(measure.key).not.toMatch(/worker|operator|person|employee|user|cutter/)
  })

  it('names the seeded versions’ facts exactly (on-time in full v2/v3, supplier on-time v1 can be put in force)', () => {
    expect(kpiFileOf('delivery.otif')!.calc).toMatchObject({ numerator: ['orders.lines_shipped_on_time'], denominator: ['orders.lines_due'] })
    expect(kpiFileOf('purchasing.supplier_on_time')!.calc).toMatchObject({ numerator: ['purchasing.lines_on_time'], denominator: ['purchasing.lines_received'] })
  })

  it('shows margin only with the margin grain (and the price of its value), from the costing list', () => {
    expect(grainsOfKpi(kpiFileOf('sales.margin_actual')!)).toEqual(['margin', 'price'])
    expect(permissionsOfKpi(kpiFileOf('sales.margin_actual')!)).toEqual(['costing.view'])
    expect(measureOf('margin.actual')).toMatchObject({ grain: 'margin', unconverted: 'margin.unconverted', partyScoped: true })
    expect(grainsOfKpi(kpiFileOf('production.leather_yield')!)).toEqual([])
    expect(permissionsOfKpi(kpiFileOf('purchasing.supplier_on_time')!)).toEqual(['purchasing.view'])
  })

  it('averages days with the one calculation: Σ days ÷ orders, one decimal; no orders, no value', () => {
    const lead = kpiFileOf('delivery.order_to_ship_days')!.calc
    expect(applyCalc(lead, sums({ 'leadtimes.order_to_ship_days': '31', 'leadtimes.order_to_ship_orders': '3' }))).toBe('10.3')
    expect(applyCalc(lead, sums({ 'leadtimes.order_to_ship_days': '0', 'leadtimes.order_to_ship_orders': '0' }))).toBeNull()
    expect(applyCalc(kpiFileOf('production.wip_age_days')!.calc, sums({ 'wip.piece_days': '250', 'wip.pieces': '40' }))).toBe('6.3')
    const file = kpiFileOf('delivery.order_to_ship_days')!
    expect(kpiFileProblems({ ...file, calc: { ...file.calc, scale: 100 } } as KpiFile)).toContain('delivery.order_to_ship_days: a percent scales by 100, a ratio by 1')
  })
})

describe('on-time in full (ANA-013)', () => {
  const line = (over: Partial<OtifLine> = {}): OtifLine => ({ kind: 'SIZE_GRID', quantity: 10, closedShortQuantity: null, firstPromise: '2026-11-10', currentPromise: '2026-11-17', shipped: [], ...over })

  it('is on time when the pieces due left by the promised day; a partial shipment is not in full', () => {
    expect(otifOf(line({ shipped: [{ day: '2026-11-09', quantity: 10 }] }), 'FIRST', '2026-11-20')).toMatchObject({ outcome: 'ON_TIME', completeOn: '2026-11-09', lateDays: 0 })
    expect(otifOf(line({ shipped: [{ day: '2026-11-09', quantity: 6 }, { day: '2026-11-12', quantity: 4 }] }), 'FIRST', '2026-11-20')).toMatchObject({ outcome: 'LATE', completeOn: '2026-11-12', lateDays: 2, shippedByPromise: 6 })
    // On the promise of now the same line is on time.
    expect(otifOf(line({ shipped: [{ day: '2026-11-09', quantity: 6 }, { day: '2026-11-12', quantity: 4 }] }), 'CURRENT', '2026-11-20')).toMatchObject({ outcome: 'ON_TIME' })
    // Closed short: only what is still due counts.
    expect(otifOf(line({ closedShortQuantity: 4, shipped: [{ day: '2026-11-10', quantity: 6 }] }), 'FIRST', '2026-11-20')).toMatchObject({ outcome: 'ON_TIME', due: 6 })
    // Not complete: late from its day, counted until today.
    expect(otifOf(line(), 'FIRST', '2026-11-14')).toMatchObject({ outcome: 'LATE', completeOn: null, lateDays: 4 })
  })

  it('counts no fee line, nothing due, no promise', () => {
    expect(otifOf(line({ kind: 'FEE' }), 'FIRST', '2026-11-20')).toBeNull()
    expect(otifOf(line({ closedShortQuantity: 10 }), 'FIRST', '2026-11-20')).toBeNull()
    expect(otifOf(line({ firstPromise: null }), 'FIRST', '2026-11-20')).toBeNull()
    expect(completeOn([{ day: '2026-11-02', quantity: 3 }, { day: '2026-11-01', quantity: 2 }], 5)).toBe('2026-11-02')
  })

  it('counts each line on the day of its promise, first and current apart', () => {
    const days = otifByDay([line({ shipped: [{ day: '2026-11-10', quantity: 10 }] }), line({ firstPromise: '2026-11-10', currentPromise: '2026-11-10' }), line({ kind: 'FEE' })], '2026-11-20')
    expect(days.get('2026-11-10')).toEqual({ due: 2, onTime: 1, dueCurrent: 1, onTimeCurrent: 0 })
    expect(days.get('2026-11-17')).toEqual({ due: 0, onTime: 0, dueCurrent: 1, onTimeCurrent: 1 })
  })

  it('takes the first promise from the history (the latest of the sizes’ first), else the first date typed', () => {
    const at = (iso: string) => new Date(iso)
    const rows = [
      { id: 'a', size: 'M', promisedDate: '2026-11-10', kind: 'FIRST' as const, promisedAt: at('2026-10-01T08:00:00Z') },
      { id: 'b', size: 'L', promisedDate: '2026-11-12', kind: 'FIRST' as const, promisedAt: at('2026-10-01T08:00:00Z') },
      { id: 'c', size: 'L', promisedDate: '2026-11-20', kind: 'RE_PROMISE' as const, promisedAt: at('2026-10-05T08:00:00Z') },
    ]
    expect(linePromises(['M', 'L'], rows, '2026-11-08', '2026-11-08')).toEqual({ first: '2026-11-12', current: '2026-11-20' })
    expect(linePromises([null], [], '2026-11-15', '2026-11-11')).toEqual({ first: '2026-11-11', current: '2026-11-15' })
  })
})

describe('lead times (ANA-014)', () => {
  it('takes whole days, the median and the middle half, the average', () => {
    expect(leadDays('2026-11-01', '2026-11-11')).toBe(10)
    expect(leadDays('2026-11-11', '2026-11-01')).toBe(0)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(leadSummary([10, 2, 4, 30])).toEqual({ orders: 4, medianDays: '7.0', p25Days: '3.5', p75Days: '15.0', spreadDays: '11.5', averageDays: '11.5', minDays: 2, maxDays: 30 })
    expect(leadSummary([])).toMatchObject({ orders: 0, medianDays: null, spreadDays: null, averageDays: null })
  })

  it('ships an order complete on the day its last garment due left; the family of most garments', () => {
    const shipped = (day: string, quantity: number) => ({ day, quantity })
    expect(orderShippedOn([
      { kind: 'SIZE_GRID', quantity: 4, closedShortQuantity: null, shipped: [shipped('2026-11-03', 4)] },
      { kind: 'SIZE_GRID', quantity: 5, closedShortQuantity: 1, shipped: [shipped('2026-11-02', 2), shipped('2026-11-06', 2)] },
      { kind: 'FEE', quantity: 1, closedShortQuantity: null, shipped: [] },
    ])).toBe('2026-11-06')
    expect(orderShippedOn([{ kind: 'SIZE_GRID', quantity: 4, closedShortQuantity: null, shipped: [shipped('2026-11-03', 3)] }])).toBeNull()
    expect(orderShippedOn([{ kind: 'FEE', quantity: 1, closedShortQuantity: null, shipped: [] }])).toBeNull()
    expect(familyOf([{ family: 'TROUSERS', pieces: 4 }, { family: 'JACKET', pieces: 3 }, { family: 'JACKET', pieces: 2 }])).toBe('JACKET')
    expect(familyOf([{ family: 'TROUSERS', pieces: 2 }, { family: 'JACKET', pieces: 2 }], ['JACKET', 'TROUSERS'])).toBe('JACKET')
    expect(familyOf([])).toBeNull()
  })
})

describe('work in progress and its age (ANA-015)', () => {
  const at = (iso: string) => new Date(iso)
  it('is in work from its release until completed, closed or cancelled; ages in days on the site’s clock', () => {
    const order = { releasedAt: at('2026-11-02T09:00:00Z'), completedAt: at('2026-11-09T15:00:00Z'), closedAt: at('2026-11-10T09:00:00Z'), cancelledAt: null }
    expect(endedAt(order)).toEqual(at('2026-11-09T15:00:00Z'))
    expect(inWorkAt(order, at('2026-11-02T08:00:00Z'))).toBe(false)
    expect(inWorkAt(order, at('2026-11-05T23:00:00Z'))).toBe(true)
    expect(inWorkAt(order, at('2026-11-09T23:00:00Z'))).toBe(false)
    expect(inWorkAt({ ...order, releasedAt: null }, at('2026-11-05T23:00:00Z'))).toBe(false)
    // 23:30 UTC on 1 Nov is already 2 Nov in Rome.
    expect(ageDays(at('2026-11-01T23:30:00Z'), '2026-11-05', 'Europe/Rome')).toBe(3)
    expect([0, 2, 3, 5, 6, 10, 11].map(ageBucketOf)).toEqual(['D0_2', 'D0_2', 'D3_5', 'D3_5', 'D6_10', 'D6_10', 'D11_PLUS'])
    expect(waitingSince({ releasedAt: at('2026-11-01T08:00:00Z'), startedAt: null, lastReportAt: null })).toEqual(at('2026-11-01T08:00:00Z'))
    expect(waitingSince({ releasedAt: at('2026-11-01T08:00:00Z'), startedAt: at('2026-11-02T08:00:00Z'), lastReportAt: at('2026-11-04T08:00:00Z') })).toEqual(at('2026-11-04T08:00:00Z'))
  })
})

describe('leather yield (ANA-020)', () => {
  it('adds square metres from every unit, then takes the percent of the sums; single parts are left out', () => {
    const a = cutAreas({ used: '10.7639', remnant: '0', pattern: '8.6111', need: null }, 'FT2') // 1 m² cut, 0.8 m² pattern
    const b = cutAreas({ used: '0.5', remnant: '0', pattern: '0.45', need: null }, 'M2')
    const single = cutAreas({ used: '3', remnant: '0', pattern: null, need: null }, 'M2')
    expect(single.cut.isZero() && single.pattern.isZero()).toBe(true)
    const total = yieldOfAreas(addAreas([a, b, single]))
    expect(total).toMatchObject({ cutM2: '1.5000', patternM2: '1.2500', wasteM2: '0.2500', yieldPct: '83.3', wastePct: '16.7' })
    // A pattern larger than the area used counts at most the area used.
    expect(yieldOfAreas(cutAreas({ used: '1', remnant: '0', pattern: '1.4', need: null }, 'M2')).yieldPct).toBe('100.0')
    expect(yieldOfAreas(addAreas([])).yieldPct).toBeNull()
  })
})

describe('margin quoted against actual (ANA-021)', () => {
  it('shares a line by garments, half up; percents of the sums and the points gained or lost', () => {
    expect(shareOf(100_001, 1, 2)).toBe(50_001)
    expect(shareOf(1000, 3, 0)).toBe(0)
    const view = marginOf(addFigures([{ value: 60_000, quotedCost: 36_000, actualCost: 40_000 }, { value: 40_000, quotedCost: 24_000, actualCost: 22_000 }]))
    expect(view).toEqual({ value: 100_000, quotedCost: 60_000, actualCost: 62_000, quotedMargin: 40_000, actualMargin: 38_000, quotedPct: '40.0', actualPct: '38.0', changePts: '-2.0' })
    expect(marginOf({ value: 0, quotedCost: 0, actualCost: 0 })).toMatchObject({ quotedPct: null, actualPct: null, changePts: null })
  })
})

describe('supplier on-time, shortages and cover (ANA-023)', () => {
  it('is due by the confirmed date, else the date asked; cover = on hand ÷ daily use, none without use', () => {
    expect(supplierDueOf({ confirmedDate: '2026-11-12', needDate: '2026-11-10' })).toBe('2026-11-12')
    expect(supplierDueOf({ confirmedDate: null, needDate: '2026-11-10' })).toBe('2026-11-10')
    expect(receivedOnTime('2026-11-12', '2026-11-12')).toBe(true)
    expect(receivedOnTime('2026-11-13', '2026-11-12')).toBe(false)
    expect(onTimePct(2, 3)).toBe('66.7')
    expect(onTimePct(0, 0)).toBeNull()
    expect(coverDays(new Dec(45), new Dec(30))).toBe('45.0')
    expect(coverDays(new Dec(45), new Dec(0))).toBeNull()
    expect(coverDays(new Dec(-2), new Dec(30))).toBe('0.0')
  })
})

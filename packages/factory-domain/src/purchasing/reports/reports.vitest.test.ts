import { describe, expect, it } from 'vitest'
import { templateOf } from '../../auth/roles/templates'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PURCHASING_REPORTS_ADDS, PURCHASING_REPORTS_VIEW } from './permissions'
import { figuresOf, groupsOf, inCompanyCurrency, lineSpendOf, monthsOf, periodOf, periodProblems, shareOf, spendKindOf, SPEND_STATUSES, SUPPLY_ALERT_STATUSES, worstConfirmedLate, type SpendRow } from './rules'

const row = (n: number, over: Partial<SpendRow> = {}): SpendRow => ({
  lineId: `l${n}`,
  orderId: `o${n}`,
  kind: 'production',
  keys: { supplier: 's1', category: 'LEATHER', material: 'm1', company: 'c1', month: '2026-11' },
  month: '2026-11',
  currency: 'EUR',
  spend: 1000,
  ...over,
})

describe('purchasing reports — who reads them', () => {
  it('is declared, read only, and given to the buyer, planner, production manager, finance and the warehouse', () => {
    expect(FACTORY_PERMISSIONS.get(PURCHASING_REPORTS_VIEW)).toMatchObject({ risk: 'read' })
    for (const key of Object.keys(PURCHASING_REPORTS_ADDS)) expect(templateOf(key)!.permissions, key).toContain(PURCHASING_REPORTS_VIEW)
    expect(templateOf('sales')!.permissions).not.toContain(PURCHASING_REPORTS_VIEW)
    expect(templateOf('owner')!.permissions).toContain(PURCHASING_REPORTS_VIEW)
  })
})

describe('the spend of a line and an order', () => {
  it('counts a line at its value, a cancelled one at nothing, one closed short at what came', () => {
    const line = { netAmount: 120_000, cancelled: false, closedShort: false, baseQuantity: '100.0000', receivedBase: '40.0000' }
    expect(lineSpendOf(line)).toBe(120_000)
    expect(lineSpendOf({ ...line, cancelled: true })).toBe(0)
    expect(lineSpendOf({ ...line, closedShort: true })).toBe(48_000)
    // More came than was ordered: the line's value, never more.
    expect(lineSpendOf({ ...line, closedShort: true, receivedBase: '130.0000' })).toBe(120_000)
    // A third of a cent rounds half up.
    expect(lineSpendOf({ netAmount: 100, cancelled: false, closedShort: true, baseQuantity: '3.0000', receivedBase: '1.0000' })).toBe(33)
  })

  it('turns an order in another currency into the company’s at the rate of the order, else keeps it apart', () => {
    expect(inCompanyCurrency(5_000, { currency: 'EUR', companyCurrency: 'EUR', netAmount: 10_000, companyNetAmount: null })).toEqual({ currency: 'EUR', spend: 5_000 })
    // 10,850 USD at 1.0850 = 10,000 EUR: a line of 5,425 USD is 5,000 EUR.
    expect(inCompanyCurrency(542_500, { currency: 'USD', companyCurrency: 'EUR', netAmount: 1_085_000, companyNetAmount: 1_000_000 })).toEqual({ currency: 'EUR', spend: 500_000 })
    expect(inCompanyCurrency(542_500, { currency: 'USD', companyCurrency: 'EUR', netAmount: 1_085_000, companyNetAmount: null })).toEqual({ currency: 'USD', spend: 542_500 })
  })

  it('keeps sample and development orders apart from production spend; a draft, a request for a yes, a decline or a cancel is no spend', () => {
    expect(spendKindOf('STANDARD')).toBe('production')
    expect(spendKindOf('SAMPLE')).toBe('samples')
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'DECLINED', 'CANCELLED']) expect(SPEND_STATUSES as readonly string[]).not.toContain(status)
  })
})

describe('the fold', () => {
  it('sums per currency, counts orders and lines, and keeps samples apart', () => {
    const figures = figuresOf([row(1), row(2, { orderId: 'o1', spend: 500 }), row(3, { kind: 'samples', spend: 200 })], 'EUR')
    expect(figures).toMatchObject({ production: 1500, samples: 200, currency: 'EUR', mixedCurrencies: false, orders: 1, lines: 2, sampleOrders: 1, sampleLines: 1 })
    const mixed = figuresOf([row(1), row(2, { currency: 'USD', spend: 300 })], 'EUR')
    expect(mixed).toMatchObject({ production: null, samples: null, currency: null, mixedCurrencies: true })
    expect(mixed.byCurrency.map((entry) => entry.currency)).toEqual(['EUR', 'USD'])
    expect(figuresOf([], 'EUR')).toMatchObject({ production: 0, samples: 0, currency: 'EUR', orders: 0 })
  })

  it('ranks groups by production spend when amounts may be seen, by orders when not, and months in order', () => {
    const rows = [
      row(1, { keys: { supplier: 'a', category: 'LEATHER', material: 'm1', company: 'c1', month: '2026-10' }, month: '2026-10', spend: 100 }),
      row(2, { keys: { supplier: 'b', category: 'LINING', material: 'm2', company: 'c1', month: '2026-11' }, spend: 900 }),
      row(3, { keys: { supplier: 'a', category: 'LEATHER', material: 'm1', company: 'c1', month: '2026-11' }, spend: 100 }),
    ]
    const months = ['2026-10', '2026-11']
    expect(groupsOf(rows, 'supplier', months, { byValue: true, companyCurrency: 'EUR' }).map((group) => group.key)).toEqual(['b', 'a'])
    expect(groupsOf(rows, 'supplier', months, { byValue: false, companyCurrency: 'EUR' }).map((group) => group.key)).toEqual(['a', 'b'])
    const a = groupsOf(rows, 'supplier', months, { byValue: true, companyCurrency: 'EUR' })[1]!
    expect(a.months.map((month) => [month.month, month.figures.production])).toEqual([
      ['2026-10', 100],
      ['2026-11', 100],
    ])
    expect(groupsOf(rows, 'month', months, { byValue: true }).map((group) => group.key)).toEqual(['2026-10', '2026-11'])
  })

  it('says a share with one decimal, never for nothing', () => {
    expect(shareOf(1, 3)).toBe('33.3')
    expect(shareOf(0, 0)).toBeNull()
    expect(shareOf(null, 10)).toBeNull()
  })
})

describe('the period', () => {
  it('is this month so far by default, at most a year, never after today, and lists its months', () => {
    expect(periodOf({}, '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' })
    expect(periodProblems({ from: '2026-11-01', to: '2026-11-13' }, '2026-11-12').map((issue) => issue.path)).toEqual(['querystring/to'])
    expect(monthsOf({ from: '2025-12-15', to: '2026-02-03' })).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(monthsOf({ from: '2026-11-01', to: '2026-11-12' })).toEqual(['2026-11'])
  })
})

describe('the supply alerts', () => {
  it('name the line confirmed the most days later than needed, with the dates that say it (its next delivery when later)', () => {
    const line = (seq: number, needDate: string, confirmedDate: string | null, nextDelivery: { needDate: string; confirmedDate: string | null } | null = null) => ({ seq, needDate, confirmedDate, nextDelivery, confirmedLaterBy: 0 })
    expect(worstConfirmedLate([line(10, '2026-11-20', '2026-11-24'), line(20, '2026-11-20', '2026-12-04')])).toMatchObject({ days: 14, needDate: '2026-11-20', confirmedDate: '2026-12-04', line: { seq: 20 } })
    expect(worstConfirmedLate([line(10, '2026-11-20', '2026-11-20', { needDate: '2026-12-01', confirmedDate: '2026-12-11' })])).toMatchObject({ days: 10, needDate: '2026-12-01', confirmedDate: '2026-12-11' })
    expect(worstConfirmedLate([line(10, '2026-11-20', '2026-11-18'), line(20, '2026-11-20', null)])).toBeNull()
  })

  it('tell of the statuses that limit or stop buying, never of an approval', () => {
    expect([...SUPPLY_ALERT_STATUSES]).toEqual(['CONDITIONAL', 'ON_HOLD', 'BLOCKED', 'INACTIVE'])
  })
})

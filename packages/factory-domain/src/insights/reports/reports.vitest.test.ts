import { describe, expect, it } from 'vitest'
import { grainPermission } from '../../auth/grains/grains'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import type { Actor, Grant, Permission } from '../../core/permissions'
import { choiceFilter, defineReportMeta, MIN_GROUP_PEOPLE, packProblems, periodFilter, reportProblems, SITE_FILTER, type ReportColumn, type ReportMeta } from './definition'
import { NUMBER_RULES, numberLensesFor, numberProblems, numbersFor, targetWordOf } from './numbers'
import { HOME_REPORTS_VIEW } from './permissions'
import { appliedFilters, groupsOf, lastWeeks, pctText, periodRange, totalsOf, weekStart } from './results'
import { columnsFor, hideSmallGroups, libraryState, onlyShown, rightsNoteOf, type ReportRow } from './rights'

const actor = (key: string, extra: readonly Permission[] = []): Actor => {
  const template = templateOf(key)!
  const grants: Grant[] = [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission), ...extra], companies: 'all', sites: 'all', parties: 'all' }]
  return { audience: 'office', tenantId: 't', grants }
}
const only = (permissions: readonly Permission[]): Actor => ({ audience: 'office', tenantId: 't', grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' }] })

const COLUMNS: readonly ReportColumn[] = [
  { key: 'order', label: 'Order', kind: 'text' },
  { key: 'status', label: 'Status', kind: 'code', group: true, codes: ['A', 'B'] },
  { key: 'units', label: 'Garments', kind: 'number', sum: true },
  { key: 'netAmount', label: 'Net value', kind: 'money', grain: 'price', sum: true },
  { key: 'costNow', label: 'Cost now', kind: 'money', grain: 'cost', sum: true },
  { key: 'marginPct', label: 'Margin', kind: 'percent', grain: 'margin' },
  { key: 'efficiencyPct', label: 'Efficiency', kind: 'percent', people: true },
]

const meta = (change: Partial<ReportMeta> = {}): ReportMeta => ({
  key: 'sales.test-report',
  area: 'sales',
  title: 'Test',
  question: 'What does it count?',
  permission: 'orders.view',
  needs: null,
  columns: COLUMNS,
  filters: [periodFilter(['THIS_WEEK', 'THIS_MONTH'], 'THIS_WEEK'), SITE_FILTER, choiceFilter('status', 'Status', { A: 'A', B: 'B' })],
  groupBy: 'status',
  sources: 'Orders',
  definition: 'How.',
  numbers: [],
  mail: null,
  formats: ['CSV', 'PDF'],
  ...change,
})

const row = (id: string, cells: ReportRow['cells'], extra: Partial<ReportRow> = {}): ReportRow => ({ id, record: null, cells, currency: 'EUR', ...extra })

describe('a report definition (B-W2a-79; design home.reports, one definition file per report)', () => {
  it('accepts a good definition and names every problem of a bad one', () => {
    expect(reportProblems(meta())).toEqual([])
    expect(defineReportMeta(meta()).key).toBe('sales.test-report')
    const bad = reportProblems(
      meta({
        key: 'Sales',
        question: 'No question mark',
        columns: [
          { key: 'totalPieces', label: 'x', kind: 'number' },
          { key: 'value', label: 'x', kind: 'money' },
          { key: 'status', label: 'x', kind: 'code' },
          { key: 'status', label: 'x', kind: 'text' },
        ],
        groupBy: 'nothing',
      }),
    )
    expect(bad.join(' ')).toMatch(/<area>\.<name>/)
    expect(bad.join(' ')).toMatch(/ends with "\?"/)
    expect(bad.join(' ')).toMatch(/totalPieces: a key that looks like money/)
    expect(bad.join(' ')).toMatch(/value: money says its grain/)
    expect(bad.join(' ')).toMatch(/lists its codes/)
    expect(bad.join(' ')).toMatch(/two columns "status"/)
    expect(bad.join(' ')).toMatch(/groupBy nothing/)
    expect(() => defineReportMeta(meta({ formats: [] }))).toThrow(/at least one format/)
    expect(packProblems([meta(), meta()])).toEqual(['sales.test-report: two definitions'])
  })
})

describe('reports obey data permissions (ANA-034)', () => {
  it('lists a report the person cannot run, and says why', () => {
    expect(libraryState(actor('sales'), meta())).toEqual({ state: 'READY', grain: null })
    expect(libraryState(actor('quality_inspector'), meta())).toEqual({ state: 'NO_ACCESS', grain: null })
    // A planner reads orders but holds no price grain: a report about prices is held, with its grain named.
    expect(libraryState(actor('planner'), meta({ needs: 'price' }))).toEqual({ state: 'NEEDS_GRAIN', grain: 'price' })
    expect(libraryState(actor('owner'), meta({ needs: 'cost' })).state).toBe('READY')
  })

  it('leaves out the columns of grains the person lacks and names them (S2: sales see margin %, never cost)', () => {
    const sales = columnsFor(actor('sales'), COLUMNS)
    expect(sales.shown.map((column) => column.key)).toEqual(['order', 'status', 'units', 'netAmount', 'marginPct', 'efficiencyPct'])
    expect(sales.leftOut).toEqual(['cost'])
    const planner = columnsFor(actor('planner'), COLUMNS)
    expect(planner.leftOut).toEqual(['price', 'cost', 'margin'])
    expect(planner.leftOutColumns).toEqual(['netAmount', 'costNow', 'marginPct'])
    expect(columnsFor(actor('owner'), COLUMNS).leftOut).toEqual([])
    const kept = onlyShown([row('1', { order: 'SO-1', netAmount: 100, costNow: 60, marginPct: '40.0' })], planner.shown)
    expect(Object.keys(kept[0]!.cells)).toEqual(['order', 'status', 'units', 'efficiencyPct'])
  })

  it(`blanks the people figures of a group of fewer than ${MIN_GROUP_PEOPLE} people, and an unknown headcount (Statuto art. 4)`, () => {
    const rows = [row('big', { order: 'L1', efficiencyPct: '91.0' }, { people: 12 }), row('small', { order: 'L2', efficiencyPct: '88.0' }, { people: 3 }), row('unknown', { order: 'L3', efficiencyPct: '70.0' }, { people: null }), row('centre', { order: 'QC', efficiencyPct: null })]
    const { rows: out, hidden } = hideSmallGroups(rows, COLUMNS)
    expect(out.map((entry) => entry.cells.efficiencyPct)).toEqual(['91.0', null, null, null])
    expect(hidden).toBe(2)
    expect(out[1]!.cells.order).toBe('L2')
    expect(rightsNoteOf(columnsFor(actor('planner'), COLUMNS), hidden)).toEqual({ leftOut: ['price', 'cost', 'margin'], hiddenGroups: 2 })
    expect(rightsNoteOf(columnsFor(actor('owner'), COLUMNS), 0)).toBeNull()
  })
})

describe("a report's run", () => {
  it('cuts the periods at the site’s days, weeks from Monday', () => {
    // Friday 30 October 2026.
    expect(weekStart('2026-10-30')).toBe('2026-10-26')
    expect(periodRange('THIS_WEEK', '2026-10-30')).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    expect(periodRange('LAST_WEEK', '2026-10-30')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    expect(periodRange('THIS_MONTH', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(periodRange('LAST_MONTH', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodRange('LAST_8_WEEKS', '2026-10-30')).toEqual({ from: '2026-09-07', to: '2026-11-01' })
    expect(periodRange('NEXT_90_DAYS', '2026-10-30').to).toBe('2027-01-27')
    const weeks = lastWeeks('2026-10-30')
    expect(weeks).toHaveLength(8)
    expect(weeks[0]).toEqual({ from: '2026-09-07', to: '2026-09-13' })
    expect(weeks[7]).toEqual({ from: '2026-10-26', to: '2026-11-01' })
  })

  it('applies the address’s filters it knows, the defaults otherwise, and refuses a value that is not a choice', () => {
    expect(appliedFilters(meta(), {}).values).toEqual({ period: 'THIS_WEEK', site: null, status: null })
    expect(appliedFilters(meta(), { period: 'THIS_MONTH', site: 'site-1', status: 'B', other: 'x' }).values).toEqual({ period: 'THIS_MONTH', site: 'site-1', status: 'B' })
    expect(appliedFilters(meta(), { period: 'NEXT_YEAR' }).problems).toEqual([{ path: 'querystring/period', message: 'Not one of THIS_WEEK, THIS_MONTH.' }])
  })

  it('totals and groups the summed columns, money only in one currency', () => {
    const rows = [row('1', { status: 'A', units: 10, netAmount: 1000 }), row('2', { status: 'B', units: 5, netAmount: 500 }), row('3', { status: 'A', units: 1, netAmount: null })]
    expect(totalsOf(rows, COLUMNS)).toEqual({ rows: 3, sums: { units: 16, netAmount: 1500, costNow: 0 }, currency: 'EUR', mixedCurrencies: false })
    const mixed = totalsOf([...rows, row('4', { units: 1, netAmount: 9 }, { currency: 'USD' })], COLUMNS)
    expect(mixed.sums.netAmount).toBeNull()
    expect(mixed.sums.units).toBe(17)
    expect(mixed.mixedCurrencies).toBe(true)
    const groups = groupsOf(rows, COLUMNS[1]!, COLUMNS)
    expect(groups.map((group) => [group.value, group.rows, group.sums.units])).toEqual([
      ['A', 2, 11],
      ['B', 1, 5],
    ])
    expect(pctText(91, 100)).toBe('91.0')
    expect(pctText(2, 3)).toBe('66.7')
    expect(pctText(1, 0)).toBeNull()
  })
})

describe('My numbers on Today (ANA-001; design home.today key-numbers)', () => {
  it('has three to five numbers per lens, each linked and explained, money with its grain', () => {
    expect(numberProblems()).toEqual([])
    expect(numberProblems([NUMBER_RULES[0]!, { ...NUMBER_RULES[0]!, grain: null }])).toContain('orders.inThisWeek: twice')
  })

  it('shows a number only with its list and its grain (the owner: orders in, late, promised, on time, margin)', () => {
    expect(numbersFor(actor('owner'), 'ORDERS').map((entry) => entry.key)).toEqual(['orders.inThisWeek', 'orders.late', 'orders.promisedThisWeek', 'orders.shippedOnTime', 'orders.marginThisMonth'])
    // A planner reads orders without price or margin: counts only.
    expect(numbersFor(actor('planner'), 'ORDERS').map((entry) => entry.key)).toEqual(['orders.late', 'orders.promisedThisWeek', 'orders.shippedOnTime'])
    expect(numbersFor(actor('planner'), 'WORK_ORDERS').map((entry) => entry.key)).toEqual(['workorders.late', 'planning.shortages', 'planning.loadNextWeek', 'production.goodLastDay'])
    // Finance without the cost grain would not see the stock value; with it, it does.
    expect(numbersFor(only(['invoices.view', 'receivables.view', 'inventory.stock.view', 'money.price']), 'INVOICES').map((entry) => entry.key)).toEqual(['finance.overdue', 'finance.sdiRefused', 'finance.invoicedThisWeek'])
    expect(numbersFor(actor('finance'), 'INVOICES').map((entry) => entry.key)).toContain('finance.stockValue')
    expect(numberLensesFor(actor('admin'))).toEqual([])
    expect(numberLensesFor(actor('quality_inspector'))).toEqual(['WORK_ORDERS', 'LOTS'])
  })

  it('says a value against its target in words', () => {
    expect(targetWordOf(0, { value: 0, direction: 'AT_MOST' })).toBe('ON_TARGET')
    expect(targetWordOf(6, { value: 0, direction: 'AT_MOST' })).toBe('ABOVE_TARGET')
    expect(targetWordOf(91, { value: 95, direction: 'AT_LEAST' })).toBe('BELOW_TARGET')
    expect(targetWordOf(96.2, { value: 95, direction: 'AT_LEAST' })).toBe('ON_TARGET')
    expect(targetWordOf(null, { value: 95, direction: 'AT_LEAST' })).toBeNull()
    expect(targetWordOf(3, null)).toBeNull()
  })
})

describe('the report library permission', () => {
  it('is declared, read risk, and given to the office templates that work with records (not the administrator)', () => {
    expect(FACTORY_PERMISSIONS.get(HOME_REPORTS_VIEW)?.risk).toBe('read')
    for (const key of ['owner', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor', 'read_only']) {
      expect(templateOf(key)!.permissions, key).toContain(HOME_REPORTS_VIEW)
    }
    expect(templateOf('admin')!.permissions).not.toContain(HOME_REPORTS_VIEW)
    for (const key of ['operator', 'team_leader']) expect(templateOf(key)?.permissions ?? []).not.toContain(HOME_REPORTS_VIEW)
  })
})

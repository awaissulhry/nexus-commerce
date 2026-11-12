import { describe, expect, it } from 'vitest'
import { EXPEDITE_REASONS as DOMAIN_REASONS } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { SPEND_GROUPS as DOMAIN_GROUPS, SPEND_KINDS as DOMAIN_KINDS } from '@nexus/factory-domain/purchasing/reports/rules'
import { EXPEDITE_REASONS, SPEND_GROUPS, SPEND_KINDS } from './api'
import { BUYER, LATE, PLANNER, SPEND } from './fixtures'
import {
  amountText,
  blockedOf,
  chainOf,
  chaseGroupsOf,
  chaseHeldOf,
  groupLabel,
  measureOf,
  measuresFor,
  neighbourOf,
  pivotMonths,
  printAddress,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  spendCsvRows,
  type ChainWords,
} from './model'

describe('Purchasing reports — the lists mirror the domain', () => {
  it('groups, kinds and reasons', () => {
    expect([...SPEND_GROUPS]).toEqual([...DOMAIN_GROUPS])
    expect([...SPEND_KINDS]).toEqual([...DOMAIN_KINDS])
    expect([...EXPEDITE_REASONS]).toEqual([...DOMAIN_REASONS])
  })
})

describe('rights and the address', () => {
  it('reads the page, the orders, amounts and chasing from the session', () => {
    expect(reportsCan(BUYER)).toEqual({ view: true, orders: true, cost: true, send: true })
    expect(reportsCan(PLANNER)).toMatchObject({ view: true, cost: false, send: false })
    expect(reportsCan(['home.view'])).toMatchObject({ view: false })
  })

  it('keeps the period, the grouping and the reason in the address; unknown words fall back', () => {
    expect(reportsAddressOf(new URLSearchParams('from=2026-10-01&to=2026-10-31&by=category&reason=LATE'))).toEqual({ from: '2026-10-01', to: '2026-10-31', by: 'category', reason: 'LATE' })
    expect(reportsAddressOf(new URLSearchParams('from=yesterday&by=colour&reason=SOON'))).toEqual({ from: null, to: null, by: 'supplier', reason: null })
    expect(reportsAddressText({ from: '2026-10-01', to: null, by: 'supplier', reason: null })).toBe('?from=2026-10-01')
    expect(printAddress('/w/DEMO', { from: '2026-11-01', to: '2026-11-12' }, 'month')).toBe('/w/DEMO/purchasing/reports/print?from=2026-11-01&to=2026-11-12&by=month')
  })
})

describe('the spend', () => {
  it('offers amounts only with the cost grain, and says a group in words', () => {
    expect(measuresFor(true)).toEqual(['production', 'samples', 'orders'])
    expect(measuresFor(false)).toEqual(['orders', 'lines'])
    const first = SPEND.groups[0]!
    expect(measureOf(first, 'production')).toBe(1_842_600)
    expect(measureOf({ ...first, mixedCurrencies: true }, 'production')).toBeNull()
    expect(groupLabel(first, 'supplier', { category: (kind) => kind, locale: 'en' })).toBe('DEMO-CON-01 · Conceria Demo Alfa')
    expect(groupLabel({ key: 'LEATHER', code: null, name: 'LEATHER' }, 'category', { category: (kind) => `kind ${kind}`, locale: 'en' })).toBe('kind LEATHER')
    expect(groupLabel({ key: '2026-11', code: null, name: '2026-11' }, 'month', { category: (kind) => kind, locale: 'en' })).toBe('November 2026')
  })

  it('never adds amounts of two currencies', () => {
    const mixed = { byCurrency: [{ currency: 'EUR', production: 100_00 }, { currency: 'USD', production: 50_00 }], currency: null, mixedCurrencies: true, production: null, samples: null }
    expect(amountText(mixed, 'production', 'en')).toBe('€100.00 · US$50.00')
  })

  it('shows the months as pivot columns only over more than one month', () => {
    expect(pivotMonths(SPEND)).toEqual([])
    expect(pivotMonths({ ...SPEND, months: ['2026-10', '2026-11'] })).toEqual(['2026-10', '2026-11'])
    expect(pivotMonths({ ...SPEND, by: 'month', months: ['2026-10', '2026-11'] })).toEqual([])
  })

  it('steps to the next and the previous bar (J / K)', () => {
    const keys = SPEND.groups.map((group) => group.key)
    expect(neighbourOf(SPEND.groups, keys[0]!, 1)).toBe(keys[1])
    expect(neighbourOf(SPEND.groups, keys[0]!, -1)).toBeNull()
    expect(neighbourOf(SPEND.groups, keys[3]!, 1)).toBeNull()
  })

  it('writes a CSV without amounts for a reader without the cost grain', () => {
    const words = { header: [], group: (group: (typeof SPEND.groups)[number]) => group.name, month: (month: string) => month, locale: 'en' as const }
    expect(spendCsvRows(SPEND, { ...words, cost: false }, 'All').at(-1)).toEqual(['All', 11, 20, 2])
    expect(spendCsvRows(SPEND, { ...words, cost: true }, 'All')[0]).toEqual(['Conceria Demo Alfa', '€18,426.00', '€0.00', 4, 7, 0, '58.4 %'])
  })
})

describe('the late lines', () => {
  it('names what a line holds up once each, the latest first, and draws its chain', () => {
    const row = LATE.rows[0]!
    const blocked = blockedOf(row)
    expect(blocked.workOrders.map((entry) => [entry.number, entry.lateBy])).toEqual([['DEMO-WO-0231', 1]])
    expect(blocked.salesOrders.map((entry) => [entry.number, entry.lateBy])).toEqual([
      ['DEMO-SO-1047', 2],
      ['DEMO-SO-1043', 0],
    ])
    const words: ChainWords = {
      supplier: (name) => `S ${name}`,
      line: (number, seq) => `L ${number}/${seq}`,
      lineDetail: () => 'detail',
      workOrder: (number) => `W ${number}`,
      workOrderDetail: () => 'w',
      salesOrder: (number) => `O ${number}`,
      salesOrderDetail: () => 'o',
      nothing: 'nothing',
    }
    expect(chainOf(row, words).map((step) => [step.key.split(':')[0], step.tone])).toEqual([
      ['supplier', 'neutral'],
      ['line', 'warning'],
      ['wo', 'danger'],
      ['so', 'danger'],
      ['so', 'success'],
    ])
    expect(chainOf(LATE.rows[2]!, words).at(-1)).toMatchObject({ key: 'none', label: 'nothing' })
  })

  it('chases one mail per order for the selected lines, and holds a row without the right to send', () => {
    const ids = [LATE.rows[0]!.lineId, LATE.rows[1]!.lineId, LATE.rows[3]!.lineId]
    expect(chaseGroupsOf(LATE.rows, ids).map((group) => [group.number, group.seqs])).toEqual([
      ['DEMO-PO-0401', [10]],
      ['DEMO-PO-0418', [10]],
      ['DEMO-PO-0402', [10]],
    ])
    const words = { send: 'no send', status: 'nothing to chase' }
    expect(chaseHeldOf(LATE.rows[0]!, { send: true }, words)).toBeNull()
    expect(chaseHeldOf(LATE.rows[0]!, { send: false }, words)).toBe('no send')
    expect(chaseHeldOf({ status: 'RECEIVED' }, { send: true }, words)).toBe('nothing to chase')
  })
})

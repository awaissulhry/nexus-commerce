import { describe, expect, it } from 'vitest'
import { DIMENSIONS as DOMAIN_DIMENSIONS, KPI_KEYS as DOMAIN_KPI_KEYS } from '@nexus/factory-domain/quality/reports/rules'
import { DIMENSIONS, KPI_KEYS } from './api'
import { COMPARE, INCOMING, KPIS, TREND } from './fixtures'
import {
  changeWords,
  closuresOf,
  compareCsvRows,
  countText,
  daysIn,
  defaultRange,
  hiddenWeeks,
  incomingCsvRows,
  kpiCsvRows,
  kpiValueText,
  oneText,
  pctText,
  printAddress,
  rangeShown,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  rowHref,
  sparkValues,
  supplierHref,
  tileHeld,
  tileHref,
  trendCsvRows,
  trendRows,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const ALL = reportsCan(['quality.reports.view', 'quality.inspections.view', 'quality.ncr.view', 'quality.holds.view', 'quality.capa.view', 'parties.view', 'product.styles.view', 'product.routing.view', 'workorders.view'])
const BUILT = new Set(['/quality/inspections', '/quality/ncr', '/quality/holds', '/production/floor', '/products/operations/[id]', '/purchasing/suppliers/[partyId]', '/products/styles/[id]'])

describe('quality reports: the lists match the domain', () => {
  it('dimensions and headline numbers are the API\'s', () => {
    expect(DIMENSIONS).toEqual(DOMAIN_DIMENSIONS)
    expect(KPI_KEYS).toEqual(DOMAIN_KPI_KEYS)
  })
})

describe('quality reports: the address', () => {
  it('reads and writes the period, compare (on unless 0), the dimension and the line; never a person', () => {
    const address = reportsAddressOf(params('from=2026-10-01&to=2026-10-31&compare=0&by=supplier&line=0190f0e2-3802-7000-8000-000000000001&worker=x'))
    expect(address).toEqual({ from: '2026-10-01', to: '2026-10-31', compare: false, by: 'supplier', lineId: '0190f0e2-3802-7000-8000-000000000001' })
    expect(reportsAddressText(address)).toBe('?from=2026-10-01&to=2026-10-31&compare=0&by=supplier&line=0190f0e2-3802-7000-8000-000000000001')
    expect(reportsAddressOf(params('by=worker&from=bad'))).toEqual({ from: null, to: null, compare: true, by: 'line', lineId: null })
    expect(reportsAddressText(reportsAddressOf(params('')))).toBe('')
    expect(printAddress('/w/DEMO', reportsAddressOf(params('by=style')))).toBe('/w/DEMO/quality/reports/print?by=style')
  })

  it('the period shown: the address, else the answer, else the 30 days up to today', () => {
    const now = new Date(2026, 10, 3, 12)
    expect(defaultRange(now)).toEqual({ from: '2026-10-05', to: '2026-11-03' })
    expect(rangeShown({ from: null, to: null }, { from: '2026-10-01', to: '2026-10-31' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(rangeShown({ from: '2026-09-01', to: null }, null, now)).toEqual({ from: '2026-09-01', to: '2026-11-03' })
    expect(daysIn({ from: '2026-10-05', to: '2026-11-03' })).toBe(30)
  })
})

describe('quality reports: figures in words', () => {
  it('percent, one decimal and counts; nothing is "—", never 0', () => {
    expect(pctText('96.4', 'en')).toBe('96.4 %')
    expect(pctText('96.4', 'it')).toBe('96,4 %')
    expect(pctText(null, 'en')).toBe('—')
    expect(oneText('4.6', 'it')).toBe('4,6')
    expect(countText(null, 'en')).toBe('—')
    expect(countText(1928, 'en')).toBe('1,928')
    expect(kpiValueText('dhu', KPIS.kpis, 'en')).toBe('4.6')
    expect(kpiValueText('ncrOpen', KPIS.kpis, 'en')).toBe('7')
    expect(kpiValueText('fpy', { ...KPIS.kpis, fpy: { ...KPIS.kpis.fpy!, tooFew: true, value: null } }, 'en')).toBe('—')
  })

  it('the trend arrow in words, with its tone: better is green whichever way it goes', () => {
    expect(changeWords('fpy', { direction: 'UP', by: '1.2', better: true }, 30, 'en')).toMatchObject({ key: 'change.up.points', params: { by: '1.2', days: 30 }, tone: 'positive', arrow: '↑' })
    expect(changeWords('dhu', { direction: 'DOWN', by: '1.3', better: true }, 30, 'it')).toMatchObject({ key: 'change.down.dhu', params: { by: '1,3' }, tone: 'positive', arrow: '↓' })
    expect(changeWords('ncrOpen', { direction: 'UP', by: '2.0', better: false }, 30, 'en')).toMatchObject({ key: 'change.up.count', params: { by: '2', count: 2 }, tone: 'negative' })
    expect(changeWords('holdsOld', { direction: 'SAME', by: '0.0', better: null }, 30, 'en')).toMatchObject({ key: 'change.same.count', tone: 'neutral', arrow: '→' })
    expect(changeWords('fpy', null, 30, 'en')).toBeNull()
  })

  it('a sparkline keeps a hidden week\'s place', () => {
    expect(sparkValues({ weeks: [{ week: 'a', from: '', to: '', tooFew: false, value: '95.0' }, { week: 'b', from: '', to: '', tooFew: true, value: null }] })).toEqual([95, null])
  })
})

describe('quality reports: where each number leads', () => {
  const address = reportsAddressOf(params('from=2026-10-01&to=2026-10-31'))
  it('each tile opens its source list, filtered as close as the list allows; FPY and DHU the comparison by line', () => {
    expect(tileHref('fpy', '/w/DEMO', ALL, 'S1', address, BUILT)).toBe('/w/DEMO/quality/reports?from=2026-10-01&to=2026-10-31#fw-qr-table')
    expect(tileHref('ncrOpen', '/w/DEMO', ALL, 'S1', address, BUILT)).toBe('/w/DEMO/quality/ncr?site=S1')
    expect(tileHref('holdsOld', '/w/DEMO', ALL, 'S1', address, BUILT)).toBe('/w/DEMO/quality/holds?view=open')
    expect(tileHref('aqlPass', '/w/DEMO', ALL, 'S1', address, BUILT)).toBe('/w/DEMO/quality/inspections?view=all')
  })

  it('a tile whose list is not built or not in the role opens nothing and says why', () => {
    expect(tileHref('capaOnTime', '/w/DEMO', ALL, 'S1', address, BUILT)).toBeNull()
    expect(tileHeld('capaOnTime', ALL, BUILT)).toBe('tile.held.capaPage')
    expect(tileHref('capaOnTime', '/w/DEMO', ALL, 'S1', address, new Set([...BUILT, '/quality/capa']))).toBe('/w/DEMO/quality/capa?view=closed')
    const noNcr = { ...ALL, ncr: false }
    expect(tileHref('ncrOpen', '/w/DEMO', noNcr, 'S1', address, BUILT)).toBeNull()
    expect(tileHeld('ncrOpen', noNcr, BUILT)).toBe('tile.held.noList')
  })

  it('a comparison row opens its line, operation, supplier or style; a code-only operation opens nothing', () => {
    const line = COMPARE.line.rows[0]!
    expect(rowHref('line', line, '/w/DEMO', ALL, BUILT)).toBe(`/w/DEMO/production/floor?line=${line.ref!.id}`)
    expect(rowHref('operation', COMPARE.operation.rows[2]!, '/w/DEMO', ALL, BUILT)).toBeNull()
    expect(rowHref('supplier', COMPARE.supplier.rows[0]!, '/w/DEMO', { ...ALL, suppliers: false }, BUILT)).toBeNull()
    expect(supplierHref(INCOMING.suppliers[0]!, '/w/DEMO', ALL, BUILT)).toBe(`/w/DEMO/purchasing/suppliers/${INCOMING.suppliers[0]!.party!.id}`)
  })
})

describe('quality reports: the chart and the files', () => {
  it('the chart has a point only where a week shows one; hidden weeks and CAPA closures are counted', () => {
    expect(trendRows(TREND.weeks)[0]).toEqual({ week: 'W41', fpy: 95.8, dhu: 5.1 })
    expect(trendRows([{ ...TREND.weeks[0]!, tooFew: true, fpy: null, dhu: null }])).toEqual([{ week: 'W41' }])
    expect(hiddenWeeks([{ tooFew: true }, { tooFew: false }])).toBe(1)
    expect(closuresOf(TREND.weeks).map((entry) => [entry.week, entry.capas.length])).toEqual([['2026-W43', 1], ['2026-W44', 2]])
  })

  it('each panel\'s rows as a file, a hidden group with no figure', () => {
    expect(kpiCsvRows(KPIS, { fpy: 'FPY', dhu: 'DHU', aqlPass: 'AQL', ncrOpen: 'NCR', capaOnTime: 'CAPA', holdsOld: 'Holds' }, 'en')[0]).toEqual(['FPY', '96.4 %', '95.2 %'])
    expect(trendCsvRows([{ ...TREND.weeks[0]!, tooFew: true }], { tooFew: 'too few' }, 'en')[0]!.slice(3, 5)).toEqual(['too few', 'too few'])
    const rows = compareCsvRows(COMPARE.line.rows, { none: 'none', tooFew: 'too few' }, 'en')
    expect(rows[2]).toEqual(['L-C · Linea guanti', 'too few', '', '', '', ''])
    expect(incomingCsvRows(INCOMING, { none: 'none' }, 'en')[0]).toEqual(['FOR-001 · Conceria Demo Srl', '12', '1', '1', '3.4', '11', '2'])
  })
})

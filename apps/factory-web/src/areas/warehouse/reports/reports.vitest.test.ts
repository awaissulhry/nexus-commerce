import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGE_BUCKETS as DOMAIN_BUCKETS, MATERIAL_TYPES as DOMAIN_TYPES } from '@nexus/factory-domain/inventory/reports/rules'
import { AGE_BUCKETS, LEATHER_MEASURES, MATERIAL_TYPES } from './api'
import { AGEING, LEATHER, designScreen, noValues } from './fixtures'
import { designScreen as printScreen } from './print/fixtures'
import {
  ageingChartRows,
  ageingCsvRows,
  articleHrefs,
  csvName,
  hidesHref,
  lastMonth,
  leatherCsvRows,
  measureOf,
  printAddress,
  quantitiesText,
  rangeShown,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  shareText,
  thisMonth,
  typesWithoutShare,
  type CsvWords,
} from './model'

const catalogue = (lang: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../../messages/${lang}/warehouse-reports.json`, import.meta.url), 'utf8')) as Record<string, any>
const words: CsvWords = { header: [], unitWord: (uom) => uom.toLowerCase(), typeWord: (type) => type, noLot: 'No lot', locale: 'en', cost: true }

describe('the lists are the domain\'s', () => {
  it('age buckets and material types', () => {
    expect(AGE_BUCKETS).toEqual(DOMAIN_BUCKETS)
    expect(MATERIAL_TYPES).toEqual(DOMAIN_TYPES)
  })

  it('every type, bucket and measure has its words in both languages', () => {
    for (const lang of ['it', 'en'] as const) {
      const words = catalogue(lang)
      for (const type of MATERIAL_TYPES) expect(words.type[type], `${lang} type.${type}`).toBeTruthy()
      for (const bucket of AGE_BUCKETS) expect(words.bucket[bucket], `${lang} bucket.${bucket}`).toBeTruthy()
      for (const measure of LEATHER_MEASURES) expect(words.leather.col[measure], `${lang} leather.col.${measure}`).toBeTruthy()
    }
  })
})

describe('rights and the address', () => {
  it('the page, the stock behind it and the values are three rights', () => {
    expect(reportsCan(['inventory.reports.view'])).toEqual({ view: true, stock: false, cost: false })
    expect(reportsCan(['inventory.reports.view', 'inventory.stock.view', 'money.cost'])).toEqual({ view: true, stock: true, cost: true })
  })

  it('?from=&to= only; this month so far by default; last month', () => {
    expect(reportsAddressOf(new URLSearchParams('from=2026-10-01&to=2026-10-31&site=x'))).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(reportsAddressOf(new URLSearchParams('from=yesterday'))).toEqual({ from: null, to: null })
    expect(reportsAddressText({ from: '2026-10-01', to: null })).toBe('?from=2026-10-01')
    expect(thisMonth('2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' })
    expect(lastMonth('2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(lastMonth('2026-03-05')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(lastMonth('2026-01-20')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(rangeShown({ from: null, to: null }, null, '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' })
    expect(rangeShown({ from: null, to: null }, { from: '2026-11-01', to: '2026-11-10' }, '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-10' })
    expect(printAddress('/w/DEMO', { from: '2026-10-01', to: '2026-10-31' })).toBe('/w/DEMO/warehouse/reports/print?from=2026-10-01&to=2026-10-31')
  })
})

describe('the figures in words and charts', () => {
  it('quantities per unit, never across; a share; nothing is "—"', () => {
    expect(quantitiesText([{ uom: 'M', quantity: '130.0000' }, { uom: 'PCS', quantity: '12.0000' }], (uom) => uom.toLowerCase(), 'en')).toBe('130 m · 12 pcs')
    expect(quantitiesText([], (uom) => uom, 'en')).toBe('—')
    expect(shareText('41.7', 'it')).toBe('41,7 %')
    expect(shareText(null, 'en')).toBe('—')
  })

  it('the chart: shares per type (a type over two units is left out and said), or values in the currency\'s units', () => {
    const share = ageingChartRows(AGEING.types, 'share', (type) => type)
    expect(share.map((row) => row.type)).toEqual(['LEATHER', 'LINING', 'PROTECTOR', 'TRIM'])
    expect(share[0]).toMatchObject({ d0to90: 72.5, overYear: 3.2, averageDays: 74.3 })
    const value = ageingChartRows(AGEING.types, 'value', (type) => type)
    expect(value[0]).toMatchObject({ d0to90: 17_982, overYear: 799 })
    expect(ageingChartRows(noValues(AGEING).types, 'value', (type) => type)).toEqual([])
    const mixed = [...AGEING.types, { ...AGEING.types[3]!, type: 'THREAD' as const, whole: { quantities: [{ uom: 'CONE' as const, quantity: '52.0000' }, { uom: 'M' as const, quantity: '5000.0000' }] }, buckets: { d0to90: { quantities: [], share: null }, d91to180: { quantities: [], share: null }, d181to365: { quantities: [], share: null }, overYear: { quantities: [], share: null } } }]
    expect(ageingChartRows(mixed, 'share', (type) => type).map((row) => row.type)).not.toContain('THREAD')
    expect(typesWithoutShare(mixed)).toEqual(['THREAD'])
  })

  it('a leather measure in m² per article', () => {
    expect(measureOf(LEATHER.articles[0]!.figures, 'received')).toBeCloseTo(186.5)
    expect(measureOf(LEATHER.articles[0]!.figures, 'end')).toBeGreaterThan(0)
    expect(measureOf({ ...LEATHER.articles[0]!.figures, m2: null, base: null, uom: null }, 'cut')).toBeNull()
  })
})

describe('where a number leads', () => {
  it('an article opens Stock searched by its code and its moves; a leather bar its hides, a lot its hides', () => {
    const [first] = AGEING.types[0]!.articles
    const hrefs = articleHrefs('/w/DEMO', first!)
    expect(hrefs.stock).toBe('/w/DEMO/warehouse/stock?q=DEMO-LEA-100')
    expect(hrefs.moves).toBe(`/w/DEMO/warehouse/moves?item=${first!.item.id}&colour=${first!.colour!.id}`)
    expect(hidesHref('/w/DEMO', { itemId: 'i', colourId: 'c' })).toBe('/w/DEMO/warehouse/hides?view=all&item=i&colour=c')
    expect(hidesHref('/w/DEMO', { lotId: 'l', itemId: 'i' })).toBe('/w/DEMO/warehouse/hides?view=all&lot=l')
  })
})

describe('the files', () => {
  it('ageing: a row per type, then its articles; values only with the cost grain', () => {
    const rows = ageingCsvRows(AGEING, words)
    expect(rows).toHaveLength(AGEING.types.length + AGEING.types.reduce((sum, type) => sum + type.articles.length, 0))
    expect(rows[0]!.slice(0, 2)).toEqual(['LEATHER', ''])
    expect(rows[0]!.length).toBe(2 + 4 * 3 + 2 + 2)
    expect(ageingCsvRows(noValues(AGEING), { ...words, cost: false })[0]!.length).toBe(2 + 4 * 2 + 1 + 2)
    expect(csvName('ageing', { from: '2026-11-01', to: '2026-11-12' })).toBe('warehouse-ageing-2026-11-01-2026-11-12.csv')
  })

  it('leather: a row per article, then its supplier lots', () => {
    const rows = leatherCsvRows(LEATHER, words)
    expect(rows).toHaveLength(LEATHER.articles.length + LEATHER.articles.reduce((sum, article) => sum + article.lots.length, 0))
    expect(rows[1]![1]).toBe('LOT-DEMO-0007 · TAN-4471 · Conceria Demo Srl')
    expect(rows[0]!.length).toBe(12 + 4)
  })
})

describe('the design review', () => {
  it('SCR-257 and its print view SCR-353 carry every state', () => {
    expect(designScreen.screen).toBe('SCR-257')
    expect(designScreen.cases.map((row) => row.id)).toEqual(expect.arrayContaining(['report', 'warehouse', 'loading', 'error', 'empty', 'arrange', 'keys', 'offline', 'stock-not-in-role', 'no-permission']))
    expect(printScreen.screen).toBe('SCR-353')
    expect(printScreen.cases.map((row) => row.id)).toEqual(expect.arrayContaining(['review', 'loading', 'error', 'no-permission']))
  })
})

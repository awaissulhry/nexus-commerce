import { describe, expect, it } from 'vitest'
import { parseRow } from '../imports/plan'
import { EVERY_STYLE, isSurchargesOnly, priceListImporter, priceRecordValues, surchargesOf, surchargesRecordValues, surchargesText, versionRecordValues } from '../sales/pricing-depth/importer'
import { priceListMail, priceListPdfFingerprint, priceListPdfNumber, priceListReport, type PriceListPdfInput } from './price-list-pdf'

/** B-W2b-380 (XF6:01 the price list PDF, XF6:04 the import's version-wide rows): pure rules, made-up codes and prices. */

const input: PriceListPdfInput = {
  language: 'it',
  date: '2026-11-14',
  version: 1,
  company: { name: 'Fabbrica Fittizia S.r.l.', lines: ['Via Inventata 1, 20100 Milano MI'], legal: 'P. IVA IT00000000000' },
  list: { code: 'PL-CLI', name: 'Listino cliente', kind: 'CUSTOMER', currency: 'EUR', showDiscount: false },
  priceVersion: { revision: 2, draft: true, validFrom: '2026-12-01', validTo: null },
  prices: [
    { style: 'JK-1 · Giacca', colourway: null, validFrom: null, validTo: null, unitPrice: '435' },
    { style: 'JK-1 · Giacca', colourway: 'RED · Rosso', validFrom: '2027-01-01', validTo: '2027-03-31', unitPrice: '449.5' },
  ],
  breaks: [
    { of: 'JK-1', minQuantity: 10, unitPrice: '425', discountPct: null },
    { of: null, minQuantity: 100, unitPrice: null, discountPct: '3' },
  ],
  surcharges: [
    { style: 'JK-1', size: '56', amount: null, pct: '5' },
    { style: null, size: '58', amount: '20', pct: null },
  ],
}

describe('the price list PDF (XF6:01)', () => {
  it('prints the list, its prices with their days, the breaks and the surcharges; every style first', () => {
    const report = priceListReport(input)
    expect(report.title).toBe('Listino prezzi')
    expect(report.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Listino', 'PL-CLI · Listino cliente'],
      ['Versione', '2 (bozza)'],
      ['Validità', 'dal 01/12/2026'],
      ['Valuta', 'EUR'],
      ['Tipo', 'Cliente'],
      ['Sconto sui documenti', 'Solo prezzo netto'],
      ['Stampato il', '14/11/2026'],
      ['Versione del PDF', '1'],
    ])
    expect(report.sections.map((section) => section.heading)).toEqual(['Prezzi', 'Sconti per quantità', 'Maggiorazioni per taglia'])
    expect(report.sections[0]!.table!.rows).toEqual([
      ['JK-1 · Giacca', 'Ogni variante', 'Tutta la versione', '435,00 EUR'],
      ['JK-1 · Giacca', 'RED · Rosso', 'dal 01/01/2027 al 31/03/2027', '449,50 EUR'],
    ])
    expect(report.sections[1]!.table!.rows).toEqual([
      ['JK-1', '10 pezzi', '425,00 EUR'],
      ['Ogni prezzo', '100 pezzi', '-3%'],
    ])
    expect(report.sections[2]!.table!.rows).toEqual([
      ['Ogni modello', '58', '+ 20,00 EUR'],
      ['JK-1', '56', '+ 5%'],
    ])
    expect(report.fileName).toBe('listino-pl-cli-v2-1-it.pdf')
    const empty = priceListReport({ ...input, language: 'en', prices: [], breaks: [], surcharges: [] })
    expect(empty.sections.map((section) => [section.lines, section.table])).toEqual([
      [['No price in this version.'], null],
      [['No quantity break.'], null],
      [['No size surcharge.'], null],
    ])
  })

  it('the fingerprint ignores the day and the PDF version, never a price; the number and the mail words', () => {
    expect(priceListPdfFingerprint({ ...input, date: '2026-12-24', version: 7 })).toBe(priceListPdfFingerprint(input))
    expect(priceListPdfFingerprint({ ...input, prices: [{ ...input.prices[0]!, unitPrice: '436' }] })).not.toBe(priceListPdfFingerprint(input))
    expect(priceListPdfNumber('PL-CLI', 2, 3)).toBe('PL-CLI v2 · 3')
    expect(priceListMail({ language: 'en', code: 'PL-CLI', name: 'Customer list', revision: 2, message: null })).toEqual({ subject: 'Price list PL-CLI - Customer list', body: 'Hello,\n\nplease find attached our price list PL-CLI (version 2).' })
    expect(priceListMail({ language: 'it', code: 'PL-CLI', name: 'Listino', revision: 2, message: '  Ecco il listino.  ' }).body).toBe('Ecco il listino.')
  })
})

describe("the import's version-wide breaks and size surcharges (XF6:04)", () => {
  const context = { numberFormat: 'it' as const }
  const columns = ['list', 'style', 'colourway', 'validFrom', 'validTo', 'unitPrice', 'breaks', 'sizeSurcharges']
  const mapping = columns.map((column, index) => ({ index, header: column, column }))
  const read = (cells: string[]) => parseRow(priceListImporter, mapping, { rowNumber: 2, cells }, context)

  it('reads the version row (style *) and a style row with its surcharges, Italian numbers, sizes in order', () => {
    const own = read(['pl-cli', '*', '*', '-', '', '', '100=3%', '58=20,5 | 56=4%'])
    expect(own.errors).toEqual([])
    expect(own.values).toEqual({ list: 'PL-CLI', style: EVERY_STYLE, colourway: '*', validFrom: '-', breaks: '100=3%', sizeSurcharges: '56=4%;58=20.5' })
    const style = read(['PL-CLI', 'JK-1', '*', '-', '-', '435', '', 'xl=5;3xl=10'])
    expect(style.errors).toEqual([])
    expect(style.values.sizeSurcharges).toBe('3XL=10;XL=5')
    const alone = read(['PL-CLI', 'JK-2', '*', '-', '', '', '', '54=2'])
    expect(alone.errors).toEqual([])
    expect(isSurchargesOnly(alone.values)).toBe(true)
    expect(priceListImporter.plan(alone.values, null)).toMatchObject({ action: 'CREATE' })
    expect(priceListImporter.plan(own.values, null)).toMatchObject({ action: 'CREATE' })
  })

  it('refuses in words: a price or days on the version row, a unit price break of every price, surcharges off the style row, bad pairs', () => {
    expect(read(['PL', '*', 'BLK', '2027-01-01', '2027-02-01', '10', '100=9', '']).errors.map((issue) => issue.column)).toEqual(['colourway', 'validFrom', 'validTo', 'unitPrice', 'breaks'])
    expect(read(['PL', 'JK-1', 'BLK', '-', '', '400', '', '56=5']).errors.map((issue) => issue.message)).toEqual(["Size surcharges go on the style's row with colourway * and first day -."])
    expect(read(['PL', 'JK-1', '*', '-', '', '400', '', '56=0']).errors[0]!.message).toBe('56: expected an amount above 0 (6 decimals at most), or a percent like 5% (above 0, at most 100).')
    expect(read(['PL', 'JK-1', '*', '-', '', '400', '', '56=5;56=6']).errors[0]!.message).toBe('Size 56 is listed twice.')
    expect(read(['PL', 'JK-1', '*', '-', '', '400', '', '56=101%']).errors).toHaveLength(1)
  })

  it('the export writes what the load reads (a file goes back unchanged); the text round-trips', () => {
    const own = versionRecordValues('PL-CLI', [{ minQuantity: 100, unitPrice: null, discountPct: '3.0000' }], [{ size: '58', amount: '20.000000', pct: null }])
    expect(own).toEqual({ list: 'PL-CLI', style: '*', colourway: '*', validFrom: '-', breaks: '100=3%', sizeSurcharges: '58=20' })
    expect(priceListImporter.plan({ list: 'PL-CLI', style: '*', colourway: '*', validFrom: '-', breaks: '100=3%', sizeSurcharges: '58=20' }, { id: 'v', values: own })).toEqual({ action: 'UNCHANGED' })
    expect(surchargesRecordValues('PL-CLI', 'JK-2', [])).toMatchObject({ sizeSurcharges: '-' })
    const price = priceRecordValues({ list: 'PL', style: 'JK-1', colourway: null, validFrom: null, validTo: null, unitPrice: '435.000000', breaks: [], sizeSurcharges: [{ size: '56', amount: null, pct: '5.0000' }] })
    expect(price).toMatchObject({ breaks: '-', sizeSurcharges: '56=5%' })
    expect(priceRecordValues({ list: 'PL', style: 'JK-1', colourway: null, validFrom: '2027-01-01', validTo: null, unitPrice: '435', breaks: [] })).not.toHaveProperty('sizeSurcharges')
    expect(surchargesOf(surchargesText([{ size: '56', amount: '2.5', pct: null }, { size: '50', amount: null, pct: '1' }]))).toEqual([
      { size: '50', amount: null, pct: '1' },
      { size: '56', amount: '2.5', pct: null },
    ])
    expect(surchargesText([])).toBe('-')
  })
})

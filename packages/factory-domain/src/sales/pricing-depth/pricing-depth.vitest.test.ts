import { describe, expect, it } from 'vitest'
import { importerRegistry } from '../../imports/importer'
import { parseRow } from '../../imports/plan'
import { breaksOf, breaksText, priceListImporter, priceRecordValues } from './importer'
import { breakQuantityOf, linePriceOf } from './line-price'
import { breakFor, breakProblems, daysProblems, holdsOn, minimumFindings, minimumProblems, overlapProblems, surchargeFor, surchargeProblems, type BreakRow, type MinimumRule, type SurchargeRow } from './rules'

const ENTRY = 'e1'
const BREAKS: BreakRow[] = [
  { id: 'b10', entryId: ENTRY, minQuantity: 10, unitPrice: '425', discountPct: null },
  { id: 'b50', entryId: ENTRY, minQuantity: 50, unitPrice: '415', discountPct: null },
  { id: 'b100', entryId: null, minQuantity: 100, unitPrice: null, discountPct: '3' },
]

describe('quantity breaks (SAL-166)', () => {
  it('the entry takes its deepest break reached, and the version-wide discount only when it is lower', () => {
    expect(breakFor(BREAKS, ENTRY, '435', 9, 'EUR')).toBeNull()
    expect(breakFor(BREAKS, ENTRY, '435', 10, 'EUR')).toMatchObject({ breakId: 'b10', unitPrice: '425', ownBreak: true })
    expect(breakFor(BREAKS, ENTRY, '435', 60, 'EUR')).toMatchObject({ breakId: 'b50', unitPrice: '415' })
    // 100 pieces: 3 % off 435 = 421.95, dearer than the entry's own 415: the customer keeps 415.
    expect(breakFor(BREAKS, ENTRY, '435', 100, 'EUR')).toMatchObject({ breakId: 'b50', unitPrice: '415' })
    // Another entry of the version: only the version's discount, to the cent.
    expect(breakFor(BREAKS, 'e2', '399.99', 100, 'EUR')).toMatchObject({ breakId: 'b100', unitPrice: '387.99', discountPct: '3', ownBreak: false })
  })

  it('refuses a break twice, both a price and a discount, a version-wide unit price and one that does not lower the price', () => {
    const prices = new Map([[ENTRY, '435']])
    expect(breakProblems([{ entryId: ENTRY, minQuantity: 10, unitPrice: '425', discountPct: null }, { entryId: null, minQuantity: 100, unitPrice: null, discountPct: '3' }], prices)).toEqual([])
    const messages = breakProblems(
      [
        { entryId: ENTRY, minQuantity: 1, unitPrice: '425', discountPct: null },
        { entryId: ENTRY, minQuantity: 20, unitPrice: '425', discountPct: '2' },
        { entryId: null, minQuantity: 30, unitPrice: '400', discountPct: null },
        { entryId: ENTRY, minQuantity: 40, unitPrice: '435', discountPct: null },
        { entryId: ENTRY, minQuantity: 40, unitPrice: null, discountPct: null },
        { entryId: ENTRY, minQuantity: 60, unitPrice: null, discountPct: '100' },
      ],
      prices,
    ).map((issue) => issue.message)
    expect(messages).toEqual([
      'A break applies from 2 to 1000000 pieces.',
      'A break gives a unit price or a discount, not both.',
      'A break for every price of the version gives a discount, not one unit price.',
      'A break lowers the price: below 435.',
      'The same price and quantity twice: one break each.',
      'A discount above 0 and below 100 percent, with at most 4 decimals.',
    ])
  })
})

describe('dated prices (SAL-167)', () => {
  const entry = (id: string, validFrom: string | null, validTo: string | null) => ({ id, styleId: 's', colourwayId: null, validFrom, validTo })
  it('a price holds on its days; prices of one style never overlap', () => {
    expect(holdsOn(entry('a', null, '2027-01-31'), '2027-01-31')).toBe(true)
    expect(holdsOn(entry('a', null, '2027-01-31'), '2027-02-01')).toBe(false)
    expect(holdsOn(entry('b', '2027-02-01', null), '2027-02-01')).toBe(true)
    expect(overlapProblems([entry('a', null, '2027-01-31'), entry('b', '2027-02-01', null)], () => 'JKT-02')).toEqual([])
    expect(overlapProblems([entry('a', null, '2027-01-31'), entry('b', '2027-01-31', null)], () => 'JKT-02')[0]!.message).toBe(
      'JKT-02 has two prices on the same days (to 2027-01-31 and from 2027-01-31): the days of one style\'s prices never overlap.',
    )
    // An undated price holds every day: a dated one beside it overlaps.
    expect(overlapProblems([entry('a', null, null), entry('b', '2027-02-01', null)], () => 'JKT-02')).toHaveLength(1)
    // Another colourway is another price.
    expect(overlapProblems([entry('a', null, null), { ...entry('b', null, null), colourwayId: 'RED' }], () => 'JKT-02')).toEqual([])
    expect(daysProblems('2027-02-01', '2027-01-31')).toEqual([{ path: 'validTo', message: 'The last day is on or after the first.' }])
  })
})

describe('size surcharges (SAL-180)', () => {
  const rows: SurchargeRow[] = [
    { id: 'v56', versionId: 'v', styleId: null, size: '56', amount: '20', currency: 'EUR', pct: null },
    { id: 'vs56', versionId: 'v', styleId: 'jkt05', size: '56', amount: '25', currency: 'EUR', pct: null },
    { id: 's54', versionId: null, styleId: 'jkt05', size: '54', amount: null, currency: null, pct: '5' },
    { id: 's58', versionId: null, styleId: 'jkt05', size: '58', amount: '30', currency: 'CHF', pct: null },
  ]
  it('the version for the style first, then the version, then the style’s own (an amount only in the same currency)', () => {
    expect(surchargeFor(rows, { versionId: 'v', styleId: 'jkt05', size: '56', unitPrice: '400', currency: 'EUR' })).toMatchObject({ surchargeId: 'vs56', amount: '25', scope: 'VERSION_STYLE' })
    expect(surchargeFor(rows, { versionId: 'v', styleId: 'jkt01', size: '56', unitPrice: '400', currency: 'EUR' })).toMatchObject({ surchargeId: 'v56', amount: '20', scope: 'VERSION' })
    expect(surchargeFor(rows, { versionId: 'v', styleId: 'jkt05', size: '54', unitPrice: '470', currency: 'EUR' })).toMatchObject({ surchargeId: 's54', amount: '23.5', pct: '5', scope: 'STYLE' })
    expect(surchargeFor(rows, { versionId: 'v', styleId: 'jkt05', size: '58', unitPrice: '470', currency: 'EUR' })).toBeNull()
    expect(surchargeFor(rows, { versionId: null, styleId: 'jkt05', size: '58', unitPrice: '470', currency: 'CHF' })).toMatchObject({ surchargeId: 's58' })
  })
  it('refuses both an amount and a percent, a percent over 100, a size with a space and a style amount without its currency', () => {
    expect(surchargeProblems([{ styleId: null, size: '56', amount: '20', pct: null }], false)).toEqual([])
    expect(surchargeProblems([{ styleId: 's', size: '5 6', amount: '20', pct: '2' }, { styleId: 's', size: '58', amount: null, pct: '101' }, { styleId: 's', size: '60', amount: '3', pct: null }], true).map((issue) => issue.path)).toEqual([
      'surcharges/0/size',
      'surcharges/0',
      'surcharges/1/pct',
      'surcharges/2/currency',
    ])
  })
})

describe("a line's price from its list", () => {
  it('LIST → BREAK → SIZE_SURCHARGE → NET, the steps adding up on a gross basis too', () => {
    const surcharges: SurchargeRow[] = [{ id: 'v56', versionId: 'v', styleId: null, size: '56', amount: '20', currency: 'EUR', pct: null }]
    const net = linePriceOf({ entry: { id: ENTRY, versionId: 'v', unitPrice: '435', label: 'P1 v2' }, breaks: BREAKS, surcharges, styleId: 'jkt01', quantity: 12, sizes: ['52', '56'], currency: 'EUR' })
    expect(net.unitPrice).toBe('425')
    expect(net.steps).toEqual([
      { kind: 'LIST', unitPrice: '435', source: { type: 'PriceListEntry', id: ENTRY }, label: 'P1 v2' },
      { kind: 'BREAK', delta: '-10', unitPrice: '425', source: { type: 'PriceBreak', id: 'b10' }, label: 'From 10 pieces' },
      { kind: 'SIZE_SURCHARGE', sizes: { '56': '20' }, source: { type: 'SizeSurcharge', id: 'v56' }, label: 'Size 56' },
      { kind: 'NET', unitPrice: '425' },
    ])
    // VAT 22 % included (a consumer's quote): 435 → 530.7, 415 → 506.3, 415 + 20 → 530.7.
    const GROSS: Record<string, string> = { '435': '530.7', '415': '506.3', '435.0': '530.7' }
    const gross = linePriceOf({ entry: { id: ENTRY, versionId: 'v', unitPrice: '435', label: 'P1 v2' }, breaks: BREAKS, surcharges, styleId: 'jkt01', quantity: 120, sizes: ['56'], currency: 'EUR', onBasis: (value) => GROSS[value] ?? value })
    expect(gross.listPrice).toBe('530.7')
    expect(gross.break).toMatchObject({ breakId: 'b50', delta: '-24.4' })
    expect(gross.sizeSurcharges).toMatchObject([{ size: '56', amount: '20', onBasis: '24.4' }])
    expect(breakQuantityOf([{ entryId: ENTRY, quantity: 6 }, { entryId: ENTRY, quantity: 6 }, { entryId: 'e2', quantity: 40 }], ENTRY)).toBe(12)
    expect(linePriceOf({ entry: null, breaks: [], surcharges: [], styleId: 's', quantity: 1, sizes: [], currency: 'EUR' }).steps).toEqual([])
  })
})

describe('minimum order quantities (SAL-178)', () => {
  const rule = (over: Partial<MinimumRule>): MinimumRule => ({ id: 'r', companyId: 'A', priceListId: null, styleId: 'jkt01', productType: null, itemId: null, minQuantity: 5, per: 'COLOURWAY', action: 'WARN', surchargeAmount: null, currency: null, surchargePct: null, note: null, status: 'ACTIVE', ...over })
  const lines = [
    { id: 'l10', seq: 10, styleId: 'jkt01', colourwayId: 'BLK', productType: 'JACKET' as const, itemIds: ['pel'], quantity: 3, label: 'SEED-JKT-01 BLK' },
    { id: 'l20', seq: 20, styleId: 'jkt01', colourwayId: 'RED', productType: 'JACKET' as const, itemIds: ['pel'], quantity: 6, label: 'SEED-JKT-01 RED' },
    { id: 'l30', seq: 30, styleId: 'jkt02', colourwayId: 'BLK2', productType: 'JACKET' as const, itemIds: [], quantity: 4, label: 'SEED-JKT-02 BLK' },
  ]
  const doc = { kind: 'QUOTE' as const, companyId: 'A', priceListId: 'P1', lines }
  it('per colourway, per document and per line, binding by company and list', () => {
    const findings = minimumFindings([rule({}), rule({ id: 'all', styleId: null, productType: 'JACKET', per: 'ORDER', minQuantity: 20, action: 'BLOCK', priceListId: 'P1' }), rule({ id: 'other', priceListId: 'P2', per: 'LINE', minQuantity: 50 })], doc, (r) => (r.styleId ? 'SEED-JKT-01' : 'jackets'))
    expect(findings.map((finding) => [finding.ruleId, finding.quantity, finding.seqs])).toEqual([
      ['r', 3, [10]],
      ['all', 13, [10, 20, 30]],
    ])
    expect(findings[0]!.message).toBe('SEED-JKT-01: 3 pieces in SEED-JKT-01 BLK; the minimum is 5 per colourway. It can go out, below the minimum.')
    expect(findings[1]!.message).toBe('jackets: 13 pieces on this quote; the minimum is 20 per quote. The quote cannot go out below it.')
    expect(minimumFindings([rule({ itemId: 'pel', styleId: null, per: 'LINE', minQuantity: 4, action: 'SURCHARGE', surchargeAmount: '12.000000', currency: 'EUR' })], doc, () => 'material PEL')[0]).toMatchObject({ seqs: [10], surcharge: { amount: '12', currency: 'EUR', pct: null } })
    expect(minimumFindings([rule({ status: 'ARCHIVED' }), rule({ companyId: 'B' })], doc, () => '')).toEqual([])
  })
  it('a rule names one subject; a surcharge only on SURCHARGE', () => {
    expect(minimumProblems({ styleId: 's', minQuantity: 5, per: 'ORDER', action: 'WARN' })).toEqual([])
    expect(minimumProblems({ styleId: 's', productType: 'JACKET', minQuantity: 1, per: 'ORDER', action: 'WARN', surchargePct: '2' }).map((issue) => issue.path)).toEqual(['styleId', 'minQuantity', 'surchargeAmount'])
    expect(minimumProblems({ itemId: 'i', minQuantity: 5, per: 'LINE', action: 'SURCHARGE', surchargeAmount: '3' }).map((issue) => issue.path)).toEqual(['currency'])
  })
})

describe('the price list import (SAL-183)', () => {
  const context = { numberFormat: 'it' as const }
  const mapping = ['list', 'style', 'colourway', 'validFrom', 'validTo', 'unitPrice', 'breaks'].map((column, index) => ({ index, header: column, column }))
  it('reads a sheet row: every colourway, open days, Italian numbers, breaks as a whole set', () => {
    expect(importerRegistry([{ importer: priceListImporter }]).get('sales.priceLists')).toBeDefined()
    const row = parseRow(priceListImporter, mapping, { rowNumber: 2, cells: ['seed-pl-p1', 'seed-jkt-01', '*', '-', '31/01/2027', '1.234,50', '50=415; 10=425 | 100=3%'] }, context)
    expect(row.errors).toEqual([])
    expect(row.values).toEqual({ list: 'SEED-PL-P1', style: 'SEED-JKT-01', colourway: '*', validFrom: '-', validTo: '2027-01-31', unitPrice: '1234.5', breaks: '10=425;50=415;100=3%' })
    expect(breaksOf('10=425;100=3%')).toEqual([
      { minQuantity: 10, unitPrice: '425', discountPct: null },
      { minQuantity: 100, unitPrice: null, discountPct: '3' },
    ])
    const bad = parseRow(priceListImporter, mapping, { rowNumber: 3, cells: ['L', 'S', 'BLK', '2027-02-01', '2027-01-01', '0', '1=3'] }, context)
    expect(bad.errors.map((issue) => issue.column)).toEqual(['unitPrice', 'breaks'])
  })
  it('the export writes what the load reads, so a file goes back unchanged', () => {
    const values = priceRecordValues({ list: 'SEED-PL-P1', style: 'SEED-JKT-02', colourway: null, validFrom: '2027-02-01', validTo: null, unitPrice: '415.000000', breaks: [{ minQuantity: 50, unitPrice: '405.000000', discountPct: null }] })
    expect(values).toEqual({ list: 'SEED-PL-P1', style: 'SEED-JKT-02', colourway: '*', validFrom: '2027-02-01', validTo: '-', unitPrice: '415', breaks: '50=405' })
    expect(priceListImporter.plan(values, { id: 'x', values })).toEqual({ action: 'UNCHANGED' })
    expect(priceListImporter.plan({ ...values, unitPrice: undefined } as never, null)).toMatchObject({ action: 'ERROR' })
    expect(breaksText([])).toBe('-')
  })
})

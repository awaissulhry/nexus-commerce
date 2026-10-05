/**
 * CHMAP M2 — our eBay workbook's mapping version: one column key whatever the header's name order, the rules'
 * draft, and the reader following the Owner's decisions. Fixtures are built here (never the Owner's files).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import { mapEbayWorkbook, readEbayWorkbook, type EbayWorkbookTarget } from '../pim/catalog-ebay-workbook.js'
import { ebaySpecFromCache } from '../pim/channel-specs/ebay.js'
import { readerMapping } from './decisions.js'
import { buildEbayDraftFields, ebayChannelKeyOf, headerNames, matchAspect } from './ebay-draft.js'

const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [
  { id: 'aspect_Colore', label: 'Colore', localizedName: 'Colore', englishName: 'Color', cardinality: 'SINGLE', required: false },
  { id: 'aspect_Materiale', label: 'Materiale', localizedName: 'Materiale', englishName: 'Material', cardinality: 'SINGLE' },
  { id: 'aspect_Marca', label: 'Marca', localizedName: 'Marca', englishName: 'Brand', cardinality: 'SINGLE', required: true },
] })
const specs = new Map([['177104', spec]])
const OLD = ['SKU', 'Action', 'Parent/Child', 'Parent SKU', 'Item ID', 'Title', 'Category ID', 'Weight', 'Wt Unit', 'Price (€)', 'Qty', 'Follow', 'Image 1', 'Image 2',
  'Marca (Brand) *', 'Colore (Color) ↕', 'Materiale (Material) ○', 'team name ⚠']
const NEW = OLD.map(h => ({ 'Marca (Brand) *': 'Brand (Marca) *', 'Colore (Color) ↕': 'Color (Colore) ↕', 'Materiale (Material) ○': 'Material (Materiale) ○' } as Record<string, string>)[h] ?? h)
const draft = (headers: string[]): MappingFieldRow[] => buildEbayDraftFields(headers, specs, 'IT').map((r, i) => ({ ...r, id: `f${i}` }))
const find = (rows: MappingFieldRow[], key: string) => rows.find(r => r.channelKey === key)!

function book(headers: string[], values: Record<string, string>[]) {
  const b = new ExcelJS.Workbook(), sheet = b.addWorksheet('ebay_it')
  sheet.addRow(headers)
  for (const v of values) sheet.addRow(headers.map(h => v[h] ?? ''))
  return b
}
const parentRow = { SKU: 'GALE-JACKET', 'Parent/Child': 'parent', 'Item ID': '900000000001', Title: 'Giacca', 'Category ID': '177104' }
const childRow = { SKU: 'GALE-JACKET-BLACK-MEN-M', 'Parent/Child': 'child', 'Parent SKU': 'GALE-JACKET', 'Item ID': '900000000001', Title: 'Giacca', 'Category ID': '177104', 'Price (€)': '105', Qty: '6', Follow: 'Follow' }
const aspects = (headers: string[]) => Object.fromEntries(headers.filter(h => /Marca|Brand|Color|Colore|Material/.test(h)).map(h => [h, /Marca|Brand/.test(h) ? 'Xavia Racing' : /Colo/.test(h) ? 'Nero' : 'Poliestere']))
const targets: EbayWorkbookTarget[] = [
  { id: 'l-parent', sku: 'GALE-JACKET', parentSku: 'GALE-JACKET', sourceParentSku: 'GALE-JACKET', isParent: true, itemId: '900000000001', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 1 },
  { id: 'l-child', sku: 'GALE-JACKET-BLACK-MEN-M', parentSku: 'GALE-JACKET', sourceParentSku: 'GALE-JACKET', isParent: false, itemId: '900000000001', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 1 },
]
const read = (headers: string[], extra: Record<string, string> = {}) => readEbayWorkbook(book(headers, [{ ...parentRow, ...aspects(headers) }, { ...childRow, ...aspects(headers), ...extra }]))!

describe('CHMAP — our eBay workbook becomes a mapping version', () => {
  it('names a column by BOTH of its names, whatever order the export used', () => {
    expect(headerNames('Colore (Color) ↕')).toEqual(['Colore', 'Color'])
    expect(headerNames('Color (Colore) ↕')).toEqual(['Color', 'Colore'])
    expect(headerNames('team name ⚠')).toEqual(['team name'])
    expect(matchAspect('Color (Colore) ↕', spec)?.key).toBe(matchAspect('Colore (Color) ↕', spec)?.key)
    expect(ebayChannelKeyOf('Color (Colore) ↕', specs).channelKey).toBe('aspect:Colore')
    expect(ebayChannelKeyOf('Colore (Color) ↕', specs).channelKey).toBe('aspect:Colore')
    expect(ebayChannelKeyOf('team name ⚠', specs).channelKey).toBe('specific:team name')
    // The old and the new export are ONE form: the same ordered keys.
    expect(OLD.map(h => ebayChannelKeyOf(h, specs).channelKey)).toEqual(NEW.map(h => ebayChannelKeyOf(h, specs).channelKey))
  })

  it('decides every column by the shipped defaults and the category spec', () => {
    const rows = draft(OLD)
    expect(find(rows, 'SKU')).toMatchObject({ targetKind: 'identity', state: 'mapped' })
    expect(find(rows, 'Parent SKU')).toMatchObject({ targetKind: 'relationship', state: 'managed' })
    expect(find(rows, 'Item ID')).toMatchObject({ targetKind: 'identifier', state: 'managed' })
    expect(find(rows, 'Qty')).toMatchObject({ targetKind: 'quantity', state: 'managed' })
    expect(find(rows, 'Follow')).toMatchObject({ targetKind: 'none', state: 'ignored' })
    expect(find(rows, 'Price (€)')).toMatchObject({ targetKind: 'price', state: 'mapped' })
    expect(find(rows, 'Image 2')).toMatchObject({ targetKind: 'image', transform: [{ op: 'list', slot: 2 }] })
    expect(find(rows, 'Title')).toMatchObject({ targetKind: 'channelField', targetKey: 'title', state: 'mapped' })
    expect(find(rows, 'aspect:Marca')).toMatchObject({ targetKind: 'channelField', state: 'mapped', requirement: 'required', aliases: ['Brand (Marca)'] })
    expect(find(rows, 'specific:team name')).toMatchObject({ targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name', state: 'mapped' })
  })

  it('imports an English-first header into eBay’s aspect, not into a new custom specific (drift #5)', () => {
    const old = mapEbayWorkbook(read(OLD), targets, specs)
    const renamed = mapEbayWorkbook(read(NEW), targets, specs)
    const colour = (r: typeof old) => r.rows.filter(x => x.sku === 'GALE-JACKET-BLACK-MEN-M' && /color|Colo/i.test(x.field)).map(x => [x.field, x.value])
    expect(colour(renamed)).toEqual(colour(old))
    expect(renamed.rows.some(r => r.field === 'itemSpecifics.Color')).toBe(false)
  })

  it('the reader gives the SAME result with the rules’ version, and follows the Owner’s decisions', () => {
    const table = read(OLD, { 'team name ⚠': 'Giacca' })
    const plain = mapEbayWorkbook(table, targets, specs)
    const rules = draft(OLD)
    const same = mapEbayWorkbook(table, targets, specs, { mapping: readerMapping({ id: 's', version: 1, status: 'DRAFT' }, 'eBay IT · 177104 · v1 (draft)', rules) })
    expect(same.rows).toEqual(plain.rows)
    expect(same.ledger).toEqual(plain.ledger)
    expect(plain.rows.some(r => r.field === 'itemSpecifics.team name')).toBe(true)
    const decided = rules.map(r => r.channelKey === 'specific:team name' ? { ...r, state: 'ignored' as const, decidedBy: 'owner' as const, reason: 'Amazon workaround field' } : r)
    const out = mapEbayWorkbook(table, targets, specs, { mapping: readerMapping({ id: 's', version: 2, status: 'DRAFT' }, 'eBay IT · 177104 · v2 (draft)', decided) })
    expect(out.rows.some(r => r.field === 'itemSpecifics.team name')).toBe(false)
    expect(out.exclusions.find(e => e.field === 'team name ⚠')?.message).toBe('Ignored by eBay IT · 177104 · v2 (draft): Amazon workaround field')
    expect(out.rows.filter(r => r.field !== 'itemSpecifics.team name')).toEqual(plain.rows.filter(r => r.field !== 'itemSpecifics.team name'))
  })
})

// W3-6 (2026-10-05) — the product sheet now heads eBay's "Quantità" / "Unità di misura" columns "Unit quantity" /
// "Unit type" (the sheet's naming table, display only). A workbook header is matched by eBay's own names (the Italian
// one, and the English one the cache carries), so the old export's headers, the draft rows and their aliases are pinned.
describe('the sheet\'s names change no workbook match (W3-6)', () => {
  const cached = JSON.parse(readFileSync(new URL('../pim/channel-specs/__tests__/fixtures/ebay-it-177104.json', import.meta.url), 'utf8'))
  const full = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: cached.aspects, conditions: cached.conditions })
  const fullSpecs = new Map([['177104', full]])

  it('matches the unit-price aspects by eBay\'s names, in either order', () => {
    expect(matchAspect('Quantità (Quantity)', full)?.key).toBe('quantita')
    expect(matchAspect('Quantity (Quantità)', full)?.key).toBe('quantita')
    expect(matchAspect('Unità di misura (Unit of measure)', full)?.key).toBe('unita_di_misura')
    expect(matchAspect('Unit of measure', full)?.key).toBe('unita_di_misura')
  })

  it('keeps the same channel keys and aliases for those columns', () => {
    expect(ebayChannelKeyOf('Quantità (Quantity)', fullSpecs)).toEqual({ channelKey: 'aspect:Quantità', aliases: ['Quantity (Quantità)'] })
    expect(ebayChannelKeyOf('Unità di misura (Unit of measure)', fullSpecs)).toEqual({ channelKey: 'aspect:Unità di misura', aliases: ['Unit of measure (Unità di misura)'] })
  })

  it('never matches a sheet header: the display name is not a matching name', () => {
    expect(matchAspect('Unit quantity', full)).toBeNull()
    expect(matchAspect('Unit type', full)).toBeNull()
  })
})

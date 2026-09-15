import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { mapEbayWorkbook, readEbayWorkbook, type EbayWorkbookTarget } from './catalog-ebay-workbook.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'
import { readCatalogWorkbook, writeCatalogWorkbook } from './catalog-workbook.js'

const parents = ['GALE-JACKET', 'IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3']
const ids = ['257584954808', '256564203510', '256566101420', '256566102729', '256566103703']
const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
const variants = ['BLACK', 'YELLOW'].flatMap(color => sizes.map(size => `GALE-JACKET-${color}-MEN-${size}`))
const headers = ['SKU', 'Action', 'Parent/Child', 'Parent SKU', 'Item ID', 'Listing ID', 'Title', 'Category ID', 'Shared-SKU (Trading API)', 'Weight', 'Wt Unit', 'Price (€)', 'Qty', 'Materiale (Material) ○', 'Caratteristiche (Features)', 'Stagione (Season)', 'Image 1', 'Image 2', 'Description']
const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [
  { id: 'aspect_Material', label: 'Materiale', localizedName: 'Materiale', englishName: 'Material', cardinality: 'SINGLE' },
  { id: 'aspect_Features', label: 'Caratteristiche', localizedName: 'Caratteristiche', englishName: 'Features', cardinality: 'MULTI' },
  { id: 'aspect_Season', label: 'Stagione', localizedName: 'Stagione', englishName: 'Season', kind: 'enum', enumMode: 'strict', options: ['Tutte le stagione'] },
] })
const specs = new Map([['177104', spec]])
function fixture() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it'), targets: EbayWorkbookTarget[] = []
  sheet.addRow(headers)
  parents.forEach((parent, i) => {
    ;[parent, ...variants].forEach((sku, j) => {
      const isParent = j === 0, id = `listing-${i}-${j}`
      sheet.addRow([sku, '', isParent ? 'parent' : 'child', isParent ? '' : parent, ids[i], '', `Title ${i}`, '177104', '1', '0', 'KILOGRAM', '105', '0', 'Poliestere, Nylon', 'Ventilato, Impermeabile', '', '', '', ''])
      targets.push({ id, sku: isParent ? parents[0] : sku, parentSku: parents[0], sourceParentSku: parent, isParent, itemId: ids[i], accountId: 'seller-a', marketplace: 'IT', aliasKey: i ? `alias-${i}` : '', version: 4 })
    })
  })
  return { book, sheet, targets }
}
function parse(input = fixture()) { return mapEbayWorkbook(readEbayWorkbook(input.book)!, input.targets, specs) }
function set(sheet: ExcelJS.Worksheet, row: number, header: string, value: ExcelJS.CellValue) { sheet.getCell(row, headers.indexOf(header) + 1).value = value }

describe('legacy eBay workbook import identities and values', () => {
  it('keeps all five listings and 100 repeated variants independent under one canonical family', () => {
    const result = parse()
    expect(result.issues).toEqual([])
    const titles = result.rows.filter(r => r.field === 'title')
    expect(titles).toHaveLength(105)
    expect(new Set(titles.map(r => `${r.aliasKey}:${r.sku}`)).size).toBe(105)
    expect(new Set(titles.map(r => r.sku)).size).toBe(21)
    expect(titles.filter(r => r.sku === parents[0]).map(r => r.value)).toEqual(parents.map((_, i) => `Title ${i}`))
    expect(result.rows.every(r => r.entity !== 'Products' && r.accountId === 'seller-a' && r.version === 4)).toBe(true)
  })
  it('preserves false, zero, scalar commas, schema lists, blank omissions and ordered images', () => {
    const input = fixture()
    set(input.sheet, 2, 'Shared-SKU (Trading API)', '0')
    set(input.sheet, 2, 'Image 1', 'https://example.com/1.jpg')
    set(input.sheet, 2, 'Image 2', 'https://example.com/2.jpg')
    const result = parse(input), rows = result.rows.filter(r => r.row === 2)
    expect(result.issues).toEqual([])
    expect(rows.find(r => r.field === 'sharedSkuListing')?.value).toBe(false)
    expect(rows.find(r => r.field === 'packageWeight')?.value).toEqual({ value: 0, unit: 'KILOGRAM' })
    expect(rows.find(r => r.field === 'material')?.value).toBe('Poliestere, Nylon')
    expect(rows.find(r => r.field === 'features')?.value).toEqual(['Ventilato', 'Impermeabile'])
    expect(rows.find(r => r.field === 'imageUrls')?.value).toEqual(['https://example.com/1.jpg', 'https://example.com/2.jpg'])
    expect(result.rows.some(r => ['price', 'quantity', 'description'].includes(r.field))).toBe(false)
    expect(result.exclusions.filter(r => ['Price (€)', 'Qty'].includes(r.field))).toHaveLength(210)
  })
  it.each(['wrong item', 'wrong parent', 'wrong listing', 'missing target', 'ambiguous account'])('refuses %s without falling back to the primary listing', kind => {
    const input = fixture()
    if (kind === 'wrong item') set(input.sheet, 24, 'Item ID', ids[0])
    if (kind === 'wrong parent') set(input.sheet, 24, 'Parent SKU', parents[0])
    if (kind === 'wrong listing') set(input.sheet, 24, 'Listing ID', input.targets[1].id)
    if (kind === 'missing target') input.targets = input.targets.filter(t => !t.aliasKey)
    if (kind === 'ambiguous account') input.targets.push({ ...input.targets[22], id: 'other-account-listing', accountId: 'seller-b' })
    const result = parse(input)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.rows.filter(r => r.row === 24)).toEqual([])
  })
  it('blocks duplicate records, orphans and a parent row that claims a parent', () => {
    const input = fixture()
    input.sheet.addRow(input.sheet.getRow(3).values)
    set(input.sheet, 4, 'Parent SKU', 'MISSING')
    set(input.sheet, 44, 'Parent SKU', 'GALE-JACKET')
    const result = parse(input)
    expect(result.issues.some(i => i.message.includes('Duplicate'))).toBe(true)
    expect(result.issues.some(i => i.row === 4)).toBe(true)
    expect(result.issues.some(i => i.row === 44)).toBe(true)
  })
  it('rejects a child category that differs from its eBay parent', () => {
    const input = fixture(); set(input.sheet, 3, 'Category ID', '123456')
    const result = parse(input)
    expect(result.issues).toEqual([expect.objectContaining({ row: 3, field: 'Category ID' })])
    expect(result.rows.some(r => r.row === 3)).toBe(false)
  })
  it('rejects unsafe lifecycle actions, unsupported columns and invalid provider choices with source addresses', () => {
    const input = fixture()
    set(input.sheet, 2, 'Action', 'end')
    set(input.sheet, 3, 'Stagione (Season)', 'Tutte le stagioni')
    input.sheet.getCell(1, headers.length + 1).value = 'athlete ⚠'
    input.sheet.getCell(2, headers.length + 1).value = 'Unisex'
    const result = parse(input)
    expect(result.issues.map(i => i.field)).toEqual(['Action', 'athlete ⚠', 'Stagione (Season)'])
    expect(result.issues[2]).toMatchObject({ row: 3, source: { sheet: 'ebay_it', column: 'P' } })
  })
  it('refuses formulas, error cells, duplicate headers and extra worksheets', () => {
    for (const value of [{ formula: '1+1', result: 2 }, { error: '#REF!' }] as ExcelJS.CellValue[]) {
      const input = fixture(); set(input.sheet, 2, 'Title', value)
      expect(() => readEbayWorkbook(input.book)).toThrow('verified values')
    }
    const duplicate = fixture(); duplicate.sheet.getCell('B1').value = 'SKU'
    expect(() => readEbayWorkbook(duplicate.book)).toThrow('unique')
    const extra = fixture(); extra.book.addWorksheet('Hidden data')
    expect(() => readEbayWorkbook(extra.book)).toThrow('one eBay marketplace')
  })
  it('retains aliases and typed fields through the canonical product workbook round trip', async () => {
    const mapped = parse(), book = new ExcelJS.Workbook()
    const data = parents.map((_, i) => ({ sheet: `eBay listing ${i + 1}`, entity: 'Overrides' as const, channel: 'EBAY', accountId: 'seller-a', marketplace: 'IT', locale: '', category: '177104',
      fields: [{ field: 'title', label: 'Title', type: 'text' }, { field: 'features', label: 'Features', type: 'list' }, { field: 'packageWeight', label: 'Weight', type: 'measure' }],
      rows: mapped.rows.filter(r => r.aliasKey === (i ? `alias-${i}` : '') && ['title', 'features', 'packageWeight'].includes(r.field)),
    }))
    await book.xlsx.load(await writeCatalogWorkbook(data) as never)
    const result = readCatalogWorkbook(book)!
    expect(result.issues).toEqual([])
    expect(result.rows.filter(r => r.entity === 'Overrides')).toHaveLength(315)
    expect(result.rows.filter(r => r.entity === 'Listings' && r.field === 'categoryId')).toHaveLength(105)
    expect(new Set(result.rows.map(r => `${r.aliasKey}:${r.sku}`)).size).toBe(105)
    expect(result.rows.find(r => r.aliasKey === 'alias-4' && r.field === 'title')?.value).toBe('Title 4')
  })
})

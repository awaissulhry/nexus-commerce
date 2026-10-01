/**
 * PSIE — the product sheet's file, read in changes-only mode, and the small rules around it. Pure: no database.
 * The whole engine on real families is measured by `scripts/psie-bench.mts` (read → check → save → undo).
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { sheetCellMarker, type TransferRow } from '@nexus/shared/catalog-transfer'
import { writeCatalogWorkbook, readCatalogWorkbook, type WorkbookScope } from '../catalog-workbook.js'
import { sheetTabNames } from '../catalog-editor-workbook.js'
import { undeclaredListingValues } from '../catalog-transfer-export.js'
import { planChanges, sameValue } from './sheet-import.service.js'
import { inDatabaseTransaction, beforeDatabaseCommit, hasBeforeDatabaseCommit, dropBeforeDatabaseCommit } from '../../../lib/database-context.js'

const base: TransferRow = { row: 3, entity: 'Products', sku: 'JACKET-M', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'Gale jacket', version: 7 }
const listing = (sku: string, field: string, value: unknown, action: TransferRow['action'] = 'SET'): TransferRow =>
  ({ ...base, sku, entity: 'Overrides', channel: 'AMAZON', accountId: 'acc', marketplace: 'IT', field, action, value })
/** Two products; `gtin` applies to JACKET-M only (JACKET-L has no baseline row for it, like a column that does not apply). */
const scopes = (): WorkbookScope[] => [
  { sheet: 'Shared', entity: 'Products', channel: '', accountId: '', marketplace: '', locale: '', category: '',
    fields: [{ field: 'name', label: 'Name', type: 'text' }, { field: 'gtin', label: 'GTIN', type: 'text' }, { field: 'weightValue', label: 'Weight', type: 'number' }],
    rows: [base, { ...base, field: 'gtin', value: '0000123456789' }, { ...base, field: 'weightValue', value: 1.5 },
      { ...base, sku: 'JACKET-L', version: 3, value: 'Gale jacket L' }, { ...base, sku: 'JACKET-L', version: 3, field: 'weightValue', value: null, action: 'INHERIT' }] },
  { sheet: 'Amazon IT', entity: 'Overrides', channel: 'AMAZON', accountId: 'acc', marketplace: 'IT', locale: '', category: 'COAT',
    fields: [{ field: 'material', label: 'Material', type: 'text' }, { field: 'bullets', label: 'Bullets', type: 'list' }],
    rows: [listing('JACKET-M', 'material', 'Nylon'), listing('JACKET-M', 'bullets', ['Warm', 'Light']), listing('JACKET-L', 'material', null, 'INHERIT')].map(r => ({ ...r, version: r.sku === 'JACKET-L' ? 3 : 7 })) },
]
const baseline = (data = scopes()) => ({ id: 'export-1', scopes: data, exportedAt: '2026-09-26T10:00:00.000Z', expiresAt: '2026-10-26T10:00:00.000Z', aliasLabels: { '': 'Primary listing' } })
async function sheetFile(edit?: (book: ExcelJS.Workbook, cell: (sheet: string, sku: string, field: string) => ExcelJS.Cell) => void) {
  const data = scopes(), saved = baseline(data)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await writeCatalogWorkbook(data, true, saved, 'sheet') as never)
  const cell = (name: string, sku: string, field: string) => {
    const sheet = book.getWorksheet(name)!
    const keys = (sheet.getRow(2).values as string[]).map(h => typeof h === 'string' ? h.replace(/@[^@]*$/, '') : h)
    const row = Array.from({ length: sheet.rowCount }, (_, i) => i + 1).find(r => sheet.getCell(r, keys.indexOf('sku')).text === sku)!
    return sheet.getCell(row, keys.indexOf(field))
  }
  edit?.(book, cell)
  const reopened = new ExcelJS.Workbook()
  await reopened.xlsx.load(await book.xlsx.writeBuffer() as never)
  return { book: reopened, saved }
}

describe('the product sheet file (sheet style)', () => {
  it('has no action columns and short, plain instructions', async () => {
    const { book } = await sheetFile()
    const keys = (book.getWorksheet('Shared')!.getRow(2).values as unknown[]).filter(Boolean) as string[]
    expect(keys.some(k => k.startsWith('action:'))).toBe(false)
    const instructions = book.getWorksheet('Instructions')!
    const topics = Array.from({ length: instructions.rowCount }, (_, i) => instructions.getCell(i + 1, 1).text)
    expect(topics).toEqual(expect.arrayContaining(['Change a value', 'Empty a value', 'Use the shared value', 'Channels', 'Valid until']))
    expect(topics.length).toBeLessThanOrEqual(10)
  })

  it('an untouched file changes nothing: no rows and no issues', async () => {
    const { book, saved } = await sheetFile()
    expect(readCatalogWorkbook(book, saved, { changesOnly: true })).toEqual({ rows: [], issues: [] })
  })

  it('returns only the changed cells, each with what the export held', async () => {
    const { book, saved } = await sheetFile((_, cell) => {
      cell('Shared', 'JACKET-M', 'name').value = 'Gale jacket 2'
      cell('Amazon IT', 'JACKET-M', 'material').value = 'Polyester'
    })
    const { rows, issues } = readCatalogWorkbook(book, saved, { changesOnly: true })!
    expect(issues).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ entity: 'Products', sku: 'JACKET-M', field: 'name', action: 'SET', value: 'Gale jacket 2', version: 7, expected: { action: 'SET', value: 'Gale jacket' } })
    expect(rows[1]).toMatchObject({ entity: 'Overrides', channel: 'AMAZON', marketplace: 'IT', field: 'material', value: 'Polyester', expected: { action: 'SET', value: 'Nylon' } })
  })

  it('a value typed back exactly as exported is untouched', async () => {
    const { book, saved } = await sheetFile((_, cell) => { cell('Shared', 'JACKET-M', 'name').value = 'Gale jacket' })
    expect(readCatalogWorkbook(book, saved, { changesOnly: true })!.rows).toEqual([])
  })

  it('#clear empties a value and #shared follows the shared value again (any case)', async () => {
    const { book, saved } = await sheetFile((_, cell) => {
      cell('Shared', 'JACKET-M', 'gtin').value = '#clear'
      cell('Amazon IT', 'JACKET-M', 'material').value = ' #SHARED '
    })
    const { rows, issues } = readCatalogWorkbook(book, saved, { changesOnly: true })!
    expect(issues).toEqual([])
    expect(rows.map(r => [r.field, r.action])).toEqual([['gtin', 'CLEAR'], ['material', 'INHERIT']])
  })

  it('🔴 a blank cell in a column that does not apply to a product is untouched, never a problem (the 284 false problems)', async () => {
    const { book, saved } = await sheetFile()
    // JACKET-L has no baseline row for `gtin`; its blank cell used to be refused as "Keep the exported SKU, alias and version intact".
    expect(readCatalogWorkbook(book, saved, { changesOnly: true })!.issues).toEqual([])
    expect(readCatalogWorkbook(book, saved)!.issues.some(i => i.sku === 'JACKET-L' && i.field === 'gtin')).toBe(true)
  })

  it('a value typed where the export held none travels with `expected: null`, for the check to judge', async () => {
    const { book, saved } = await sheetFile((_, cell) => { cell('Shared', 'JACKET-L', 'gtin').value = '0000999999999' })
    const { rows, issues } = readCatalogWorkbook(book, saved, { changesOnly: true })!
    expect(issues).toEqual([])
    expect(rows).toEqual([expect.objectContaining({ sku: 'JACKET-L', field: 'gtin', value: '0000999999999', version: 3, expected: null })])
  })

  it('a changed version cell is refused for that cell', async () => {
    const { book, saved } = await sheetFile((_, cell) => {
      cell('Shared', 'JACKET-M', 'name').value = 'Gale jacket 2'
      cell('Shared', 'JACKET-M', 'version').value = '8'
    })
    const { rows, issues } = readCatalogWorkbook(book, saved, { changesOnly: true })!
    expect(rows).toEqual([])
    expect(issues).toEqual([expect.objectContaining({ sku: 'JACKET-M', field: 'name', message: 'Shared: keep the exported record version intact' })])
  })

  it('the old reader still reads a sheet-style file (no action columns): every cell, as before', async () => {
    const { book, saved } = await sheetFile()
    const all = readCatalogWorkbook(book, saved)!
    expect(all.rows.filter(r => r.sku === 'JACKET-M').map(r => r.field).sort()).toEqual(['bullets', 'gtin', 'material', 'name', 'weightValue'])
  })
})

describe('readable tab names', () => {
  const scope = (entity: WorkbookScope['entity'], channel = '', marketplace = '', locale = '', category = '') => ({ entity, channel, marketplace, locale, category })
  it('names shared, language and channel tabs for people, unique and within Excel’s rules', () => {
    expect(sheetTabNames([scope('Products'), scope('Products', '', '', 'de'), scope('Overrides', 'AMAZON', 'IT'), scope('Overrides', 'AMAZON', 'IT', '', 'COAT'),
      scope('Overrides', 'AMAZON', 'IT'), scope('Overrides', 'EBAY', 'DE', 'de', '11450'), scope('Overrides', 'SHOPIFY', 'GLOBAL', '', 'a/b:c*d?[e]')]))
      .toEqual(['Shared', 'Shared · DE', 'Amazon IT', 'Amazon IT · COAT', 'Amazon IT 2', 'eBay DE · de · 11450', 'Shopify GLOBAL · a b c d e'])
  })
  it('keeps every name at 31 characters or fewer', () => {
    const names = sheetTabNames(Array.from({ length: 12 }, () => scope('Overrides', 'AMAZON', 'IT', 'it', 'A_VERY_LONG_PRODUCT_TYPE_NAME')))
    expect(names.every(n => n.length <= 31)).toBe(true)
    expect(new Set(names).size).toBe(12)
  })
})

describe('small rules', () => {
  it('cell markers are case- and space-insensitive and nothing else', () => {
    expect([sheetCellMarker('#clear'), sheetCellMarker(' #Clear '), sheetCellMarker('#SHARED'), sheetCellMarker('#cleared'), sheetCellMarker(''), sheetCellMarker(3)])
      .toEqual(['CLEAR', 'CLEAR', 'INHERIT', undefined, undefined, undefined])
  })
  it('sameValue: every empty is one empty; otherwise structural equality', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(undefined, [])).toBe(true)
    expect(sameValue('', 'a')).toBe(false)
    expect(sameValue(0, null)).toBe(false)
    expect(sameValue(1.5, 1.5)).toBe(true)
    expect(sameValue({ value: 1, unit: 'kg' }, { unit: 'kg', value: 1 })).toBe(true)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
  })
  it('undeclared stored listing values are named, never dropped (declared by field or sheet key are not)', () => {
    const stored = { overrideData: { material: 'Nylon', legacy_code: 'X1', empty_one: '', old_list: ['a'], item_name__0: 'T' } }
    expect(undeclaredListingValues(stored, [{ fieldKey: 'material' }, { fieldKey: 'item_name', sheetKey: 'item_name__0' }]))
      .toEqual([['legacy_code', 'X1'], ['old_list', ['a']]])
  })
})

describe('before-commit producers: a wider producer covers narrower ones', () => {
  const fakeClient = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}) } as never
  it('reports and drops registered producers by key and prefix inside one transaction', async () => {
    const ran: string[] = []
    await inDatabaseTransaction(fakeClient, async () => {
      await beforeDatabaseCommit('readiness:root:{"channel":"AMAZON"}', async () => { ran.push('scoped') })
      expect(hasBeforeDatabaseCommit('readiness:root')).toBe(false)
      dropBeforeDatabaseCommit('readiness:root:')
      await beforeDatabaseCommit('readiness:root', async () => { ran.push('family') })
      expect(hasBeforeDatabaseCommit('readiness:root')).toBe(true)
    })
    expect(ran).toEqual(['family'])
  })
  it('outside a transaction there is nothing registered and nothing to drop', () => {
    expect(hasBeforeDatabaseCommit('readiness:root')).toBe(false)
    expect(() => dropBeforeDatabaseCommit('readiness:')).not.toThrow()
  })
})

// Phase 2 (the Owner, 2026-10-01) — an import that creates products: every made thing is first in the review, in the order
// Apply makes it, as status "new"; then the values of each new listing. After Apply the made things read "saved".
describe('the review of an import that creates a family', () => {
  const row = (sku: string, field: string, value: unknown): TransferRow => ({ ...base, entity: 'Overrides', sku, channel: 'EBAY', accountId: 'acc-1', marketplace: 'IT', field, value, version: 0 })
  const payload = {
    labels: {}, listingPlan: {
      names: [], creates: [{ sku: 'IT-GALE', rootId: '', rootSku: 'GALE', accountId: 'acc-1', marketplace: 'IT', rows: [row('GALE-BLACK-M', 'price', 105)] }],
      families: [{ rootSku: 'GALE', name: 'Giacca', theme: 'Colore,Taglia', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
        children: [{ sku: 'GALE-BLACK-M', name: 'Giacca', values: { color: 'Nero', size: 'M' } }], restore: {} }],
      mains: [{ rootSku: 'GALE', rootId: '', accountId: 'acc-1', marketplace: 'IT', rows: [row('GALE', 'title', 'Giacca GALE')] }],
    },
  }
  it('lists the new product, its variations, the main listing and its values, then the extra listings', () => {
    expect(planChanges(payload as never).map(c => [c.sku, c.destination, c.label, c.after, c.status])).toEqual([
      ['GALE', 'Shared', 'Product', 'New product GALE (varies by Colore, Taglia)', 'new'],
      ['GALE-BLACK-M', 'Shared', 'Variation', 'New variation GALE-BLACK-M (Nero · M)', 'new'],
      ['GALE', 'eBay · IT', 'Listing', 'New listing (draft)', 'new'],
      ['GALE', 'eBay · IT', 'Title', 'Giacca GALE', 'new'],
      ['GALE', 'eBay · IT · IT-GALE', 'Listing', 'New listing IT-GALE (draft)', 'new'],
      ['GALE-BLACK-M', 'eBay · IT · IT-GALE', 'Price', 105, 'new'],
    ])
  })
  it('says the open product becomes the parent, and shows what Apply made as saved', () => {
    const adopted = { ...payload, listingPlan: { ...payload.listingPlan, families: [{ ...payload.listingPlan.families[0], adoptId: 'open' }] },
      familiesDone: { families: [], mains: [] }, listingsDone: { named: [], created: [] } }
    const rows = planChanges(adopted as never)
    expect(rows[0]).toMatchObject({ sku: 'GALE', before: 'No variations', after: 'GALE becomes a product with variations (varies by Colore, Taglia)', status: 'saved' })
    expect(rows.every(c => c.status === 'saved')).toBe(true)
    expect(rows.some(c => c.field === 'title' || c.field === 'price')).toBe(false)
  })
  it('an undo says what goes to the recycle bin, and that the open product stays a parent', () => {
    const undo = { labels: {}, listingUndo: { named: [], created: [],
      families: [{ rootId: 'open', rootSku: 'GALE', adopted: true, axes: ['Colore', 'Taglia'], products: [{ id: 'v1', sku: 'GALE-BLACK-M' }] }],
      mains: [{ rootId: 'open', rootSku: 'GALE', accountId: 'acc-1', marketplace: 'IT', listings: [{ id: 'l0', productId: 'open' }, { id: 'l1', productId: 'v1' }] }] } }
    expect(planChanges(undo as never).map(c => [c.sku, c.before, c.after])).toEqual([
      ['GALE', '1 variation', 'GALE stays a product with variations (Colore, Taglia). Its variations go to the recycle bin.'],
      ['GALE-BLACK-M', 'Product GALE-BLACK-M', 'In the recycle bin'],
      ['GALE', 'Draft listing', 'Removed'],
    ])
  })
})

// Phase 2b (the Owner, 2026-10-01) — an existing family the file completes: its new axes, variations and values, as "New";
// an undo puts them back to none.
describe('the review of an import that completes an existing family', () => {
  it('lists the axes it gets, its new variations, the values it lacked, then the new variations’ listing values', () => {
    const payload = { labels: {}, listingPlan: { names: [], creates: [], mains: [], families: [{ rootSku: 'GALE', existingId: 'r1', name: 'Gale', theme: '', setsAxes: true,
      axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }], restore: {},
      children: [{ sku: 'GALE-YELLOW-M', name: 'Gale (Giallo, M)', values: { color: 'Giallo', size: 'M' } }],
      fills: [{ productId: 'v1', sku: 'GALE-BLACK-M', values: { color: 'Nero', size: 'M' } }],
      listings: [{ accountId: 'acc-1', aliasKey: 'a1', marketplace: 'IT', label: 'IT-GALE' }],
      rows: [{ ...base, entity: 'Overrides', sku: 'GALE-YELLOW-M', channel: 'EBAY', accountId: 'acc-1', marketplace: 'IT', aliasKey: 'a1', field: 'price', value: 105 }] }] } }
    expect(planChanges(payload as never).map(c => [c.sku, c.destination, c.label, c.before, c.after, c.status])).toEqual([
      ['GALE', 'Shared', 'Axes', null, 'Colore, Taglia', 'new'],
      ['GALE-YELLOW-M', 'Shared', 'Variation', null, 'New variation GALE-YELLOW-M (Giallo · M)', 'new'],
      ['GALE-BLACK-M', 'Shared', 'Colore', null, 'Nero', 'new'],
      ['GALE-BLACK-M', 'Shared', 'Taglia', null, 'M', 'new'],
      ['GALE-YELLOW-M', 'eBay · IT · IT-GALE', 'Price', null, 105, 'new'],
    ])
  })
  it('an undo puts the axes and values back to none and the new variations in the recycle bin', () => {
    const undo = { labels: {}, listingUndo: { named: [], created: [], mains: [], families: [{ rootId: 'r1', rootSku: 'GALE', adopted: false, existing: true,
      axes: ['Colore', 'Taglia'], axisCodes: ['color', 'size'], axesSet: ['color', 'size'], products: [{ id: 'n1', sku: 'GALE-YELLOW-M' }],
      filled: [{ productId: 'v1', sku: 'GALE-BLACK-M', values: { color: 'Nero' } }] }] } }
    expect(planChanges(undo as never).map(c => [c.sku, c.label, c.before, c.after])).toEqual([
      ['GALE', 'Axes', 'Colore, Taglia', null],
      ['GALE-BLACK-M', 'Colore', 'Nero', null],
      ['GALE-YELLOW-M', 'Product', 'Product GALE-YELLOW-M', 'In the recycle bin'],
    ])
  })
})

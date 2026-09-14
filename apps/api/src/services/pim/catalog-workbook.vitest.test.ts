import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { writeCatalogWorkbook, readCatalogWorkbook, type WorkbookScope } from './catalog-workbook.js'
import { parseHeader } from './import-diff.service.js'
import { readTransferFile } from './catalog-transfer-file.js'
import { mapAmazonWorkbook } from './catalog-amazon-workbook.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import { detectAmazonTemplate } from '../amazon/template-workbook.js'
import type { TransferRow } from '@nexus/shared/catalog-transfer'

const product: TransferRow = { row: 3, entity: 'Products', sku: '00001234', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'Shared title', version: 7 }
const scopes = (): WorkbookScope[] => [
  { sheet: 'Products', entity: 'Products', channel: '', accountId: '', marketplace: '', locale: '', category: '',
    fields: [{ field: 'name', label: 'Name', type: 'text' }, { field: 'gtin', label: 'GTIN', type: 'text' }, { field: 'weightValue', label: 'Weight', type: 'number' }, { field: 'batteries', label: 'Batteries', type: 'boolean' }],
    rows: [product, { ...product, field: 'gtin', value: '0000123456789' }, { ...product, field: 'weightValue', value: 0 }, { ...product, field: 'batteries', value: false }] },
  ...['it', 'de'].map(locale => ({ sheet: `Content ${locale}`, entity: 'Products' as const, channel: '', accountId: '', marketplace: '', locale, category: '',
    fields: [{ field: 'name', label: 'Title', type: 'text' }, { field: 'description', label: 'Description', type: 'text' }],
    rows: [{ ...product, locale, value: locale === 'it' ? 'Giacca' : 'Jacke' }, { ...product, locale, field: 'description', value: 'Line 1\r\nLine 2\u0007' }] })),
  ...[['AMAZON', 'a', 'IT'], ['AMAZON', 'a', 'DE'], ['AMAZON', 'b', 'IT'], ['EBAY', 'c', 'IT']].map(([channel, accountId, marketplace], i) => ({
    sheet: `Listing ${i}`, entity: 'Overrides' as const, channel, accountId, marketplace, locale: '', category: channel === 'AMAZON' ? 'COAT' : '1059',
    fields: [{ field: 'title', label: 'Title', type: 'text' }, { field: 'bullets', label: 'Bullets', type: 'list' }, { field: 'weight', label: 'Weight', type: 'measure' }],
    rows: [{ ...product, entity: 'Overrides' as const, channel, accountId, marketplace, aliasKey: i === 2 ? 'secondary' : '', field: 'title', value: `${accountId} ${marketplace}` },
      { ...product, entity: 'Overrides' as const, channel, accountId, marketplace, aliasKey: i === 2 ? 'secondary' : '', field: 'bullets', value: ['first', 'second'] },
      { ...product, entity: 'Overrides' as const, channel, accountId, marketplace, aliasKey: i === 2 ? 'secondary' : '', field: 'weight', value: { value: 1.6, unit: 'kilograms' } }],
  })),
]
const headersOf = (sheet: ExcelJS.Worksheet) => (sheet.getRow(2).values as string[]).map(h => h?.replace(/@[^@]*$/, ''))
const load = async (input = scopes()) => { const book = new ExcelJS.Workbook(); await book.xlsx.load(await writeCatalogWorkbook(input) as never); return book }
describe('multi-language and multi-market catalog workbook', () => {
  it.each([false, true])('keeps channel attributes separate from workbook identity (editing=%s)', async editing => {
    const data = [scopes()[3]]
    for (const field of ['sku', 'aliasKey', 'version', 'listing', 'value:sku', 'action:sku']) {
      data[0].fields.push({ field, label: field, type: 'text' })
      data[0].rows.push({ ...data[0].rows[0], field, value: `channel ${field}` })
    }
    const baseline = { id: 'reserved-attributes', scopes: data }
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, editing, editing ? baseline : undefined) as never)
    const sheet = book.getWorksheet(data[0].sheet)!
    const headers = headersOf(sheet)
    expect(new Set(headers.slice(1)).size).toBe(headers.length - 1)
    expect(sheet.getCell(3, headers.indexOf('sku')).text).toBe(product.sku)
    expect(sheet.getCell(3, headers.indexOf('value:sku')).text).toBe('channel sku')
    const parsed = readCatalogWorkbook(book, editing ? baseline : undefined)!
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toEqual(expect.arrayContaining(data[0].rows.map(row => expect.objectContaining(row))))
    sheet.getCell(3, headers.indexOf('value:sku')).value = 'new channel SKU'
    const changed = readCatalogWorkbook(book, editing ? baseline : undefined)!
    expect(changed.issues).toEqual([])
    expect(changed.rows.find(row => row.field === 'sku')).toMatchObject({ sku: product.sku, aliasKey: '', version: 7, value: 'new channel SKU' })
  })
  it('keeps one horizontal choice row per attribute and scope, with exact dropdown ranges after save/reopen', async () => {
    const choices = ['0001', 'Blue, green', 'Crème', 'Red/white', '#NAME?', '=literal', ...Array.from({ length: 24 }, (_, i) => `Choice ${i}`)]
    const data = [scopes()[0], scopes()[3]]
    data[0].fields.push({ field: 'color', label: 'Color', type: 'text', options: choices, selectionOnly: true })
    data[0].rows.push({ ...product, field: 'color', value: '0001' })
    data[1].fields.push({ field: 'color', label: 'Listing color', type: 'text', options: ['Black', 'White'], selectionOnly: false })
    data[1].rows.push({ ...data[1].rows[0], field: 'color', value: 'Black' })
    const baseline = { id: 'choices', scopes: data }, book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const values = book.getWorksheet('Valid values')!
    expect(values.rowCount).toBe(3)
    expect(values.getRow(2).values.slice(6)).toEqual(choices)
    expect(values.getRow(3).values.slice(6)).toEqual(['Black', 'White'])
    expect(values.getCell('F2').type).toBe(ExcelJS.ValueType.String)
    expect(values.getCell('K2').type).toBe(ExcelJS.ValueType.String)
    expect(values.getCell('E2').text).toBe('Listed values only')
    expect(values.getCell('E3').text).toBe('Suggestions; custom values allowed')
    const cell = (sheetName: string) => {
      const sheet = book.getWorksheet(sheetName)!
      return sheet.getCell(3, headersOf(sheet).indexOf('color'))
    }
    expect(book.definedNames.getRanges(cell('Products').dataValidation.formulae[0]).ranges).toEqual(["'Valid values'!$F$2:$AI$2"])
    expect(book.definedNames.getRanges(cell('Listing 0').dataValidation.formulae[0]).ranges).toEqual(["'Valid values'!$F$3:$G$3"])
    expect(cell('Products').dataValidation).toMatchObject({ showErrorMessage: true, errorStyle: 'warning' })
    expect(cell('Listing 0').dataValidation.showErrorMessage).not.toBe(true)
    expect(cell('Listing 0').dataValidation.prompt).toContain('custom values allowed')
    expect(readCatalogWorkbook(book, baseline)!.issues).toEqual([])
    cell('Products').value = 'Crème'
    const parsed = readCatalogWorkbook(book, baseline)!
    expect(parsed.rows.find(r => r.field === 'color' && r.entity === 'Products')?.value).toBe('Crème')
    expect(parsed.rows.find(r => r.field === 'color' && r.entity === 'Overrides')?.value).toBe('Black')
  })
  it('explains list choices and preserves encoded legacy values without offering a scalar list dropdown', async () => {
    const data = [scopes()[0]]
    data[0].fields.push({ field: 'colors', label: 'Colors', type: 'list', options: ['red', 'blue'] })
    data[0].fields.find(f => f.field === 'weightValue')!.options = ['001.00', '002.00']
    data[0].rows.find(r => r.field === 'weightValue')!.value = '001.00'
    data[0].rows.push({ ...product, field: 'colors', value: ['red', 'blue'] })
    const baseline = { id: 'typed-choices', scopes: data }, book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const choices = book.getWorksheet('Valid values')!, sheet = book.getWorksheet('Products')!
    const rows = choices.getRows(2, choices.rowCount - 1)!
    expect(rows.find(r => r.getCell(3).text === 'colors')!.getCell(4).text).toBe('JSON list items')
    expect(rows.find(r => r.getCell(3).text === 'weightValue')!.getCell(6).text).toBe('"001.00"')
    expect(rows.find(r => r.getCell(3).text === 'weightValue')!.getCell(5).text).toBe('Check current rules in Nexus')
    expect(sheet.getCell(3, headersOf(sheet).indexOf('colors')).dataValidation).toBeUndefined()
    expect(readCatalogWorkbook(book, baseline)!.rows.map(({ source, ...r }) => r)).toEqual(expect.arrayContaining(data[0].rows))
    expect(book.worksheets.map(s => s.name).slice(0, 2)).toEqual(['Instructions', 'Products'])
    expect(book.getWorksheet('Nexus workbook')!.state).toBe('hidden')
    expect(sheet.rowCount).toBe(3)
  })
  it('still reads the original dictionary headers and refuses oversized choice rows without truncation', async () => {
    const book = await load([scopes()[0]]), dictionary = book.getWorksheet('Dictionary')!
    dictionary.getCell('A1').value = 'sheet'; dictionary.getCell('B1').value = 'field'; dictionary.getCell('D1').value = 'type'
    expect(readCatalogWorkbook(book)!.issues).toEqual([])
    const data = [scopes()[0]]
    data[0].fields[0].options = Array.from({ length: 16_380 }, (_, i) => String(i))
    await expect(writeCatalogWorkbook(data)).rejects.toThrow('16,379 valid values')
  })
  it('keeps long content intact in compact rows and protects dropdown references while allowing header filters', async () => {
    const data = [scopes()[0]], text = 'First line of the full description.\n' + 'Verified product detail. '.repeat(400)
    data[0].fields.push({ field: 'description', label: 'Description', type: 'text' }, { field: 'color', label: 'Color', type: 'text', options: ['red', 'blue'] })
    data[0].rows.push({ ...product, field: 'description', value: text }, { ...product, field: 'color', value: 'red' })
    const baseline = { id: 'long-content', scopes: data }, bytes = await writeCatalogWorkbook(data, true, baseline), book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes as never)
    const sheet = book.getWorksheet('Products')!, cell = sheet.getCell(3, headersOf(sheet).indexOf('description'))
    expect(sheet.getRow(3).height).toBe(72)
    expect(cell.value).toBe(text)
    expect(cell.alignment.vertical).toBe('top')
    expect(sheet.autoFilter).toBe(`A2:${sheet.getColumn(sheet.columnCount).letter}3`)
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 2 })
    expect(readCatalogWorkbook(book, baseline)!.rows.find(r => r.field === 'description')!.value).toBe(text)
    const instructions = book.getWorksheet('Instructions')!.getSheetValues().flat().join(' ')
    expect(instructions).toContain('Hidden or filtered rows are still imported')
    expect(instructions).toContain('expand the formula bar')
    const zip = await JSZip.loadAsync(bytes)
    for (const name of ['Valid values', 'Dictionary', 'Nexus workbook']) {
      const reference = book.getWorksheet(name)!, xml = await zip.file(`xl/worksheets/sheet${reference.id}.xml`)!.async('string')
      const protection = xml.match(/<sheetProtection[^>]+>/)?.[0]
      expect(protection).toContain('sheet="1"')
      expect(protection).toContain('autoFilter="0"')
      expect(protection).toContain('formatRows="0"')
      expect(protection).not.toContain('sort="0"')
      if (name !== 'Nexus workbook') expect(reference.autoFilter).toBeTruthy()
    }
    expect(await zip.file(`xl/worksheets/sheet${sheet.id}.xml`)!.async('string')).not.toContain('<sheetProtection')
  })
  it('preserves typed and legacy values with the saved editing baseline and refuses dictionary tampering', async () => {
    const data = scopes()
    data[0].rows.find(r => r.field === 'weightValue')!.value = '001.00'
    const baseline = { id: 'saved-export', scopes: data }, book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const parsed = readCatalogWorkbook(book, baseline)!
    expect(parsed.issues).toEqual([])
    expect(parsed.rows.map(({ source, ...r }) => r)).toEqual(expect.arrayContaining(data.flatMap(s => s.rows)))
    const dictionary = book.getWorksheet('Dictionary')!
    dictionary.eachRow(r => { if (r.getCell(1).text === 'Products' && r.getCell(2).text === 'weightValue') r.getCell(11).value = 'cell' })
    expect(() => readCatalogWorkbook(book, baseline)).toThrow('Dictionary intact')
  })
  it('refuses spreadsheet formulas in an editing cell even when the cached result matches the baseline', async () => {
    const data = [scopes()[0]], baseline = { id: 'saved-export', scopes: data }, book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const sheet = book.getWorksheet('Products')!, column = (headersOf(sheet)).indexOf('weightValue')
    sheet.getCell(3, column).value = { formula: '1-1', result: 0 }
    expect(() => readCatalogWorkbook(book, baseline)).toThrow(/formula/i)
  })
  it('accepts native logical constants without trusting cached results and still refuses calculated or misplaced formulas', async () => {
    const data = [scopes()[0]], baseline = { id: 'logical-constants', scopes: data }, book = new ExcelJS.Workbook()
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const sheet = book.getWorksheet('Products')!, col = (field: string) => headersOf(sheet).indexOf(field)
    for (const [formula, result, expected] of [['FALSE()', undefined, false], ['TRUE()', false, true], ['FALSE()', true, false]] as const) {
      sheet.getCell(3, col('batteries')).value = { formula, result }
      const reopened = new ExcelJS.Workbook(); await reopened.xlsx.load(await book.xlsx.writeBuffer() as never)
      expect(readCatalogWorkbook(reopened, baseline)!.rows.find(r => r.field === 'batteries')!.value).toBe(expected)
    }
    for (const formula of ['1=1', 'NOT(FALSE())', 'TRUE()+0', 'IF(A1,TRUE(),FALSE())']) {
      sheet.getCell(3, col('batteries')).value = { formula, result: false }
      expect(() => readCatalogWorkbook(book, baseline)).toThrow(/formula/i)
    }
    sheet.getCell(3, col('batteries')).value = false
    for (const field of ['sku', 'action:batteries']) {
      const cell = sheet.getCell(3, col(field)), before = cell.value
      cell.value = { formula: 'TRUE()', result: true }
      expect(() => readCatalogWorkbook(book, baseline)).toThrow(/formula/i)
      cell.value = before
    }
    // Older fields can store a native boolean even when their current dictionary
    // says text. A logical constant preserves that value's type, not the string.
    data[0].fields.find(f => f.field === 'batteries')!.type = 'text'
    await book.xlsx.load(await writeCatalogWorkbook(data, true, baseline) as never)
    const legacy = book.getWorksheet('Products')!
    legacy.getCell(3, headersOf(legacy).indexOf('batteries')).value = { formula: 'FALSE()', result: false }
    expect(readCatalogWorkbook(book, baseline)!.rows.find(r => r.field === 'batteries')!.value).toBe(false)
  })
  it('round-trips every typed value, record version, locale, marketplace, account and alias', async () => {
    const data = scopes(), parsed = await readTransferFile(await writeCatalogWorkbook(data), 'catalog.xlsx')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows.filter(r => r.entity !== 'Listings')).toHaveLength(data.flatMap(s => s.rows).length)
    expect(parsed.rows.map(({ source, ...r }) => r)).toEqual(expect.arrayContaining(data.flatMap(s => s.rows)))
  })
  it('auto-maps populated cells and preserves blanks; CLEAR and INHERIT remain explicit', async () => {
    const book = await load([scopes()[0]]), sheet = book.getWorksheet('Products')!
    const col = (name: string) => headersOf(sheet).indexOf(name)
    sheet.getCell(3, col('action:name')).value = ''
    sheet.getCell(3, col('name')).value = 'Updated'
    sheet.getCell(3, col('gtin')).value = null
    sheet.getCell(3, col('action:gtin')).value = 'CLEAR'
    sheet.getCell(3, col('weightValue')).value = null
    sheet.getCell(3, col('action:weightValue')).value = 'INHERIT'
    sheet.getCell(4, 1).value = 'ANOTHER-SKU'
    const parsed = readCatalogWorkbook(book)!
    expect(parsed.issues).toEqual([])
    expect(parsed.rows.map(r => [r.field, r.action, r.value])).toEqual(expect.arrayContaining([['name', 'SET', 'Updated'], ['gtin', 'CLEAR', undefined], ['weightValue', 'INHERIT', undefined], ['batteries', 'SET', false]]))
  })
  it('refuses unknown columns, including data beyond the header, and undeclared sheets', async () => {
    const book = await load([scopes()[0]]), sheet = book.getWorksheet('Products')!
    sheet.getCell(3, sheet.columnCount + 1).value = 'must not disappear'
    expect(() => readCatalogWorkbook(book)).toThrow('headers')
    const other = await load([scopes()[0]]); other.addWorksheet('Forgotten data').addRow(['product'])
    expect(() => readCatalogWorkbook(other)).toThrow('no declared destination')
  })
  it('preserves legacy scalar/list mismatches and numeric strings without altering schema types', async () => {
    const scope = scopes()[0]
    scope.fields.push({ field: 'oldList', label: 'List', type: 'list' })
    scope.rows.push({ ...product, field: 'oldList', value: 'a legacy scalar' })
    scope.rows.find(r => r.field === 'weightValue')!.value = '22'
    const book = await load([scope])
    expect(readCatalogWorkbook(book)!.rows.map(({ source, ...r }) => r)).toEqual(expect.arrayContaining(scope.rows))
    const dictionary = book.getWorksheet('Dictionary')!
    const weight = dictionary.getRows(2, dictionary.rowCount - 1)!.find(r => r.getCell(2).text === 'weightValue')!
    expect(weight.getCell(4).text).toBe('number'); expect(weight.getCell(11).text).toBe('json')
  })
  it('refuses formula caches in import data while allowing calculation helpers', async () => {
    const book = await load([scopes()[0]]), sheet = book.getWorksheet('Products')!
    sheet.getCell(3, headersOf(sheet).indexOf('name')).value = { formula: '"fresh"', result: 'stale' }
    expect(() => readCatalogWorkbook(book)).toThrow('paste verified formula results')
  })
  it('does not permit multiple sheets to write the same coordinate', async () => {
    const a = scopes()[0], book = await load([a, { ...a, sheet: 'Duplicate' }])
    expect(() => readCatalogWorkbook(book)).toThrow('Multiple sheets write')
  })
  it('declares listing categories as Listings operations when creating a draft', async () => {
    const a = scopes()[3]; a.fields.unshift({ field: 'productType', label: 'Category', type: 'text' }); a.rows.unshift({ ...a.rows[0], field: 'productType', value: 'COAT', entity: 'Listings' })
    expect(readCatalogWorkbook(await load([a]))!.rows[0].entity).toBe('Listings')
  })
  it('uses the sheet category for added product rows and refuses a contradictory category', async () => {
    const scope = scopes()[3], book = await load([scope])
    expect(readCatalogWorkbook(book)!.rows.find(r => r.entity === 'Listings')).toMatchObject({ field: 'productType', value: 'COAT', accountId: 'a', marketplace: 'IT' })
    scope.fields.push({ field: 'productType', label: 'Category', type: 'text' }); scope.rows.push({ ...scope.rows[0], entity: 'Listings', field: 'productType', value: 'SHOES' })
    expect(readCatalogWorkbook(await load([scope]))!.issues[0].message).toContain('bound to category COAT')
  })
})

const attr = (properties: object, max = 1) => ({ type: 'array', maxItems: max, items: { type: 'object', properties } })
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
  item_name: attr({ value: { type: 'string' } }), bullet_point: attr({ value: { type: 'string' } }, 10),
  country_of_origin: attr({ value: { type: 'string', enum: ['PK', 'IT'] } }),
  batteries_required: attr({ value: { type: 'boolean' } }),
  item_package_weight: attr({ value: { type: 'number' }, unit: { type: 'string', enum: ['kilograms'] } }),
} } })
const h = (key: string, index = 1, leaf = 'value') => `${key}[marketplace_id=APJ6JRA9NG5V4]#${index}.${leaf}`
function amazon(): AmazonTemplateParse {
  const record = { 'contribution_sku#1.value': '00001234', 'product_type#1.value': 'COAT', '::record_action': 'Modifica', __action: 'partial',
    [h('item_name')]: 'Giacca', [h('bullet_point', 2)]: 'Secondo', [h('bullet_point')]: 'Primo', [h('country_of_origin')]: 'Pakistan', [h('batteries_required')]: 'No',
    [h('item_package_weight')]: '1.6', [h('item_package_weight', 1, 'unit')]: 'Chilogrammi' }
  return { headers: Object.keys(record).filter(k => k !== '__action'), labels: {}, rows: [record], rowNumbers: [17], valueAliases: {
    [h('country_of_origin')]: { Pakistan: 'PK' }, [h('batteries_required')]: { No: 'false' }, [h('item_package_weight', 1, 'unit')]: { Chilogrammi: 'kilograms' } },
    meta: { grammar: 'v2', sheet: 'Modello', attrRow: 5, dataStartRow: 17, primaryMarketplaceId: 'APJ6JRA9NG5V4', marketplace: 'IT', contentLanguageTag: 'it_IT', productTypes: ['COAT'], actions: { partial: 1, replace: 0, delete: 0, unknown: 0 }, skippedEmptyRows: 0 } }
}
const map = (p = amazon()) => mapAmazonWorkbook(p, new Map([['COAT', spec]]), { accountId: 'amazon-a', marketplace: 'IT', language: 'it' })
describe('Amazon workbook automatic mapping', () => {
  it('imports only an explicitly typed ASIN into the channel reference field', () => {
    const p = amazon(), type = 'amzn1.volt.ca.product_id_type', value = 'amzn1.volt.ca.product_id_value'
    p.headers.push(type, value); p.rows[0][type] = 'ASIN'; p.rows[0][value] = 'B0H7W8PH1F'; p.valueAliases[type] = { ASIN: 'asin' }
    const copy = structuredClone(spec); copy.fields.push({ ...copy.fields[0], key: 'merchant_suggested_asin', attribute: 'merchant_suggested_asin', masterKey: undefined, channelStore: undefined })
    const run = () => mapAmazonWorkbook(p, new Map([['COAT', copy]]), { accountId: 'a', marketplace: 'IT', language: 'it' })
    expect(run().rows).toContainEqual(expect.objectContaining({ field: 'merchant_suggested_asin', value: 'B0H7W8PH1F' }))
    p.rows[0][type] = 'Unknown'
    expect(run().rows.some(row => row.field === 'merchant_suggested_asin')).toBe(false)
    p.rows[0][type] = 'ASIN'; p.rows[0][value] = 'invalid'
    expect(run().issues).toContainEqual(expect.objectContaining({ field: value }))
  })
  it('maps provider wire values, ordered lists, typed booleans and paired measures with original row numbers', () => {
    const result = map()
    expect(result.issues).toEqual([])
    expect(Object.fromEntries(result.rows.map(r => [r.field, r.value]))).toEqual({ productType: 'COAT', item_name: 'Giacca', bullet_point: ['Primo', 'Secondo'], country_of_origin: 'PK', batteries_required: false, item_package_weight: { value: 1.6, unit: 'kilograms' } })
    expect(result.rows.every(r => r.row === 17 && r.accountId === 'amazon-a' && r.marketplace === 'IT' && r.entity !== 'Products')).toBe(true)
  })
  it('blocks marketplace and language mismatches and delete actions', () => {
    expect(() => mapAmazonWorkbook(amazon(), new Map(), { accountId: 'a', marketplace: 'DE', language: 'de' })).toThrow('belongs to Amazon IT')
    expect(() => mapAmazonWorkbook(amazon(), new Map(), { accountId: 'a', marketplace: 'IT', language: 'de' })).toThrow('language')
    const p = amazon(); p.rows[0].__action = 'delete'; expect(map(p).rows).toEqual([])
  })
  it('surfaces every populated unknown field and refuses a measure with no unit', () => {
    const p = amazon(); p.headers.push('unknown#1.value'); p.rows[0]['unknown#1.value'] = 'evidence'; p.rows[0][h('item_package_weight', 1, 'unit')] = ''
    expect(map(p).issues.map(i => i.field)).toEqual(['unknown#1.value', 'item_package_weight'])
  })
  it('makes existing-listing read-only fields visible as exclusions, while allowing them for new listings', () => {
    const copy = structuredClone(spec); copy.fields.find(f => f.key === 'country_of_origin')!.editable = false
    const result = mapAmazonWorkbook(amazon(), new Map([['COAT', copy]]), { accountId: 'a', marketplace: 'IT', language: 'it', existingListingSkus: new Set(['00001234']) })
    expect(result.rows.some(r => r.field === 'country_of_origin')).toBe(false)
    expect(result.exclusions.some(e => e.message.includes('read-only') && e.message.includes('Pakistan'))).toBe(true)
    expect(mapAmazonWorkbook(amazon(), new Map([['COAT', copy]]), { accountId: 'a', marketplace: 'IT', language: 'it' }).rows.some(r => r.field === 'country_of_origin')).toBe(true)
  })
  it('reuses the native reader with full split dictionaries and physical row gaps', async () => {
    const p = amazon(), b = new ExcelJS.Workbook(), s = b.addWorksheet('Modello')
    const aliases = Buffer.from(JSON.stringify([{ attribute: h('country_of_origin'), aliases: { Pakistan: 'PK' } }])).toString('base64')
    const settings = `feedType=256&primaryMarketplaceId=APJ6JRA9NG5V4&contentLanguageTag=it_IT&dataRow=7&attributeSettings=${aliases}`
    s.getCell('A1').value = `settings=${settings.slice(0, 180)}`; s.getCell('B1').value = `settings2=${settings.slice(180)}`
    const headers = [...p.headers, ...Array.from({ length: 20 }, (_, i) => `unused_${i}#1.value`)]
    s.getRow(5).values = headers; s.getRow(17).values = headers.map(k => p.rows[0][k] ?? '')
    const parsed = (await detectAmazonTemplate(Buffer.from(await b.xlsx.writeBuffer()), { strict: true }))!
    expect(parsed.rowNumbers).toEqual([17]); expect(parsed.valueAliases[h('country_of_origin')]).toEqual({ Pakistan: 'PK' })
  })
})


it.each(['SHOPIFY', 'ETSY'])('round trips %s category ownership separately from custom product fields', async channel => {
  const categoryKey = channel === 'SHOPIFY' ? 'category' : 'taxonomy_id'
  const data: WorkbookScope = { sheet: 'Store', entity: 'Overrides', channel, marketplace: 'GLOBAL', accountId: 'store-account', locale: '', category: '',
    fields: [{ field: categoryKey, label: 'Category', type: channel === 'ETSY' ? 'number' : 'text' }, { field: 'productType', label: 'Custom product type', type: 'text' }],
    rows: [{ ...product, channel, marketplace: 'GLOBAL', accountId: 'store-account', entity: 'Listings', field: categoryKey, action: 'CLEAR', value: undefined },
      { ...product, channel, marketplace: 'GLOBAL', accountId: 'store-account', entity: 'Overrides', field: 'productType', value: 'Travel bags' }] }
  const parsed = await readTransferFile(await writeCatalogWorkbook([data]), 'store.xlsx')
  expect(parsed.issues).toEqual([])
  expect(parsed.rows.find(r => r.field === categoryKey)).toMatchObject({ entity: 'Listings', action: 'CLEAR' })
  expect(parsed.rows.find(r => r.field === 'productType')).toMatchObject({ entity: 'Overrides', value: 'Travel bags' })
})

/**
 * CFI-1 — both import doors read a workbook on the parse worker, by what it IS.
 *
 * 🔴 records/2026-09-24-results.md §3: the catalog page ran ExcelJS on the request thread (> 8 min on an Amazon
 * template chosen as "Nexus workbook"); the product-sheet drawer refused `.xlsm` outright. The worker parses; the
 * host maps. The mapping functions are other lanes' (L2 Amazon, L3 eBay) — replaced here by recording stubs so this
 * suite pins only the door: which reader runs, on which thread, with which of the Owner's decisions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { ooxmlWorkbook, amazonTemplateSheets, ATTRIBUTE_SHEET_HEADERS, EBAY_HEADERS } from './catalog-transfer-test/channel-file-fixtures.js'
import { csvOf, SHOPIFY_INVENTORY_HEADERS, shopifySampleCsv } from './catalog-transfer-test/shopify-csv-fixtures.js'

const calls = vi.hoisted(() => ({ sessions: 0, reads: [] as { filename: string; options: unknown }[], amazon: [] as { parsed: any; options: any }[], ebay: [] as { table: any; options: any }[], drawerEbay: [] as { table: any; productId: string; options: any }[], shopify: [] as { table: any; options: any }[] }))
vi.mock('./workbook-parse.js', async importOriginal => {
  const real = await importOriginal<typeof import('./workbook-parse.js')>()
  return { ...real, openWorkbookParser: (options: Parameters<typeof real.openWorkbookParser>[0]) => {
    calls.sessions++
    const session = real.openWorkbookParser(options)
    return { ...session, read: (filename: string, bytes: Buffer, budget: number, partOptions?: unknown) => { calls.reads.push({ filename, options: partOptions }); return session.read(filename, bytes, budget, partOptions as never) } }
  } }
})
vi.mock('./catalog-amazon-workbook.js', () => ({ resolveAmazonCatalogWorkbook: async (parsed: unknown, options: unknown) => { calls.amazon.push({ parsed, options }); return { rows: [], issues: [], exclusions: [], warnings: [] } } }))
vi.mock('./catalog-ebay-workbook.js', async importOriginal => ({ ...await importOriginal<object>(),
  resolveEbayCatalogWorkbook: async (table: unknown, options: unknown) => { calls.ebay.push({ table, options }); return { rows: [], issues: [], exclusions: [] } },
  resolveEbayWorkbook: async (table: unknown, productId: string, options: unknown) => { calls.drawerEbay.push({ table, productId, options }); return { rows: [], issues: [], exclusions: [] } } }))

vi.mock('./catalog-shopify-csv.js', async importOriginal => ({ ...await importOriginal<object>(),
  resolveShopifyCsv: async (table: unknown, options: unknown) => { calls.shopify.push({ table, options }); return { rows: [], issues: [], exclusions: [], ledger: [], links: [], warnings: [], accountId: 'store' } } }))

// The product group's listings, as `productTransferOptions` reports them — the drawer's only marketplace evidence.
const group = vi.hoisted(() => ({ ebayMarkets: [] as string[] }))
vi.mock('./catalog-product-transfer.js', async importOriginal => ({ ...await importOriginal<object>(),
  productTransferOptions: async (productId: string) => ({ productId, rootId: productId, products: [], locales: [], accounts: [], markets: [], familyId: null,
    listings: group.ebayMarkets.map((marketplace, i) => ({ id: `l${i}`, productId, channel: 'EBAY', accountId: 'ebay', marketplace, aliasKey: '', aliasLabel: 'Primary listing' })) }) }))
const { readCatalogTransferUpload, readEditorTransfer } = await import('./catalog-editor-workbook.js')
afterEach(() => { calls.sessions = 0; calls.reads.length = 0; calls.amazon.length = 0; calls.ebay.length = 0; calls.drawerEbay.length = 0; calls.shopify.length = 0; group.ebayMarkets = [] })

describe('the catalog page reads every workbook on the parse worker, by what it is', () => {
  it('reads an Amazon template chosen as "Nexus workbook" as an Amazon template, and says so', async () => {
    const file = await ooxmlWorkbook({ sheets: amazonTemplateSheets(), sharedStrings: true })
    const parsed = await readCatalogTransferUpload(file, 'GALE IT.xlsx', { format: 'catalog', market: 'IT', accountId: 'acct', mode: 'update', links: { 'MOSS-JACKET': 'IT-MOSS-JACKET' }, confirmDeletes: true })
    expect(calls.sessions).toBe(1)
    expect(calls.amazon).toHaveLength(1)
    expect(calls.amazon[0].parsed.meta).toMatchObject({ marketplace: 'IT', contentLanguageTag: 'it_IT', sheet: 'Modello' })
    expect(calls.amazon[0].options).toMatchObject({ accountId: 'acct', marketplace: 'IT', mode: 'update', links: { 'MOSS-JACKET': 'IT-MOSS-JACKET' }, confirmDeletes: true })
    expect(parsed.warnings).toEqual([expect.stringMatching(/is an Amazon template \(IT, it_IT\); it was read as one/)])
  })

  it('reads the same template as .xlsm, with no warning when "Amazon template" was chosen', async () => {
    const parsed = await readCatalogTransferUpload(await ooxmlWorkbook({ sheets: amazonTemplateSheets() }), 'GALE IT.xlsm', { format: 'amazon', market: 'IT', accountId: 'acct', mode: 'upsert', familyId: 'fam' })
    expect(calls.amazon[0].options).toMatchObject({ familyId: 'fam', mode: 'upsert' })
    expect(parsed.warnings ?? []).toEqual([])
  })

  it('reads our eBay workbook on the catalog page (it was refused as "Unknown worksheet")', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it')
    sheet.addRow(EBAY_HEADERS); sheet.addRow(['AIREON', '', 'parent', '', '123456789012', '', '', 'Giacca', '1000', '177104', 'Colore,Taglia', '99', '5'])
    const parsed = await readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'AIREON IT.xlsx', { format: 'catalog', market: 'IT', mode: 'update', links: { A: 'B' }, confirmDeletes: true })
    expect(calls.ebay).toHaveLength(1)
    expect(calls.ebay[0].table).toMatchObject({ sheet: 'ebay_it', marketplace: 'IT' })
    expect(calls.ebay[0].options).toMatchObject({ market: 'IT', links: { A: 'B' }, confirmDeletes: true })
    expect(parsed.warnings).toEqual([expect.stringMatching(/is an eBay workbook \(sheet "ebay_it"\)/)])
  })

  it('passes the "Blank cells" choice to the worker', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products')
    sheet.addRow(['sku', 'field', 'action', 'value']); sheet.addRow(['GALE-JACKET', 'name', 'SET', 'Gale jacket'])
    const parsed = await readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'rows.xlsx', { format: 'catalog', market: 'IT', mode: 'update', blankPolicy: 'clear' })
    expect(calls.reads).toEqual([{ filename: 'rows.xlsx', options: { blankPolicy: 'clear', market: 'IT' } }])
    expect(parsed.rows).toMatchObject([{ sku: 'GALE-JACKET', field: 'name', value: 'Gale jacket' }])
  })

  it('reads a CSV without a worker and without ExcelJS', async () => {
    const parsed = await readCatalogTransferUpload(Buffer.from('entity,sku,channel,accountId,marketplace,aliasKey,locale,field,action,format,value,version\nProducts,GALE-JACKET,,,,,,name,SET,text,Gale,\n'), 'rows.csv', { market: 'IT', mode: 'update' })
    expect(calls.sessions).toBe(0)
    expect(parsed.rows).toHaveLength(1)
  })

  it('NCF — reads Shopify’s product CSV on the parse worker, by its header, whatever File type was chosen', async () => {
    const parsed = await readCatalogTransferUpload(shopifySampleCsv(), 'products_export_1.csv', { format: 'catalog', market: '', mode: 'update', accountId: 'store', links: { 'acme-jacket': 'ACME-JACKET' } })
    expect(calls.sessions).toBe(1)
    expect(calls.reads.map(r => r.filename)).toEqual(['products_export_1.csv'])
    expect(calls.shopify).toHaveLength(1)
    expect(calls.shopify[0].table.records).toHaveLength(7)
    expect(calls.shopify[0].options).toEqual({ accountId: 'store', links: { 'acme-jacket': 'ACME-JACKET' } })
    expect(parsed.market).toBe('GLOBAL')
    expect(parsed.warnings).toEqual(['products_export_1.csv is Shopify’s product CSV; it was read as one, not as a Nexus file.'])
  })

  it('NCF — the product sheet reads Shopify’s product CSV on the worker for its own product group', async () => {
    const parsed = await readEditorTransfer(shopifySampleCsv(), 'products_export_1.csv', 'p1', 'owner', undefined, { links: { a: 'b' } })
    expect(calls.shopify[0].options).toEqual({ productId: 'p1', links: { a: 'b' } })
    expect(parsed.kinds).toEqual(['shopify'])
  })

  it('NCF — refuses Shopify’s inventory CSV with the stock sentence, without a worker', async () => {
    await expect(readCatalogTransferUpload(csvOf(SHOPIFY_INVENTORY_HEADERS, [{ Handle: 'a', SKU: 'b', Location: 'Shop' }]), 'inventory_export_1.csv', { market: 'IT', mode: 'update' }))
      .rejects.toThrow('inventory_export_1.csv is Shopify’s inventory CSV (quantities by location). Nexus never imports stock from a file')
    expect(calls.sessions).toBe(0)
  })

  it('sends the Amazon attribute sheet to "Map a source file"', async () => {
    await expect(readCatalogTransferUpload(await ooxmlWorkbook({ sheets: [{ name: 'amazon_OUTERWEAR_IT', rows: { 1: ATTRIBUTE_SHEET_HEADERS } }] }), 'amazon_OUTERWEAR_IT.xlsx', { format: 'catalog', market: 'IT', mode: 'update' }))
      .rejects.toThrow(/Map a source file/)
  })
})

describe('the product-sheet drawer accepts Amazon templates', () => {
  it('reads a .xlsm Amazon template for its product group, with the Owner’s decisions, as a verified (editing) part', async () => {
    const parsed = await readEditorTransfer(await ooxmlWorkbook({ sheets: amazonTemplateSheets(), sharedStrings: true }), 'GALE IT.xlsm', 'product-1', null, undefined, { links: { X: 'Y' }, confirmDeletes: true })
    expect(calls.amazon).toHaveLength(1)
    expect(calls.amazon[0].options).toEqual({ productId: 'product-1', mode: 'update', links: { X: 'Y' }, confirmDeletes: true })
    expect(parsed.editing).toBe(true)
    expect(parsed.warnings ?? []).not.toContainEqual(expect.stringMatching(/legacy workbook/))
  })

  it('passes the Owner’s decisions to the eBay reader too, including a per-SKU delete list, unchanged', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it')
    sheet.addRow(EBAY_HEADERS); sheet.addRow(['AIREON', 'End', 'parent', '', '123456789012', '', '', 'Giacca', '1000', '177104', 'Colore,Taglia', '99', '5'])
    await readEditorTransfer(Buffer.from(await book.xlsx.writeBuffer()), 'AIREON IT.xlsx', 'product-1', null, undefined, { links: { 'AIREON-ALT1': 'AIREON' }, confirmDeletes: ['AIREON'] })
    expect(calls.drawerEbay).toHaveLength(1)
    expect(calls.drawerEbay[0]).toMatchObject({ productId: 'product-1', options: { links: { 'AIREON-ALT1': 'AIREON' }, confirmDeletes: ['AIREON'] } })
  })
})

describe('the catalog page gives the eBay reader its chosen marketplace', () => {
  it('reads a family-named eBay sheet whose file name states no market, using the chosen marketplace', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('AIREON')
    sheet.addRow(EBAY_HEADERS); sheet.addRow(['AIREON', '', 'parent', '', '', '', '', 'Giacca', '1000', '177104', 'Size,Color', '99', '5'])
    await readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'AIREON.xlsx', { format: 'catalog', market: 'DE', mode: 'update', confirmDeletes: ['AIREON'] })
    expect(calls.ebay[0].table).toMatchObject({ sheet: 'AIREON', marketplace: 'DE' })
    expect(calls.ebay[0].options).toMatchObject({ market: 'DE', confirmDeletes: ['AIREON'] })
  })

})

describe('the drawer names the eBay marketplace from its own listings', () => {
  const familySheet = async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('AIREON')
    sheet.addRow(EBAY_HEADERS); sheet.addRow(['AIREON', '', 'parent', '', '', '', '', 'Giacca', '1000', '177104', 'Size,Color', '99', '5'])
    return Buffer.from(await book.xlsx.writeBuffer())
  }
  it('reads a family-named eBay sheet as the one marketplace this product group sells on', async () => {
    group.ebayMarkets = ['IT', 'IT']
    await readEditorTransfer(await familySheet(), 'AIREON.xlsx', 'product-1', null)
    expect(calls.drawerEbay[0].table).toMatchObject({ sheet: 'AIREON', marketplace: 'IT' })
  })
  it('assumes nothing when the group sells on eBay in two marketplaces — the refusal names the choice', async () => {
    group.ebayMarkets = ['IT', 'DE']
    await expect(readEditorTransfer(await familySheet(), 'AIREON.xlsx', 'product-1', null)).rejects.toThrow(/Choose the eBay marketplace/)
    expect(calls.drawerEbay).toHaveLength(0)
  })

})

describe('an empty marketplace means "the file’s own" — for channel files only', () => {
  it('reads an Amazon template with no chosen marketplace as the template’s own', async () => {
    const parsed = await readCatalogTransferUpload(await ooxmlWorkbook({ sheets: amazonTemplateSheets() }), 'GALE IT.xlsm', { format: 'amazon', market: '', accountId: 'acct', mode: 'update' })
    expect(calls.amazon[0].options.marketplace).toBeUndefined()
    expect(parsed.market).toBe('IT')
  })
  it('reads an eBay workbook with no chosen marketplace as its sheet’s, and refuses a sheet that states none', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it')
    sheet.addRow(EBAY_HEADERS); sheet.addRow(['AIREON', '', 'parent', '', '', '', '', 'Giacca', '1000', '177104', 'Colore,Taglia', '99', '5'])
    const parsed = await readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'AIREON.xlsx', { format: 'catalog', market: '', mode: 'update' })
    expect(parsed.market).toBe('IT')
    expect(calls.ebay[0].options.market).toBeUndefined()
    const family = new ExcelJS.Workbook(), named = family.addWorksheet('AIREON')
    named.addRow(EBAY_HEADERS); named.addRow(['AIREON', '', 'parent', '', '', '', '', 'Giacca', '1000', '177104', 'Size,Color', '99', '5'])
    await expect(readCatalogTransferUpload(Buffer.from(await family.xlsx.writeBuffer()), 'AIREON.xlsx', { format: 'catalog', market: '', mode: 'update' })).rejects.toThrow(/Choose the eBay marketplace/)
  })
  it('still requires a marketplace for a Nexus workbook and a CSV', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Products')
    sheet.addRow(['sku', 'field', 'action', 'value']); sheet.addRow(['GALE-JACKET', 'name', 'SET', 'Gale jacket'])
    await expect(readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'rows.xlsx', { format: 'catalog', market: '', mode: 'update' })).rejects.toThrow('Select a marketplace for the attribute dictionary')
    await expect(readCatalogTransferUpload(Buffer.from('entity,sku\n'), 'rows.csv', { market: '', mode: 'update' })).rejects.toThrow('Select a marketplace for the attribute dictionary')
    expect((await readCatalogTransferUpload(Buffer.from(await book.xlsx.writeBuffer()), 'rows.xlsx', { format: 'catalog', market: 'IT', mode: 'update' })).market).toBe('IT')
  })
})

/**
 * CFI-5 / CFI-6 (R-CFI-1) — our eBay workbooks "as is", for every family and both shapes the Owner holds.
 * Fixtures are built here in memory; the Owner's own files are never read by a test.
 */
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { checkEbayLedger, mapEbayWorkbook, planEbayGroups, readEbayWorkbook, type EbayWorkbookResult, type EbayWorkbookTable, type EbayWorkbookTarget } from './catalog-ebay-workbook.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'

const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [
  { id: 'aspect_Brand', label: 'Marca', localizedName: 'Marca', englishName: 'Brand', cardinality: 'SINGLE' },
  { id: 'aspect_Season', label: 'Stagione', localizedName: 'Stagione', englishName: 'Season', kind: 'enum', enumMode: 'strict', options: ['Estate', 'Inverno', 'Tutte le stagione'] },
  { id: 'aspect_Colour', label: 'Colore', localizedName: 'Colore', englishName: 'Color', kind: 'enum', enumMode: 'strict', options: ['Nero', 'Giallo'] },
] })
const specs = new Map([['177104', spec]])

/** The root-file shape: sheet named by the family, Category ID only on the parent, two price columns, no Item IDs. */
const ROOT_HEADERS = ['SKU', 'Parent/Child', 'Parent SKU', 'Title', 'Category ID', 'Variation Theme', 'Price (EUR)', 'Quantity', 'Weight', 'Wt Unit', 'Image 1', 'Image 2', 'Listing Status', 'Marca (Brand) *', 'Stagione (Season)', 'Colore (Color) ↕', 'Price (€)', 'Qty', 'Item ID', 'Status', 'Listing ID']
function rootBook(sheetName = 'FAMILYX', mutate?: (rows: Record<string, string>[]) => void) {
  const rows: Record<string, string>[] = [
    { SKU: 'ROOT', 'Parent/Child': 'parent', Title: 'Giacca', 'Category ID': '177104', 'Variation Theme': 'Size,Color', 'Price (EUR)': '0', Quantity: '0', 'Listing Status': 'DRAFT', 'Marca (Brand) *': 'XAVIA', 'Stagione (Season)': 'Tutte le stagione' },
    { SKU: 'ROOT-BLACK-M', 'Parent/Child': 'child', 'Parent SKU': 'ROOT', Title: 'Giacca M', 'Price (EUR)': '139', 'Price (€)': '139', Quantity: '3', Weight: '1.2', 'Wt Unit': 'KILOGRAM', 'Image 1': 'https://x/1.jpg', 'Image 2': 'https://x/2.jpg', 'Colore (Color) ↕': 'nero', 'Stagione (Season)': 'Tutte le stagioni', Qty: '3' },
    { SKU: 'ROOT-BLACK-L', 'Parent/Child': 'child', 'Parent SKU': 'ROOT', Title: 'Giacca L', 'Price (EUR)': '139', 'Price (€)': '139' },
  ]
  mutate?.(rows)
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet(sheetName)
  sheet.addRow(ROOT_HEADERS)
  for (const r of rows) sheet.addRow(ROOT_HEADERS.map(h => r[h] ?? ''))
  return book
}
const target = (sku: string, over: Partial<EbayWorkbookTarget> = {}): EbayWorkbookTarget => ({ id: `listing-${sku}`, sku, parentSku: 'ROOT', sourceParentSku: 'ROOT', isParent: sku === 'ROOT', itemId: '257000000001', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 7, ...over })
const rootTargets = () => ['ROOT', 'ROOT-BLACK-M', 'ROOT-BLACK-L'].map(sku => target(sku))
const mapRoot = (book = rootBook(), targets = rootTargets(), options = {}) => {
  const table = readEbayWorkbook(book, { filename: 'XAVIA-eBay-IT-FAMILYX.xlsx' })!
  return { table, result: mapEbayWorkbook(table, targets, specs, options) }
}
const ledgerClean = (table: EbayWorkbookTable, result: EbayWorkbookResult) => {
  const check = checkEbayLedger(table, result)
  expect(check).toEqual({ unaccounted: [], duplicated: [], danglingRows: [], phantom: [] })
}

describe('recognition — by the identity headers, never the sheet name', () => {
  it('reads a sheet named by the family and takes the market from the file name', () => {
    const table = readEbayWorkbook(rootBook(), { filename: 'XAVIA-eBay-IT-FAMILYX.xlsx' })!
    expect(table).toMatchObject({ sheet: 'FAMILYX', marketplace: 'IT', marketplaceFrom: 'filename' })
    expect(table.records).toHaveLength(3)
  })
  it('takes the market from the caller when neither the sheet nor the file states it, and refuses to guess', () => {
    expect(readEbayWorkbook(rootBook(), { market: 'de' })).toMatchObject({ marketplace: 'DE', marketplaceFrom: 'hint' })
    expect(() => readEbayWorkbook(rootBook(), { filename: 'upload.xlsx' })).toThrow('Choose the eBay marketplace')
  })
  it('ignores a workbook without the eBay identity headers', () => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('Products').addRow(['sku', 'name'])
    expect(readEbayWorkbook(book, { market: 'IT' })).toBeNull()
  })
})

describe('matching — blank Item IDs and the parent-only category', () => {
  it('matches a blank Item ID by SKU and parent, and lets variations inherit the parent category', () => {
    const { table, result } = mapRoot()
    expect(result.issues).toEqual([])
    expect(new Set(result.rows.map(r => r.sku))).toEqual(new Set(['ROOT', 'ROOT-BLACK-M', 'ROOT-BLACK-L']))
    expect(result.rows.find(r => r.sku === 'ROOT-BLACK-L' && r.field === 'title')?.value).toBe('Giacca L')
    ledgerClean(table, result)
  })
  it('refuses a present Item ID that differs from the one Nexus holds, and says the file may be older', () => {
    const { result } = mapRoot(rootBook('FAMILYX', rows => { rows[1]['Item ID'] = '257999999999' }))
    expect(result.issues).toEqual([expect.objectContaining({ row: 3, field: 'Item ID', message: expect.stringContaining('differs from the Item ID Nexus holds') })])
    expect(result.rows.some(r => r.row === 3)).toBe(false)
  })
  it('says a SKU is not a Nexus product when it is not, instead of blaming a missing listing', () => {
    const table = readEbayWorkbook(rootBook(), { filename: 'XAVIA-eBay-IT-FAMILYX.xlsx' })!
    const result = mapEbayWorkbook(table, rootTargets().filter(t => t.sku !== 'ROOT-BLACK-L'), specs, { knownSkus: new Set(['ROOT', 'ROOT-BLACK-M']) })
    expect(result.issues).toEqual([expect.objectContaining({ row: 4, field: 'SKU', message: expect.stringContaining('ROOT-BLACK-L is not a Nexus product') })])
    ledgerClean(table, result)
  })
  it('names the adopt step when a listing is not in Nexus', () => {
    const { table, result } = mapRoot(undefined, rootTargets().filter(t => t.sku !== 'ROOT-BLACK-L'))
    expect(result.issues).toEqual([expect.objectContaining({ row: 4, message: expect.stringContaining('pes5-adopt-shells') })])
    ledgerClean(table, result)
  })
})

describe('values — every row is channel-file, versioned, and nothing is lost', () => {
  it('marks every row channel-file with the listing version', () => {
    const { result } = mapRoot()
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows.every(r => r.origin === 'channel-file' && r.version === 7)).toBe(true)
  })
  it('imports a variation price; a multi-variation parent has none; agreeing price columns give one row', () => {
    const { table, result } = mapRoot()
    expect(result.rows.filter(r => r.field === 'price')).toEqual([
      expect.objectContaining({ sku: 'ROOT-BLACK-M', value: 139, entity: 'Overrides' }), expect.objectContaining({ sku: 'ROOT-BLACK-L', value: 139 }),
    ])
    expect(result.exclusions.find(e => e.sku === 'ROOT' && e.field === 'Price (EUR)')?.message).toContain('multi-variation parent')
    expect(result.ledger.filter(e => e.row === 3 && e.field === 'price').map(e => e.header)).toEqual(['Price (EUR)', 'Price (€)'])
    ledgerClean(table, result)
  })
  it('refuses disagreeing price columns and excludes a zero price', () => {
    const { result } = mapRoot(rootBook('FAMILYX', rows => { rows[1]['Price (€)'] = '129'; rows[2]['Price (EUR)'] = '0'; rows[2]['Price (€)'] = '' }))
    expect(result.issues.filter(i => i.row === 3).map(i => i.field)).toEqual(['Price (EUR)', 'Price (€)'])
    expect(result.exclusions.find(e => e.row === 4 && e.field === 'Price (EUR)')?.message).toContain('not a selling price')
    expect(result.rows.some(r => r.field === 'price')).toBe(false)
  })
  it('never imports quantity, and keeps the file value in the reason', () => {
    const { result } = mapRoot()
    expect(result.rows.some(r => /quantity/i.test(r.field))).toBe(false)
    expect(result.exclusions.find(e => e.row === 3 && e.field === 'Quantity')?.message).toMatch(/one number for every EU market.*File value: 3/)
  })
  it('folds a later image into the ordered list and the weight unit into the measure', () => {
    const { table, result } = mapRoot()
    expect(result.rows.find(r => r.row === 3 && r.field === 'imageUrls')?.value).toEqual(['https://x/1.jpg', 'https://x/2.jpg'])
    expect(result.rows.find(r => r.row === 3 && r.field === 'packageWeight')?.value).toEqual({ value: 1.2, unit: 'KILOGRAM' })
    expect(result.ledger.find(e => e.row === 3 && e.header === 'Wt Unit')).toMatchObject({ outcome: 'row', field: 'packageWeight' })
    ledgerClean(table, result)
  })
  it('uses eBay’s own spelling for a choice that differs only in case or accents, and keeps any other value with a warning', () => {
    const { result } = mapRoot()
    expect(result.rows.find(r => r.row === 3 && r.field === 'color')?.value).toBe('Nero')
    expect(result.rows.find(r => r.row === 3 && r.field === 'season')?.value).toBe('Tutte le stagioni')
    expect(result.warnings).toEqual([expect.stringContaining('"Tutte le stagioni" is not one of eBay\'s choices')])
    expect(result.issues).toEqual([])
  })
})

describe('custom item specifics (⚠) — stored where the listing already keeps them', () => {
  const withCustom = (header: string, value: string) => {
    const book = rootBook(), sheet = book.worksheets[0]
    sheet.getCell(1, ROOT_HEADERS.length + 1).value = header
    sheet.getCell(3, ROOT_HEADERS.length + 1).value = value
    return book
  }
  it('imports a ⚠ column as a seller-defined item specific, keeping the stored spelling', () => {
    const targets = rootTargets().map(t => ({ ...t, specificNames: ['Athlete', 'Marca'] }))
    const { table, result } = mapRoot(withCustom('athlete ⚠', 'Unisex'), targets)
    expect(result.rows.find(r => r.row === 3 && r.field === 'itemSpecifics.Athlete')?.value).toBe('Unisex')
    ledgerClean(table, result)
    // No stored spelling yet: the ⚠ marker alone makes it a seller-defined specific, named as the file names it.
    expect(mapRoot(withCustom('team name ⚠', 'Ducati')).result.rows.find(r => r.row === 3 && r.field === 'itemSpecifics.team name')?.value).toBe('Ducati')
  })
  it('imports an unmarked non-schema column as the seller’s own specific, keeping a stored spelling, with a warning', () => {
    const stored = mapRoot(withCustom('genere', 'Uomo'), rootTargets().map(t => ({ ...t, specificNames: ['Genere'] }))).result
    expect(stored.rows.find(r => r.field === 'itemSpecifics.Genere')?.value).toBe('Uomo')
    const { table, result } = mapRoot(withCustom('Colore esatto', 'Nero opaco'))
    expect(result.issues).toEqual([])
    expect(result.rows.find(r => r.row === 3 && r.field === 'itemSpecifics.Colore esatto')?.value).toBe('Nero opaco')
    expect(result.warnings).toContain("Colore esatto: not in eBay's current category requirements; kept as the seller's own specific.")
    ledgerClean(table, result)
  })
  it('keeps a product identifier column out, with its value, unless the category declares it', () => {
    const { table, result } = mapRoot(withCustom('EAN', '8051234567890'))
    expect(result.rows.some(r => r.field.includes('EAN'))).toBe(false)
    expect(result.exclusions.find(e => e.row === 3 && e.field === 'EAN')?.message).toContain('File value: 8051234567890')
    ledgerClean(table, result)
  })
})

describe('lifecycle — a delete is never applied unconfirmed; other actions are not imported', () => {
  const withAction = (action: string) => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it'), headers = ['SKU', 'Action', 'Parent/Child', 'Parent SKU', 'Title', 'Category ID', 'Item ID']
    sheet.addRow(headers)
    sheet.addRow(['ROOT', '', 'parent', '', 'Giacca', '177104', '257000000001'])
    sheet.addRow(['ROOT-BLACK-M', action, 'child', 'ROOT', 'Giacca M', '177104', '257000000001'])
    return readEbayWorkbook(book)!
  }
  it('turns an unconfirmed delete into ONE presence issue and imports nothing from that row', () => {
    const table = withAction('End'), result = mapEbayWorkbook(table, rootTargets(), specs)
    expect(result.issues).toEqual([expect.objectContaining({ row: 3, field: 'presence', message: expect.stringContaining('Confirm deletes') })])
    expect(result.rows.some(r => r.row === 3)).toBe(false)
    ledgerClean(table, result)
  })
  it('marks a confirmed delete ENDED and imports none of the row’s other values', () => {
    const table = withAction('Elimina'), result = mapEbayWorkbook(table, rootTargets(), specs, { confirmDeletes: true })
    expect(result.rows.filter(r => r.row === 3)).toEqual([expect.objectContaining({ entity: 'Listings', field: 'presence', value: 'ENDED', origin: 'channel-file', sku: 'ROOT-BLACK-M' })])
    expect(result.exclusions.filter(e => e.row === 3).map(e => e.field)).toEqual(['SKU', 'Parent/Child', 'Parent SKU', 'Title', 'Category ID', 'Item ID'])
    ledgerClean(table, result)
  })
  it('confirms only the listed delete rows when confirmDeletes is a list', () => {
    const table = withAction('End')
    table.records.push({ row: 4, values: { SKU: 'ROOT-BLACK-L', Action: 'End', 'Parent/Child': 'child', 'Parent SKU': 'ROOT', Title: 'Giacca L', 'Category ID': '177104', 'Item ID': '257000000001' } })
    const result = mapEbayWorkbook(table, rootTargets(), specs, { confirmDeletes: ['ROOT-BLACK-L'] })
    expect(result.rows.filter(r => r.field === 'presence').map(r => r.sku)).toEqual(['ROOT-BLACK-L'])
    expect(result.issues).toEqual([expect.objectContaining({ row: 3, field: 'presence' })])
    expect(mapEbayWorkbook(table, rootTargets(), specs, { confirmDeletes: true }).rows.filter(r => r.field === 'presence')).toHaveLength(2)
    ledgerClean(table, result)
  })
  it('confirms by the FILE SKU only: naming the primary listing does not confirm its adopted alias, and the issue names the listing', () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it'), headers = ['SKU', 'Action', 'Parent/Child', 'Parent SKU', 'Title', 'Category ID', 'Item ID']
    sheet.addRow(headers)
    sheet.addRow(['ROOT', 'End', 'parent', '', 'Giacca', '177104', '257000000001'])
    sheet.addRow(['ROOT-ALT1', 'End', 'parent', '', 'Giacca 2', '177104', '257000000002'])
    const table = readEbayWorkbook(book)!
    const targets = [target('ROOT'), target('ROOT', { id: 'listing-alias', sourceParentSku: 'ROOT-ALT1', itemId: '257000000002', aliasKey: 'alias-1' })]
    const result = mapEbayWorkbook(table, targets, specs, { confirmDeletes: ['ROOT'] })
    expect(result.rows.filter(r => r.field === 'presence')).toEqual([expect.objectContaining({ row: 2, aliasKey: '' })])
    expect(result.issues).toEqual([expect.objectContaining({ row: 3, field: 'presence', sku: 'ROOT', fileSku: 'ROOT-ALT1', channel: 'EBAY', marketplace: 'IT', accountId: 'seller-a', aliasKey: 'alias-1' })])
    ledgerClean(table, result)
  })
  it('excludes any other lifecycle action with its value', () => {
    const table = withAction('Revise'), result = mapEbayWorkbook(table, rootTargets(), specs)
    expect(result.exclusions.find(e => e.field === 'Action')?.message).toContain('Revise')
    expect(result.rows.find(r => r.row === 3 && r.field === 'title')?.value).toBe('Giacca M')
  })
})

describe('one row per listing', () => {
  it('refuses EVERY row that names the same listing, so no copy can be applied as the ready one', () => {
    const { table, result } = mapRoot(rootBook('FAMILYX', rows => { rows.push({ ...rows[1], Title: 'Giacca M (copy)' }) }))
    expect(result.issues.filter(i => i.sku === 'ROOT-BLACK-M').map(i => i.row)).toEqual([3, 5])
    expect(result.issues[0].message).toContain('Duplicate rows 3, 5')
    expect(result.rows.some(r => r.sku === 'ROOT-BLACK-M')).toBe(false)
    expect(result.ledger.filter(e => e.sku === 'ROOT-BLACK-M').every(e => e.outcome === 'refused')).toBe(true)
    ledgerClean(table, result)
  })
})

describe('the ledger is an independent zero-loss check', () => {
  it('reports a cell the mapper did not decide, a duplicate decision and a row entry with no row', () => {
    const { table, result } = mapRoot()
    const dropped = { ...result, ledger: result.ledger.slice(1) }
    expect(checkEbayLedger(table, dropped).unaccounted).toHaveLength(1)
    const doubled = { ...result, ledger: [...result.ledger, result.ledger[0]] }
    expect(checkEbayLedger(table, doubled).duplicated).toHaveLength(1)
    const rowEntry = result.ledger.findIndex(e => e.outcome === 'row')
    const orphan = { ...result, rows: result.rows.filter(r => !(r.row === result.ledger[rowEntry].row && r.field === result.ledger[rowEntry].field)) }
    expect(checkEbayLedger(table, orphan).danglingRows.length).toBeGreaterThan(0)
  })
})

describe('product groups — a Nexus root, an adopted shell, a confirmed link, or a proposal', () => {
  type P = { id: string; sku: string; parentId: string | null; productType: string | null; deletedAt: Date | null }
  const fakeDb = (products: P[], aliases: { productId: string; adoptedFromProductId: string; status: string }[] = []) => ({
    product: { findMany: async ({ where }: any) => products.filter(p => (where.sku ? where.sku.in.includes(p.sku) : where.id.in.includes(p.id)) && (where.deletedAt === null ? !p.deletedAt : true)) },
    productListingAlias: { findMany: async ({ where }: any) => aliases.filter(a => where.adoptedFromProductId.in.includes(a.adoptedFromProductId) && a.status === where.status) },
  }) as any
  const table = (parent: string, children: string[]): EbayWorkbookTable => ({ sheet: 'ebay_it', marketplace: 'IT', headers: ['SKU', 'Parent/Child', 'Parent SKU', 'Category ID', 'Title'], records: [
    { row: 2, values: { SKU: parent, 'Parent/Child': 'parent', 'Parent SKU': '', 'Category ID': '177104', Title: 'P' } },
    ...children.map((sku, i) => ({ row: 3 + i, values: { SKU: sku, 'Parent/Child': 'child', 'Parent SKU': parent, 'Category ID': '177104', Title: sku } })),
  ] })
  const empty = (): EbayWorkbookResult => ({ rows: [], issues: [], exclusions: [], ledger: [], links: [], warnings: [] })
  const nexus: P[] = [
    { id: 'r1', sku: 'NEXUS-ROOT', parentId: null, productType: 'OUTERWEAR', deletedAt: null },
    { id: 'c1', sku: 'KID-M', parentId: 'r1', productType: 'OUTERWEAR', deletedAt: null },
    { id: 'c2', sku: 'KID-L', parentId: 'r1', productType: 'OUTERWEAR', deletedAt: null },
    { id: 's1', sku: 'NEXUS-ROOT-ALT1', parentId: null, productType: 'EBAY_LISTING_SHELL', deletedAt: null },
  ]
  it('places a file parent that is a Nexus root', async () => {
    const out = empty(), t = table('NEXUS-ROOT', ['KID-M'])
    expect((await planEbayGroups(fakeDb(nexus), t, out, {})).map(g => [g.rootSku, g.records.length])).toEqual([['NEXUS-ROOT', 2]])
    expect(out.issues).toEqual([])
  })
  it('refuses an unadopted legacy shell and names the adopt step; an adopted one joins its product', async () => {
    const out = empty(), t = table('NEXUS-ROOT-ALT1', ['KID-M'])
    expect(await planEbayGroups(fakeDb(nexus), t, out, {})).toEqual([])
    expect(out.issues.every(i => i.message.includes('pes5-adopt-shells'))).toBe(true)
    ledgerClean(t, out)
    const adopted = nexus.map(p => p.id === 's1' ? { ...p, deletedAt: new Date() } : p)
    const groups = await planEbayGroups(fakeDb(adopted, [{ productId: 'r1', adoptedFromProductId: 's1', status: 'ACTIVE' }]), t, empty(), {})
    expect(groups.map(g => g.rootSku)).toEqual(['NEXUS-ROOT'])
  })
  it('matches an adopted shell by its SKU even when the shell product is soft-deleted and untyped — no proposal', async () => {
    const soft: P[] = [...nexus.filter(p => p.id !== 's1'), { id: 's2', sku: 'LEGACY-ALT1', parentId: null, productType: null, deletedAt: new Date() }]
    const out = empty(), t = table('LEGACY-ALT1', ['KID-M'])
    const groups = await planEbayGroups(fakeDb(soft, [{ productId: 'r1', adoptedFromProductId: 's2', status: 'ACTIVE' }]), t, out, {})
    expect(groups.map(g => [g.rootSku, g.records.length])).toEqual([['NEXUS-ROOT', 2]])
    expect(out.links).toEqual([])
    expect(out.issues).toEqual([])
  })
  it('PROPOSES a link from the children and imports nothing until it is confirmed', async () => {
    const out = empty(), t = table('FILE-PARENT', ['KID-M', 'KID-L', 'NEW-KID'])
    expect(await planEbayGroups(fakeDb(nexus), t, out, {})).toEqual([])
    expect(out.links).toEqual([{ fileSku: 'FILE-PARENT', proposedSku: 'NEXUS-ROOT', reason: expect.stringContaining('2 of 3') }])
    expect(out.issues).toHaveLength(4)
    ledgerClean(t, out)
    const confirmed = await planEbayGroups(fakeDb(nexus), t, empty(), { links: { 'FILE-PARENT': 'NEXUS-ROOT' } })
    expect(confirmed[0].records[0]).toMatchObject({ fileSku: 'FILE-PARENT', values: { SKU: 'NEXUS-ROOT' } })
    expect(confirmed[0].records[1]).toMatchObject({ values: { 'Parent SKU': 'NEXUS-ROOT' } })
  })
  it('keeps the file SKU on a confirmed link and records it as the listing’s channel SKU', async () => {
    const t = table('FILE-PARENT', ['KID-M'])
    const [group] = await planEbayGroups(fakeDb(nexus), t, empty(), { links: { 'FILE-PARENT': 'NEXUS-ROOT' } })
    const sub = { ...t, records: group.records }
    const targets: EbayWorkbookTarget[] = [
      { id: 'L-root', sku: 'NEXUS-ROOT', parentSku: 'NEXUS-ROOT', sourceParentSku: 'NEXUS-ROOT', isParent: true, itemId: '', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 2 },
      { id: 'L-kid', sku: 'KID-M', parentSku: 'NEXUS-ROOT', sourceParentSku: 'NEXUS-ROOT', isParent: false, itemId: '', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 2 },
    ]
    const result = mapEbayWorkbook(sub, targets, specs)
    expect(result.rows.find(r => r.field === 'sellerSku')).toMatchObject({ entity: 'Listings', sku: 'NEXUS-ROOT', value: 'FILE-PARENT', fileSku: 'FILE-PARENT' })
    ledgerClean(t, result)
  })
  it('skips — does not refuse — rows of another product group in the drawer', async () => {
    const out = empty(), t = table('NEXUS-ROOT', ['KID-M'])
    expect(await planEbayGroups(fakeDb(nexus), t, out, {}, 'another-root')).toEqual([])
    expect(out.issues).toEqual([])
    expect(out.exclusions[0].message).toContain('Outside this product')
    expect(new Set(out.ledger.map(e => e.outcome))).toEqual(new Set(['skipped-row']))
  })
})

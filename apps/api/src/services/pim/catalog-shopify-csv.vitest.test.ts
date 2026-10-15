/**
 * NCF — Shopify's own product CSV: recognised from its header, read into a table, and routed on the parse worker.
 * A Nexus CSV reads exactly as before; Shopify's inventory export is refused (stock is never imported from a file).
 */
import { describe, expect, it } from 'vitest'
import { sniffCsv } from './channel-file-sniff.js'
import { readShopifyCsv, shopifyCsvShape } from './catalog-shopify-csv.js'
import { readTransferFile } from './catalog-transfer-file.js'
import { openWorkbookParser } from './workbook-parse.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_CURRENT_HEADERS, SHOPIFY_INVENTORY_HEADERS, SHOPIFY_SAMPLE_ROWS, shopifySampleCsv } from './catalog-transfer-test/shopify-csv-fixtures.js'

const NEXUS_CSV = Buffer.from('entity,sku,channel,accountId,marketplace,aliasKey,locale,field,action,format,value,version\nProducts,GALE-JACKET,,,,,,name,SET,text,"Gale, blue",\nOverrides,GALE-JACKET,EBAY,acct,IT,,,title,SET,text,Gale,3\n')
const refuseBaseline = async () => { throw new Error('no baseline in this suite') }

describe('NCF N2 — sniffCsv says what a CSV is from its header alone', () => {
  it('recognises Shopify’s product CSV under its classic and its current header names', () => {
    expect(sniffCsv(shopifySampleCsv())).toMatchObject({ kind: 'shopify-product-csv', delimiter: ',' })
    expect(sniffCsv(csvOf(SHOPIFY_CURRENT_HEADERS, []))).toMatchObject({ kind: 'shopify-product-csv' })
    // Re-saved by a European Excel: semicolons and a BOM.
    expect(sniffCsv(shopifySampleCsv({ delimiter: ';', bom: true, eol: '\r\n' }))).toMatchObject({ kind: 'shopify-product-csv', delimiter: ';' })
  })

  it('names Shopify’s inventory export as what it is', () => {
    expect(sniffCsv(csvOf(SHOPIFY_INVENTORY_HEADERS, [{ Handle: 'acme-jacket', SKU: 'ACME-JACKET-S', Location: 'Shop', 'On hand (current)': '4' }]))).toMatchObject({ kind: 'shopify-inventory-csv' })
  })

  it('names a Nexus attribute CSV, and anything else as other', () => {
    expect(sniffCsv(NEXUS_CSV)).toMatchObject({ kind: 'nexus-csv' })
    expect(sniffCsv(Buffer.from('Handle,Title\nacme,Acme\n'))).toMatchObject({ kind: 'other' })
    expect(sniffCsv(Buffer.from([0xff, 0x00, 0x22, 0x0a]))).toMatchObject({ kind: 'other' })
  })
})

describe('NCF N2 — readShopifyCsv', () => {
  it('reads every record in file order, with its record number and the file’s dialect', () => {
    const table = readShopifyCsv(shopifySampleCsv())
    expect(table.headers).toEqual(SHOPIFY_CLASSIC_HEADERS)
    expect(table.records.map(r => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(table.records[0].values['Body (HTML)']).toBe('<p>A warm jacket,\nwith "two" pockets.</p>')
    expect(table.dialect).toEqual({ delimiter: ',', lineEnding: 'LF', bom: false })
    expect(shopifyCsvShape(table)).toEqual({ products: 3, rows: SHOPIFY_SAMPLE_ROWS.length })
    expect(readShopifyCsv(shopifySampleCsv({ bom: true, eol: '\r\n' })).dialect).toEqual({ delimiter: ',', lineEnding: 'CRLF', bom: true })
  })

  it('refuses two spellings of one Shopify column, and a repeated or nameless column', () => {
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, 'URL handle'], []))).toThrow('Columns Handle and URL handle are the same Shopify column')
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, 'Title'], []))).toThrow('Column Title appears twice')
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, ''], []))).toThrow('has no header')
    expect(() => readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, []))).toThrow('contains no product rows')
  })
})

describe('NCF N2 — the parse worker routes a CSV by what it is', () => {
  it('reads Shopify’s product CSV as Shopify’s file, refuses its inventory CSV, and reads a Nexus CSV exactly as before', async () => {
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline })
    try {
      const shopify = await session.read('products_export_1.csv', shopifySampleCsv(), 128 * 1024 * 1024)
      expect(shopify.kind).toBe('shopify')
      expect(shopify.kind === 'shopify' && shopify.table).toEqual(readShopifyCsv(shopifySampleCsv()))
      await expect(session.read('inventory_export_1.csv', csvOf(SHOPIFY_INVENTORY_HEADERS, [{ Handle: 'a', SKU: 'b', Location: 'Shop' }]), 128 * 1024 * 1024))
        .rejects.toThrow('Nexus never imports stock from a file')
      const nexus = await session.read('rows.csv', NEXUS_CSV, 128 * 1024 * 1024)
      expect(nexus).toEqual({ kind: 'transfer', parsed: await readTransferFile(NEXUS_CSV, 'rows.csv'), expandedBytes: 0 })
    } finally { await session.close() }
  }, 60_000)
})

// ── N6 — the mapping: every filled cell a row, an exclusion or a refusal ─────────────────────────────────────────
import { checkShopifyLedger, mapShopifyCsv, readShopifyCsvIdentity, SHOPIFY_CSV_IDENTITY, type ShopifyCsvTarget } from './catalog-shopify-csv.js'
import { shopifyProductSpec } from './channel-specs/store.js'
import { readerMapping } from '../channel-mapping/decisions.js'
import { buildShopifyDraftFields } from '../channel-mapping/shopify-draft.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

const STORE = 'store-1'
const listing = (sku: string, extra: Partial<ShopifyCsvTarget> = {}): ShopifyCsvTarget => ({ id: `l-${sku}`, sku, parentSku: sku === 'ACME-JACKET' || sku === 'ACME-CAP' ? null : 'ACME-JACKET', accountId: STORE, aliasKey: '', version: 4, handles: [], ...extra })
const TARGETS = [listing('ACME-JACKET', { handles: ['acme-jacket'] }), listing('ACME-JACKET-S'), listing('ACME-JACKET-M'), listing('ACME-JACKET-L'), listing('ACME-CAP', { handles: ['acme-cap'] })]
const PRODUCTS = new Map([['ACME-JACKET', { sku: 'ACME-JACKET', parentSku: null }], ['ACME-JACKET-S', { sku: 'ACME-JACKET-S', parentSku: 'ACME-JACKET' }], ['ACME-JACKET-M', { sku: 'ACME-JACKET-M', parentSku: 'ACME-JACKET' }],
  ['ACME-JACKET-L', { sku: 'ACME-JACKET-L', parentSku: 'ACME-JACKET' }], ['ACME-CAP', { sku: 'ACME-CAP', parentSku: null }]])
const nativeSpec = shopifyProductSpec(null, STORE)
const definition = (namespace: string, key: string, type: string) => ({ id: `gid://shopify/MetafieldDefinition/${key.length}`, ownerType: 'PRODUCT', namespace, key, name: key, type, description: null, validations: [], required: false, pinned: true }) as never
const storeSchema = { revision: 'r1', currency: 'EUR', definitions: [definition('custom', 'concise_description', 'single_line_text_field'), definition('custom', 'features', 'list.single_line_text_field')],
  metaobjectDefinitions: [], locales: [{ locale: 'it', primary: true, published: true }], types: [], native: null } as unknown as ShopifyStoreSchema
const warmSpec = shopifyProductSpec(storeSchema, STORE)
const read = (rows = SHOPIFY_SAMPLE_ROWS, extra: Partial<Parameters<typeof mapShopifyCsv>[2]> = {}, targets = TARGETS) => {
  const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, rows))
  const result = mapShopifyCsv(table, targets, { accountId: STORE, spec: nativeSpec, storeFields: false, products: PRODUCTS, ...extra })
  return { table, result, ledger: checkShopifyLedger(table, result) }
}
const cellsOf = (result: ReturnType<typeof mapShopifyCsv>, outcome: string, header: string) => result.ledger.filter(e => e.outcome === outcome && e.header === header)

describe('NCF N6 — mapShopifyCsv', () => {
  it('accounts for every filled cell exactly once, and every row entry has its emitted row', () => {
    const { table, result, ledger } = read()
    expect(ledger).toEqual({ unaccounted: [], duplicated: [], danglingRows: [], phantom: [] })
    const filledCells = table.records.reduce((n, r) => n + table.headers.filter(h => r.values[h]?.trim()).length, 0)
    expect(result.ledger).toHaveLength(filledCells)
  })

  it('writes product fields on the product’s Shopify listing and variant fields on each variant’s', () => {
    const { result } = read()
    const on = (sku: string, field: string) => result.rows.find(r => r.sku === sku && r.field === field)
    expect(on('ACME-JACKET', 'title')).toMatchObject({ entity: 'Overrides', channel: 'SHOPIFY', accountId: STORE, marketplace: 'GLOBAL', aliasKey: '', value: 'Acme jacket', version: 4, origin: 'channel-file', row: 2 })
    expect(on('ACME-JACKET', 'descriptionHtml')?.value).toBe('<p>A warm jacket,\nwith "two" pockets.</p>')
    expect(on('ACME-JACKET', 'tags')?.value).toEqual(['Jackets', 'Winter', 'Acme'])
    expect(on('ACME-JACKET', 'vendor')?.value).toBe('ACME')
    expect(on('ACME-JACKET', 'seo_title')?.value).toBe('Acme jacket | ACME')
    expect(on('ACME-JACKET-S', 'price')).toMatchObject({ entity: 'Overrides', value: 199, row: 2 })
    expect(on('ACME-JACKET-S', 'compareAt')?.value).toBe(249)
    expect(on('ACME-JACKET-L', 'compareAt')).toBeUndefined()
    expect(result.rows.some(r => r.field === 'weight')).toBe(false)
    expect(cellsOf(result, 'excluded', 'Variant Grams')[0]?.reason).toMatch(/Weight is not carried by a file yet/)
    expect(on('ACME-JACKET-M', 'barcode')?.value).toBe('4006381333931')
    expect(on('ACME-JACKET-S', 'taxable')?.value).toBe(true)
    expect(on('ACME-JACKET-S', 'inventoryPolicy')?.value).toBe('DENY')
    // A single-variant product: the product and its variant are the same Nexus listing.
    expect(result.rows.filter(r => r.sku === 'ACME-CAP').map(r => r.field).sort()).toEqual(['inventoryPolicy', 'price', 'productType', 'requiresShipping', SHOPIFY_CSV_IDENTITY, 'tags', 'taxable', 'title', 'vendor'].sort())
  })

  it('records Shopify’s identity of each product: handle, status, option names and every variant', () => {
    const { result } = read()
    const identity = result.rows.find(r => r.sku === 'ACME-JACKET' && r.field === SHOPIFY_CSV_IDENTITY)!
    expect(identity).toMatchObject({ entity: 'Listings', row: 2 })
    expect(identity.value).toEqual({ handle: 'acme-jacket', status: 'active', options: ['Size'], variants: [{ sku: 'ACME-JACKET-S', values: ['S'] }, { sku: 'ACME-JACKET-M', values: ['M'] }, { sku: 'ACME-JACKET-L', values: ['L'] }] })
    expect(readShopifyCsvIdentity({ [SHOPIFY_CSV_IDENTITY]: identity.value })).toEqual(identity.value)
    expect(result.rows.find(r => r.sku === 'ACME-CAP' && r.field === SHOPIFY_CSV_IDENTITY)?.value).toMatchObject({ status: 'draft', options: ['Title'], variants: [{ sku: 'ACME-CAP', values: ['Default Title'] }] })
  })

  it('never imports stock, status, publication, pictures, options or cost — each cell with its reason', () => {
    const { result } = read()
    for (const header of ['Variant Inventory Qty', 'Variant Inventory Tracker', 'Variant Fulfillment Service']) expect(cellsOf(result, 'excluded', header)[0]?.reason).toMatch(/Stock is never imported/)
    expect(cellsOf(result, 'excluded', 'Status')[0]?.reason).toMatch(/Listing lifecycle is not imported \(Status "active"\)/)
    expect(cellsOf(result, 'excluded', 'Published')[0]?.reason).toMatch(/Publication is not imported/)
    expect(cellsOf(result, 'excluded', 'Image Src')).toHaveLength(3)
    expect(cellsOf(result, 'excluded', 'Option1 Value')[0]?.reason).toMatch(/Variant structure is not imported/)
    expect(cellsOf(result, 'excluded', 'Cost per item')[0]?.reason).toMatch(/Product cost belongs to Nexus pricing/)
    expect(cellsOf(result, 'excluded', 'Google Shopping / Gender')[0]?.reason).toMatch(/Google Shopping/)
    expect(result.rows.some(r => /inventory|quantity|status|image|media|option/i.test(r.field) && r.field !== 'inventoryPolicy')).toBe(false)
  })

  it('refuses a category given by its path, and a variant without a SKU, with the reason', () => {
    const { result } = read()
    expect(cellsOf(result, 'refused', 'Product Category')[0]?.reason).toMatch(/names the category by its path/)
    // acme-gloves is not linked, so its rows are refused as a whole (below); a SKU-less variant of a linked product:
    const gloves = SHOPIFY_SAMPLE_ROWS.filter(r => r.Handle === 'acme-cap').map(r => ({ ...r, 'Variant SKU': '' }))
    const noSku = read(gloves).result
    expect(cellsOf(noSku, 'refused', 'Variant Price')[0]?.reason).toBe('This Shopify variant has no SKU. Nexus matches variants by SKU: give it its SKU in Shopify, export the file again, then import.')
    expect(noSku.rows.find(r => r.field === 'title')).toBeDefined()
  })

  it('never imports a product or handle Nexus does not know: a link proposal when its SKUs name one Nexus product', () => {
    const { result } = read()
    expect(cellsOf(result, 'refused', 'Handle').filter(e => e.sku === 'acme-gloves' || e.reason?.includes('acme-gloves'))[0]?.reason).toMatch(/Nexus does not link a Shopify product with the handle acme-gloves/)
    // The jacket's handle unknown, its SKUs all Nexus variants of ACME-JACKET → a proposal, nothing imported.
    const unlinked = read(SHOPIFY_SAMPLE_ROWS, {}, TARGETS.map(t => ({ ...t, handles: [] })))
    expect(unlinked.result.links).toEqual([{ fileSku: 'acme-jacket', proposedSku: 'ACME-JACKET', reason: '3 of 3 variant SKUs of Shopify product acme-jacket belong to Nexus product ACME-JACKET' },
      { fileSku: 'acme-cap', proposedSku: 'ACME-CAP', reason: '1 of 1 variant SKUs of Shopify product acme-cap belong to Nexus product ACME-CAP' }])
    expect(unlinked.result.rows.filter(r => r.sku.startsWith('ACME-JACKET'))).toEqual([])
    expect(cellsOf(unlinked.result, 'refused', 'Title')[0]?.reason).toBe('Link Shopify product acme-jacket to Nexus product ACME-JACKET? Confirm the link to import it.')
    // Confirmed: the rows are read, and the handle becomes the product's recorded identity.
    const confirmed = read(SHOPIFY_SAMPLE_ROWS, { links: { 'acme-jacket': 'ACME-JACKET' } }, TARGETS.map(t => ({ ...t, handles: [] })))
    expect(confirmed.result.rows.find(r => r.field === SHOPIFY_CSV_IDENTITY && r.sku === 'ACME-JACKET')?.value).toMatchObject({ handle: 'acme-jacket' })
    expect(confirmed.ledger.unaccounted).toEqual([])
  })

  it('names why a variant SKU is not imported: unknown, another product’s, or no listing in this store', () => {
    const rows = SHOPIFY_SAMPLE_ROWS.filter(r => r.Handle === 'acme-jacket')
    const swap = (sku: string) => read(rows.map(r => r['Variant SKU'] === 'ACME-JACKET-L' ? { ...r, 'Variant SKU': sku } : r), {}, [...TARGETS, listing('OTHER-M', { parentSku: 'OTHER' })])
    const products = new Map([...PRODUCTS, ['OTHER-M', { sku: 'OTHER-M', parentSku: 'OTHER' }], ['ACME-JACKET-XL', { sku: 'ACME-JACKET-XL', parentSku: 'ACME-JACKET' }]])
    expect(cellsOf(swap('NOPE').result, 'refused', 'Variant Price')[0]?.reason).toBe('NOPE is not a Nexus product. Create it first, then import this file again.')
    const other = mapShopifyCsv(readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, rows.map(r => r['Variant SKU'] === 'ACME-JACKET-L' ? { ...r, 'Variant SKU': 'OTHER-M' } : r))), [...TARGETS, listing('OTHER-M', { parentSku: 'OTHER' })], { accountId: STORE, spec: nativeSpec, storeFields: false, products })
    expect(cellsOf(other, 'refused', 'Variant Price')[0]?.reason).toBe('OTHER-M belongs to Nexus product OTHER, not to ACME-JACKET, which Shopify product acme-jacket is linked to.')
    const noListing = mapShopifyCsv(readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, rows.map(r => r['Variant SKU'] === 'ACME-JACKET-L' ? { ...r, 'Variant SKU': 'ACME-JACKET-XL' } : r))), TARGETS, { accountId: STORE, spec: nativeSpec, storeFields: false, products })
    expect(cellsOf(noListing, 'refused', 'Variant Price')[0]?.reason).toBe('Nexus holds no Shopify listing of ACME-JACKET-XL in this store. Publish it to Shopify from Nexus first: an import never creates listings.')
    const twice = read(rows.map(r => r['Variant SKU'] === 'ACME-JACKET-L' ? { ...r, 'Variant SKU': 'ACME-JACKET-M' } : r)).result
    expect(cellsOf(twice, 'refused', 'Variant Price').map(e => e.reason)).toEqual(['Rows 3, 4 name the same Nexus listing of ACME-JACKET-M; keep one row per variant.', 'Rows 3, 4 name the same Nexus listing of ACME-JACKET-M; keep one row per variant.'])
  })

  it('refuses metafield cells while the store’s field list is not loaded; reads them by the store’s definitions when it is', () => {
    const cold = read()
    expect(cellsOf(cold.result, 'refused', 'Features (product.metafields.custom.features)')[0]?.reason).toMatch(/field list \(its metafield definitions\) is not loaded/)
    expect(cold.result.warnings.join(' ')).toMatch(/Shopify metafields: .*not loaded/)
    const warm = read(SHOPIFY_SAMPLE_ROWS, { spec: warmSpec, storeFields: true })
    const features = warm.result.rows.find(r => r.field.startsWith('shopify_metafield:') && r.field.includes('features'))
    expect(features).toMatchObject({ sku: 'ACME-JACKET', value: '["Waterproof","Breathable"]' })
    expect(warm.result.rows.find(r => r.field.includes('concise_description'))?.value).toBe('Warm')
    expect(warm.ledger).toEqual({ unaccounted: [], duplicated: [], danglingRows: [], phantom: [] })
    const unknown = read(SHOPIFY_SAMPLE_ROWS, { spec: shopifyProductSpec({ ...storeSchema, definitions: [] } as ShopifyStoreSchema, STORE), storeFields: true })
    expect(cellsOf(unknown.result, 'refused', 'Features (product.metafields.custom.features)')[0]?.reason).toMatch(/This store has no product metafield custom.features/)
  })

  it('follows the mapping version: an Owner’s ignore is excluded with its reason, an unmapped column is refused', () => {
    const fields = buildShopifyDraftFields(SHOPIFY_CLASSIC_HEADERS).map((f, i) => ({ ...f, id: `f${i}`,
      ...(f.channelKey === 'Vendor' ? { state: 'ignored' as const, decidedBy: 'owner' as const, reason: 'Vendor is the brand, kept in Nexus' } : {}),
      ...(f.channelKey === 'Type' ? { state: 'unmapped' as const, targetKind: 'none' as const, reason: null } : {}) }))
    const mapping = readerMapping({ id: 's1', version: 2, status: 'ACTIVE' }, 'Shopify · product CSV · v2 (active)', fields)
    const { result, ledger } = read(SHOPIFY_SAMPLE_ROWS, { mapping })
    expect(cellsOf(result, 'excluded', 'Vendor')[0]?.reason).toBe('Ignored by Shopify · product CSV · v2 (active): Vendor is the brand, kept in Nexus')
    expect(cellsOf(result, 'refused', 'Type')[0]?.reason).toMatch(/^Column Type is not mapped in Shopify · product CSV · v2 \(active\)/)
    expect(result.rows.some(r => r.field === 'vendor')).toBe(false)
    expect(ledger.unaccounted).toEqual([])
  })

  it('reads only its own product group on the product sheet; the others are skipped', () => {
    const { result } = read(SHOPIFY_SAMPLE_ROWS, { onlyRootSku: 'ACME-CAP' })
    expect(new Set(result.rows.map(r => r.sku))).toEqual(new Set(['ACME-CAP']))
    expect(result.ledger.filter(e => e.outcome === 'skipped-row' && e.reason === 'Outside this product; use Catalog import').length).toBeGreaterThan(0)
  })
})

// ── An adopted colour family: one Shopify product per colour ─────────────────────────────────────────────────────
import { SHOPIFY_COLOUR_ROWS } from './catalog-transfer-test/shopify-csv-fixtures.js'

describe('NCF N6 — mapShopifyCsv on an adopted colour family', () => {
  const BLACK = 'gid://shopify/Product/101', RED = 'gid://shopify/Product/102'
  const size = (sku: string, colourProductId: string, shopifyProductId: string, extra: Partial<ShopifyCsvTarget> = {}): ShopifyCsvTarget =>
    ({ id: `l-${sku}`, sku, parentSku: 'ACME-RIDE', accountId: STORE, aliasKey: '', version: 3, handles: [], shopifyProductId, colourProductId, ...extra })
  // In the product sheet's row order (`shopifyStoreTargets`: by SKU). The black sizes carry their product's handle from a
  // linked-products member, which used to refuse the file ("Several Nexus listings are linked to Shopify product …").
  const colourTargets = (): ShopifyCsvTarget[] => [
    { id: 'l-ACME-RIDE', sku: 'ACME-RIDE', parentSku: null, accountId: STORE, aliasKey: '', version: 2, handles: [] },
    size('ACME-RIDE-BLK-M', 'c-black', BLACK, { handles: ['acme-ride-black'] }), size('ACME-RIDE-BLK-S', 'c-black', BLACK, { handles: ['acme-ride-black'] }),
    size('ACME-RIDE-RED-M', 'c-red', RED), size('ACME-RIDE-RED-S', 'c-red', RED, { listingSkus: ['acme-ride-red-s'] }),
  ]
  const products = new Map(['ACME-RIDE', 'ACME-RIDE-BLK-S', 'ACME-RIDE-BLK-M', 'ACME-RIDE-RED-S', 'ACME-RIDE-RED-M'].map(sku => [sku, { sku, parentSku: sku === 'ACME-RIDE' ? null : 'ACME-RIDE' }]))
  const readColour = (rows = SHOPIFY_COLOUR_ROWS, targets = colourTargets(), extra: Partial<Parameters<typeof mapShopifyCsv>[2]> = {}) => {
    const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, rows))
    const result = mapShopifyCsv(table, targets, { accountId: STORE, spec: nativeSpec, storeFields: false, products, ...extra })
    return { table, result, ledger: checkShopifyLedger(table, result) }
  }
  const fieldsOn = (result: ReturnType<typeof mapShopifyCsv>, sku: string) => result.rows.filter(r => r.sku === sku).map(r => r.field).sort()

  it('maps each colour’s Shopify product to that colour’s owner row: its first size in the sheet’s order', () => {
    const { result, ledger } = readColour()
    expect(result.issues).toEqual([])
    expect(ledger).toEqual({ unaccounted: [], duplicated: [], danglingRows: [], phantom: [] })
    const on = (sku: string, field: string) => result.rows.find(r => r.sku === sku && r.field === field)
    expect(on('ACME-RIDE-BLK-M', 'title')).toMatchObject({ entity: 'Overrides', channel: 'SHOPIFY', accountId: STORE, marketplace: 'GLOBAL', aliasKey: '', version: 3, value: 'Ride jacket – Black', row: 2 })
    expect(on('ACME-RIDE-BLK-M', 'descriptionHtml')?.value).toBe('<p>The black ride jacket.</p>')
    expect(on('ACME-RIDE-BLK-M', 'seo_title')?.value).toBe('Ride jacket black')
    expect(on('ACME-RIDE-RED-M', 'title')?.value).toBe('Ride jacket – Red')
    expect(on('ACME-RIDE-RED-M', 'tags')?.value).toEqual(['Jackets', 'Red'])
    for (const sku of ['ACME-RIDE-BLK-M', 'ACME-RIDE-RED-M']) expect(on(sku, 'vendor')?.value).toBe('ACME')
    // Shopify's identity of each colour product, on its owner row.
    expect(on('ACME-RIDE-BLK-M', SHOPIFY_CSV_IDENTITY)?.value).toEqual({ handle: 'acme-ride-black', status: 'active', options: ['Size'], variants: [{ sku: 'ACME-RIDE-BLK-S', values: ['S'] }, { sku: 'ACME-RIDE-BLK-M', values: ['M'] }] })
    expect(on('ACME-RIDE-RED-M', SHOPIFY_CSV_IDENTITY)?.value).toMatchObject({ handle: 'acme-ride-red', variants: [{ sku: 'acme-ride-red-s', values: ['S'] }, { sku: 'ACME-RIDE-RED-M', values: ['M'] }] })
    // Nothing on the family row; a size that owns no colour gets its variant fields only.
    expect(result.rows.filter(r => r.sku === 'ACME-RIDE')).toEqual([])
    expect(fieldsOn(result, 'ACME-RIDE-BLK-S')).toEqual(['compareAt', 'inventoryPolicy', 'price', 'requiresShipping', 'taxable'])
    expect(result.links).toEqual([])
  })

  it('matches a size Shopify sells under a case-only SKU by the listing’s own channel SKU', () => {
    const { result } = readColour()
    expect(result.rows.find(r => r.sku === 'ACME-RIDE-RED-S' && r.field === 'price')).toMatchObject({ value: 199, fileSku: 'acme-ride-red-s', row: 4 })
    expect(result.rows.find(r => r.sku === 'ACME-RIDE-RED-S' && r.field === 'compareAt')?.value).toBe(239)
    expect(cellsOf(result, 'excluded', 'Variant SKU').find(e => e.row === 4)?.reason).toBe('The variant’s identity: matched to Nexus product ACME-RIDE-RED-S (Shopify sells it as acme-ride-red-s). Nexus keeps its own SKUs: a file never changes one.')
    // Without the listing's own SKU on record, the case-only SKU is no Nexus product: refused, as before.
    const without = readColour(SHOPIFY_COLOUR_ROWS, colourTargets().map(t => ({ ...t, listingSkus: [] }))).result
    expect(cellsOf(without, 'refused', 'Variant Price').map(e => e.reason)).toEqual(['acme-ride-red-s is not a Nexus product. Create it first, then import this file again.'])
    expect(without.rows.find(r => r.sku === 'ACME-RIDE-RED-M' && r.field === 'title')?.value).toBe('Ride jacket – Red')
  })

  it('records prices and compare-at prices per size, as for any product', () => {
    const { result } = readColour()
    const prices = result.rows.filter(r => r.field === 'price' || r.field === 'compareAt').map(r => [r.sku, r.field, r.value])
    expect(prices).toEqual([['ACME-RIDE-BLK-S', 'price', 189], ['ACME-RIDE-BLK-S', 'compareAt', 229], ['ACME-RIDE-BLK-M', 'price', 189],
      ['ACME-RIDE-RED-S', 'price', 199], ['ACME-RIDE-RED-S', 'compareAt', 239], ['ACME-RIDE-RED-M', 'price', 199]])
  })

  it('refuses a Shopify product whose SKUs are the sizes of two colours, or of a size not linked to its colour', () => {
    const mixed = SHOPIFY_COLOUR_ROWS.map(r => r['Variant SKU'] === 'ACME-RIDE-BLK-M' ? { ...r, 'Variant SKU': 'ACME-RIDE-RED-M' } : r).filter(r => r.Handle === 'acme-ride-black')
    const { result } = readColour(mixed)
    expect(cellsOf(result, 'refused', 'Title')[0]?.reason).toBe('The variant SKUs of Shopify product acme-ride-black (ACME-RIDE-BLK-S, ACME-RIDE-RED-M) are not the sizes of one Nexus colour product. Correct the SKUs in Shopify, or confirm the colour again in Colour products, then import.')
    expect(result.rows).toEqual([])
    const unlinked = colourTargets().map(t => t.sku === 'ACME-RIDE-BLK-M' ? { ...t, colourProductId: null, shopifyProductId: null, handles: [] } : t)
    expect(cellsOf(readColour(SHOPIFY_COLOUR_ROWS.filter(r => r.Handle === 'acme-ride-black'), unlinked).result, 'refused', 'Title')[0]?.reason)
      .toBe('The variant SKUs of Shopify product acme-ride-black (ACME-RIDE-BLK-S, ACME-RIDE-BLK-M) are not the sizes of one Nexus colour product: ACME-RIDE-BLK-M is not linked to it. Correct the SKUs in Shopify, or confirm the colour again in Colour products, then import.')
  })

  it('a colour family with one adopted colour maps it the same way; the product sheet reads only its own product group', () => {
    const { result } = readColour(SHOPIFY_COLOUR_ROWS.filter(r => r.Handle === 'acme-ride-red'))
    expect(result.issues).toEqual([])
    expect(result.rows.find(r => r.field === 'title')).toMatchObject({ sku: 'ACME-RIDE-RED-M', value: 'Ride jacket – Red' })
    const sheet = readColour(SHOPIFY_COLOUR_ROWS, colourTargets(), { onlyRootSku: 'ACME-RIDE' }).result
    expect(sheet.rows.filter(r => r.field === 'title').map(r => r.sku)).toEqual(['ACME-RIDE-BLK-M', 'ACME-RIDE-RED-M'])
  })

  it('never writes a SKU from the file: the SKU column only names the variant, also when a mapping version targets the SKU', () => {
    // Shopify spells every SKU of the red colour in lower case; Nexus holds the red S's spelling as its listing's own SKU.
    const lower = SHOPIFY_COLOUR_ROWS.map(r => r['Variant SKU'] === 'ACME-RIDE-RED-M' ? { ...r, 'Variant SKU': 'acme-ride-red-m' } : r)
    const { result, ledger } = readColour(lower)
    expect(ledger.unaccounted).toEqual([])
    expect(result.rows.some(r => /sku/i.test(r.field))).toBe(false)
    expect(cellsOf(result, 'excluded', 'Variant SKU').map(e => e.reason).every(reason => reason?.endsWith('Nexus keeps its own SKUs: a file never changes one.'))).toBe(true)
    // The red M has no SKU of its own in Nexus that Shopify's spelling matches: refused, never matched by a guess or renamed.
    expect(cellsOf(result, 'refused', 'Variant Price').map(e => e.reason)).toEqual(['acme-ride-red-m is not a Nexus product. Create it first, then import this file again.'])
    // An Owner's mapping that sends the SKU column, or another column, to the SKU field: excluded, not written.
    const fields = buildShopifyDraftFields(SHOPIFY_CLASSIC_HEADERS).map((f, i) => ({ ...f, id: `f${i}`,
      ...(f.channelKey === 'Variant SKU' || f.channelKey === 'Variant Barcodes' ? { state: 'mapped' as const, decidedBy: 'owner' as const, targetKind: 'channelField' as const, targetKey: 'sku' } : {}) }))
    const mapping = readerMapping({ id: 's1', version: 3, status: 'ACTIVE' }, 'Shopify · product CSV · v3 (active)', fields)
    const mapped = readColour(SHOPIFY_COLOUR_ROWS.map(r => r['Variant SKU'] === 'ACME-RIDE-BLK-S' ? { ...r, 'Variant Barcodes': 'NEW-SKU' } : r), colourTargets(), { mapping }).result
    expect(mapped.rows.some(r => /sku/i.test(r.field))).toBe(false)
    expect(cellsOf(mapped, 'excluded', 'Variant Barcodes')[0]?.reason).toBe('Shopify · product CSV · v3 (active) maps this column to the SKU. Nexus keeps its own SKUs: a file never changes one.')
  })

  it('leaves a family Shopify sells as ONE product exactly as before, also when its listings name that product', () => {
    const before = read().result
    // The jacket's listings all name its one Shopify product (as a family Nexus published does), with no colour link.
    const tied = TARGETS.map(t => t.sku.startsWith('ACME-JACKET') ? { ...t, shopifyProductId: 'gid://shopify/Product/9' } : t)
    expect(read(SHOPIFY_SAMPLE_ROWS, {}, tied).result).toEqual(before)
    // A tombstone of a deleted colour (no Shopify product left) is not a colour link: `shopifyStoreTargets` gives it none.
    expect(read(SHOPIFY_SAMPLE_ROWS, {}, TARGETS.map(t => ({ ...t, colourProductId: null }))).result).toEqual(before)
  })
})

/**
 * NCF N7 — Shopify's product CSV written from Nexus (pure): the columns, the two traps (a blank cell erases, a missing
 * option deletes), the products it refuses, the upload-safety check, and the round trip on the synthetic file.
 */
import { describe, expect, it } from 'vitest'
import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import { buildShopifyCsv, checkShopifyExport, compareShopifyCsv, shopifyCsvText, type ShopifyExportProduct } from './shopify-export.js'
import { buildShopifyDraftFields, shopifyChannelKeyOf } from './shopify-draft.js'
import { mapShopifyCsv, readShopifyCsv, SHOPIFY_CSV_IDENTITY, type ShopifyCsvIdentity, type ShopifyCsvTarget } from '../pim/catalog-shopify-csv.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS } from '../pim/catalog-transfer-test/shopify-csv-fixtures.js'

const STORE = 'store-1'
const spec = shopifyProductSpec(null, STORE)
const fields: MappingFieldRow[] = buildShopifyDraftFields(SHOPIFY_CLASSIC_HEADERS).map((f, i) => ({ ...f, id: `f${i}` }))
const options = { spec, storeFields: false, includePrices: true }

/** Nexus's store, simulated: every listing holds exactly what the reader emitted for it (the golden pipeline's way). */
function importThenStore(rows: Record<string, string>[]) {
  const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, rows))
  const targets: ShopifyCsvTarget[] = ['ACME-JACKET', 'ACME-JACKET-S', 'ACME-JACKET-M', 'ACME-JACKET-L', 'ACME-CAP'].map(sku => ({ id: `l-${sku}`, sku, parentSku: ['ACME-JACKET', 'ACME-CAP'].includes(sku) ? null : 'ACME-JACKET',
    accountId: STORE, aliasKey: '', version: 1, handles: sku === 'ACME-JACKET' ? ['acme-jacket'] : sku === 'ACME-CAP' ? ['acme-cap'] : [] }))
  const read = mapShopifyCsv(table, targets, { accountId: STORE, spec, storeFields: false })
  const stored = new Map<string, { values: Map<string, unknown>; price: number | null; compareAt: number | null; identity: ShopifyCsvIdentity | null }>()
  for (const t of targets) stored.set(t.sku, { values: new Map(), price: null, compareAt: null, identity: null })
  for (const r of read.rows as TransferRow[]) {
    const s = stored.get(r.sku)!
    if (r.field === 'price') s.price = r.value as number
    else if (r.field === 'compareAt') s.compareAt = r.value as number
    else if (r.field === SHOPIFY_CSV_IDENTITY) s.identity = r.value as ShopifyCsvIdentity
    else s.values.set(r.field, r.value)
  }
  const variant = (sku: string) => ({ sku, values: stored.get(sku)!.values, price: stored.get(sku)!.price, compareAt: { state: stored.get(sku)!.compareAt === null ? 'inherited' as const : 'stored' as const, value: stored.get(sku)!.compareAt } })
  const products: ShopifyExportProduct[] = [
    { sku: 'ACME-JACKET', identity: stored.get('ACME-JACKET')!.identity, values: stored.get('ACME-JACKET')!.values, variants: new Map(['ACME-JACKET-S', 'ACME-JACKET-M', 'ACME-JACKET-L'].map(s => [s, variant(s)])) },
    { sku: 'ACME-CAP', identity: stored.get('ACME-CAP')!.identity, values: stored.get('ACME-CAP')!.values, variants: new Map([['ACME-CAP', variant('ACME-CAP')]]) },
  ]
  return { table, read, products }
}

describe('NCF N7 — buildShopifyCsv', () => {
  it('round-trips the file: every written cell equals Shopify’s own, and the file passes its upload-safety check', () => {
    const { table, products } = importThenStore(SHOPIFY_SAMPLE_ROWS)
    const out = buildShopifyCsv(fields, products, options)
    expect(checkShopifyExport(fields, out)).toEqual([])
    expect(out).toMatchObject({ products: 2, variants: 4, refused: [] })
    const cmp = compareShopifyCsv(table, out, shopifyChannelKeyOf)
    expect({ differ: cmp.differ, missing: cmp.missing, extra: cmp.extra }).toEqual({ differ: [], missing: [], extra: [] })
    expect(cmp.equal).toBe(cmp.compared)
    expect(cmp.compared).toBe(40)
  })

  it('always writes Handle, Title, Variant SKU, Status and Option1..3 Name/Value; never stock, pictures, publication or cost', () => {
    const out = buildShopifyCsv(fields, importThenStore(SHOPIFY_SAMPLE_ROWS).products, options)
    for (const h of ['Handle', 'Title', 'Variant SKU', 'Status', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value']) expect(out.headers).toContain(h)
    for (const h of ['Variant Inventory Qty', 'Variant Inventory Tracker', 'Variant Fulfillment Service', 'Image Src', 'Published', 'Cost per item', 'Variant Grams']) expect(out.headers).not.toContain(h)
    const col = (h: string) => out.headers.indexOf(h)
    // Every variant row names its option value exactly as Shopify gave it; option names ride on a product's first row.
    expect(out.rows.map(r => [r[col('Handle')], r[col('Variant SKU')], r[col('Option1 Name')], r[col('Option1 Value')], r[col('Status')]])).toEqual([
      ['acme-jacket', 'ACME-JACKET-S', 'Size', 'S', 'active'], ['acme-jacket', 'ACME-JACKET-M', '', 'M', ''], ['acme-jacket', 'ACME-JACKET-L', '', 'L', ''], ['acme-cap', 'ACME-CAP', 'Title', 'Default Title', 'draft']])
  })

  it('leaves a column out of the whole file when Nexus lacks a value for one row that carries it (a blank would erase)', () => {
    const out = buildShopifyCsv(fields, importThenStore(SHOPIFY_SAMPLE_ROWS).products, options)
    // Body: the cap's is blank in Shopify's own file, so Nexus holds none — the column is left out, never blanked.
    expect(out.headers).not.toContain('Body (HTML)')
    expect(out.omitted.find(o => o.header === 'Body (HTML)')?.reason).toBe('Nexus holds no Body (HTML) for 1 of 2 products; left out so Shopify keeps its values.')
    expect(out.omitted.find(o => o.header === 'Variant Compare At Price')?.reason).toBe('Nexus holds no compare-at price for 2 of 4 variants; left out so Shopify keeps its values.')
    expect(out.omitted.find(o => o.header === 'Variant Barcodes')?.reason).toMatch(/for 3 of 4 variants/)
    // With every value held, the column is written.
    const all = importThenStore(SHOPIFY_SAMPLE_ROWS.map(r => r['Variant SKU'] ? { ...r, 'Variant Compare At Price': '299.00' } : r))
    expect(buildShopifyCsv(fields, all.products, options).headers).toContain('Variant Compare At Price')
    expect(buildShopifyCsv(fields, all.products, { ...options, includePrices: false }).headers).not.toContain('Variant Price')
  })

  it('writes nothing of a product Nexus cannot write safely, and says why', () => {
    const { products } = importThenStore(SHOPIFY_SAMPLE_ROWS)
    const [jacket, cap] = products
    const partial = { ...jacket, variants: new Map([...jacket.variants].filter(([sku]) => sku !== 'ACME-JACKET-L')) }
    const out = buildShopifyCsv(fields, [partial, { ...cap, identity: null }, { ...cap, sku: 'ACME-CAP-2', identity: { ...cap.identity!, status: null } }, { ...cap, sku: 'ACME-CAP-3', values: new Map() }], options)
    expect(out.rows).toEqual([])
    expect(out.refused).toEqual([
      { sku: 'ACME-JACKET', reason: 'Shopify holds 3 variants of this product; Nexus links 2. A file without the others could erase or delete them in Shopify.' },
      { sku: 'ACME-CAP', reason: expect.stringMatching(/has not read this product from Shopify’s own product file yet/) },
      { sku: 'ACME-CAP-2', reason: 'Nexus does not know this product’s Shopify status; a file without it can make the product active.' },
      { sku: 'ACME-CAP-3', reason: 'Shopify needs a Title to update a product, and Nexus holds none for it.' },
    ])
  })

  it('refuses a version that cannot write a safe file (no option or Status columns)', () => {
    const without = (key: string) => fields.filter(f => f.channelKey !== key)
    expect(() => buildShopifyCsv(without('Option1 Value'), [], options)).toThrow(/Shopify deletes variants when they are missing/)
    expect(() => buildShopifyCsv(without('Status'), [], options)).toThrow(/A file without Status can make a draft product active/)
  })

  it('the upload-safety check catches a blank, a stock column, a missing Status and missing options', () => {
    const out = buildShopifyCsv(fields, importThenStore(SHOPIFY_SAMPLE_ROWS).products, options)
    const price = out.headers.indexOf('Variant Price')
    const blanked = { headers: out.headers, rows: out.rows.map((r, i) => i === 1 ? r.map((c, j) => j === price ? '' : c) : r) }
    expect(checkShopifyExport(fields, blanked)).toEqual(['Row 3, Variant Price: a blank cell would erase Shopify’s value'])
    expect(checkShopifyExport(fields, { headers: [...out.headers, 'Variant Inventory Qty'], rows: out.rows.map(r => [...r, '5']) })).toEqual(['Variant Inventory Qty must never be written'])
    expect(checkShopifyExport(fields, { headers: out.headers.filter(h => h !== 'Status'), rows: out.rows.map(r => r.filter((_, i) => out.headers[i] !== 'Status')) })).toContain('Status is missing')
    expect(checkShopifyExport(fields, { headers: out.headers.filter(h => h !== 'Option1 Value'), rows: out.rows.map(r => r.filter((_, i) => out.headers[i] !== 'Option1 Value')) })).toContain('Option1 Name / Option1 Value are missing while Variant SKU is written')
    const title = out.headers.indexOf('Title')
    expect(checkShopifyExport(fields, { headers: out.headers, rows: out.rows.map((r, i) => i === 0 ? r.map((c, j) => j === title ? '' : c) : r) })).toEqual(['Row 2, Title: a blank cell would erase Shopify’s value'])
  })

  it('writes UTF-8 without BOM, comma, LF, quoting only where needed', () => {
    const text = shopifyCsvText(['Handle', 'Body (HTML)'], [['acme', '<p>a, "b"\nc</p>'], ['acme', 'plain']])
    expect(text).toBe('Handle,Body (HTML)\nacme,"<p>a, ""b""\nc</p>"\nacme,plain\n')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(text.includes('\r')).toBe(false)
  })
})

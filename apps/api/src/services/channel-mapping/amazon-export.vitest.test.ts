/**
 * CHMAP M3 (E-1) — Nexus values back into Amazon's own template, through the same mapping version the import used.
 * The heart of it is a round trip with no database: template → reader → the values Nexus would store → export →
 * the same cells. Fixtures are built in memory (never the Owner's files).
 */
import { describe, expect, it } from 'vitest'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import { mapAmazonWorkbook, type AmazonDestination } from '../pim/catalog-amazon-workbook.js'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import { buildAmazonDraftFields } from './amazon-draft.js'
import { buildAmazonTemplateRows, compareTemplateRows, labelFor, type AmazonExportRecord } from './amazon-export.js'
import { readerMapping } from './decisions.js'
import { ACTION, b64, h, IT, SKU, template, TYPE } from './__tests__/amazon-template-fixture.js'

const attr = (properties: object, max = 1) => ({ type: 'array', maxItems: max, items: { type: 'object', properties } })
const selectorAttr = (properties: object, selectors: string[]) => ({ type: 'array', maxItems: 1, selectors: ['marketplace_id', ...selectors], items: { type: 'object', properties } })
const coat = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { required: ['brand', 'item_name'], properties: {
  item_name: attr({ value: { type: 'string' } }), brand: attr({ value: { type: 'string' } }), bullet_point: attr({ value: { type: 'string' } }, 5),
  condition_type: attr({ value: { type: 'string', enum: ['new_new'] } }), color: attr({ value: { type: 'string' } }),
  item_package_weight: attr({ value: { type: 'number' }, unit: { type: 'string', enum: ['kilograms'] } }),
  compliance_media: selectorAttr({ content_type: { type: 'string', enum: ['user_manual', 'safety_information'] }, source_location: { type: 'string' } }, ['content_language', 'content_type']),
  apparel_size: selectorAttr({ size_system: { type: 'string', enum: ['as6'] }, size: { type: 'string', enum: ['m', 'l'] } }, ['size_system']),
  merchant_suggested_asin: attr({ value: { type: 'string' } }), supplier_declared_has_product_identifier_exemption: attr({ value: { type: 'boolean' } }),
  list_price: attr({ value_with_tax: { type: 'number' } }),
} } })
const pants = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'PANTS', schemaDefinition: { required: ['brand'], properties: {
  item_name: attr({ value: { type: 'string' } }), brand: attr({ value: { type: 'string' } }), rise: attr({ style: attr({ value: { type: 'string' } }) }),
} } })
const specs = new Map([['COAT', coat], ['PANTS', pants]])
const destination: AmazonDestination = { accountId: 'amazon-a', marketplace: 'IT', language: 'it' }
const ID_TYPE = 'amzn1.volt.ca.product_id_type', ID_VALUE = 'amzn1.volt.ca.product_id_value'
const PARENTAGE = h('parentage_level'), PARENT = `child_parent_sku_relationship[marketplace_id=${IT}]#1.parent_sku`
const PRICE = `purchasable_offer[marketplace_id=${IT}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`
const QTY = 'fulfillment_availability#1.quantity'
const MANUAL = `compliance_media[marketplace_id=${IT}][content_language=it_IT][content_type=user_manual]#1.source_location`
const SAFETY = `compliance_media[marketplace_id=${IT}][content_language=it_IT][content_type=safety_information]#1.source_location`
const keys = [SKU, TYPE, ACTION, PARENTAGE, PARENT, ID_TYPE, ID_VALUE, h('item_name', 1, 'value', 'it_IT'), h('brand', 1, 'value', 'it_IT'), h('bullet_point', 1, 'value', 'it_IT'), h('bullet_point', 2, 'value', 'it_IT'),
  h('condition_type'), h('color', 1, 'value', 'it_IT'), h('item_package_weight'), h('item_package_weight', 1, 'unit'), MANUAL, SAFETY, h('apparel_size', 1, 'size_system'), h('apparel_size', 1, 'size'), h('rise', 1, 'style#1.value'), PRICE, QTY]
const aliases = [
  { attribute: TYPE, aliases: { COAT: 'COAT', PANTS: 'PANTS' } },
  { attribute: ACTION, aliases: { 'Crea o sostituisci (aggiornamento completo)': 'full_update', 'Modifica (aggiornamento parziale)': 'partial_update', Elimina: 'delete' } },
  { attribute: PARENTAGE, aliases: { 'Articolo parent': 'parent', Bambino: 'child' } },
  { attribute: ID_TYPE, aliases: { ASIN: 'asin', EAN: 'ean', 'Esenzione GTIN': 'exempt' } },
  { attribute: h('condition_type'), aliases: { Nuovo: 'new_new' } },
  { attribute: h('item_package_weight', 1, 'unit'), aliases: { Chilogrammi: 'kilograms' } },
  { attribute: h('apparel_size', 1, 'size_system'), aliases: { IT: 'as6' } },
  { attribute: h('apparel_size', 1, 'size'), aliases: { M: 'm', L: 'l' } },
]
const col = (key: string) => keys.indexOf(key)
function line(values: Record<string, string>) { const cells = keys.map(() => ''); for (const [k, v] of Object.entries(values)) cells[col(k)] = v; return cells }
const parentLine = line({ [SKU]: 'GALE-JACKET', [TYPE]: 'COAT', [ACTION]: 'Crea o sostituisci (aggiornamento completo)', [PARENTAGE]: 'Articolo parent', [ID_TYPE]: 'Esenzione GTIN',
  [h('item_name', 1, 'value', 'it_IT')]: 'Giacca Gale', [h('brand', 1, 'value', 'it_IT')]: 'XAVIA', [h('condition_type')]: 'Nuovo' })
const childLine = (sku: string, size: string, asin: string) => line({ [SKU]: sku, [TYPE]: 'COAT', [ACTION]: 'Crea o sostituisci (aggiornamento completo)', [PARENTAGE]: 'Bambino', [PARENT]: 'GALE-JACKET',
  [ID_TYPE]: 'ASIN', [ID_VALUE]: asin, [h('item_name', 1, 'value', 'it_IT')]: 'Giacca Gale', [h('brand', 1, 'value', 'it_IT')]: 'XAVIA', [h('bullet_point', 1, 'value', 'it_IT')]: 'PROTEZIONE',
  [h('bullet_point', 2, 'value', 'it_IT')]: 'VENTILAZIONE', [h('condition_type')]: 'Nuovo', [h('color', 1, 'value', 'it_IT')]: 'Nero', [h('item_package_weight')]: '1.6', [h('item_package_weight', 1, 'unit')]: 'Chilogrammi',
  [MANUAL]: 'https://example.test/manual.pdf', [h('apparel_size', 1, 'size_system')]: 'IT', [h('apparel_size', 1, 'size')]: size, [PRICE]: '99', [QTY]: '5' })
const file = () => template(keys, [parentLine, childLine('GALE-JACKET-BLACK-MEN-M', 'M', 'B0FXTEST02'), childLine('GALE-JACKET-BLACK-MEN-L', 'L', 'B0FXTEST01')], { attributeSettings: b64(aliases) })

/** What Nexus would hold after the import: the reader's rows, grouped per listing (the store the export reads). */
function stored(rows: TransferRow[], parents: Record<string, string>): AmazonExportRecord[] {
  const bySku = new Map<string, AmazonExportRecord>()
  for (const r of rows) {
    const rec = bySku.get(r.sku) ?? { sku: r.sku, sellerSku: r.sku, parentSellerSku: parents[r.sku] ?? null, isParent: !parents[r.sku], productType: 'COAT', asin: null, values: new Map(), price: null, sale: null }
    if (r.field === 'productType') rec.productType = String(r.value)
    else if (r.field === 'price') rec.price = Number(r.value)
    else if (r.action === 'SET') rec.values.set(`${r.field}\u0000${r.locale ?? ''}`, r.value)
    bySku.set(r.sku, rec)
  }
  return [...bySku.values()]
}

describe('CHMAP — export into Amazon’s own template', () => {
  it('round trip with no database: every cell the import took comes back the same, stock stays out', async () => {
    const parsed = await file()
    const fields: MappingFieldRow[] = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] }).map((r, i) => ({ ...r, id: `f${i}` }))
    const read = mapAmazonWorkbook(parsed, specs, { ...destination, mapping: readerMapping({ id: 's', version: 1, status: 'DRAFT' }, 'v1', fields) })
    expect(read.issues).toEqual([])
    const records = stored(read.rows, { 'GALE-JACKET-BLACK-MEN-M': 'GALE-JACKET', 'GALE-JACKET-BLACK-MEN-L': 'GALE-JACKET' })
    const out = buildAmazonTemplateRows(parsed, fields, records, { recordAction: 'full_update', primaryLanguage: 'it', currency: 'EUR', includePrices: true })
    const result = compareTemplateRows(parsed, parsed.rows, out.rows, SKU, out.blankByDesign, out.blankForRow)
    expect(result.differ).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual([])
    expect(result.equal).toBeGreaterThan(40)
    // Stock is never written into a file: its cells are blank on purpose, with the reason.
    expect(result.blankByDesign.map(b => b.header)).toEqual([QTY])
    expect(out.rows.every(r => !r[QTY])).toBe(true)
    // Labels come back from codes, in the template's own words.
    const child = out.rows.find(r => r[SKU] === 'GALE-JACKET-BLACK-MEN-M')!
    expect(child[h('condition_type')]).toBe('Nuovo')
    expect(child[h('item_package_weight', 1, 'unit')]).toBe('Chilogrammi')
    expect(child[PARENTAGE]).toBe('Bambino')
    expect(child[h('bullet_point', 2, 'value', 'it_IT')]).toBe('VENTILAZIONE')
  })

  it('keeps "GTIN exemption" as a fact: the import stores it, the export declares it again', async () => {
    const parsed = await file()
    const read = mapAmazonWorkbook(parsed, specs, destination)
    expect(read.rows.find(r => r.sku === 'GALE-JACKET' && r.field === 'supplier_declared_has_product_identifier_exemption')?.value).toBe(true)
    const fields = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] }).map((r, i) => ({ ...r, id: `f${i}` }))
    const records = stored(read.rows, {})
    // The live ASIN does not override a declared exemption.
    records.find(r => r.sku === 'GALE-JACKET')!.asin = 'B0FXTEST03'
    const out = buildAmazonTemplateRows(parsed, fields, records, { recordAction: 'partial_update', primaryLanguage: 'it', currency: 'EUR', includePrices: false })
    const parent = out.rows.find(r => r[SKU] === 'GALE-JACKET')!
    expect(parent[ID_TYPE]).toBe('Esenzione GTIN')
    expect(parent[ID_VALUE]).toBeUndefined()
    expect(parent[ACTION]).toBe('Modifica (aggiornamento parziale)')
    expect(out.blankByDesign.get(PRICE)).toMatch(/Prices were not requested/)
  })

  it('writes one value back into ONE column: the document column the file used', async () => {
    const parsed = await file()
    const fields = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] })
    expect(fields.find(f => f.columnKey === MANUAL)).toMatchObject({ direction: 'both', targetKey: 'compliance_media' })
    expect(fields.find(f => f.columnKey === SAFETY)).toMatchObject({ direction: 'in', reason: expect.stringContaining('written back into') })
  })

  it('writes a size system only beside a size, and a PANTS attribute never on a COAT row', async () => {
    const parsed = await file()
    const fields = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] }).map((r, i) => ({ ...r, id: `f${i}` }))
    const read = mapAmazonWorkbook(parsed, specs, destination)
    const records = stored(read.rows, {})
    records[0].values.set('rise__style\u0000', 'Vita alta')
    const out = buildAmazonTemplateRows(parsed, fields, records, { recordAction: 'blank', primaryLanguage: 'it', currency: 'EUR', includePrices: true })
    const parent = out.rows.find(r => r[SKU] === 'GALE-JACKET')!
    expect(parent[h('apparel_size', 1, 'size_system')]).toBeUndefined()
    expect(out.rows.find(r => r[SKU] === 'GALE-JACKET-BLACK-MEN-M')![h('apparel_size', 1, 'size_system')]).toBe('IT')
    expect(parent[h('rise', 1, 'style#1.value')]).toBeUndefined()
    expect(out.blankForRow.get(`GALE-JACKET\u0000${h('rise', 1, 'style#1.value')}`)).toBe('Not an attribute of Amazon COAT')
    expect(parent[ACTION]).toBeUndefined()
  })

  it('the comparison is strict: one planted change and a code instead of a label are caught, a number spelling is not', async () => {
    const parsed = await file()
    const rows = parsed.rows.map(r => ({ ...r }))
    const same = compareTemplateRows(parsed, parsed.rows, rows, SKU, new Map())
    expect(same.differ).toEqual([])
    // An Amazon code where the file shows the label is a difference: Amazon's dropdowns expect the label.
    rows[1][h('condition_type')] = 'new_new'
    expect(compareTemplateRows(parsed, parsed.rows, rows, SKU, new Map()).differ).toHaveLength(1)
    rows[1][h('condition_type')] = 'Nuovo'
    rows[1][h('item_package_weight')] = '1.60'
    expect(compareTemplateRows(parsed, parsed.rows, rows, SKU, new Map()).differ).toEqual([])
    rows[1][h('item_name', 1, 'value', 'it_IT')] = 'Giacca Gale (planted)'
    expect(compareTemplateRows(parsed, parsed.rows, rows, SKU, new Map()).differ).toHaveLength(1)
    expect(labelFor(parsed, h('condition_type'), 'new_new')).toBe('Nuovo')
  })

  // Item 12 (product sheet consistency, 2026-10-05) — a single product is neither a parent nor a child: it was written as
  // "Articolo parent" with a blank price.
  it('writes the listing role from the family: a single product gets a blank role and keeps its price', async () => {
    const parsed = await file()
    const fields = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] }).map((r, i) => ({ ...r, id: `f${i}` }))
    const read = mapAmazonWorkbook(parsed, specs, destination)
    const records = stored(read.rows, { 'GALE-JACKET-BLACK-MEN-M': 'GALE-JACKET', 'GALE-JACKET-BLACK-MEN-L': 'GALE-JACKET' })
    records.find(r => r.sku === 'GALE-JACKET')!.role = 'parent'
    const child = records.find(r => r.sku === 'GALE-JACKET-BLACK-MEN-M')!
    child.role = 'child'
    records.push({ ...child, sku: 'TEST-SINGLE', sellerSku: 'TEST-SINGLE', parentSellerSku: null, isParent: false, role: 'single', price: 49 })
    const out = buildAmazonTemplateRows(parsed, fields, records, { recordAction: 'partial_update', primaryLanguage: 'it', currency: 'EUR', includePrices: true })
    const row = (sku: string) => out.rows.find(r => r[SKU] === sku)!
    expect(row('GALE-JACKET')[PARENTAGE]).toBe('Articolo parent')
    expect(row('GALE-JACKET-BLACK-MEN-M')[PARENTAGE]).toBe('Bambino')
    expect(row('GALE-JACKET-BLACK-MEN-M')[PARENT]).toBe('GALE-JACKET')
    expect(row('TEST-SINGLE')[PARENTAGE]).toBeUndefined()
    expect(row('TEST-SINGLE')[PARENT]).toBeUndefined()
    expect(row('TEST-SINGLE')[PRICE]).toBe('49')
    expect(out.blankForRow.has(`TEST-SINGLE\u0000${PRICE}`)).toBe(false)
  })
})

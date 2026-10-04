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
import { amazonExportValues, buildAmazonTemplateRows, compareTemplateRows, labelFor, type AmazonExportRecord, type AmazonOfferExportCell } from './amazon-export.js'
import { FBA_FULFILMENT_REASON, amazonOfferFieldFor, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
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

/**
 * Product sheet consistency PR 3 (2026-10-05) — the exported file holds what the sheet shows. Built on a template with the
 * offer columns, two bullet columns and two document columns; the records are written by hand (what the host reads).
 */
describe('the file holds what the sheet shows (B2 inherited values, B3 offer settings, B4 long lists, B5 documents, B7 product ID type)', () => {
  const LEAD = 'fulfillment_availability#1.lead_time_to_ship_max_days', AVAILABLE = 'fulfillment_availability#1.is_inventory_available'
  const CHANNEL = 'fulfillment_availability#1.fulfillment_channel_code'
  const MIN = `purchasable_offer[marketplace_id=${IT}][audience=ALL]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax`
  const NAME = h('item_name', 1, 'value', 'it_IT'), COLOR = h('color', 1, 'value', 'it_IT'), BRAND = h('brand', 1, 'value', 'it_IT')
  const B1 = h('bullet_point', 1, 'value', 'it_IT'), B2 = h('bullet_point', 2, 'value', 'it_IT')
  const sheetKeys = [SKU, TYPE, ACTION, PARENTAGE, PARENT, ID_TYPE, ID_VALUE, NAME, BRAND, COLOR, B1, B2, MANUAL, SAFETY, PRICE, QTY, CHANNEL, LEAD, AVAILABLE, MIN]
  const sheetAliases = [
    { attribute: TYPE, aliases: { COAT: 'COAT' } }, { attribute: PARENTAGE, aliases: { 'Articolo parent': 'parent', Bambino: 'child' } },
    { attribute: ACTION, aliases: { 'Modifica (aggiornamento parziale)': 'partial_update' } },
    { attribute: ID_TYPE, aliases: { ASIN: 'asin', EAN: 'ean', UPC: 'upc', 'Esenzione GTIN': 'exempt' } },
    { attribute: AVAILABLE, aliases: { Abilitato: 'true', Disabilitato: 'false' } },
    { attribute: CHANNEL, aliases: { 'Gestito dal venditore (default)': 'DEFAULT', 'Logistica di Amazon': 'AMAZON_EU' } },
  ]
  const setup = async () => {
    const parsed = await template(sheetKeys, [sheetKeys.map(k => k === SKU ? 'GALE-JACKET' : k === TYPE ? 'COAT' : '')], { attributeSettings: b64(sheetAliases) })
    const fields = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT'] }).map((r, i) => ({ ...r, id: `f${i}` }))
    return { parsed, fields }
  }
  const options = { recordAction: 'partial_update' as const, primaryLanguage: 'it', currency: 'EUR', includePrices: true }
  const record = (sku: string, patch: Partial<AmazonExportRecord> = {}): AmazonExportRecord =>
    ({ sku, sellerSku: sku, parentSellerSku: 'GALE-JACKET', isParent: false, role: 'child', productType: 'COAT', asin: null, values: new Map(), price: 99, sale: null, ...patch })
  const offer = (leaf: AmazonOfferLeaf, live: unknown, extra: Partial<AmazonOfferExportCell> = {}): AmazonOfferExportCell => ({ leaf, live, hold: null, waiting: null, ...extra })

  it('B2 — a stored value wins, a value that follows Shared takes what Nexus sends, a cleared value stays blank and says so', async () => {
    const values = amazonExportValues(
      [{ field: 'item_name', locale: 'it', action: 'SET', value: 'Giacca Gale M' }, { field: 'color', locale: 'it', action: 'INHERIT', value: null },
        { field: 'brand', locale: '', action: 'INHERIT' }, { field: 'bullet_point', locale: 'it', action: 'CLEAR', value: null }, { field: 'material', locale: 'it', action: 'INHERIT' }],
      [{ field: 'item_name', locale: 'it', action: 'SET', value: 'Giacca Gale (Shared)' }, { field: 'color', locale: 'it', action: 'SET', value: 'Nero' },
        { field: 'brand', locale: 'it', action: 'SET', value: 'XAVIA' }, { field: 'bullet_point', locale: 'it', action: 'SET', value: ['PROTEZIONE'] }, { field: 'material', locale: 'it', action: 'SET', value: null }],
      [], 'it')
    // A field without a language reads what the primary language sends; an empty Shared value is no value.
    expect([...values.values]).toEqual([['item_name\u0000it', 'Giacca Gale M'], ['color\u0000it', 'Nero'], ['brand\u0000', 'XAVIA']])
    expect(values.inherited).toBe(2)
    expect([...values.cleared]).toEqual(['bullet_point\u0000it'])
    const { parsed, fields } = await setup()
    const out = buildAmazonTemplateRows(parsed, fields, [record('GALE-JACKET-BLACK-MEN-M', { values: values.values, cleared: values.cleared })], options)
    expect(out.rows[0]).toMatchObject({ [NAME]: 'Giacca Gale M', [COLOR]: 'Nero', [BRAND]: 'XAVIA' })
    expect(out.rows[0][B1]).toBeUndefined()
    // The inherited cells are no gap; the cleared one is not "no value".
    expect(out.gaps.filter(g => [NAME, COLOR, BRAND].includes(g.header))).toEqual([])
    expect(out.gaps.find(g => g.header === B1)).toMatchObject({ reason: 'Cleared on this listing in Nexus, so the cell is blank' })
  })

  it('B3 — the offer settings carry their LIVE values; a saved change waiting for Publish is named; parents, FBA, stock and the fulfilment method stay blank', async () => {
    const { parsed, fields } = await setup()
    const lead = amazonOfferFieldFor('fulfillment_availability__lead_time_to_ship_max_days')!, min = amazonOfferFieldFor('purchasable_offer__minimum_seller_allowed_price')!
    const records = [
      record('GALE-JACKET', { isParent: true, role: 'parent', parentSellerSku: null, offers: new Map([['lead_time_to_ship_max_days', offer('lead_time_to_ship_max_days', 2, { hold: lead.parentReason })], ['minimum_seller_allowed_price', offer('minimum_seller_allowed_price', null, { hold: min.parentReason })]]) }),
      record('GALE-JACKET-FBM', { offers: new Map<AmazonOfferLeaf, AmazonOfferExportCell>([
        ['lead_time_to_ship_max_days', offer('lead_time_to_ship_max_days', 2, { waiting: { saved: '3 days', live: '2 days', sent: true } })],
        ['is_inventory_available', offer('is_inventory_available', false)], ['minimum_seller_allowed_price', offer('minimum_seller_allowed_price', 80)],
        ['our_price', offer('our_price', { mode: 'pin', price: 99 }, { waiting: { saved: '89.00', live: '99.00', sent: true } })]]) }),
      record('GALE-JACKET-FBA', { offers: new Map([['lead_time_to_ship_max_days', offer('lead_time_to_ship_max_days', 1, { hold: FBA_FULFILMENT_REASON })], ['minimum_seller_allowed_price', offer('minimum_seller_allowed_price', 70)]]) }),
      // Offer settings not read (an older caller): the columns keep the version's reason.
      record('GALE-JACKET-OLD'),
    ]
    const out = buildAmazonTemplateRows(parsed, fields, records, options)
    const row = (sku: string) => out.rows.find(r => r[SKU] === sku)!
    expect(row('GALE-JACKET-FBM')).toMatchObject({ [LEAD]: '2', [AVAILABLE]: 'Disabilitato', [MIN]: '80', [PRICE]: '99' })
    expect(out.notes.map(n => n.note)).toEqual([
      'Price on GALE-JACKET-FBM: saved 89.00, waiting for Publish; the file holds the live 99.00.',
      'Handling time on GALE-JACKET-FBM: saved 3 days, waiting for Publish; the file holds the live 2 days.',
    ])
    expect(row('GALE-JACKET-FBA')[LEAD]).toBeUndefined()
    expect(out.blankForRow.get(`GALE-JACKET-FBA\u0000${LEAD}`)).toBe(FBA_FULFILMENT_REASON)
    expect(row('GALE-JACKET-FBA')[MIN]).toBe('70')
    expect(row('GALE-JACKET')[LEAD]).toBeUndefined()
    expect(out.blankForRow.get(`GALE-JACKET\u0000${LEAD}`)).toBe(lead.parentReason)
    expect(out.blankForRow.get(`GALE-JACKET\u0000${MIN}`)).toBe(min.parentReason)
    expect(row('GALE-JACKET-OLD')[LEAD]).toBeUndefined()
    // FBA quantity is untouchable: neither the quantity nor the fulfilment method is ever written.
    expect(out.rows.every(r => r[QTY] === undefined && r[CHANNEL] === undefined)).toBe(true)
    expect(out.blankByDesign.get(QTY)).toMatch(/Stock is not imported/)
    expect(out.gaps.filter(g => [LEAD, AVAILABLE, MIN].includes(g.header))).toEqual([])
    // Without prices, the offer's price settings are left out like the price.
    const noPrices = buildAmazonTemplateRows(parsed, fields, records, { ...options, includePrices: false })
    expect(noPrices.rows.find(r => r[SKU] === 'GALE-JACKET-FBM')).toMatchObject({ [LEAD]: '2' })
    expect(noPrices.rows.every(r => r[MIN] === undefined)).toBe(true)
    expect(noPrices.blankByDesign.get(MIN)).toBe('Prices were not requested for this file.')
  })

  it('B4 — a list longer than the template’s columns is reported: what Nexus holds, what the template takes', async () => {
    const { parsed, fields } = await setup()
    const out = buildAmazonTemplateRows(parsed, fields, [
      record('GALE-JACKET-BLACK-MEN-M', { values: new Map([['bullet_point\u0000it', ['PROTEZIONE', 'VENTILAZIONE', 'TASCHE']]]) }),
      record('GALE-JACKET-BLACK-MEN-L', { values: new Map([['bullet_point\u0000it', ['PROTEZIONE', 'VENTILAZIONE']]]) }),
    ], options)
    expect(out.rows[0]).toMatchObject({ [B1]: 'PROTEZIONE', [B2]: 'VENTILAZIONE' })
    expect(out.truncated).toEqual([{ sellerSku: 'GALE-JACKET-BLACK-MEN-M', sku: 'GALE-JACKET-BLACK-MEN-M', field: 'bullet_point', label: 'Bullet point', held: 3, columns: 2 }])
  })

  it('B5 — a document goes into the column of its own type; no type kept → the version’s column, said once', async () => {
    const { parsed, fields } = await setup()
    expect(fields.find(f => f.columnKey === SAFETY)).toMatchObject({ direction: 'in' })
    const doc = (url: string, type?: unknown) => new Map<string, unknown>([['compliance_media\u0000', url], ...(type ? [['compliance_media__content_type\u0000', type] as [string, unknown]] : [])])
    const out = buildAmazonTemplateRows(parsed, fields, [
      record('D1', { values: doc('https://example.test/safety.pdf', 'safety_information') }),
      record('D2', { values: doc('https://example.test/manual.pdf') }),
      record('D3', { values: doc('https://example.test/manual-2.pdf') }),
      record('D4', { values: doc('https://example.test/warranty.pdf', ['warranty']) }),
    ], options)
    const row = (sku: string) => out.rows.find(r => r[SKU] === sku)!
    expect([row('D1')[MANUAL], row('D1')[SAFETY]]).toEqual([undefined, 'https://example.test/safety.pdf'])
    expect(out.blankForRow.get(`D1\u0000${MANUAL}`)).toBe('Written into the column of its own content language it_IT, content type safety_information')
    expect([row('D2')[MANUAL], row('D2')[SAFETY]]).toEqual(['https://example.test/manual.pdf', undefined])
    expect([row('D4')[MANUAL], row('D4')[SAFETY]]).toEqual([undefined, undefined])
    expect(out.notes.map(n => [n.sellerSkus, n.note])).toEqual([
      [['D4'], 'Compliance media on D4: the template has no column for content type warranty, so the file leaves it blank.'],
      [['D2', 'D3'], 'Compliance media: Nexus keeps no content language or content type beside it on 2 rows, so it is written into the version\'s column (content language it_IT, content type user_manual).'],
    ])
  })

  it('B7 — the product ID keeps its own type; a code without one leaves the type blank with a required gap, never "EAN" by guess', async () => {
    const { parsed, fields } = await setup()
    const out = buildAmazonTemplateRows(parsed, fields, [
      record('U1', { values: new Map<string, unknown>([['externally_assigned_product_identifier\u0000', '012345678905'], ['externally_assigned_product_identifier__type\u0000', ['upc']]]) }),
      record('E1', { values: new Map([['externally_assigned_product_identifier\u0000', '8000000000001']]) }),
      record('A1', { asin: 'B0FXTEST01' }),
      record('L1', { asin: 'B0FXTEST02', values: new Map([['externally_assigned_product_identifier\u0000', '8000000000002']]) }),
    ], options)
    const row = (sku: string) => out.rows.find(r => r[SKU] === sku)!
    expect([row('U1')[ID_TYPE], row('U1')[ID_VALUE]]).toEqual(['UPC', '012345678905'])
    expect([row('E1')[ID_TYPE], row('E1')[ID_VALUE]]).toEqual([undefined, '8000000000001'])
    expect(out.gaps.filter(g => g.header === ID_TYPE)).toEqual([{ sellerSku: 'E1', header: ID_TYPE, required: true,
      reason: 'Product ID 8000000000001 has no product ID type in Nexus; Nexus never guesses one. Set the type in the sheet\'s Amazon columns.' }])
    expect([row('A1')[ID_TYPE], row('A1')[ID_VALUE]]).toEqual(['ASIN', 'B0FXTEST01'])
    // A live listing whose code (e.g. the Shared EAN) has no type keeps its live ASIN, with no gap.
    expect([row('L1')[ID_TYPE], row('L1')[ID_VALUE]]).toEqual(['ASIN', 'B0FXTEST02'])
  })
})

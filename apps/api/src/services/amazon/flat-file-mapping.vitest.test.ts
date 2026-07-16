/**
 * FX.3 — smart column-mapping. Pure, so all four tiers (exact-id, exact-label
 * EN+IT, normalized, Amazon alias), the confidence + source, the claim-once
 * guard, and the safe alias-skip are fully unit-testable.
 */
import { describe, it, expect } from 'vitest'
import { suggestFlatFileMapping } from './flat-file-mapping.js'

const cols = [
  { id: 'item_sku', labelEn: 'Seller SKU', labelLocal: 'SKU venditore' },
  { id: 'item_name', labelEn: 'Product Name', labelLocal: 'Nome del prodotto' },
  { id: 'externally_assigned_product_identifier', labelEn: 'Barcode (EAN/UPC)', labelLocal: '' },
  { id: 'standard_price', labelEn: 'Standard Price', labelLocal: 'Prezzo' },
  { id: 'color_name', labelEn: 'Colour', labelLocal: 'Colore' },
]
const map1 = (header: string, columns = cols) => suggestFlatFileMapping([header], columns).mappings[0]

describe('FX.3 — suggestFlatFileMapping tiers', () => {
  it('exact column id → confidence 1', () => {
    expect(map1('item_sku')).toMatchObject({ columnId: 'item_sku', source: 'exact-id', confidence: 1 })
  })
  it('exact English label', () => {
    expect(map1('Product Name')).toMatchObject({ columnId: 'item_name', source: 'exact-label' })
  })
  it('exact localized (Italian) label', () => {
    expect(map1('Nome del prodotto')).toMatchObject({ columnId: 'item_name', source: 'exact-label' })
  })
  it('normalized (case/space-insensitive) on the id', () => {
    expect(map1('Item Name')).toMatchObject({ columnId: 'item_name', source: 'normalized' })
  })
  it('Amazon alias: EAN → external identifier column', () => {
    expect(map1('EAN')).toMatchObject({ columnId: 'externally_assigned_product_identifier', source: 'alias', confidence: 0.7 })
  })
  it('alias falls through to the next existing candidate', () => {
    const reduced = [{ id: 'external_product_id', labelEn: 'Product ID' }]
    expect(map1('barcode', reduced)).toMatchObject({ columnId: 'external_product_id', source: 'alias' })
  })
  it('alias is safe: no candidate column exists → unmatched', () => {
    expect(map1('EAN', [{ id: 'item_name', labelEn: 'Product Name' }])).toMatchObject({ columnId: null, source: 'none' })
  })
})

describe('FX.3 — claim-once + unmapped sets', () => {
  it('a column is claimed by the highest tier; the loser is left unmapped', () => {
    // 'item_sku' (exact-id) and 'Seller SKU' (exact-label) both want item_sku.
    const { mappings } = suggestFlatFileMapping(['item_sku', 'Seller SKU'], cols)
    expect(mappings[0]).toMatchObject({ columnId: 'item_sku', source: 'exact-id' })
    expect(mappings[1]).toMatchObject({ columnId: null, source: 'none' })
  })
  it('reports unmappedHeaders and unmappedColumns', () => {
    const r = suggestFlatFileMapping(['item_sku', 'Mystery Field'], cols)
    expect(r.unmappedHeaders).toEqual(['Mystery Field'])
    expect(r.unmappedColumns).toEqual(['item_name', 'externally_assigned_product_identifier', 'standard_price', 'color_name'])
  })
  it('price alias resolves to standard_price; mapping order follows header order', () => {
    const r = suggestFlatFileMapping(['Price', 'Colore'], cols)
    expect(r.mappings[0]).toMatchObject({ columnId: 'standard_price', source: 'alias' })
    expect(r.mappings[1]).toMatchObject({ columnId: 'color_name', source: 'exact-label' })
  })
})

// ── A3 (XLSM hybrid) — Amazon-template attribute-path tier ──────────────────
import { canonicalizeTemplatePath } from './flat-file-mapping.js'

describe('A3 — canonicalizeTemplatePath', () => {
  it('strips qualifiers and collapses repeated #1 levels, keeping the instance index', () => {
    expect(canonicalizeTemplatePath('contribution_sku#1.value')).toBe('contribution_sku#1.value')
    expect(
      canonicalizeTemplatePath(
        'purchasable_offer[marketplace_id=APJ6JRA9NG5V4][audience=ALL]#1.our_price#1.schedule#1.value_with_tax',
      ),
    ).toBe('purchasable_offer#1.our_price.schedule.value_with_tax')
    expect(
      canonicalizeTemplatePath('item_name[marketplace_id=APJ6JRA9NG5V4][language_tag=it_IT]#1.value'),
    ).toBe('item_name#1.value')
    expect(
      canonicalizeTemplatePath('bullet_point[marketplace_id=X][language_tag=de_DE]#3.value'),
    ).toBe('bullet_point#3.value')
    expect(
      canonicalizeTemplatePath('color[marketplace_id=X][language_tag=it_IT]#1.standardized_values#1'),
    ).toBe('color#1.standardized_values')
    expect(canonicalizeTemplatePath('::record_action')).toBe('::record_action')
    // manifest fieldRef shapes canonicalize to the same keys
    expect(canonicalizeTemplatePath('item_name[marketplace_id][language_tag]#1.value')).toBe('item_name#1.value')
    expect(
      canonicalizeTemplatePath('purchasable_offer[marketplace_id]#1.our_price.schedule.value_with_tax'),
    ).toBe('purchasable_offer#1.our_price.schedule.value_with_tax')
  })
})

describe('A3 — template-path tier in suggestFlatFileMapping', () => {
  const columns = [
    { id: 'item_sku', labelEn: 'Seller SKU', fieldRef: 'contribution_sku#1.value' },
    { id: 'record_action', labelEn: 'Record Action', fieldRef: '::record_action' },
    { id: 'item_name', labelEn: 'Title', fieldRef: 'item_name[marketplace_id][language_tag]#1.value' },
    { id: 'bullet_point_2', labelEn: 'Bullet Point 2', fieldRef: 'bullet_point[marketplace_id][language_tag]#2.value' },
    {
      id: 'purchasable_offer__our_price',
      labelEn: 'Price (incl. tax)',
      fieldRef: 'purchasable_offer[marketplace_id]#1.our_price.schedule.value_with_tax',
    },
    { id: 'parent_sku', labelEn: 'Parent SKU', fieldRef: 'child_parent_sku_relationship[marketplace_id]#1.parent_sku' },
    {
      id: 'main_product_image_locator',
      labelEn: 'Main Image URL',
      fieldRef: 'main_product_image_locator[marketplace_id]#1.media_location',
    },
    { id: 'quantity', labelEn: 'Quantity', fieldRef: 'fulfillment_availability[marketplace_id]#1.quantity' },
  ]
  const MP = '[marketplace_id=APJ6JRA9NG5V4]'
  const LT = '[language_tag=it_IT]'

  it('maps real template headers at confidence 1 via canonical paths', () => {
    const headers = [
      'contribution_sku#1.value',
      '::record_action',
      `item_name${MP}${LT}#1.value`,
      `bullet_point${MP}${LT}#2.value`,
      `purchasable_offer${MP}[audience=ALL]#1.our_price#1.schedule#1.value_with_tax`,
      `child_parent_sku_relationship${MP}#1.parent_sku`,
      'fulfillment_availability#1.quantity',
    ]
    const { mappings, unmappedHeaders } = suggestFlatFileMapping(headers, columns)
    expect(unmappedHeaders).toEqual([])
    for (const m of mappings) {
      expect(m.source).toBe('template-path')
      expect(m.confidence).toBe(1)
    }
    const byHeader = new Map(mappings.map((m) => [m.header, m.columnId]))
    expect(byHeader.get('contribution_sku#1.value')).toBe('item_sku')
    expect(byHeader.get('::record_action')).toBe('record_action')
    expect(byHeader.get(`bullet_point${MP}${LT}#2.value`)).toBe('bullet_point_2')
    expect(byHeader.get(`purchasable_offer${MP}[audience=ALL]#1.our_price#1.schedule#1.value_with_tax`)).toBe(
      'purchasable_offer__our_price',
    )
    expect(byHeader.get(`child_parent_sku_relationship${MP}#1.parent_sku`)).toBe('parent_sku')
    expect(byHeader.get('fulfillment_availability#1.quantity')).toBe('quantity')
  })

  it('bridges offer-level image attributes onto product-level columns', () => {
    const { mappings } = suggestFlatFileMapping([`main_offer_image_locator${MP}#1.media_location`], columns)
    expect(mappings[0].columnId).toBe('main_product_image_locator')
    expect(mappings[0].source).toBe('template-alias')
    expect(mappings[0].confidence).toBe(0.85)
  })

  it('plain external headers never enter the template tier and still map via labels/aliases', () => {
    const { mappings } = suggestFlatFileMapping(['Title', 'Qty'], columns)
    const title = mappings.find((m) => m.header === 'Title')!
    expect(title.columnId).toBe('item_name')
    expect(title.source).not.toBe('template-path')
    const qty = mappings.find((m) => m.header === 'Qty')!
    expect(qty.columnId).toBe('quantity')
  })

  it('columns without fieldRef leave the tier inert (backwards compatible)', () => {
    const bare = [{ id: 'item_name', labelEn: 'Title' }]
    const { mappings } = suggestFlatFileMapping(['item_name[marketplace_id=X][language_tag=y]#1.value'], bare)
    // no fieldRefs → tier skipped; normalized/label tiers do not match the path
    expect(mappings[0].columnId).toBeNull()
  })
})

describe('A3.1 — volt identity aliases + suffix relaxation', () => {
  const columns = [
    { id: 'external_product_id', labelEn: 'Product ID', fieldRef: '::external_product_id' },
    { id: 'external_product_id_type', labelEn: 'Product ID Type', fieldRef: '::external_product_id_type' },
    { id: 'closure__type', labelEn: 'Closure Type', fieldRef: 'closure[marketplace_id]#1.type' },
    { id: 'rise__style', labelEn: 'Rise Style', fieldRef: 'rise[marketplace_id]#1.style' },
    { id: 'outer__material', labelEn: 'Outer Material', fieldRef: 'outer[marketplace_id]#1.material' },
  ]
  const MP = '[marketplace_id=APJ6JRA9NG5V4]'
  const LT = '[language_tag=it_IT]'

  it('maps the amzn1.volt identity pair onto the sentinel columns', () => {
    const { mappings } = suggestFlatFileMapping(
      ['amzn1.volt.ca.product_id_type', 'amzn1.volt.ca.product_id_value'],
      columns,
    )
    const byHeader = new Map(mappings.map((m) => [m.header, m]))
    expect(byHeader.get('amzn1.volt.ca.product_id_value')!.columnId).toBe('external_product_id')
    expect(byHeader.get('amzn1.volt.ca.product_id_type')!.columnId).toBe('external_product_id_type')
    expect(byHeader.get('amzn1.volt.ca.product_id_value')!.source).toBe('template-alias')
  })

  it('relaxes a trailing .value (and a trailing instance) onto sub-prop fieldRefs', () => {
    const headers = [
      `closure${MP}#1.type${LT}#1.value`,
      `rise${MP}#1.style${LT}#1.value`,
      `outer${MP}#1.material${LT}#1.value`,
      `outer${MP}#1.material${LT}#2.value`, // instance 2 — stays unmapped (claim-once; merge = A3.1b)
    ]
    const { mappings } = suggestFlatFileMapping(headers, columns)
    const byHeader = new Map(mappings.map((m) => [m.header, m.columnId]))
    expect(byHeader.get(headers[0])).toBe('closure__type')
    expect(byHeader.get(headers[1])).toBe('rise__style')
    expect(byHeader.get(headers[2])).toBe('outer__material')
    expect(byHeader.get(headers[3])).toBeNull()
    expect(mappings.find((m) => m.header === headers[0])!.source).toBe('template-path')
  })
})

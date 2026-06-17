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

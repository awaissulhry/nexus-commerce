/**
 * MS.1 — the master sheet's column merge. Pure function, no DB.
 *
 * What these lock down is the honesty of a cell: a counter that shows no cap, a "strict" list that
 * silently blocks, or a parent row flagged for a size it cannot have are all worse than an empty
 * column. Each test names the defect it would catch.
 */
import { describe, it, expect } from 'vitest'
import {
  buildSheetColumns,
  coordinatesFor,
  normaliseKey,
  type EbayAspect,
  type SheetCoordinate,
} from '../pim/sheet-columns.service.js'
import type { FieldDefinition } from '../pim/field-registry.service.js'
import type { MergedCaps, SchemaCap } from '../pim/schema-caps.js'

const AMAZON_IT: SheetCoordinate = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }
const EBAY_IT: SheetCoordinate = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true }
const SHOPIFY: SheetCoordinate = { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'id'>): FieldDefinition => ({
  label: over.label ?? over.id,
  type: 'text',
  category: 'category',
  editable: true,
  ...over,
})

/** Build a MergedCaps the way `mergeSchemaCaps` would, for one or more attributes. */
const caps = (entries: Record<string, Partial<SchemaCap> & { definedBy?: string[]; requiredBy?: string[] }>): MergedCaps => {
  const out: MergedCaps = { caps: {}, definedBy: {}, requiredBy: {} }
  for (const [name, e] of Object.entries(entries)) {
    const { definedBy, requiredBy, ...cap } = e
    out.caps[name] = { required: false, editable: true, ...cap }
    out.definedBy[name] = definedBy ?? ['COAT']
    if (requiredBy) out.requiredBy[name] = requiredBy
    else if (cap.required) out.requiredBy[name] = ['COAT']
  }
  return out
}

describe('normaliseKey', () => {
  it('joins an Amazon snake_case name to an eBay English aspect name', () => {
    // Without this the eBay cap never lands on the Amazon-derived column and the counter under-reports.
    expect(normaliseKey('outer_material')).toBe('outer_material')
    expect(normaliseKey('aspect_Outer Material')).toBe('outer_material')
    expect(normaliseKey('attr_outer_material')).toBe('outer_material')
  })
})

describe('coordinatesFor', () => {
  const rows = [
    { channel: 'AMAZON', code: 'IT', isActive: true },
    { channel: 'AMAZON', code: 'DE', isActive: true },
    { channel: 'EBAY', code: 'IT', isActive: true },
    { channel: 'SHOPIFY', code: 'GLOBAL', isActive: true },
    { channel: 'ETSY', code: 'GLOBAL', isActive: false },
  ]

  it('names channels the way the brands are written', () => {
    // 'Ebay · IT' and 'Woocommerce · GLOBAL' look like a bug to anyone who sells on them.
    const coords = coordinatesFor('IT', [...rows, { channel: 'WOOCOMMERCE', code: 'GLOBAL', isActive: true }])
    expect(coords.map((c) => c.label)).toContain('eBay · IT')
    expect(coords.map((c) => c.label)).toContain('WooCommerce · GLOBAL')
  })

  it('leaves out a channel with no presence in this market, unless it is forced in', () => {
    // Three columns of "Unlisted" for channels nobody sells on teach the operator to stop reading
    // the readiness strip; a channel being launched can still be forced in before its first listing.
    const present = new Set(['AMAZON:IT', 'EBAY:IT'])
    expect(coordinatesFor('IT', rows, { present }).map((c) => c.channel)).toEqual(['AMAZON', 'EBAY'])
    expect(coordinatesFor('IT', rows, { present, channels: ['SHOPIFY'] }).map((c) => c.channel)).toEqual(['AMAZON', 'EBAY', 'SHOPIFY'])
  })

  it('reports every active channel when presence is not supplied', () => {
    expect(coordinatesFor('IT', rows).map((c) => c.channel)).toEqual(['AMAZON', 'EBAY', 'SHOPIFY'])
  })

  it('resolves a market to a coordinate LIST and keeps the webstore out of the country market', () => {
    // The defect: filtering `marketplace = 'IT'` drops the webstore entirely (it is seeded GLOBAL),
    // so the sheet would silently lose a channel the operator publishes to.
    const coords = coordinatesFor('IT', rows)
    expect(coords.map((c) => `${c.channel}:${c.marketplace}`)).toEqual(['AMAZON:IT', 'EBAY:IT', 'SHOPIFY:GLOBAL'])
    expect(coords.find((c) => c.channel === 'SHOPIFY')!.inMarket).toBe(false)
    expect(coords.find((c) => c.channel === 'AMAZON')!.inMarket).toBe(true)
  })

  it('never leaks another country and skips inactive marketplaces', () => {
    const coords = coordinatesFor('IT', rows)
    expect(coords.some((c) => c.marketplace === 'DE')).toBe(false)
    expect(coords.some((c) => c.channel === 'ETSY')).toBe(false)
  })

  it('labels the webstore GLOBAL rather than pretending it is Italian', () => {
    expect(coordinatesFor('IT', rows).find((c) => c.channel === 'SHOPIFY')!.label).toBe('Shopify · GLOBAL')
  })
})

describe('buildSheetColumns', () => {
  it('takes the TIGHTEST cap across coordinates and records who set it', () => {
    // The defect this catches: showing Amazon's 200 when eBay refuses at 80 — the operator writes a
    // title the counter calls fine and the push is rejected.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_outer_material', label: 'Outer material' })],
      amazon: caps({ outer_material: { maxLength: 200 } }),
      ebayAspects: [{ fieldKey: 'aspect_Outer Material', label: 'Outer Material', maxLength: 80, required: false, allowedValues: null }],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns[0].maxLength).toBe(80)
    expect(columns[0].capFrom).toBe('eBay · IT')
  })

  it('keeps a cap of 0/null from wiping a real cap', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_material' })],
      amazon: caps({ material: { maxLength: 100 } }),
      ebayAspects: [{ fieldKey: 'material', label: 'Material', maxLength: null, required: false, allowedValues: null }],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns[0].maxLength).toBe(100)
    expect(columns[0].capFrom).toBe('Amazon · IT')
  })

  it('marks a variation-child-only attribute per_variant so a parent cell locks instead of flagging', () => {
    // The defect: a parent row showing "⚠ required" for a Size it can never have.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_size' }), field({ id: 'attr_material' })],
      amazon: caps({ size: {}, material: {} }),
      coordinates: [AMAZON_IT],
      variationAxes: ['Size'],
    })
    expect(columns.find((c) => c.key === 'size')!.scope).toBe('per_variant')
    expect(columns.find((c) => c.key === 'material')!.scope).toBe('global')
  })

  it('matches a variation axis against the LOCALISED label, not only the key', () => {
    // Measured on the real IT catalogue: `variationAxes` is ["Colore","Taglia"] — the operator's own
    // Italian labels — while the attributes are `color` and `size`. Key-only matching marked every
    // axis global, so a parent row offered to set one size for the whole family.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_color' }), field({ id: 'attr_size' }), field({ id: 'attr_material' })],
      amazon: caps({ color: { label: 'Colore' }, size: { label: 'Taglia' }, material: { label: 'Materiale' } }),
      coordinates: [AMAZON_IT],
      variationAxes: ['Colore', 'Taglia'],
    })
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]))
    expect(byKey.color.scope).toBe('per_variant')
    expect(byKey.size.scope).toBe('per_variant')
    expect(byKey.material.scope).toBe('global')
  })

  it('lets the catalogue’s own variation axes decide per_variant', () => {
    // The defect this catches, seen on real IT data: colour and size came from the hardcoded
    // fallback field list with no parentage, so every variation axis read as `global` and a
    // parent row offered to edit a size for the whole family.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_color' }), field({ id: 'attr_size' }), field({ id: 'attr_material' })],
      amazon: caps({ color: {}, size: {}, material: {} }),
      coordinates: [AMAZON_IT],
      variationAxes: ['Color', 'Size'],
    })
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]))
    expect(byKey.color.scope).toBe('per_variant')
    expect(byKey.size.scope).toBe('per_variant')
    expect(byKey.material.scope).toBe('global')
  })

  it('treats identifiers as per_variant whatever the schema says', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'ean', category: 'identifiers' })],
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].scope).toBe('per_variant')
  })

  it('only calls a list strict when Amazon says selection-only', () => {
    // The defect: a strict list that is really a combobox blocks a legitimate value; the design is
    // warn-never-block, and `mode` is what the cell reads to decide.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_gender', type: 'select', options: ['male', 'female'] }), field({ id: 'attr_season', type: 'select', options: ['summer'] })],
      amazon: caps({ gender: { options: ['male', 'female'], selectionOnly: true }, season: { options: ['summer'] } }),
      coordinates: [AMAZON_IT],
    })
    expect(columns.find((c) => c.key === 'gender')!.mode).toBe('strict')
    expect(columns.find((c) => c.key === 'season')!.mode).toBe('open')
  })

  it('keeps the schema enum as the option list', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_gender', type: 'select' })],
      amazon: caps({ gender: { options: ['male', 'female'] } }),
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].options).toEqual(['male', 'female'])
  })

  it('records requiredBy per coordinate, not as a boolean', () => {
    // The defect: "required" with no channel named — the operator cannot tell whether filling it
    // unblocks Amazon, eBay or nothing at all.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_brand' }), field({ id: 'attr_season' })],
      amazon: caps({ brand: { required: true }, season: {} }),
      ebayAspects: [{ fieldKey: 'brand', label: 'Brand', maxLength: null, required: true, allowedValues: null }],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns.find((c) => c.key === 'brand')!.requiredBy).toEqual(['Amazon · IT', 'eBay · IT'])
    expect(columns.find((c) => c.key === 'season')!.requiredBy).toEqual([])
  })

  it('folds an expanded column back onto its base master key', () => {
    // `bullet_point_1..5` are one master key; without expandedFields the sheet grows five columns
    // that all write the same attribute.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_bullet_point' })],
      amazon: caps({ bullet_point: { maxLength: 500 } }),
      coordinates: [AMAZON_IT],
    })
    expect(columns.filter((c) => c.key === 'bullet_point')).toHaveLength(1)
    expect(columns[0].maxLength).toBe(500)
  })

  it('drops a master attribute no coordinate in this market reads, and reports it', () => {
    const { columns, droppedKeys } = buildSheetColumns({
      fields: [field({ id: 'attr_only_in_de' }), field({ id: 'attr_material' })],
      amazon: caps({ material: {} }),
      coordinates: [AMAZON_IT],
    })
    expect(columns.map((c) => c.key)).toEqual(['material'])
    expect(droppedKeys).toEqual(['only_in_de'])
  })

  it('never drops the master’s own shape (columns, content, price) for lack of a channel schema', () => {
    const { columns, droppedKeys } = buildSheetColumns({
      fields: [
        field({ id: 'title', category: 'content' }),
        field({ id: 'basePrice', category: 'pricing', type: 'number' }),
        field({ id: 'sku', category: 'universal' }),
      ],
      coordinates: [SHOPIFY],
    })
    expect(columns.map((c) => c.key).sort()).toEqual(['basePrice', 'sku', 'title'])
    expect(droppedKeys).toEqual([])
  })

  it('routes each key to the storage a write must address', () => {
    const { columns } = buildSheetColumns({
      fields: [
        field({ id: 'title', category: 'content' }),
        field({ id: 'attr_material' }),
        field({ id: 'basePrice', category: 'pricing', type: 'number' }),
      ],
      amazon: caps({ material: {} }),
      coordinates: [AMAZON_IT],
    })
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]))
    expect(byKey.title.storage).toBe('localizedContent')
    expect(byKey.material.storage).toBe('categoryAttributes')
    expect(byKey.basePrice.storage).toBe('column')
    // The write field keeps the prefix the bulk endpoint expects.
    expect(byKey.material.writeField).toBe('attr_material')
    expect(byKey.title.writeField).toBe('title')
  })

  it('decides longtext by the KEY, never by how generous the cap is', () => {
    // Measured on the real IT schema: Amazon gives `color` a 1000-character cap and
    // `product_tax_code` 949. A cap-based rule opened a textarea for a one-word colour.
    const { columns } = buildSheetColumns({
      fields: [
        field({ id: 'description', category: 'content' }),
        field({ id: 'attr_care_instructions' }),
        field({ id: 'attr_color' }),
        field({ id: 'attr_product_tax_code' }),
        field({ id: 'attr_legal_disclaimer_description' }),
      ],
      amazon: caps({ care_instructions: { maxLength: 500 }, color: { maxLength: 1000 }, product_tax_code: { maxLength: 949 }, legal_disclaimer_description: { maxLength: 100 } }),
      coordinates: [AMAZON_IT],
    })
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]))
    expect(byKey.description.kind).toBe('longtext')
    expect(byKey.care_instructions.kind).toBe('longtext')
    expect(byKey.legal_disclaimer_description.kind).toBe('longtext')
    expect(byKey.color.kind).toBe('text')
    expect(byKey.product_tax_code.kind).toBe('text')
  })

  it('opens on the master’s own shape plus what a channel requires, not on all 174 columns', () => {
    const { columns } = buildSheetColumns({
      fields: [
        field({ id: 'title', category: 'content' }),
        field({ id: 'attr_brand', label: 'Brand' }),
        field({ id: 'attr_athlete' }),
      ],
      amazon: caps({ brand: { required: true }, athlete: {} }),
      coordinates: [AMAZON_IT],
    })
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c]))
    expect(byKey.title.defaultVisible).toBe(true)
    expect(byKey.brand.defaultVisible).toBe(true)
    expect(byKey.athlete.defaultVisible).toBe(false)
  })

  it('orders groups, then required-first inside a group', () => {
    const { columns } = buildSheetColumns({
      fields: [
        field({ id: 'attr_zeta' }),
        field({ id: 'attr_alpha' }),
        field({ id: 'title', category: 'content' }),
      ],
      amazon: caps({ zeta: { required: true }, alpha: {} }),
      coordinates: [AMAZON_IT],
    })
    expect(columns.map((c) => c.key)).toEqual(['title', 'zeta', 'alpha'])
  })

  it('carries the byte cap separately from the character cap', () => {
    // Amazon enforces UTF-8 BYTES; an Italian title inside maxLength chars can still be refused.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_title_tag' })],
      amazon: caps({ title_tag: { maxLength: 200, maxBytes: 200 } }),
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].maxLength).toBe(200)
    expect(columns[0].maxBytes).toBe(200)
  })
})

import { describe, expect, it } from 'vitest'

/**
 * E1 (Etsy publisher) — the pure builder: listing values, createDraftListing's form, the inventory PUT body and its
 * structure, listing attributes, translations and the create's own numbers. No database, no Etsy: plain fixtures with
 * fake ids (property 200 = Etsy's "Primary color"; 513/514 = Etsy's custom variation properties, R1 §3).
 */
import { buildEtsyListing, etsyAxisValues, etsyCreateForm, etsyInventory, etsyListingProperties, etsyListingValues, etsyPropertyChoice, etsyTranslations, etsyValue,
  ETSY_ZERO_STOCK_NOTE, type EtsyBuildInput, type EtsyBuildRow } from './studio-publication-etsy-build.js'
import { etsyProblems } from './studio-publication-etsy-problems.js'

const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, status: 'mapped' }]))
const MAIN = {
  title: 'Leather knee slider', description: 'A hand-stitched knee slider.', taxonomy_id: '1234', who_made: 'i_did', when_made: '2020_2026', is_supply: false,
  tags: ['moto', ' knee slider '], materials: ['leather'], shipping_profile_id: '7001', return_policy_id: '7002', readiness_state_id: '5001',
  item_weight: '120', item_weight_unit: 'g', styles: ['Racing'], should_auto_renew: false, type: 'physical',
}
const COLOR_FIELD = { fieldKey: 'property_200', label: 'Primary color', validation: { etsyValues: [{ code: '1', label: 'Black', scaleId: null }, { code: '2', label: 'Red', scaleId: null }] } }
const row = (productId: string, sku: string, extra: Partial<EtsyBuildRow> = {}): EtsyBuildRow => ({ productId, sku, cells: {}, price: 25, quantity: 4, axisValues: {}, ...extra })
const owner = (extra: Record<string, unknown> = {}) => row('p', 'FAKE-SKU-1', { cells: cells({ ...MAIN, ...extra }), price: null, quantity: 0 })
const input = (extra: Partial<EtsyBuildInput> = {}): EtsyBuildInput => ({ owner: owner(), rows: [], axes: [], fields: [], translations: [], createState: 'draft', listingId: null, ...extra })
/** A two-axis family: Primary color (a taxonomy property) and Size (a custom one). Rows listed out of SKU order on purpose. */
const family = (extra: Partial<EtsyBuildInput> = {}) => input({
  rows: [
    row('c2', 'FAKE-SKU-3', { axisValues: { color: 'Red', size: 'L' } }),
    row('c1', 'FAKE-SKU-2', { axisValues: { color: 'black', size: 'M' } }),
  ],
  axes: [
    { familyKey: 'color', label: 'Color', channelName: 'Primary color', target: 'property_200', custom: false },
    { familyKey: 'size', label: 'Size', channelName: 'Size', target: 'Size', custom: true },
  ],
  fields: [COLOR_FIELD],
  ...extra,
})

describe('listing values and the create form', () => {
  it('reads the main row in Etsy\'s shape and the create form holds the seven required fields and is_supply', () => {
    const problems = etsyProblems()
    const values = etsyListingValues(owner().cells, problems)
    expect(values).toMatchObject({ title: 'Leather knee slider', tags: ['moto', 'knee slider'], taxonomy_id: 1234, shipping_profile_id: 7001,
      classification: { who_made: 'i_did', when_made: '2020_2026', is_supply: false }, item_weight: { value: 120, unit: 'g' },
      item_dimensions: { length: null, width: null, height: null, unit: null }, production_partner_ids: [] })
    const form = etsyCreateForm(values, 5001, { price: 25, quantity: 4 })
    for (const key of ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id', 'is_supply']) expect(form).toHaveProperty(key)
    expect(form).toMatchObject({ quantity: 4, price: 25, is_supply: false, readiness_state_id: 5001, item_weight_unit: 'g' })
    // Nothing empty is sent: no dimensions, no production partners.
    expect(form).not.toHaveProperty('item_length')
    expect(form).not.toHaveProperty('production_partner_ids')
    expect(problems.issues).toEqual([])
  })

  it('a listing that exists builds the form without the POST\'s own price and quantity', () => {
    const form = etsyCreateForm(etsyListingValues(owner().cells, etsyProblems()), null, null)
    expect(form).not.toHaveProperty('price')
    expect(form).not.toHaveProperty('quantity')
    expect(form).not.toHaveProperty('readiness_state_id')
  })

  it('a unit means nothing without its value, and production partner ids are numbers in order', () => {
    const values = etsyListingValues(cells({ item_weight_unit: 'g', item_dimensions_unit: 'cm', production_partner_ids: ['30', '10'] }), etsyProblems())
    expect(values.item_weight).toEqual({ value: null, unit: null })
    expect(values.item_dimensions.unit).toBeNull()
    expect(values.production_partner_ids).toEqual([10, 30])
  })
})

describe('the inventory', () => {
  it('a two-axis family: products sorted by SKU, value ids from the taxonomy, the custom axis is 513, every *_on_property names both', () => {
    const problems = etsyProblems()
    const { inventory, structure, axisPropertyIds } = etsyInventory(family(), problems)
    expect(problems.issues).toEqual([])
    expect(axisPropertyIds).toEqual([200, 513])
    expect(inventory.products.map(p => p.sku)).toEqual(['FAKE-SKU-2', 'FAKE-SKU-3'])
    expect(inventory.products[0]).toEqual({ sku: 'FAKE-SKU-2', offerings: [{ price: 25, quantity: 4, is_enabled: true, readiness_state_id: 5001 }], property_values: [
      { property_id: 200, property_name: 'Primary color', value_ids: [1], values: ['Black'], scale_id: null },
      { property_id: 513, property_name: 'Size', value_ids: [], values: ['M'], scale_id: null },
    ] })
    expect(inventory).toMatchObject({ price_on_property: [200, 513], quantity_on_property: [200, 513], sku_on_property: [200, 513], readiness_state_on_property: [] })
    expect(structure).toEqual({
      properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }, { property_id: 513, property_name: 'Size', scale_id: null }],
      products: [
        { sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }, { property_id: 513, values: ['M'] }], readiness_state_id: 5001 },
        { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }, { property_id: 513, values: ['L'] }], readiness_state_id: 5001 },
      ],
    })
  })

  it('two custom axes take 513, then 514', () => {
    const { axisPropertyIds } = etsyInventory(family({ axes: [
      { familyKey: 'color', label: 'Colour', channelName: 'Colour', target: 'Colour', custom: true },
      { familyKey: 'size', label: 'Size', channelName: 'Size', target: 'Size', custom: true },
    ] }), etsyProblems())
    expect(axisPropertyIds).toEqual([513, 514])
  })

  it('a variation new on a listing on Etsy, set Inactive, is switched off (is_enabled false); every other offering is on', () => {
    const rows = [row('c1', 'FAKE-SKU-2', { onEtsy: true, axisValues: { color: 'Black', size: 'M' } }), row('c2', 'FAKE-SKU-3', { inactive: true, axisValues: { color: 'Red', size: 'M' } })]
    expect(etsyInventory(family({ rows, listingId: '9000000001' }), etsyProblems()).inventory.products.map(p => [p.sku, p.offerings[0].is_enabled]))
      .toEqual([['FAKE-SKU-2', true], ['FAKE-SKU-3', false]])
  })

  it('rows with different processing profiles vary the profile by property', () => {
    const rows = family().rows.map((r, index) => ({ ...r, cells: cells({ readiness_state_id: index ? '5002' : '5003' }) }))
    expect(etsyInventory(family({ rows }), etsyProblems()).inventory.readiness_state_on_property).toEqual([200, 513])
  })

  it('a single product: one product with no property values, every *_on_property empty', () => {
    const main = owner()
    const { inventory, structure } = etsyInventory(input({ owner: { ...main, price: 25, quantity: 4 }, rows: [{ ...main, price: 25, quantity: 4 }] }), etsyProblems())
    expect(inventory).toEqual({ products: [{ sku: 'FAKE-SKU-1', offerings: [{ price: 25, quantity: 4, is_enabled: true, readiness_state_id: 5001 }] }],
      price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] })
    expect(structure).toEqual({ properties: [], products: [{ sku: 'FAKE-SKU-1', values: [], readiness_state_id: 5001 }] })
  })

  it('a row\'s own mapped Etsy property cell wins over the family value', () => {
    expect(etsyAxisValues({ color: 'Black' }, [{ familyKey: 'color', target: 'property_200' }], { property_200: { value: '2', status: 'mapped' } })).toEqual({ color: '2' })
    expect(etsyAxisValues({ color: 'Black' }, [{ familyKey: 'color', target: 'property_200' }], { property_200: { value: '2', status: 'unmapped' } })).toEqual({ color: 'Black' })
    expect(etsyPropertyChoice('2', COLOR_FIELD)).toEqual({ value_ids: [2], values: ['Red'], scaleId: null })
    expect(etsyPropertyChoice('Sky', COLOR_FIELD)).toBeNull()
    expect(etsyPropertyChoice('Sky', { validation: {} })).toEqual({ value_ids: [], values: ['Sky'], scaleId: null })
  })
})

describe('the create\'s own numbers', () => {
  it('stock 0: the draft is created at quantity 1 and the review says why (W1)', () => {
    const problems = etsyProblems()
    const built = buildEtsyListing(family({ rows: family().rows.map(r => ({ ...r, quantity: 0 })) }), problems)
    expect(built.create).toEqual({ state: 'draft', price: 25, quantity: 1 })
    expect(built.inventory.products.map(p => p.offerings[0].quantity)).toEqual([0, 0])
    expect(problems.notes).toContain(ETSY_ZERO_STOCK_NOTE)
    // E3 (D2) — the note says exactly what the create does at stock 0: the POST's 1, then each variation's real 0.
    expect(ETSY_ZERO_STOCK_NOTE).toBe('Stock is 0. Etsy cannot create a listing at 0, so Nexus creates the draft with quantity 1 and then sends each variation\'s real stock (0). Etsy cannot sell at 0: the listing can go live once it has stock.')
  })

  it('stock above 0: no zero-stock note', () => {
    const problems = etsyProblems()
    buildEtsyListing(family(), problems)
    expect(problems.notes).not.toContain(ETSY_ZERO_STOCK_NOTE)
  })

  it('stock 1200: each variation is sent 999, and the review names the SKU (W2)', () => {
    const problems = etsyProblems()
    const built = buildEtsyListing(family({ rows: [row('c1', 'FAKE-SKU-2', { quantity: 1200, axisValues: { color: 'Black', size: 'M' } })] }), problems)
    expect(built.create?.quantity).toBe(999)
    expect(built.inventory.products[0].offerings[0].quantity).toBe(999)
    expect(problems.notes).toContain('FAKE-SKU-2: stock 1200 is sent as 999, the most Etsy takes for one variation.')
  })

  it('the lowest price above 0 is the draft\'s price; a listing that exists has no create numbers', () => {
    const rows = [row('c1', 'FAKE-SKU-2', { price: 30, axisValues: { color: 'Black', size: 'M' } }), row('c2', 'FAKE-SKU-3', { price: 19.5, axisValues: { color: 'Red', size: 'M' } })]
    expect(buildEtsyListing(family({ rows }), etsyProblems()).create).toEqual({ state: 'draft', price: 19.5, quantity: 8 })
    expect(buildEtsyListing(family({ rows: rows.map(r => ({ ...r, onEtsy: true })), listingId: '9000000001' }), etsyProblems()).create).toBeNull()
  })
})

describe('translations and attributes', () => {
  it('translations come from the languages after the first; one without a description is a note and is left out (W6)', () => {
    const problems = etsyProblems()
    const translations = etsyTranslations({ translations: [
      { language: 'it', cells: cells({ title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }) },
      { language: 'de', cells: cells({ title: 'Knieschleifer' }) },
    ] }, problems)
    expect(translations).toEqual([{ language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: ['moto'] }])
    expect(problems.notes).toEqual(['de translation: Etsy needs a title and a description, so it is not sent.'])
  })

  it('a property used as a variation is never repeated as a listing attribute', () => {
    const fields = [COLOR_FIELD, { fieldKey: 'property_47626759834', label: 'Material', validation: { etsyValues: [{ code: '300', label: 'Leather', scaleId: null }] } }]
    const main = cells({ property_200: '1', property_47626759834: ['leather'] })
    expect(etsyListingProperties(main, fields, [200], etsyProblems())).toEqual([{ property_id: 47626759834, property_name: 'Material', value_ids: [300], values: ['Leather'], scale_id: null }])
    expect(etsyListingProperties(main, fields, [], etsyProblems()).map(p => p.property_id)).toEqual([200, 47626759834])
  })

  it('a variation-only property\'s label loses its id ("Size (100)" is Etsy\'s "Size")', () => {
    const fields = [{ fieldKey: 'property_100', label: 'Size (100)', validation: {} }]
    expect(etsyListingProperties(cells({ property_100: 'XL' }), fields, [], etsyProblems())[0].property_name).toBe('Size')
  })
})

describe('etsyValue', () => {
  it('nothing is absent, the same way for Nexus and Etsy', () => {
    for (const raw of [null, undefined, '', '  ', [], { who_made: null, when_made: null, is_supply: null }, { value: null, unit: null }])
      expect(etsyValue('field', raw)).toEqual({ state: 'absent' })
    expect(etsyValue('translation:it', { language: 'it', title: null, description: null, tags: [] })).toEqual({ state: 'absent' })
    expect(etsyValue('property:200', { property_id: 200, property_name: 'Primary color', value_ids: [], values: [], scale_id: null })).toEqual({ state: 'absent' })
    expect(etsyValue('classification', { who_made: 'i_did', when_made: null, is_supply: null })).toEqual({ state: 'value', value: { who_made: 'i_did', when_made: null, is_supply: null } })
    expect(etsyValue('is_taxable', false)).toEqual({ state: 'value', value: false })
    expect(etsyValue('taxonomy_id', 0)).toEqual({ state: 'value', value: 0 })
  })
})

/**
 * AM.1 — adapter conformance. The one property these tests exist for: EVERY top-level property of
 * the channel's schema yields at least one column, and no shape falls through unrecognised.
 *
 * Fixtures are trimmed from the real cached definitions (AMAZON·IT OUTERWEAR fetched 2026-09-01;
 * EBAY·IT category 177104) — descriptions stripped, long enums cut to 12 — chosen for shape coverage:
 * scalar, bounded list (bullet_point 10, material 3), unbounded list (supplier_declared… 1000),
 * measure (item_weight), compound (closure, battery, fulfillment_availability, purchasable_offer),
 * nested list (closure.type), selector-only siblings (list_price.currency, hazmat.aspect),
 * value + sibling leaf (color.standardized_values), hidden + non-editable, deprecated enum.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { amazonSpecFromDefinition, AMAZON_MASTER_LINKS } from '../amazon.js'
import { ebaySpecFromCache, aspectNames } from '../ebay.js'
import { SLOT_COLUMNS_MAX, isProseKey, normaliseKey, slotKey, leafKey, humanizeKey } from '../types.js'

const here = dirname(fileURLToPath(import.meta.url))
const amazonDef = JSON.parse(readFileSync(join(here, 'fixtures/amazon-it-outerwear.trimmed.json'), 'utf8'))
const ebayDef = JSON.parse(readFileSync(join(here, 'fixtures/ebay-it-177104.json'), 'utf8'))

const amazon = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: amazonDef })
const byKey = new Map(amazon.fields.map((f) => [f.key, f]))

describe('Amazon adapter — conformance', () => {
  it('maps the declared apparel size member to the shared size concept', () => {
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { apparel_size: { type: 'array', maxItems: 1, items: { type: 'object', properties: { size: { type: 'string' }, size_class: { type: 'string' } } } } } } })
    expect(spec.fields.find(f => f.key === 'apparel_size__size')?.masterKey).toBe('size')
    expect(spec.fields.find(f => f.key === 'apparel_size__size_class')?.masterKey).toBeUndefined()
  })
  it('classifies EVERY top-level property (no exclusion path exists)', () => {
    const properties = Object.keys(amazonDef.properties).filter((k) => !k.startsWith('__'))
    const uncovered = properties.filter((p) => !amazon.coverage[p] || amazon.coverage[p].length === 0)
    expect(uncovered).toEqual([])
    expect(Object.keys(amazon.coverage).sort()).toEqual(properties.sort())
  })

  it('recognises every shape in the fixture (an unrecognised shape is a defect, not a skip)', () => {
    expect(amazon.unrecognised).toEqual([])
  })

  it('keys are unique — a compound leaf can never shadow an attribute', () => {
    const keys = amazon.fields.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('a mutation that drops one classification branch is caught (the test can fail)', () => {
    // Simulate a walker that never produced `closure__type`: the coverage witness must show it.
    const broken = { ...amazon.coverage, closure: [] }
    const uncovered = Object.entries(broken).filter(([, v]) => v.length === 0).map(([k]) => k)
    expect(uncovered).toEqual(['closure'])
  })
})

describe('Amazon adapter — shapes, measured against the real definition', () => {
  it('bullet_point is a LIST of 10 × 700 chars, required, prose', () => {
    const f = byKey.get('bullet_point')!
    expect(f.shape).toBe('list')
    expect(f.cardinality).toEqual({ min: 1, max: 10 })
    expect(f.maxLength).toBe(700)
    expect(f.kind).toBe('longtext')
    expect(f.requirement).toBe('required')
    expect(f.masterKey).toBe('bulletPoints')
    expect(f.channelStore).toEqual({ kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' })
    expect(f.selectors).toEqual(['marketplace_id', 'language_tag'])
  })

  it('generic_keyword is max 1 on this type (cardinality varies by coordinate — the adapter reports, never assumes)', () => {
    const f = byKey.get('generic_keyword')!
    expect(f.shape).toBe('scalar')
    expect(f.cardinality.max).toBe(1)
    expect(f.maxBytes).toBe(2000)
    expect(f.masterKey).toBe('keywords')
  })

  it('material is a list of 3 with an OPEN enum (anyOf string | enum)', () => {
    const f = byKey.get('material')!
    expect(f.shape).toBe('list')
    expect(f.cardinality.max).toBe(3)
    expect(f.kind).toBe('select')
    expect(f.mode).toBe('open')
    expect(f.options!.length).toBeGreaterThan(0)
  })

  it('supplier_declared_dg_hz_regulation is a list of 1000 — unbounded for the sheet', () => {
    const f = byKey.get('supplier_declared_dg_hz_regulation')!
    expect(f.shape).toBe('list')
    expect(f.cardinality.max).toBe(1000)
    expect(f.cardinality.max! > SLOT_COLUMNS_MAX).toBe(true)
  })

  it('item_weight is a MEASURE with the unit enum, not a skipped attribute', () => {
    const f = byKey.get('item_weight')!
    expect(f.shape).toBe('measure')
    expect(f.kind).toBe('number')
    expect(f.unitOptions).toEqual(['kilograms', 'grams', 'pounds', 'milligrams', 'ounces'])
    expect(f.selectors).toEqual(['marketplace_id'])
  })

  it('closure keeps the attribute key (its one sub-property IS the attribute) with the full path — a nested list of 2, open enum', () => {
    expect(byKey.has('closure__type')).toBe(false)
    const f = byKey.get('closure')!
    expect(f.attribute).toBe('closure')
    expect(f.path).toEqual(['type'])
    expect(f.shape).toBe('list')
    expect(f.cardinality.max).toBe(2)
    expect(f.mode).toBe('open')
    expect(amazon.coverage.closure).toEqual(['closure'])
  })

  it('inner.material keeps the attribute key with path [material] (minimal key, complete path)', () => {
    const f = byKey.get('inner')!
    expect(f.shape).toBe('scalar')
    expect(f.kind).toBe('text')
    expect(f.path).toEqual(['material'])
    expect(f.label).toBe('Materiale interno')
  })

  it('item_package_dimensions flattens to three measures sharing the length units', () => {
    for (const leaf of ['width', 'height', 'length']) {
      const f = byKey.get(leafKey('item_package_dimensions', leaf))!
      expect(f.shape).toBe('measure')
      expect(f.unitOptions).toContain('centimeters')
      expect(f.requiredInParent).toBe(true)
    }
  })

  it('color keeps its value leaf and gains color__standardized_values (a list of 1 with an open enum)', () => {
    expect(byKey.get('color')!.shape).toBe('scalar')
    const sv = byKey.get('color__standardized_values')!
    expect(sv.shape).toBe('scalar')
    expect(sv.cardinality.max).toBe(1)
    expect(sv.mode).toBe('open')
  })

  it('selector sub-properties are never authored: list_price.currency and hazmat.aspect', () => {
    const lp = byKey.get('list_price')!
    expect(lp.kind).toBe('number')
    expect(lp.selectors).toEqual(['marketplace_id', 'currency'])
    expect(byKey.has('list_price__currency')).toBe(false)
    const hz = byKey.get('hazmat')!
    expect(hz.kind).toBe('text')
    expect(hz.selectors).toEqual(['marketplace_id', 'aspect'])
  })

  it('language is a select LIST of 103 whose `type` is a selector', () => {
    const f = byKey.get('language')!
    expect(f.shape).toBe('list')
    expect(f.cardinality.max).toBe(103)
    expect(f.kind).toBe('select')
    expect(f.selectors).toContain('type')
  })

  it('gift_options flattens to two booleans; fulfillment_availability to its four authored leaves', () => {
    expect(byKey.get('gift_options__can_be_wrapped')!.kind).toBe('boolean')
    expect(byKey.get('gift_options__can_be_messaged')!.kind).toBe('boolean')
    expect(amazon.coverage.fulfillment_availability.sort()).toEqual([
      'fulfillment_availability__is_inventory_available',
      'fulfillment_availability__lead_time_to_ship_max_days',
      'fulfillment_availability__quantity',
      'fulfillment_availability__restock_date',
    ])
    expect(byKey.get('fulfillment_availability__restock_date')!.kind).toBe('date')
    expect(byKey.get('fulfillment_availability__is_inventory_available')!.kind).toBe('boolean')
  })

  it('battery flattens to a measure (weight) and two selects', () => {
    expect(byKey.get('battery__weight')!.shape).toBe('measure')
    expect(byKey.get('battery__cell_composition')!.kind).toBe('select')
    expect(byKey.get('battery__cell_composition_other_than_listed')!.kind).toBe('text')
  })

  it('purchasable_offer reaches its price leaves (deep compound): minimal keys, complete paths', () => {
    const keys = amazon.coverage.purchasable_offer
    expect(keys).toContain('purchasable_offer__our_price')
    // `audience` and `currency` are SELECTORS on this attribute, never authored — no leaf for them.
    expect(keys).not.toContain('purchasable_offer__audience')
    const price = byKey.get('purchasable_offer__our_price')!
    expect(price.kind).toBe('number')
    expect(price.path).toEqual(['our_price', 'schedule', 'value_with_tax'])
  })

  it('externally_assigned_product_identifier is non-editable on an existing listing; hidden leaves stay columns', () => {
    const f = byKey.get('externally_assigned_product_identifier')!
    expect(f.editable).toBe(false)
    const rel = byKey.get('child_parent_sku_relationship__child_relationship_type')!
    expect(rel.hidden).toBe(true)
    expect(rel.kind).toBe('select')
  })

  it('variation_theme is a select with deprecated options carried, never dropped', () => {
    const f = byKey.get('variation_theme')!
    expect(f.kind).toBe('select')
    expect(f.mode).toBe('strict')
    expect((f.deprecatedOptions ?? []).length).toBeGreaterThan(0)
    for (const d of f.deprecatedOptions ?? []) expect(f.options).toContain(d)
  })

  it('requirement is derived: root.required → required; allOf-gated → requiredIfRelevant; else optional', () => {
    expect(byKey.get('brand')!.requirement).toBe('required')
    expect(byKey.get('item_name')!.requirement).toBe('required')
    expect(byKey.get('batteries_included')!.requirement).toBe('requiredIfRelevant')
    expect(byKey.get('gift_options__can_be_wrapped')!.requirement).toBe('optional')
  })

  it('groups come from __propertyGroups with the localised title beside an English label', () => {
    const f = byKey.get('bullet_point')!
    expect(f.group).not.toBeNull()
    expect(f.group!.label).toBe(humanizeKey(f.group!.key))
    expect(typeof f.group!.channelLabel).toBe('string')
    expect(amazon.groups.length).toBeGreaterThan(0)
  })

  it('one concept, one column: the content trio and keywords link to their master keys', () => {
    expect(byKey.get('item_name')!.masterKey).toBe('name')
    expect(byKey.get('item_name')!.channelStore).toEqual({ kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' })
    expect(Object.keys(AMAZON_MASTER_LINKS).sort()).toEqual(['apparel_size__size', 'bullet_point', 'generic_keyword', 'item_name', 'product_description'])
  })

  it('image locators are columns (Owner: no exclusions), as uri text', () => {
    const f = byKey.get('image_locator_ps01')!
    expect(f.kind).toBe('text')
    expect(f.maxLength).toBe(2500)
  })

  it('an absent or malformed definition yields an empty spec, never a throw', () => {
    const empty = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'X', schemaDefinition: null })
    expect(empty.fields).toEqual([])
    expect(empty.unrecognised).toEqual([])
    const odd = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'X', schemaDefinition: { properties: { weird: { type: 'array', items: { type: 'object', properties: { marketplace_id: {} } } } } } })
    expect(odd.fields.length).toBe(1)
    expect(odd.fields[0].kind).toBe('text')
    expect(odd.unrecognised).toEqual(['weird: object with no authored sub-property'])
  })
})

describe('eBay adapter — conformance', () => {
  const rows = [
    { fieldKey: 'aspect_Brand', label: 'Brand', maxLength: 65, required: true, allowedValues: null, notes: 'RECOMMENDED · eBay: Marca' },
    { fieldKey: 'aspect_Features', label: 'Features', maxLength: null, required: false, allowedValues: null, notes: 'OPTIONAL · multi-value · eBay: Caratteristiche' },
    { fieldKey: 'aspect_Closure / Fastening', label: 'Closure / Fastening', maxLength: null, required: false, allowedValues: null, notes: 'OPTIONAL · multi-value · eBay: Chiusura' },
  ]
  const ebay = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: ebayDef.aspects, conditions: ebayDef.conditions, channelSchemaRows: rows })
  const byKey = new Map(ebay.fields.map((f) => [f.key, f]))

  it('every aspect and every listing-level field yields a column', () => {
    const aspectAttrs = ebayDef.aspects.map((a: { label: string }) => `aspect_${aspectNames(a)!.english}`)
    for (const a of aspectAttrs) expect(ebay.coverage[a]?.length ?? 0).toBe(1)
    expect(ebay.unrecognised).toEqual([])
    expect(ebay.fields.filter((f) => f.group?.key === 'aspects').length).toBe(ebayDef.aspects.length)
    expect(ebay.fields.filter((f) => f.group?.key !== 'aspects').length).toBeGreaterThanOrEqual(20)
  })

  it('uses explicit category metadata before generic marketplace notes and separates recommendations from requirements', () => {
    const spec = ebaySpecFromCache({
      marketplace: 'IT', categoryId: '177104',
      aspects: [{ id: 'aspect_Brand', label: 'Marca (Brand)', required: false, recommended: true, cardinality: 'SINGLE' }],
      channelSchemaRows: [{ ...rows[0], notes: 'multi-value' }],
    })
    expect(spec.fields.find((f) => f.key === 'brand')).toMatchObject({
      requirement: 'bestPractice', shape: 'scalar', cardinality: { min: 1, max: 1 },
    })
  })

  it('reads the English name out of a `Marca (Brand)` label on the older cache shape', () => {
    expect(aspectNames({ id: 'aspect_Marca', label: 'Marca (Brand)' })).toEqual({ localized: 'Marca', english: 'Brand' })
    expect(aspectNames({ id: 'aspect_Scollatura', label: 'Scollatura' })).toEqual({ localized: 'Scollatura', english: 'Scollatura' })
    expect(aspectNames({ id: 'x', label: 'Marca', localizedName: 'Marca', englishName: 'Brand' })).toEqual({ localized: 'Marca', english: 'Brand' })
  })

  it('brand is required, open-listed, keyed to the master brand, stored under the LOCALISED item specific', () => {
    const f = byKey.get('brand')!
    expect(f.requirement).toBe('required')
    expect(f.mode).toBe('open')
    expect(f.masterKey).toBe('brand')
    expect(f.label).toBe('Marca')
    expect(f.englishLabel).toBe('Brand')
    expect(f.channelStore).toEqual({ kind: 'platformAttributes', path: ['itemSpecifics', 'Marca'] })
    expect(f.maxLength).toBe(65)
  })

  it('multi-value aspects are LISTS with no invented maximum; variant-eligible aspects are flagged', () => {
    expect(byKey.get('features')!.shape).toBe('list')
    expect(byKey.get('features')!.cardinality).toEqual({ min: 1, max: null })
    expect(byKey.get('closure_fastening')!.shape).toBe('list')
    expect(byKey.get('material')!.shape).toBe('scalar')
    expect(byKey.get('size')!.variantEligible).toBe(true)
    expect(byKey.get('color')!.variantEligible).toBe(true)
  })

  it('strict lists stay strict (Stagione), open lists open (Materiale)', () => {
    expect(byKey.get('season')!.mode).toBe('strict')
    expect(byKey.get('material')!.mode).toBe('open')
  })

  it('listing-level: title 80 required → master name; condition from the cached conditions; package weight a measure', () => {
    const t = byKey.get('title')!
    expect(t.maxLength).toBe(80)
    expect(t.requirement).toBe('required')
    expect(t.masterKey).toBe('name')
    const c = byKey.get('conditionId')!
    expect(c.options).toEqual(['NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'USED_EXCELLENT'])
    expect(c.optionLabels!.NEW).toBe('Nuovo con etichette')
    const w = byKey.get('packageWeight')!
    expect(w.shape).toBe('measure')
    expect(w.channelStore).toEqual({ kind: 'platformAttributes', path: ['packageWeight'], unitPath: ['weightUnit'] })
  })

  it('the two dead registry placeholders have real successors', () => {
    expect(byKey.get('listingFormat')!.options).toEqual(['FIXED_PRICE', 'AUCTION'])
    expect(byKey.get('listingDuration')!.options).toContain('GTC')
  })
})

describe('shared rules', () => {
  it('prose is decided by KEY, never by cap size', () => {
    expect(isProseKey('bullet_point')).toBe(true)
    expect(isProseKey('bulletPoints')).toBe(true)
    expect(isProseKey('attr_product_description')).toBe(true)
    expect(isProseKey('legal_disclaimer_description')).toBe(true)
    expect(isProseKey('color')).toBe(false)
    expect(isProseKey('product_tax_code')).toBe(false)
  })
  it('slot and leaf keys follow the flat-file conventions; normaliseKey joins across channels', () => {
    expect(slotKey('bulletPoints', 3)).toBe('bulletPoints_3')
    expect(leafKey('closure', 'type')).toBe('closure__type')
    expect(normaliseKey('aspect_Outer Material')).toBe('outer_material')
    expect(normaliseKey('attr_outer_material')).toBe('outer_material')
    expect(normaliseKey('aspect_Quantità')).toBe('quantita')
    expect(normaliseKey('Unità di misura')).toBe('unita_di_misura')
    expect(humanizeKey('product_details')).toBe('Product details')
  })
})

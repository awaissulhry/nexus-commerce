/**
 * FFX.3 — pull → sync → reload round-trip contract.
 *
 * The Save/Publish data-loss bug was a self-reload, but the safety net is that a
 * legitimate DB reload must never DROP a pulled field. syncRowsToPlatform writes
 * content via buildCollapsedAttrs into ChannelListing.platformAttributes.attributes;
 * getExistingRows reads it back as `attrs.<field>?.[0]?.value`. This locks that the
 * WRITE shape matches the READ shape so no pulled content silently reverts.
 *
 * buildCollapsedAttrs is pure (no prisma), so we exercise it directly and assert
 * the readback the way getExistingRows does.
 */
import { describe, it, expect } from 'vitest'
import { AmazonFlatFileService, isBlankFeedValue, applySnapshotOverlay, buildSchemaEnumCodeMap, buildSchemaFieldHints, normalizeParentage, normalizeVariationTheme } from './flat-file.service.js'

const svc = new AmazonFlatFileService({} as any, {} as any)
// private but pure — call through an any-cast (same args syncRowsToPlatform uses)
const collapse = (row: Record<string, unknown>) =>
  (svc as any).buildCollapsedAttrs(row, {}, 'IT', 'APJ6JRA9NG5V4', 'it_IT') as Record<string, any>

// mirrors how getExistingRows reads a value back out of platformAttributes.attributes
const readBack = (attrs: Record<string, any>, key: string) => attrs[key]?.[0]?.value

describe('FFX.3 — flat-file pull round-trip contract', () => {
  it('content fields survive collapse in the shape getExistingRows reads back', () => {
    const row = {
      item_sku: 'X1',
      item_name: 'XAVIA AIR-MESH Giacca',
      brand: 'Xavia',
      product_description: 'Una giacca da moto estiva',
      generic_keyword: 'giacca moto traspirante',
      color: 'Nero',
    }
    const attrs = collapse(row)
    expect(readBack(attrs, 'item_name')).toBe('XAVIA AIR-MESH Giacca')
    expect(readBack(attrs, 'brand')).toBe('Xavia')
    expect(readBack(attrs, 'product_description')).toBe('Una giacca da moto estiva')
    expect(readBack(attrs, 'generic_keyword')).toBe('giacca moto traspirante')
    expect(readBack(attrs, 'color')).toBe('Nero')
  })

  it('bullet points round-trip in order (write order = getExistingRows read order)', () => {
    const row = { item_sku: 'X2', bullet_point: 'B1', bullet_point_2: 'B2', bullet_point_3: 'B3' }
    const attrs = collapse(row)
    // getExistingRows: bullets = attrs.bullet_point.map(b => b.value), then
    // bullet_point=bullets[0], bullet_point_2=bullets[1], ...
    const bullets = (attrs.bullet_point as any[]).map((b) => b.value)
    expect(bullets).toEqual(['B1', 'B2', 'B3'])
  })

  // F.1 — slot 1 now lives in bullet_point_1 (matching the manifest column);
  // the bare bullet_point is only a blank sentinel.
  it('bullet_point_1 (new slot-1 key) round-trips in order', () => {
    const row = { item_sku: 'X2b', bullet_point: '', bullet_point_1: 'B1', bullet_point_2: 'B2', bullet_point_3: 'B3' }
    const bullets = (collapse(row).bullet_point as any[]).map((b) => b.value)
    expect(bullets).toEqual(['B1', 'B2', 'B3'])
  })
  it('an edited bullet_point_1 is NOT clobbered by a stale bare bullet_point (the revert bug)', () => {
    const row = { item_sku: 'X2c', bullet_point: '', bullet_point_1: 'EDITED-1', bullet_point_2: 'B2' }
    const bullets = (collapse(row).bullet_point as any[]).map((b) => b.value)
    expect(bullets).toEqual(['EDITED-1', 'B2'])
  })
  it('buildJsonFeedBody reassembles bullet_point_1..N into the feed array (slot 1 not dropped)', () => {
    const svc3 = new AmazonFlatFileService({} as any, {} as any)
    const expandedFields = { bullet_point_1: 'bullet_point', bullet_point_2: 'bullet_point', bullet_point_3: 'bullet_point' }
    const feed = JSON.parse(svc3.buildJsonFeedBody(
      [{ item_sku: 'B2', item_name: 'T', bullet_point: '', bullet_point_1: 'First', bullet_point_2: 'Second', bullet_point_3: 'Third' } as any],
      'IT', 'SELLER', expandedFields,
    ))
    const bp = (feed.messages[0].attributes.bullet_point as any[]).map((b) => b.value)
    expect(bp).toEqual(['First', 'Second', 'Third'])
  })

  it('does not invent fields that were not pulled (empty in → absent out)', () => {
    const attrs = collapse({ item_sku: 'X3', item_name: 'Only a title' })
    expect(readBack(attrs, 'item_name')).toBe('Only a title')
    expect(attrs.product_description).toBeUndefined()
    expect(attrs.generic_keyword).toBeUndefined()
    expect(attrs.bullet_point).toBeUndefined()
  })

  it('main image locator uses media_location (getExistingRows reads that key)', () => {
    const attrs = collapse({ item_sku: 'X4', main_product_image_locator: 'https://img/x.jpg' })
    expect(attrs.main_product_image_locator?.[0]?.media_location).toBe('https://img/x.jpg')
  })

  // FFA.3 — the reported bug: FBA channel code dropped because the whole
  // fulfillment block was gated on quantity (FBA listings have none).
  it('FBA fulfillment channel code persists WITHOUT a quantity', () => {
    const attrs = collapse({ item_sku: 'X5', fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' })
    expect(attrs.fulfillment_availability?.[0]?.fulfillment_channel_code).toBe('AMAZON_EU')
    expect(attrs.fulfillment_availability?.[0]?.quantity).toBeUndefined()
  })
  it('FBM fulfillment keeps channel code + quantity together', () => {
    const attrs = collapse({ item_sku: 'X6', fulfillment_availability__fulfillment_channel_code: 'DEFAULT', fulfillment_availability__quantity: '20' })
    expect(attrs.fulfillment_availability?.[0]?.fulfillment_channel_code).toBe('DEFAULT')
    expect(attrs.fulfillment_availability?.[0]?.quantity).toBe(20)
  })
  it('no fulfillment data → no fulfillment_availability written', () => {
    const attrs = collapse({ item_sku: 'X7', item_name: 'x' })
    expect(attrs.fulfillment_availability).toBeUndefined()
  })
})

// FFA — "Invalid empty value provided in patch" failed entire feeds when a
// pulled cell was blank/whitespace. The feed body must omit blank attributes.
describe('isBlankFeedValue (feed empty-attribute guard)', () => {
  it('flags blank / whitespace / empty', () => {
    expect(isBlankFeedValue([])).toBe(true)
    expect(isBlankFeedValue([{ value: '', marketplace_id: 'X' }])).toBe(true)
    expect(isBlankFeedValue([{ value: '   ', marketplace_id: 'X' }])).toBe(true)
    expect(isBlankFeedValue([{ marketplace_id: 'X', language_tag: 'it_IT' }])).toBe(true) // only meta
    expect(isBlankFeedValue([{ length: { value: '', unit: '' } }])).toBe(true)
  })
  it('keeps real values (incl. 0 / false)', () => {
    expect(isBlankFeedValue([{ value: 'Nero', marketplace_id: 'X' }])).toBe(false)
    expect(isBlankFeedValue([{ value_with_tax: 0 }])).toBe(false)
    expect(isBlankFeedValue([{ fulfillment_channel_code: 'AMAZON_EU', marketplace_id: 'X' }])).toBe(false)
  })

  it('buildJsonFeedBody drops a blank cell instead of sending it', () => {
    const svc2 = new AmazonFlatFileService({} as any, {} as any)
    const feed = JSON.parse(svc2.buildJsonFeedBody(
      [{ item_sku: 'B1', item_name: 'Title', color: '   ', some_attr: '' } as any],
      'IT', 'SELLER', {},
    ))
    const attrs = feed.messages[0].attributes
    expect(attrs.item_name).toBeDefined()
    expect(attrs.color).toBeUndefined()      // whitespace-only → omitted
    expect(attrs.some_attr).toBeUndefined()  // empty → omitted
  })
})

// RR — the lossless snapshot path. The grid reads the verbatim flat row back +
// overlays only the live structured columns, so no field can silently revert.
describe('RR — applySnapshotOverlay (lossless grid round-trip)', () => {
  const snapshot = {
    item_sku: 'GALE-JACKET-BLACK-MEN-S',
    item_name: 'XAVIA GALE Giacca (pulled)',
    size: 'S', material: 'Cordura', fabric_type: '100% Nylon',
    fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU', // FBA, no qty
    fulfillment_availability__quantity: '10',
    purchasable_offer__our_price: '189.99',
  }
  const liveRow: any = {
    item_sku: 'GALE-JACKET-BLACK-MEN-S',
    item_name: 'XAVIA GALE Giacca (live title)', // changed via content tool
    purchasable_offer__our_price: '199.99',       // repriced elsewhere
    fulfillment_availability__quantity: '',        // FBA → live column empty
    _rowId: 'p1', _productId: 'p1', _isNew: false, _status: 'idle',
    _listingId: 'l1', _fieldStates: { price: 'OVERRIDE' },
  }

  it('preserves the FBA channel code + long-tail verbatim (the revert bug is gone)', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row.fulfillment_availability__fulfillment_channel_code).toBe('AMAZON_EU') // not DEFAULT
    expect(row.size).toBe('S')
    expect(row.material).toBe('Cordura')
    expect(row.fabric_type).toBe('100% Nylon')
  })
  it('overlays live price (repriced elsewhere); snapshot wins for title (not in SNAPSHOT_LIVE_OVERLAY)', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row.purchasable_offer__our_price).toBe('199.99') // live price overlaid
    expect(row.item_name).toBe('XAVIA GALE Giacca (pulled)') // snapshot title wins — not a live-overlay key
  })
  it('blanks the quantity for FBA rows (Amazon-managed; a merchant qty would flip to FBM)', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    // snapshot is AMAZON_EU (FBA) with qty 10 — we deliberately surface NO merchant
    // quantity for FBA, even though the snapshot saved one.
    expect(row.fulfillment_availability__quantity).toBe('')
  })
  it('keeps the snapshot quantity for FBM rows when the live column is empty (lossless)', () => {
    const fbmSnap = { ...snapshot, fulfillment_availability__fulfillment_channel_code: 'DEFAULT' }
    const fbmLive = { ...liveRow, fulfillment_availability__fulfillment_channel_code: 'DEFAULT', fulfillment_availability__quantity: '' }
    const row = applySnapshotOverlay(fbmSnap, fbmLive)
    expect(row.fulfillment_availability__quantity).toBe('10') // FBM: snapshot wins over empty live
  })
  it('carries internal row metadata from the live (DB) row', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row._rowId).toBe('p1')
    expect(row._isNew).toBe(false)
    expect(row._fieldStates).toEqual({ price: 'OVERRIDE' })
  })
  it('surfaces the live Follow value, overriding a snapshot saved before the column existed (FM Phase 2b)', () => {
    // The snapshot predates the Follow column (no `follow` key); the live row carries
    // it (derived from ChannelListing.followMasterQuantity). Live must win — otherwise
    // the Follow column reads blank for every previously-saved listing.
    const fbmSnap = { ...snapshot, fulfillment_availability__fulfillment_channel_code: 'DEFAULT' }
    const fbmLive = { ...liveRow, fulfillment_availability__fulfillment_channel_code: 'DEFAULT', follow: 'Pinned' }
    const row = applySnapshotOverlay(fbmSnap, fbmLive)
    expect(row.follow).toBe('Pinned')
  })
  it('keeps Follow blank for FBA rows (Amazon-managed — the grid renders it read-only)', () => {
    const fbaLive = { ...liveRow, follow: '' } // getExistingRows blanks follow for FBA
    const row = applySnapshotOverlay(snapshot, fbaLive)
    expect(row.follow).toBe('')
  })
})

// The DE feed was rejected because every push went out as a full UPDATE
// (requirements:'LISTING'), so Amazon enforced the product type's full required-
// attribute set on a partial edit. Existing edits must be PARTIAL_UPDATE.
describe('buildJsonFeedBody — operationType (partial vs full)', () => {
  const svc2 = new AmazonFlatFileService({} as any, {} as any)
  const build = (row: any) => JSON.parse(svc2.buildJsonFeedBody([row], 'IT', 'SELLER', {})).messages[0]

  it('existing-listing edit → PARTIAL_UPDATE, no requirements (no full required-attr enforcement)', () => {
    // FFP.2 — pulled rows default to record_action 'partial_update'.
    const m = build({ item_sku: 'E1', item_name: 'edited title', record_action: 'partial_update', _isNew: false })
    expect(m.operationType).toBe('PARTIAL_UPDATE')
    expect(m.requirements).toBeUndefined()
  })
  it('row with no _isNew flag (pulled listing) → PARTIAL_UPDATE', () => {
    const m = build({ item_sku: 'E2', item_name: 'edited', record_action: 'partial_update' })
    expect(m.operationType).toBe('PARTIAL_UPDATE')
  })
  it('FFP.2 — explicit full_update on an existing row → full UPDATE with requirements', () => {
    const m = build({ item_sku: 'E3', item_name: 'edited', record_action: 'full_update', _isNew: false })
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING')
  })
  it('new listing → full UPDATE with requirements:LISTING', () => {
    const m = build({ item_sku: 'N1', item_name: 'brand new', _isNew: true })
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING')
  })
  it('new parent → full UPDATE with requirements:LISTING_PRODUCT_ONLY', () => {
    const m = build({ item_sku: 'P1', parentage_level: 'parent', variation_theme: 'SIZE', _isNew: true })
    expect(m.operationType).toBe('UPDATE')
    expect(m.requirements).toBe('LISTING_PRODUCT_ONLY')
  })
  it('delete row → DELETE (regardless of _isNew)', () => {
    const m = build({ item_sku: 'D1', record_action: 'delete', _isNew: false })
    expect(m.operationType).toBe('DELETE')
    expect(m.requirements).toBeUndefined()
  })
})

// country_of_origin (and every strict enum) was submitted as the display LABEL
// ("Pakistan") instead of Amazon's CODE ("PK") → code 90244, all SKUs rejected.
// The feed must convert label→code from the schema-derived map.
describe('enum label→code conversion (country_of_origin etc.)', () => {
  const svc3 = new AmazonFlatFileService({} as any, {} as any)
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(svc3.buildJsonFeedBody([row], 'IT', 'SELLER', {}, feedSchema)).messages[0]

  describe('buildSchemaEnumCodeMap', () => {
    it('pairs enum codes with enumNames labels (label→code)', () => {
      const props = {
        country_of_origin: { items: { properties: { value: { enum: ['PK', 'IT'], enumNames: ['Pakistan', 'Italy'] } } } },
      }
      expect(buildSchemaEnumCodeMap(props).country_of_origin).toEqual({ Pakistan: 'PK', Italy: 'IT' })
    })
    it('skips fields where label === code (no conversion needed)', () => {
      const props = { size_name: { items: { properties: { value: { enum: ['M', 'L'] } } } } }
      expect(buildSchemaEnumCodeMap(props).size_name).toBeUndefined()
    })
    it('maps sub-property enums under "field.sub"', () => {
      const props = { closure: { items: { properties: { type: { enum: ['button'], enumNames: ['Button'] } } } } }
      expect(buildSchemaEnumCodeMap(props)['closure.type']).toEqual({ Button: 'button' })
    })
  })

  const coo = { enumCodeMap: { country_of_origin: { Pakistan: 'PK', Italy: 'IT' } } }
  it('converts a selected label to the Amazon code', () => {
    expect(build({ item_sku: 'C1', country_of_origin: 'Pakistan' }, coo).attributes.country_of_origin[0].value).toBe('PK')
  })
  it('passes a value that is already a code through unchanged', () => {
    expect(build({ item_sku: 'C2', country_of_origin: 'PK' }, coo).attributes.country_of_origin[0].value).toBe('PK')
  })
  it('passes an unmapped value through unchanged', () => {
    expect(build({ item_sku: 'C3', country_of_origin: 'Atlantis' }, coo).attributes.country_of_origin[0].value).toBe('Atlantis')
  })
  it('no map → value unchanged (backward compatible)', () => {
    expect(build({ item_sku: 'C4', country_of_origin: 'Pakistan' }, {}).attributes.country_of_origin[0].value).toBe('Pakistan')
  })
})

// Batch 2 — schema-typed coercion (MED-2), language_tag scoping (MED-1),
// and the parent-row parentage_level emit (HIGH-5).
describe('feed schema hints — types, localization, parent', () => {
  const svc4 = new AmazonFlatFileService({} as any, {} as any)
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(svc4.buildJsonFeedBody([row], 'IT', 'SELLER', {}, feedSchema)).messages[0]

  describe('buildSchemaFieldHints', () => {
    it('classifies localized / numeric / boolean fields from the schema', () => {
      const props = {
        item_name: { items: { properties: { value: { type: 'string' }, language_tag: {}, marketplace_id: {} } } },
        thread_count: { items: { properties: { value: { type: 'integer' }, marketplace_id: {} } } },
        is_waterproof: { items: { properties: { value: { type: 'boolean' }, marketplace_id: {} } } },
        country_of_origin: { items: { properties: { value: { type: 'string', enum: ['PK'] }, marketplace_id: {} } } },
      }
      const h = buildSchemaFieldHints(props)
      expect(h.localizedFields.has('item_name')).toBe(true)
      expect(h.localizedFields.has('country_of_origin')).toBe(false)
      expect(h.numericFields.has('thread_count')).toBe(true)
      expect(h.booleanFields.has('is_waterproof')).toBe(true)
    })
  })

  it('MED-2: numeric field coerced from string to number', () => {
    const m = build({ item_sku: 'N1', thread_count: '5' }, { numericFields: new Set(['thread_count']) })
    expect(m.attributes.thread_count[0].value).toBe(5)
  })
  it('MED-2: boolean field coerced from "true" to a real boolean', () => {
    const m = build({ item_sku: 'N2', is_waterproof: 'true' }, { booleanFields: new Set(['is_waterproof']) })
    expect(m.attributes.is_waterproof[0].value).toBe(true)
  })
  it('MED-1: language_tag only on localized fields when a schema is given', () => {
    const m = build(
      { item_sku: 'L1', material: 'Cordura', country_of_origin: 'PK' },
      { localizedFields: new Set(['material']) },
    )
    expect(m.attributes.material[0].language_tag).toBe('it_IT')
    expect(m.attributes.country_of_origin[0].language_tag).toBeUndefined()
  })
  it('MED-1: no schema → language_tag preserved on everything (legacy-safe)', () => {
    const m = build({ item_sku: 'L2', material: 'Cordura' }, {})
    expect(m.attributes.material[0].language_tag).toBe('it_IT')
  })
  it('HIGH-5: a parent row emits parentage_level=parent (+ theme)', () => {
    const m = build({ item_sku: 'P1', parentage_level: 'Parent', variation_theme: 'SIZE', _isNew: true })
    expect(m.attributes.parentage_level[0].value).toBe('parent')
    expect(m.attributes.variation_theme[0].name).toBe('SIZE') // FFP.18 — key is `name` (99022)
  })
})

// ── Phase 6 — Parentage localization end-to-end tests ─────────────────────
// These lock the three-layer fix: normalizeParentage (canonical lookup),
// applySnapshotOverlay (read healing), and buildJsonFeedBody (feed emit).

describe('normalizeParentage — label→canonical normalizer', () => {
  const IT_CODE_MAP = { 'Articolo padre': 'parent', 'Articolo figlio': 'child' }

  it('already canonical codes pass through unchanged', () => {
    expect(normalizeParentage('parent')).toBe('parent')
    expect(normalizeParentage('child')).toBe('child')
  })
  it('title-case variants normalize regardless of codeMap', () => {
    expect(normalizeParentage('Parent')).toBe('parent')
    expect(normalizeParentage('Child')).toBe('child')
    expect(normalizeParentage('PARENT')).toBe('parent')
  })
  it('localized IT labels convert to canonical via codeMap', () => {
    expect(normalizeParentage('Articolo padre', IT_CODE_MAP)).toBe('parent')
    expect(normalizeParentage('Articolo figlio', IT_CODE_MAP)).toBe('child')
  })
  it('empty string → empty string (no-op)', () => {
    expect(normalizeParentage('')).toBe('')
  })
  it('unknown value without codeMap → empty string', () => {
    expect(normalizeParentage('something_else')).toBe('')
  })
  it('localized label without codeMap → empty string (cannot resolve)', () => {
    expect(normalizeParentage('Articolo padre')).toBe('')
  })
})

describe('applySnapshotOverlay — parentage healing', () => {
  const baseSnap = { item_sku: 'X', item_name: 'Jacket', size: 'M' }
  const baseLive: any = {
    item_sku: 'X', item_name: 'Jacket (live)', parentage_level: 'parent',
    _rowId: 'r', _productId: 'p', _isNew: false, _status: 'idle',
    _listingId: 'l', _version: 1, _asin: null, _listingStatus: null,
    _fieldStates: {}, _masterValues: null,
  }

  it('Phase 1: localized label in snapshot → healed to canonical on read', () => {
    const snap = { ...baseSnap, parentage_level: 'Articolo padre' }
    const row = applySnapshotOverlay(snap, baseLive, { 'Articolo padre': 'parent', 'Articolo figlio': 'child' })
    expect(row.parentage_level).toBe('parent')
  })
  it('Phase 1: title-case "Parent" in snapshot → normalized to "parent"', () => {
    const snap = { ...baseSnap, parentage_level: 'Parent' }
    const row = applySnapshotOverlay(snap, baseLive)
    expect(row.parentage_level).toBe('parent')
  })
  it('Phase 3: empty snapshot parentage_level → fills from liveRow (Product.isParent inferred)', () => {
    const snap = { ...baseSnap, parentage_level: '' }
    const row = applySnapshotOverlay(snap, baseLive) // liveRow.parentage_level = 'parent'
    expect(row.parentage_level).toBe('parent')
  })
  it('Phase 3: missing parentage_level key in snapshot → fills from liveRow', () => {
    const row = applySnapshotOverlay(baseSnap, baseLive)
    expect(row.parentage_level).toBe('parent')
  })
  it('Phase 3: both empty → stays empty (no false positive)', () => {
    const snap = { ...baseSnap, parentage_level: '' }
    const live = { ...baseLive, parentage_level: '' }
    const row = applySnapshotOverlay(snap, live)
    expect(row.parentage_level).toBe('')
  })
  it('canonical value already correct → unchanged (no spurious mutation)', () => {
    const snap = { ...baseSnap, parentage_level: 'parent' }
    const row = applySnapshotOverlay(snap, baseLive)
    expect(row.parentage_level).toBe('parent')
  })
})

describe('buildJsonFeedBody — parentage + condition_type + variation_theme via enumCodeMap', () => {
  const svc5 = new AmazonFlatFileService({} as any, {} as any)
  const build = (row: any, feedSchema: any = {}) =>
    JSON.parse(svc5.buildJsonFeedBody([row], 'IT', 'SELLER', {}, feedSchema)).messages[0]

  const IT_SCHEMA = {
    enumCodeMap: {
      'parentage_level': { 'Articolo padre': 'parent', 'Articolo figlio': 'child' },
      'purchasable_offer.condition_type': { 'Nuovo': 'new_new', 'Usato': 'used_good' },
      'variation_theme': { 'Taglia': 'SIZE', 'Colore': 'COLOR' },
    },
  }

  it('Phase 1: localized parentage label in row → canonical code in feed', () => {
    const m = build({ item_sku: 'P1', parentage_level: 'Articolo padre', variation_theme: 'SIZE', _isNew: true }, IT_SCHEMA)
    expect(m.attributes.parentage_level[0].value).toBe('parent')
  })
  it('Phase 1: parent row emits parentage_level (was silently dropped before fix)', () => {
    const m = build({ item_sku: 'P2', parentage_level: 'parent', variation_theme: 'SIZE', _isNew: true }, IT_SCHEMA)
    expect(m.attributes.parentage_level).toBeDefined()
    expect(m.attributes.parentage_level[0].value).toBe('parent')
  })
  it('Phase 2: localized condition_type → canonical code in offer', () => {
    const m = build(
      { item_sku: 'C1', purchasable_offer__condition_type: 'Nuovo', purchasable_offer__our_price: '99' },
      IT_SCHEMA,
    )
    const offer = m.attributes.purchasable_offer?.[0]
    expect(offer?.condition_type).toBe('new_new')
  })
  it('Phase 2: already-canonical condition_type passes through unchanged', () => {
    const m = build(
      { item_sku: 'C2', purchasable_offer__condition_type: 'new_new', purchasable_offer__our_price: '99' },
      IT_SCHEMA,
    )
    expect(m.attributes.purchasable_offer?.[0]?.condition_type).toBe('new_new')
  })
  it('Phase 2: localized variation_theme → canonical code in feed', () => {
    const m = build(
      { item_sku: 'V1', parentage_level: 'parent', variation_theme: 'Taglia', _isNew: true },
      IT_SCHEMA,
    )
    expect(m.attributes.variation_theme?.[0]?.name).toBe('SIZE') // FFP.18 — key is `name` (99022)
  })
  it('child row emits parentage_level + child_parent_sku_relationship', () => {
    const m = build(
      { item_sku: 'CH1', parentage_level: 'child', parent_sku: 'PAR1' },
      IT_SCHEMA,
    )
    expect(m.attributes.parentage_level[0].value).toBe('child')
    expect(m.attributes.child_parent_sku_relationship[0].parent_sku).toBe('PAR1')
  })
})

// FFP.13 — the Operation column must round-trip losslessly: a saved
// record_action (delete included) survives reload; only genuinely live
// fields (price/qty/ASIN) are overlaid from the DB row.
describe('FFP.13 — applySnapshotOverlay keeps record_action', () => {
  const live = {
    _rowId: 'p1', _productId: 'p1', _isNew: false, _status: 'idle',
    item_sku: 'SKU-1', record_action: 'partial_update',
    purchasable_offer__our_price: '49.9',
    fulfillment_availability__quantity: '7',
  } as never

  it("snapshot record_action='delete' survives the overlay", () => {
    const out = applySnapshotOverlay({ item_sku: 'SKU-1', record_action: 'delete', item_name: 'saved' }, live)
    expect(out.record_action).toBe('delete')
    expect(out.item_name).toBe('saved')
  })

  it('live price/qty still win over the snapshot', () => {
    const out = applySnapshotOverlay(
      { item_sku: 'SKU-1', record_action: 'delete', purchasable_offer__our_price: '1.0', fulfillment_availability__quantity: '99' },
      live,
    )
    expect(out.purchasable_offer__our_price).toBe('49.9')
    expect(out.fulfillment_availability__quantity).toBe('7')
    expect(out.record_action).toBe('delete')
  })
})

// FFP.19 — variation_theme values normalize onto the category's approved enum
// (legacy Seller-Central spellings, localized labels, case/separator variants).
describe('FFP.19 — normalizeVariationTheme', () => {
  const themeMap = {
    'Taglia/Colore': 'SIZE/COLOR',
    'Colore': 'COLOR',
    'Taglia nome/Colore nome': 'SIZE_NAME/COLOR_NAME',
  }
  it('legacy SizeName-ColorName → SIZE_NAME/COLOR_NAME (prefers *_NAME style + input order)', () => {
    const map = { ...themeMap, 'Colore nome/Taglia nome': 'COLOR_NAME/SIZE_NAME' }
    expect(normalizeVariationTheme('SizeName-ColorName', map)).toBe('SIZE_NAME/COLOR_NAME')
  })
  it('Size-Color → SIZE/COLOR (prefers non-NAME style)', () => {
    expect(normalizeVariationTheme('Size-Color', themeMap)).toBe('SIZE/COLOR')
  })
  it('localized label maps directly', () => {
    expect(normalizeVariationTheme('Taglia/Colore', themeMap)).toBe('SIZE/COLOR')
  })
  it('approved code passes through with canonical casing', () => {
    expect(normalizeVariationTheme('size/color', themeMap)).toBe('SIZE/COLOR')
  })
  it('order-insensitive axis match', () => {
    expect(normalizeVariationTheme('ColorName_SizeName', themeMap)).toBe('SIZE_NAME/COLOR_NAME')
  })
  it('unknown value passes through untouched', () => {
    expect(normalizeVariationTheme('FLAVOR', themeMap)).toBe('FLAVOR')
    expect(normalizeVariationTheme('', themeMap)).toBe('')
  })
})

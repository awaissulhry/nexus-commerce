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
import { AmazonFlatFileService, isBlankFeedValue, applySnapshotOverlay } from './flat-file.service.js'

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
  it('overlays live structured columns (price/title repriced/edited elsewhere)', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row.purchasable_offer__our_price).toBe('199.99')
    expect(row.item_name).toBe('XAVIA GALE Giacca (live title)')
  })
  it('keeps the snapshot value when the live column is empty', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row.fulfillment_availability__quantity).toBe('10') // snapshot wins over empty live
  })
  it('carries internal row metadata from the live (DB) row', () => {
    const row = applySnapshotOverlay(snapshot, liveRow)
    expect(row._rowId).toBe('p1')
    expect(row._isNew).toBe(false)
    expect(row._fieldStates).toEqual({ price: 'OVERRIDE' })
  })
})

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
import { AmazonFlatFileService } from './flat-file.service.js'

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

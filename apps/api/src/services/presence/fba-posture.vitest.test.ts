import { expect, it } from 'vitest'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { fbaPosture, type FbaPostureInput } from './fba-posture.js'

const coordinate = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
const named = { coordinate, sku: 'SKU', sellerSku: null, sellerSkuSource: null, accountLabel: 'Seller', aliasLabel: null, label: 'SKU · AMAZON · IT · Seller · primary alias' }
const detail = { id: 'detail', productId: 'p', sku: 'SKU', asin: 'ASIN', marketplaceId: 'italy', fulfillmentCenterId: 'FC', quantity: 6, condition: 'SELLABLE', lastSyncedAt: '2026-09-12T12:00:00.000Z' }
const fixture = (patch: Partial<FbaPostureInput> = {}): FbaPostureInput => ({
  product: { id: 'p', sku: 'SKU', fulfillmentMethod: 'FBM' }, listings: [{ ...coordinate, externalListingId: 'ASIN', offers: [] }],
  stock: [], inventory: [], markets: [{ code: 'IT', marketplaceId: 'italy', fbaProgram: 'DOMESTIC' }],
  target: coordinate, namedCoordinates: [named], error: null, ...patch,
})
it.each([
  ['product fulfilment', { product: { fulfillmentMethod: 'FBA', sku: 'SKU' } }],
  ['positive FBA stock', { stock: [{ quantity: 7, location: { code: 'AMAZON-EU-FBA' } }] }],
  ['listing fulfilment', { listings: [{ ...coordinate, fulfillmentMethod: 'FBA' }] }],
  ['active FBA offer', { listings: [{ ...coordinate, offers: [{ sku: 'FBA-SKU', fulfillmentMethod: 'FBA', isActive: true }] }] }],
])('agrees with the canonical fail-closed predicate on %s and never turns missing detail into zero', (_name, patch) => {
  const input = fixture(patch as Partial<FbaPostureInput>)
  const row = input.listings[0]
  expect(isFbaCoordinate(row, input.product, { fbaStockQty: Number(input.stock[0]?.quantity ?? 0), hasActiveFbaOffer: Array.isArray(row.offers) && row.offers.some(offer => offer.isActive && offer.fulfillmentMethod === 'FBA') })).toBe(true)
  expect(fbaPosture(input)).toMatchObject({ status: 'unavailable', rows: [{ isFba: true, units: null }] })
  expect(fbaPosture(fixture({ inventory: [detail] }))).toMatchObject({ status: 'ok', rows: [{ isFba: true, units: 6 }] })
})
it.each([
  ['sku', { ...detail, productId: null, asin: null }],
  ['asin', { ...detail, productId: null, sku: 'OTHER-SKU' }],
])('finds orphan inventory by %s and preserves provenance', (matchedBy, row) => {
  expect(fbaPosture(fixture({ inventory: [row] }))).toMatchObject({ status: 'ok', rows: [{ units: 6, detail: [expect.objectContaining({ matchedBy })] }] })
})
it('includes Offer.sku, splits conditions and uses the oldest contributing snapshot', () => {
  const result = fbaPosture(fixture({ listings: [{ ...coordinate, offers: [{ sku: 'FBA-SKU' }] }], inventory: [
    { ...detail, productId: null, sku: 'FBA-SKU' }, { ...detail, id: 'unsellable', condition: 'UNSELLABLE', quantity: 2, lastSyncedAt: '2026-09-11T12:00:00.000Z' },
  ] }))
  expect(result).toMatchObject({ asOf: '2026-09-11T12:00:00.000Z', rows: [{ units: 8, sellable: 6, notSellable: 2, accountAttribution: 'account-unattributed' }] })
})
it('reports a measured zero independently of an absent snapshot', () => {
  expect(fbaPosture(fixture({ inventory: [{ ...detail, quantity: 0 }] })).rows[0].units).toBe(0)
  expect(fbaPosture(fixture()).rows[0].units).toBeNull()
})
it('names actual pooled coordinates and totals distinct centres once', () => {
  const result = fbaPosture(fixture({ markets: [{ code: 'IT', marketplaceId: 'italy', fbaProgram: 'PAN_EU' }, { code: 'DE', marketplaceId: 'germany', fbaProgram: 'PAN_EU' }],
    inventory: [detail, { ...detail, id: 'german-view', marketplaceId: 'germany', fulfillmentCenterId: 'FC-DE' }], namedCoordinates: [named, { ...named, coordinate: { ...coordinate, marketplace: 'DE' } }],
  }))
  expect(result).toMatchObject({ status: 'ok', rows: [{ pooled: true, units: 12, quantityScope: 'eu-pooled', pooledAcross: [named, expect.objectContaining({ coordinate: { ...coordinate, marketplace: 'DE' } })] }] })
})
it('does not label stock-only FBA evidence as a fulfillment-method declaration', () => {
  const result = fbaPosture(fixture({ stock: [{ quantity: 5, location: { code: 'AMAZON-EU-FBA' } }] }))
  expect(result.rows[0].via).toEqual(['stockLevel'])
})
it('conflicting pooled snapshots and failed sources keep the quantity unknown', () => {
  expect(fbaPosture(fixture({ markets: [{ code: 'IT', marketplaceId: 'italy', fbaProgram: 'PAN_EU' }], inventory: [detail, { ...detail, quantity: 8, marketplaceId: 'germany' }] }))).toMatchObject({ status: 'unavailable', rows: [{ units: null }] })
  expect(fbaPosture(fixture({ inventory: [detail], error: new Error('stock read failed') }))).toMatchObject({ status: 'unavailable', rows: [{ units: null }] })
  expect(fbaPosture(fixture({ error: new Error('read failed') })).rows[0].isFba).toBeNull()
})
it('does not claim Amazon coverage for another channel or an unknown market', () => {
  expect(fbaPosture(fixture({ target: { ...coordinate, channel: 'EBAY' } }))).toMatchObject({ status: 'unavailable', rows: [] })
  expect(fbaPosture(fixture({ markets: [] }))).toMatchObject({ status: 'unavailable', refusal: expect.stringContaining('marketplace') })
})

it('does not infer a shared physical lot from equal quantities in two market snapshots', () => {
  const result = fbaPosture(fixture({ markets: [{ code: 'IT', marketplaceId: 'italy', fbaProgram: 'PAN_EU' }], inventory: [detail, { ...detail, id: 'other-market', marketplaceId: 'germany' }] }))
  expect(result).toMatchObject({ status: 'unavailable', rows: [{ pooled: true, units: null }] })
})

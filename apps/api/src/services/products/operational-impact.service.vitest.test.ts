import { beforeEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No channel transport is allowed') }))
  return Object.fromEntries(['product', 'channelListing', 'orderItem', 'bundle', 'bundleComponent', 'fbaInventoryDetail', 'stockLevel', 'adProductAd', 'marketplace'].map(name => [name, { findMany: vi.fn() }]))
})
vi.mock('../../db.js', () => ({ default: db }))
import { parseOperationalImpact, readHardDeletePreflight, readOperationalImpact } from './operational-impact.service.js'

const coordinate = { productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' }
const listing = { ...coordinate, id: 'listing', externalListingId: 'ASIN', region: 'IT', offers: [], product: { sku: 'SKU' }, channelConnection: { name: 'Seller' }, alias: null }
const observedAt = new Date('2026-09-13T12:00:00Z')
const read = async (target: typeof coordinate | { productId: string } = coordinate, verb = 'offer-toggle') => (await readOperationalImpact({ verb, targets: [target] })).targets[0].checks

beforeEach(() => {
  vi.clearAllMocks()
  for (const model of Object.values(db)) model.findMany.mockResolvedValue([])
  db.product.findMany.mockResolvedValue([{ id: 'p', sku: 'SKU', fulfillmentMethod: 'FBM' }])
  db.channelListing.findMany.mockResolvedValue([listing])
  db.marketplace.findMany.mockResolvedValue([{ code: 'IT', marketplaceId: 'italy', fbaProgram: 'DOMESTIC' }])
})

it.each(['channel', 'marketplace', 'channelConnectionId', 'aliasKey'])('refuses a partial coordinate naming missing %s', key => {
  const incomplete = { ...coordinate } as Record<string, unknown>
  delete incomplete[key]
  expect(() => parseOperationalImpact({ verb: 'hold', targets: [incomplete] })).toThrow(key)
  expect(parseOperationalImpact({ verb: 'hold', targets: [coordinate] }).targets).toEqual([coordinate])
})
it('caps, deduplicates and rejects unsupported per-target offer scope without widening', () => {
  expect(() => parseOperationalImpact({ verb: 'hold', targets: Array(201).fill(coordinate) })).toThrow('200')
  expect(() => parseOperationalImpact({ verb: 'hold', targets: [coordinate, coordinate] })).toThrow('Duplicate')
  expect(() => parseOperationalImpact({ verb: 'hold', targets: [{ ...coordinate, offerScope: 'FBM' }] })).toThrow('offerScope')
  expect(parseOperationalImpact({ verb: 'hard-delete', targets: [{ productId: 'p' }] }).targets).toEqual([{ productId: 'p' }])
})
it('partitions all five listing levels while retaining held ENDED identities', async () => {
  db.channelListing.findMany.mockResolvedValue([
    { ...listing, listingStatus: 'ENDED' }, { ...listing, productId: 'other' }, { ...listing, channel: 'EBAY' },
    { ...listing, marketplace: 'DE' }, { ...listing, channelConnectionId: 'other' }, { ...listing, aliasKey: 'other' },
    { ...listing, externalListingId: ' ' },
  ])
  const checks = await read()
  expect(checks.channelListings.rows).toHaveLength(1)
  expect(checks.channelListings.rows[0]).toMatchObject({ id: 'listing', listingStatus: 'ENDED' })
  expect(db.channelListing.findMany.mock.calls[0][0].where.listingStatus).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
it('does not narrow away FBA offers on unsent listings while reading impact', async () => {
  const draft = { ...listing, externalListingId: null, fulfillmentMethod: 'FBA', offers: [{ sku: 'FBA-DRAFT-SKU', isActive: true, fulfillmentMethod: 'FBA' }] }
  db.channelListing.findMany.mockImplementation(async (args: any) => args.where.externalListingId ? [] : [draft])
  const result = await read()
  expect(result.channelListings.rows).toEqual([])
  expect(result.fbaPosture).toMatchObject({ status: 'unavailable', rows: [{ isFba: true, units: null }] })
  expect(db.fbaInventoryDetail.findMany.mock.calls[0][0].where.OR).toContainEqual({ sku: { in: ['SKU', 'FBA-DRAFT-SKU'] } })
})
it('includes null-market orders as unknown without claiming an alias filter', async () => {
  db.orderItem.findMany.mockResolvedValue([
    { productId: 'p', order: { id: 'yes', channel: 'AMAZON', marketplace: null, channelConnectionId: 'account' } },
    { productId: 'p', order: { id: 'foreign-market', channel: 'AMAZON', marketplace: 'DE', channelConnectionId: 'account' } },
    { productId: 'p', order: { id: 'foreign-account', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'other' } },
  ])
  expect((await read()).openOrders.rows).toEqual([expect.objectContaining({ orderId: 'yes', marketplaceUnknown: true, aliasScoped: false })])
  expect((await read({ ...coordinate, channel: 'UNMAPPED' })).openOrders.status).toBe('unavailable')
  expect(db.orderItem.findMany.mock.calls[0][0].where).not.toHaveProperty('OR')
})
it('names the master and all its selling coordinates for a component bundle', async () => {
  db.bundleComponent.findMany.mockResolvedValue([{ productId: 'p', bundleId: 'kit', bundle: { productId: 'master', name: 'Winter kit' } }])
  db.channelListing.findMany.mockImplementation(async (args: any) => args.where.productId.in.includes('master') ? [{ ...listing, productId: 'master' }] : [listing])
  const bundles = (await read()).activeBundles
  expect(bundles).toMatchObject({ scope: 'product', status: 'ok', rows: [{ role: 'component', bundleName: 'Winter kit', masterProductId: 'master', masterCoordinates: [expect.objectContaining({ coordinate: { ...coordinate, productId: 'master' } })] }] })
})
it('retains variation-level stock holds and keeps them advisory', async () => {
  db.stockLevel.findMany.mockResolvedValue([{ id: 'stock', productId: 'p', variationId: 'variant', quantity: 10, lastSyncedAt: observedAt, reservations: [{ id: 'reservation', kind: 'HARD', orderId: 'order', quantity: 2 }] }])
  const holds = (await read({ productId: 'p' }, 'delete-variant')).stockHolds
  expect(holds).toMatchObject({ status: 'ok', scope: 'product', blocking: false, asOf: observedAt.toISOString(), rows: [expect.objectContaining({ variationId: 'variant', reservations: [expect.objectContaining({ orderId: 'order' })] })] })
  expect(db.stockLevel.findMany.mock.calls[0][0].select.reservations.where).toEqual({ kind: 'HARD', releasedAt: null, consumedAt: null, orderId: { not: null } })
  expect((await read()).stockHolds).toMatchObject({ blocking: false, rows: [] })
})
it('matches orphan ads by ASIN and labels cumulative spend and its age', async () => {
  db.adProductAd.findMany.mockResolvedValue([{ id: 'ad', productId: null, asin: 'ASIN', spendCents: 421, lastSyncedAt: observedAt, adGroup: { campaignId: 'campaign' } }, { id: 'foreign', productId: 'other', asin: 'FOREIGN' }])
  expect((await read()).advertising).toMatchObject({ status: 'ok', blocking: false, asOf: observedAt.toISOString(), rows: [{ id: 'ad', campaignId: 'campaign', spendCents: 421, spendSentence: 'Cumulative recorded spend, as of lastSyncedAt.', nextStep: 'suppressCampaignBids' }] })
  expect(db.adProductAd.findMany.mock.calls[0][0].where).toMatchObject({ status: 'ENABLED', OR: [{ productId: { in: ['p'] } }, { asin: { in: ['ASIN'] } }] })
})
it.each([
  ['channelListing', 'channelListings'], ['orderItem', 'openOrders'], ['bundle', 'activeBundles'], ['bundleComponent', 'activeBundles'],
  ['fbaInventoryDetail', 'fbaPosture'], ['stockLevel', 'stockHolds'], ['adProductAd', 'advertising'],
])('isolates a failed %s read in %s with other checks still readable', async (model, key) => {
  db[model].findMany.mockRejectedValue(new Error('read failed'))
  const checks = await read({ productId: 'p' }, 'hard-delete')
  expect(checks[key as keyof typeof checks]).toMatchObject({ status: 'unavailable', refusal: expect.any(String) })
  expect(checks[model === 'orderItem' ? 'channelListings' : 'openOrders'].status).toBe('ok')
  expect(checks.stockHolds.blocking).toBe(false)
  expect(checks.advertising.blocking).toBe(false)
})
it.each(['channelListing', 'orderItem', 'bundle', 'bundleComponent', 'fbaInventoryDetail'])('preserves legacy GET failure for original query %s', async model => {
  db[model].findMany.mockRejectedValue(new Error('original query failed'))
  await expect(readHardDeletePreflight(['p'])).rejects.toThrow('original query failed')
})
it.each(['stockLevel', 'adProductAd'])('does not turn advisory %s failure into a legacy GET 500', async model => {
  db[model].findMany.mockRejectedValue(new Error('new check failed'))
  const preflight = await readHardDeletePreflight(['p'])
  expect(preflight.channelListings).toEqual([{ productId: 'p', channel: 'AMAZON', marketplace: 'IT', externalListingId: 'ASIN' }])
  expect(preflight).toMatchObject({ openOrders: [], activeBundles: [], fbaInventory: [], confirmPhrase: 'SKU', refusal: null })
  expect(preflight.checks[0][model === 'stockLevel' ? 'stockHolds' : 'advertising']).toMatchObject({ status: 'unavailable', blocking: false })
  expect(db.channelListing.findMany.mock.calls[0][0].where).toEqual({ productId: { in: ['p'] }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, externalListingId: { not: null } })
  expect(db.fbaInventoryDetail.findMany.mock.calls[0][0].where).toEqual({ productId: { in: ['p'] }, quantity: { gt: 0 } })
})
it('keeps legacy bundle roles and inventory condition, and requires exact single-product SKU confirmation', async () => {
  db.bundle.findMany.mockResolvedValue([{ productId: 'p', id: 'kit' }])
  db.bundleComponent.findMany.mockResolvedValue([{ productId: 'p', bundleId: 'other-kit' }])
  db.fbaInventoryDetail.findMany.mockResolvedValue([{ productId: 'p', marketplaceId: 'italy', fulfillmentCenterId: 'FC', quantity: 2, condition: 'UNSELLABLE' }])
  const value = await readHardDeletePreflight(['p'])
  expect(value.activeBundles).toEqual([{ productId: 'p', bundleId: 'kit', role: 'master' }, { productId: 'p', bundleId: 'other-kit', role: 'component' }])
  expect(value.fbaInventory[0].condition).toBe('UNSELLABLE')
  expect((await readHardDeletePreflight(['p', 'other'])).confirmPhrase).toBeNull()
  db.product.findMany.mockRejectedValue(new Error('metadata read failed'))
  expect(await readHardDeletePreflight(['p'])).toMatchObject({ confirmPhrase: null, refusal: expect.stringContaining('SKU') })
})
it('batches 200 products without per-target queries', async () => {
  await readOperationalImpact({ verb: 'hard-delete', targets: Array.from({ length: 200 }, (_, i) => ({ productId: `p-${i}` })) })
  for (const model of Object.values(db)) expect(model.findMany).toHaveBeenCalledTimes(1)
})

import { describe, expect, it, vi } from 'vitest'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => {}) } }))
vi.mock('../stock-movement.service.js', () => ({ applyStockMovement: vi.fn() }))
vi.mock('../categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
const belt = vi.hoisted(() => vi.fn(async () => new Set<string>()))
vi.mock('../amazon-market-offer.service.js', () => ({ closedMarketSet: belt }))
import { applyAmazonOfferPushLock, AmazonFlatFileService } from './flat-file.service.js'

describe('the sanctioned offerActive/skip_offer pairing', () => {
  it.each([{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))])('stored lock %j overrides an attempted skip_offer clear', lock => {
    const attributes = { skip_offer: [{ value: false, marketplace_id: 'IT' }] }
    expect(applyAmazonOfferPushLock({ offerActive: true, ...lock }, attributes, 'IT')?.code).toMatch(/^PUSH_/)
    expect(attributes.skip_offer).toEqual([{ value: true, marketplace_id: 'IT' }])
  })
  it('preserves an explicitly paused Amazon offer even without a timestamp', () => {
    const attributes: any = {}
    applyAmazonOfferPushLock({ offerActive: false }, attributes, 'IT')
    expect(attributes.skip_offer[0].value).toBe(true)
  })
  it('closedMarketSet belt suppresses a stale row that otherwise appears unlocked', () => {
    const attributes: any = {}
    expect(applyAmazonOfferPushLock({ offerActive: true }, attributes, 'IT', true)?.code).toBe('PUSH_OFFER_CLOSED')
    expect(attributes.skip_offer[0].value).toBe(true)
  })
  it('acknowledged reopen control: no timestamp, LIVE intent and active offer can clear suppression', () => {
    const attributes: any = {}
    expect(applyAmazonOfferPushLock({ offerActive: true, offerClosedAt: null, presenceIntent: 'LIVE' }, attributes, 'IT')).toBeNull()
    expect(attributes.skip_offer[0].value).toBe(false)
  })
})

describe('direct flat-file feed boundary', () => {
  it('refuses stale request data, while the unlocked control reaches a correctly suppressed feed body', async () => {
    const listing: any = { id: 'l', productId: 'p', product: { sku: 'FIXTURE' }, syncPaused: false, offerClosedAt: null, offerActive: false }
    const findMany = vi.fn(async () => [listing])
    const service = new AmazonFlatFileService({ channelListing: { findMany } } as any, {} as any)
    const rows = [{ item_sku: 'FIXTURE', product_type: 'OUTERWEAR', record_action: 'partial_update', skip_offer: 'false', _listingId: 'l' }] as any
    listing.presenceIntent = 'ENDED'
    const refused = await service.prepareRowsForPush(rows, 'IT')
    expect(refused.rows).toEqual([])
    expect(refused.refusals[0].code).toBe('PUSH_INTENT_ENDED')
    listing.presenceIntent = 'LIVE'
    const allowed = await service.prepareRowsForPush(rows, 'IT')
    expect(allowed.refusals).toEqual([])
    const report = service.buildJsonFeedBodyWithReport(allowed.rows, 'IT', 'seller', {}, { booleanFields: new Set(['skip_offer']), localizedFields: new Set() })
    expect(JSON.parse(report.body).messages[0].attributes.skip_offer).toEqual([{ value: true, marketplace_id: 'APJ6JRA9NG5V4' }])
    expect(findMany).toHaveBeenCalledWith({ where: { channel: 'AMAZON', marketplace: 'IT', product: { sku: { in: ['FIXTURE'] } } }, include: { product: { select: { sku: true } } } })
  })
  it('refuses a permanent delete and an ambiguous account without choosing a target', async () => {
    const service = new AmazonFlatFileService({ channelListing: { findMany: async () => [
      { id: 'a', productId: 'p', product: { sku: 'FIXTURE' } }, { id: 'b', productId: 'p', product: { sku: 'FIXTURE' } },
    ] } } as any, {} as any)
    const result = await service.prepareRowsForPush([{ item_sku: 'FIXTURE' }, { item_sku: 'FIXTURE', record_action: 'delete' }] as any, 'IT')
    expect(result.rows).toEqual([])
    expect(result.refusals.map(r => r.code)).toEqual(['PUSH_COORDINATE_AMBIGUOUS', 'PUSH_LIFECYCLE_REFUSED'])
  })
})

describe('flat-file end uses the same complete coordinate for pre-read and write', () => {
  it.each([null, 'account-b'])('preserves explicit account %j and alias without touching a sibling', async channelConnectionId => {
    const findFirst = vi.fn(async () => ({ id: 'target' })), updateMany = vi.fn(async () => ({ count: 1 }))
    const service = new AmazonFlatFileService({ product: { findMany: async () => [{ id: 'product', sku: 'FIXTURE' }] }, channelListing: { findFirst, updateMany } } as any, {} as any)
    const row = { item_sku: 'FIXTURE', record_action: 'delete', _listingId: 'target', _channelConnectionId: channelConnectionId, _aliasKey: 'alias-b' }
    await service.syncRowsToPlatform([row] as any, 'IT')
    const where = { productId: 'product', channel: 'AMAZON', marketplace: 'IT', channelConnectionId, aliasKey: 'alias-b' }
    expect(findFirst).toHaveBeenCalledWith({ where, select: { id: true } })
    expect(updateMany).toHaveBeenCalledWith({ where: { ...where, id: 'target' }, data: { listingStatus: 'ENDED', isPublished: false, flatFileSnapshot: { item_sku: 'FIXTURE', record_action: 'delete' } } })
  })
  it('omitted attribution refuses before any listing read or write', async () => {
    const findFirst = vi.fn(), updateMany = vi.fn()
    const service = new AmazonFlatFileService({ product: { findMany: async () => [{ id: 'p', sku: 'FIXTURE' }] }, channelListing: { findFirst, updateMany } } as any, {} as any)
    await expect(service.syncRowsToPlatform([{ item_sku: 'FIXTURE', record_action: 'delete' }] as any, 'IT')).rejects.toMatchObject({ code: 'LISTING_COORDINATE_MISSING_LEVEL' })
    expect(findFirst).not.toHaveBeenCalled(); expect(updateMany).not.toHaveBeenCalled()
  })
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Amazon sheet gaps (D4=B, D6=A, D7=A) — what Amazon's acceptance of a Publish of offer drafts does in Nexus, once.
 *
 * 🔴 WHAT THIS GUARDS. A saved offer draft becomes live only when Amazon accepted it, and only once: the sent value goes
 * live through its own door (reason `publish-accepted`) and the draft leaf goes only while it still holds exactly what
 * was sent; a live value that moved since the review wins and is sent again, with an audit row; a rejected SKU, an
 * unknown answer, or a run that never committed promotes nothing — and the result sweep recovers the missed run.
 *
 * Real PostgreSQL in-process (PGlite), driving the real `storeResult` (the settle core) over journals written by the real
 * `recordPublicationRequests`, the way `deliverPublication` writes them (`request.offer = { leaves, base }`). Nothing is
 * sent anywhere; the queue fire is a spy. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any, crash: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn(), refresh: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'TEST-SELLER', getAmazonRegion: async () => 'eu', getAmazonSpClient: vi.fn() }))
vi.mock('../../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true } }))
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, run: () => Promise<unknown>) => run() }))
// A crash inside the promotion, after the doors wrote and before the marker: the last step of a listing throws once.
vi.mock('./amazon-offer-draft.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./amazon-offer-draft.service.js')>()
  return { ...real, clearPromotedDraftLeaves: vi.fn(async (...args: Parameters<typeof real.clearPromotedDraftLeaves>) => {
    if (state.crash) { state.crash = false; throw new Error('the process died here') }
    return real.clearPromotedDraftLeaves(...args)
  }) }
})
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { OFFER_DRAFT_UNVERIFIED } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { liveDraftValues, readAmazonOfferFacts } from '../amazon/offer-facts.js'
import { readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { recordPublicationRequests } from './studio-publication-records.js'
import { PUBLICATION_KIND, storeResult } from './studio-publication-settle.js'
import { OFFER_PROMOTION_MARKER, promotePublishedOffers } from './studio-publication-offer-promotion.js'
import { runPublicationSettleTick } from '../../jobs/studio-publication-settle.job.js'
import { resetSaleWindowColumnCache } from './sale-window.js'

const IT_ID = 'APJ6JRA9NG5V4'
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const leaf = (value: unknown, base: unknown) => ({ value, base, savedAt: '2026-10-01T09:00:00.000Z', savedBy: 'person-1' })
const LIVE = { amazonFulfillment: { lead_time_to_ship_max_days: 2 }, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }
let account = '', warehouse = '', serial = 0

beforeAll(() => scoped(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  for (const code of ['IT', 'DE']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'offer-promotion', isActive: true, region: 'EU' } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'OFFER-PROMOTION-WH', name: 'Offer promotion warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** A product at master 49.90 live on Amazon (following the master, handling time 2), pinned at quantity 10, with drafts. */
async function seed(sku: string, drafts: Record<string, Record<string, unknown>>, over: Record<string, Record<string, unknown>> = {}) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 49.9, minPrice: 30, maxPrice: 70, fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: warehouse, quantity: 50, available: 50 } })
  const ids: Record<string, string> = {}
  for (const market of Object.keys(drafts)) {
    const leaves = drafts[market]
    ids[market] = (await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU',
      channelConnectionId: account, aliasKey: '', externalListingId: `TEST-ASIN-${sku}`, listingStatus: 'ACTIVE', isPublished: true,
      followMasterPrice: true, price: 49.9, pricingRule: 'FIXED', followMasterQuantity: false, quantity: 10, quantityOverride: 10, fulfillmentMethod: 'FBM',
      platformAttributes: { ...LIVE, ...(Object.keys(leaves).length ? { amazonOfferDraft: { v: 1, leaves } } : {}) }, ...over[market] } as never })).id
  }
  return { productId: product.id, sku, ...ids }
}

type Sent = { productId: string; sku: string; offer: { leaves: Record<string, unknown>; base: Record<string, unknown> } }

/** A submitted Amazon IT publication whose journals carry each product's offer, exactly as `deliverPublication` records them. */
async function submitted(sent: Sent[]) {
  const id = `offer-promotion-${++serial}`
  const data = { kind: PUBLICATION_KIND, productId: sent[0].productId, captureVersion: 1, startedAt: new Date().toISOString(),
    scope: { channel: 'AMAZON', marketplace: 'IT', accountId: account }, delivery: { productIds: sent.map(s => s.productId), aliasKey: '' } }
  await prisma.bulkOperation.create({ data: { id, userId: 'person-1', productCount: sent.length, changeCount: sent.length, status: 'SUBMITTED', changes: data,
    kind: PUBLICATION_KIND, productId: sent[0].productId, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, aliasKey: '', submittedAt: new Date() } as never })
  await recordPublicationRequests({ reviewId: id, userId: 'person-1', channel: 'AMAZON', marketplace: 'IT', accountId: account, aliasKey: '' }, sent.map(s => ({
    productId: s.productId, sku: s.sku, request: { feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [IT_ID], header: { sellerId: 'TEST-SELLER', version: '2.0' },
      message: { messageId: 1, sku: s.sku, operationType: 'PATCH', productType: 'COAT', patches: [] }, intentVersion: 1, writes: [], offer: s.offer } })))
  return { id, data }
}
const result = (id: string, status: StudioPublishResult['status'], skus: Record<string, 'ACCEPTED' | 'FAILED'>): StudioPublishResult => ({ id, status, message: `Amazon: ${status}`,
  results: Object.entries(skus).map(([sku, s]) => ({ sku, status: s, reference: 'feed-1', message: s === 'ACCEPTED' ? 'Accepted' : 'Invalid value' })) })

const row = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const live = async (id: string) => liveDraftValues(readAmazonOfferFacts(await row(id), 'job'))
const draftOf = async (id: string) => readAmazonOfferDraft((await row(id)).platformAttributes)?.leaves ?? {}
const queued = (productId: string) => prisma.outboundSyncQueue.findMany({ where: { productId }, select: { channelListingId: true, syncType: true, payload: true } })
const marker = async (id: string) => ((await prisma.bulkOperation.findUniqueOrThrow({ where: { id } })).changes as Record<string, unknown>)[OFFER_PROMOTION_MARKER]

const PRICE = { our_price: { pin: 44.9 } }, FOLLOW = { our_price: { follow: true } }

describe('🔴 Amazon accepted a Publish of offer drafts', () => {
  it('PARTIAL: the accepted SKU\'s drafts go live (price + handling time on every EU row) with one re-send each; the rejected SKU\'s draft is untouched; a second run is a no-op', async () => {
    const a = await scoped(() => seed('promo-a', {
      IT: { our_price: leaf({ pin: 44.9 }, { follow: true }), lead_time_to_ship_max_days: leaf(3, 2) },
      DE: { lead_time_to_ship_max_days: leaf(3, 2) },
    }))
    const b = await scoped(() => seed('promo-b', { IT: { our_price: leaf({ pin: 39.9 }, { follow: true }) } }))
    const bDraft = await scoped(() => draftOf(b.IT))
    const { id, data } = await scoped(() => submitted([
      { ...a, offer: { leaves: { ...PRICE, lead_time_to_ship_max_days: 3 }, base: { ...FOLLOW, lead_time_to_ship_max_days: 2 } } },
      { ...b, offer: { leaves: { our_price: { pin: 39.9 } }, base: FOLLOW } },
    ]))

    const stored = await scoped(() => storeResult(id, data, 'person-1', result(id, 'PARTIAL', { 'promo-a': 'ACCEPTED', 'promo-b': 'FAILED' }), ['SUBMITTED']))
    expect(stored.count).toBe(1)

    await scoped(async () => {
      // A: the sent values are live; its drafts are gone on both EU rows.
      expect(await live(a.IT)).toMatchObject({ our_price: { pin: 44.9 }, lead_time_to_ship_max_days: 3 })
      expect(await live(a.DE)).toMatchObject({ lead_time_to_ship_max_days: 3 })
      expect(await draftOf(a.IT)).toEqual({})
      expect(await draftOf(a.DE)).toEqual({})
      // ONE re-send of the live values per door: the price row for the IT listing, the quantity row for the SKU group.
      const rows = await queued(a.productId)
      expect(rows.filter(r => r.syncType === 'PRICE_UPDATE').map(r => r.channelListingId)).toEqual([a.IT])
      expect(rows.filter(r => r.syncType === 'QUANTITY_UPDATE')).toHaveLength(1)
      // B (rejected): nothing promoted, nothing sent, the draft exactly as it was.
      expect(await live(b.IT)).toMatchObject(FOLLOW)
      expect(await draftOf(b.IT)).toEqual(bDraft)
      expect(await queued(b.productId)).toEqual([])
      expect(await marker(id)).toBe('done')
    })

    // A second run (the sweep, a repeated status read) changes nothing and sends nothing.
    const versions = await scoped(async () => [(await row(a.IT)).version, (await row(a.DE)).version, (await row(b.IT)).version])
    expect(await scoped(() => promotePublishedOffers(id))).toMatchObject({ skipped: 'done', promoted: [], dropped: [], refused: [] })
    expect((await scoped(() => storeResult(id, data, 'person-1', result(id, 'PARTIAL', { 'promo-a': 'ACCEPTED', 'promo-b': 'FAILED' }), ['SUBMITTED']))).count).toBe(0)
    await scoped(async () => {
      expect([(await row(a.IT)).version, (await row(a.DE)).version, (await row(b.IT)).version]).toEqual(versions)
      expect(await queued(a.productId)).toHaveLength(2)
      expect(await queued(b.productId)).toEqual([])
    })
  }, 60_000)

  it('a draft saved again after the review keeps the newer value; the sent one goes live', async () => {
    const c = await scoped(() => seed('promo-newer', { IT: { our_price: leaf({ pin: 42.5 }, { follow: true }) } }))
    const { id, data } = await scoped(() => submitted([{ ...c, offer: { leaves: PRICE, base: FOLLOW } }]))
    await scoped(() => storeResult(id, data, 'person-1', result(id, 'ACCEPTED', { 'promo-newer': 'ACCEPTED' }), ['SUBMITTED']))
    await scoped(async () => {
      expect(await live(c.IT)).toMatchObject(PRICE)
      expect(await draftOf(c.IT)).toMatchObject({ our_price: { value: { pin: 42.5 } } })
      expect(await marker(id)).toBe('done')
    })
  }, 60_000)

  it('live moved since the review: the newer live wins (not promoted), the draft leaf is dropped, live is sent again, an audit row says so', async () => {
    // Saved against "follows the master"; meanwhile someone pinned the listing at 52.00 in another place.
    const d = await scoped(() => seed('promo-moved', { IT: { our_price: leaf({ pin: 44.9 }, { follow: true }) } },
      { IT: { followMasterPrice: false, priceOverride: 52, price: 52 } }))
    const { id, data } = await scoped(() => submitted([{ ...d, offer: { leaves: PRICE, base: FOLLOW } }]))
    await scoped(() => storeResult(id, data, 'person-1', result(id, 'ACCEPTED', { 'promo-moved': 'ACCEPTED' }), ['SUBMITTED']))
    await scoped(async () => {
      expect(await live(d.IT)).toMatchObject({ our_price: { pin: 52 } })
      expect(await draftOf(d.IT)).toEqual({})
      const rows = await queued(d.productId)
      expect(rows.map(r => [r.channelListingId, r.syncType])).toEqual([[d.IT, 'PRICE_UPDATE']])
      expect(JSON.stringify(rows[0].payload)).toContain('52')
      // The draft door records its own removal (system:publish); the promotion's row says why live won.
      const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: d.IT, fieldName: 'amazonOfferDraft.our_price', changedBy: { not: 'system:publish' } } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ previousValue: '44.90', newValue: '52.00', changedBy: 'person-1',
        reason: expect.stringContaining('Live changed to 52.00 after the saved 44.90 was sent; Nexus keeps live and sends it again.') })
    })
  }, 60_000)

  it('UNVERIFIED (Amazon\'s answer unknown): nothing promoted, nothing sent, no marker — the sheet says what to do', async () => {
    const e = await scoped(() => seed('promo-unverified', { IT: { our_price: leaf({ pin: 44.9 }, { follow: true }) } }))
    const before = await scoped(() => draftOf(e.IT))
    const { id, data } = await scoped(() => submitted([{ ...e, offer: { leaves: PRICE, base: FOLLOW } }]))
    await scoped(() => storeResult(id, data, 'person-1', result(id, 'UNVERIFIED', { 'promo-unverified': 'ACCEPTED' }), ['SUBMITTED']))
    expect(await scoped(() => promotePublishedOffers(id))).toMatchObject({ skipped: 'unverified', note: OFFER_DRAFT_UNVERIFIED, promoted: [] })
    await scoped(async () => {
      expect(await live(e.IT)).toMatchObject(FOLLOW)
      expect(await draftOf(e.IT)).toEqual(before)
      expect(await queued(e.productId)).toEqual([])
      expect(await marker(id)).toBeUndefined()
    })
  }, 60_000)

  it('a crash before the marker rolls the promotion back whole; the result sweep runs it once', async () => {
    const f = await scoped(() => seed('promo-crash', { IT: { our_price: leaf({ pin: 44.9 }, { follow: true }), lead_time_to_ship_max_days: leaf(3, 2) } }))
    const before = await scoped(() => draftOf(f.IT))
    const { id, data } = await scoped(() => submitted([{ ...f, offer: { leaves: { ...PRICE, lead_time_to_ship_max_days: 3 }, base: { ...FOLLOW, lead_time_to_ship_max_days: 2 } } }]))
    state.crash = true
    // The result is stored (the promotion never fails it); the promotion's own transaction rolled back.
    expect((await scoped(() => storeResult(id, data, 'person-1', result(id, 'ACCEPTED', { 'promo-crash': 'ACCEPTED' }), ['SUBMITTED']))).count).toBe(1)
    expect(state.crash).toBe(false)
    await scoped(async () => {
      expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED')
      expect(await live(f.IT)).toMatchObject({ ...FOLLOW, lead_time_to_ship_max_days: 2 })
      expect(await draftOf(f.IT)).toEqual(before)
      expect(await queued(f.productId)).toEqual([])
      expect(await marker(id)).toBeUndefined()
    })

    // The sweep, after its minute of grace: the missed promotion runs now, once.
    const later = new Date(Date.now() + 120_000)
    expect(await scoped(() => runPublicationSettleTick(later))).toMatchObject({ offersRecovered: 1, failed: 0 })
    await scoped(async () => {
      expect(await live(f.IT)).toMatchObject({ ...PRICE, lead_time_to_ship_max_days: 3 })
      expect(await draftOf(f.IT)).toEqual({})
      expect((await queued(f.productId)).map(r => r.syncType).sort()).toEqual(['PRICE_UPDATE', 'QUANTITY_UPDATE'])
      expect(await marker(id)).toBe('done')
    })
    const again = await scoped(() => runPublicationSettleTick(new Date(later.getTime() + 60_000)))
    expect(again.offersRecovered).toBeUndefined()
    expect(await scoped(() => queued(f.productId))).toHaveLength(2)
  }, 60_000)
})

/**
 * Amazon sheet gaps — THE write door of an Amazon listing's fulfilment settings (`setAmazonFulfilmentSettings`): handling
 * time, restock date and always available at `platformAttributes.amazonFulfillment.*`, on every open EU row of the SKU on
 * the account, under compare-and-set; any FBA target or a parent → nothing written; then ONE QUANTITY_UPDATE re-sending
 * the quantity Nexus holds (a paused listing waits with one held row, sent on resume). Real PostgreSQL in-process
 * (PGlite), the pattern of `price-door-sale-removal.vitest.test.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, fired: [] as any[], published: [] as any[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async (rows: unknown[]) => { state.fired.push(...rows) }) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn(), refresh: vi.fn() } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn((event: unknown) => { state.published.push(event) }) }))

import prisma from '../../db.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readAmazonOfferFacts } from '../amazon/offer-facts.js'
import { FBA_FULFILMENT_REASON } from '../amazon/offer-fields.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { reassertAmazonFulfilment, setAmazonFulfilmentSettings, type AmazonFulfilmentSettings } from './amazon-fulfilment-settings.service.js'
import { PARENT_REASON } from './matrix-cells.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
let account = '', other = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  for (const code of ['IT', 'DE', 'FR', 'ES', 'UK']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: code === 'UK' ? 'GBP' : 'EUR', region: code === 'UK' ? 'UK' : 'EU', language: 'it', languages: ['it'] } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'fulfilment-main', isActive: true } })).id
  other = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'fulfilment-other', isActive: false } })).id
}))
beforeEach(async () => { await settle(); state.fired.length = 0; state.published.length = 0 })

/** One SKU's Amazon listings, pinned at 7 (a pin: a recascade leaves the quantity alone). */
async function seed(id: string, markets: string[] = ['IT', 'DE', 'FR', 'ES'], over: (market: string) => Record<string, unknown> = () => ({}), product: Record<string, unknown> = {}) {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10, ...product } })
  const out: Record<string, any> = {}
  for (const market of markets) {
    out[market] = await prisma.channelListing.create({ data: {
      productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: `AMAZON_${market}`, marketplace: market, region: market === 'UK' ? 'UK' : 'EU',
      price: 49.9, followMasterPrice: false, priceOverride: 49.9, quantity: 7, quantityOverride: 7, followMasterQuantity: false, fulfillmentMethod: 'FBM',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${id}`, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS',
      platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] } },
      ...over(market),
    } })
  }
  return out
}
const fresh = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const queue = (productId: string) => prisma.outboundSyncQueue.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } })
const set = (listing: { id: string; version: number }, settings: AmazonFulfilmentSettings, extra: Record<string, unknown> = {}) =>
  setAmazonFulfilmentSettings({ targets: [{ listingId: listing.id, expectedVersion: listing.version }], settings, actor: 'sheet@test', reason: 'Product sheet', ...extra })

describe('the EU fan-out', () => {
  it('lands on every open EU row of the SKU on the account — each audited — and ONE QUANTITY_UPDATE re-sends the held quantity', () => scoped(async () => {
    const restock = day(20)
    const rows = await seed('ful-eu', ['IT', 'DE', 'FR', 'ES', 'UK'], (m) => ({
      ...(m === 'FR' ? { offerClosedAt: new Date() } : {}),
      ...(m === 'IT' ? { overrideData: { fulfillment_availability__lead_time_to_ship_max_days: 9, item_name: 'kept' } } : {}),
    }))
    // Another account's IT row of the same SKU is another seller: untouched.
    const foreign = await prisma.channelListing.create({ data: { productId: 'ful-eu', channel: 'AMAZON', channelConnectionId: other, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU', quantity: 3 } })
    const result = await set(rows.IT, { lead_time_to_ship_max_days: 4, restock_date: restock })
    expect(result).toMatchObject({ outcome: 'applied' })
    expect(result.written.map((w) => [w.listingId, w.marketplace, w.version])).toEqual([
      [rows.DE.id, 'DE', rows.DE.version + 1], [rows.ES.id, 'ES', rows.ES.version + 1], [rows.IT.id, 'IT', rows.IT.version + 1],
    ].sort((a, b) => ['IT', 'DE', 'FR', 'ES'].indexOf(a[1] as string) - ['IT', 'DE', 'FR', 'ES'].indexOf(b[1] as string)))
    for (const m of ['IT', 'DE', 'ES']) {
      const after = await fresh(rows[m].id)
      // Written where the stock job reads it; the code and quantity Amazon reported are kept.
      expect(after.platformAttributes).toEqual({ amazonFulfillment: { lead_time_to_ship_max_days: 4, restock_date: restock }, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] } })
      expect(readAmazonOfferFacts(after, 'job').values).toMatchObject({ lead_time_to_ship_max_days: 4, restock_date: restock })
    }
    for (const untouched of [rows.FR, rows.UK, foreign]) expect((await fresh(untouched.id)).version).toBe(untouched.version)
    expect((await fresh(rows.IT.id)).overrideData).toEqual({ item_name: 'kept' })
    const audit = await prisma.channelListingOverride.findMany({ where: { channelListing: { productId: 'ful-eu' } } })
    expect(audit).toHaveLength(6)
    expect(audit.filter((a) => a.channelListingId === rows.IT.id).map((a) => [a.fieldName, a.previousValue, a.newValue]).sort()).toEqual([
      ['amazonFulfillment.lead_time_to_ship_max_days', null, '4'], ['amazonFulfillment.restock_date', null, restock],
    ])
    const queued = await queue('ful-eu')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ id: result.queueIds[0], channelListingId: rows.IT.id, syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING',
      payload: { source: 'AMAZON_FULFILMENT_SETTINGS', quantity: 7, settings: { lead_time_to_ship_max_days: 4, restock_date: restock } } })
    expect(state.fired.map((r) => r.id)).toEqual(result.queueIds)
    await settle()
    expect(state.published).toEqual([expect.objectContaining({ type: 'listing.values_changed', fields: ['fulfilmentSettings'], productId: 'ful-eu' })])
    expect(state.published[0].listings).toHaveLength(3)
  }))

  it('a non-EU market is its own only target', () => scoped(async () => {
    const rows = await seed('ful-uk', ['IT', 'UK'])
    const result = await set(rows.UK, { lead_time_to_ship_max_days: 3 })
    expect(result.written.map((w) => w.marketplace)).toEqual(['UK'])
    expect((await fresh(rows.IT.id)).version).toBe(rows.IT.version)
  }))

  it('the same values again change nothing and queue nothing', () => scoped(async () => {
    const rows = await seed('ful-noop', ['IT', 'DE'], () => ({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4 } } }))
    expect(await set(rows.IT, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'noop', written: [], queueIds: [] })
    expect(await queue('ful-noop')).toEqual([])
    // Publish's acceptance re-sends once even so.
    const accepted = await setAmazonFulfilmentSettings({ listingIds: [rows.IT.id], unguardedReason: 'publish-accepted', settings: { lead_time_to_ship_max_days: 4 }, actor: 'publish' })
    expect(accepted).toMatchObject({ outcome: 'noop', written: [] })
    expect(accepted.queueIds).toHaveLength(1)
  }))

  it('null removes a setting on Amazon: an explicit null in Nexus\'s store', () => scoped(async () => {
    const rows = await seed('ful-null', ['IT'], () => ({ platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 4, is_inventory_available: false } } }))
    expect(await set(rows.IT, { lead_time_to_ship_max_days: null, is_inventory_available: true })).toMatchObject({ outcome: 'applied' })
    expect((await fresh(rows.IT.id)).platformAttributes).toEqual({ amazonFulfillment: { lead_time_to_ship_max_days: null, is_inventory_available: true } })
  }))
})

describe('refusals write nothing', () => {
  it.each([
    // D9 = A: Nexus's own entry (`platformAttributes.fulfillment_availability`) holds the code; Amazon's pulled copy alone does not block.
    ['an AMAZON_EU code in Nexus\'s own entry on a sibling market', 'code', (m: string) => (m === 'DE' ? { platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } : {}), {}],
    ['a Remote Fulfilment code beside DEFAULT', 'rafn', (m: string) => (m === 'IT' ? { platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } } : {}), {}],
    ['the listing marked FBA', 'listing', (m: string) => (m === 'ES' ? { fulfillmentMethod: 'FBA' } : {}), {}],
    ['the product marked FBA', 'product', () => ({}), { fulfillmentMethod: 'FBA' }],
  ])('any FBA target (%s) → the FBA sentence, nothing written on any market', (_label, tag, over, product) => scoped(async () => {
    const id = `ful-fba-${tag}`
    const rows = await seed(id, ['IT', 'DE', 'ES'], over, product)
    expect(await set(rows.IT, { lead_time_to_ship_max_days: 4 })).toEqual({ outcome: 'refused', reason: FBA_FULFILMENT_REASON, written: [], queueIds: [] })
    for (const r of Object.values(rows)) expect((await fresh(r.id)).version).toBe(r.version)
    expect(await queue(id)).toEqual([])
  }))

  it('D9 = A: plain AMAZON_EU only in the copy Amazon\'s pull left does not refuse on its own', () => scoped(async () => {
    const rows = await seed('ful-fba-pulled', ['IT', 'DE'], (m: string) => (m === 'DE' ? { platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } } : {}))
    expect(await set(rows.IT, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'applied' })
  }))

  it('FBA evidence beyond the listing: FBA stock on hand, an active FBA offer', () => scoped(async () => {
    const stocked = await seed('ful-fba-stock', ['IT'])
    const location = await prisma.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA' } })
    await prisma.stockLevel.create({ data: { locationId: location.id, productId: 'ful-fba-stock', quantity: 5, available: 5 } })
    expect(await set(stocked.IT, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'refused', reason: FBA_FULFILMENT_REASON })
    const offered = await seed('ful-fba-offer', ['IT'])
    await prisma.offer.create({ data: { channelListingId: offered.IT.id, fulfillmentMethod: 'FBA', sku: 'ful-fba-offer-FBA', isActive: true } })
    expect(await set(offered.IT, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'refused', reason: FBA_FULFILMENT_REASON })
  }))

  it('a parent has no offer of its own', () => scoped(async () => {
    const rows = await seed('ful-parent', ['IT'], () => ({}), { isParent: true })
    expect(await set(rows.IT, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'refused', reason: PARENT_REASON })
  }))

  it('a stale version — the listing named, or a sibling that moved — is a conflict', () => scoped(async () => {
    const rows = await seed('ful-cas', ['IT', 'DE'])
    expect(await set({ id: rows.IT.id, version: rows.IT.version + 2 }, { lead_time_to_ship_max_days: 4 })).toMatchObject({
      outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, conflict: { listingId: rows.IT.id, version: rows.IT.version } })
    expect((await fresh(rows.DE.id)).version).toBe(rows.DE.version)
  }))

  it('another channel is refused by name', () => scoped(async () => {
    await prisma.product.create({ data: { id: 'ful-ebay', sku: 'ful-ebay', name: 'x', basePrice: 1 } })
    const ebay = await prisma.channelListing.create({ data: { productId: 'ful-ebay', channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'EU' } })
    expect(await set(ebay, { lead_time_to_ship_max_days: 4 })).toMatchObject({ outcome: 'refused', reason: 'Only an Amazon listing has a handling time, a restock date or always available' })
  }))

  it.each([
    ['handling time above 120', 'lead-high', { lead_time_to_ship_max_days: 121 }, 'Handling time is a whole number of days, 0 to 120'],
    ['handling time not whole', 'lead-half', { lead_time_to_ship_max_days: 2.5 }, 'Handling time is a whole number of days, 0 to 120'],
    ['a restock date that has passed', 'restock-past', { restock_date: day(-1) }, 'A restock date is today or later — Amazon ignores a date that has passed'],
    ['a restock date-time', 'restock-time', { restock_date: `${day(5)}T00:00:00Z` }, 'A restock date is YYYY-MM-DD'],
    ['always available that is not on or off', 'always', { is_inventory_available: 'yes' as never }, 'Always available is on or off'],
  ])('checks: %s', (_label, tag, settings, reason) => scoped(async () => {
    const rows = await seed(`ful-check-${tag}`, ['IT'])
    expect(await set(rows.IT, settings)).toEqual({ outcome: 'refused', reason, written: [], queueIds: [] })
  }))
})

describe('when nothing can be sent now', () => {
  it('paused → saved, ONE held row; resume (Sync Control) sends it ONCE with the held quantity', () => scoped(async () => {
    const rows = await seed('ful-paused', ['IT', 'DE'], (m) => (m === 'IT' ? { syncPaused: true } : {}))
    const first = await set(rows.IT, { lead_time_to_ship_max_days: 3 })
    const second = await set(await fresh(rows.IT.id), { lead_time_to_ship_max_days: 5 })
    expect(second).toMatchObject({ outcome: 'applied', queueIds: [], notSent: 'The handling time is saved in Nexus. Nothing was sent: this listing\'s sync is paused. It is sent when the listing resumes.' })
    expect(first.queueIds).toEqual([])
    // The newer change replaced the first held row: one waits.
    expect((await queue('ful-paused')).map((r) => [r.syncType, r.syncStatus, r.errorCode])).toEqual([
      ['QUANTITY_UPDATE', 'CANCELLED', 'FULFILMENT_HELD_PAUSED'], ['QUANTITY_UPDATE', 'SKIPPED', 'FULFILMENT_HELD_PAUSED'],
    ])
    // Still paused: it keeps waiting.
    expect(await reassertAmazonFulfilment(['ful-paused'])).toEqual({ sent: [], stillHeld: [rows.IT.id], closed: [] })
    // Resume, the way Sync Control does: the control change re-cascades, then held prices and held settings go.
    await prisma.channelListing.update({ where: { id: rows.IT.id }, data: { syncPaused: false } })
    await recascadeAfterSyncControlChange(['ful-paused'], 'resume@test')
    const after = await queue('ful-paused')
    expect(after.map((r) => [r.syncStatus, r.errorCode])).toEqual([['CANCELLED', 'FULFILMENT_HELD_PAUSED'], ['CANCELLED', 'FULFILMENT_HELD_PAUSED'], ['PENDING', null]])
    expect(after[2]).toMatchObject({ channelListingId: rows.IT.id, syncType: 'QUANTITY_UPDATE', payload: { source: 'AMAZON_FULFILMENT_SETTINGS', quantity: 7, settings: { lead_time_to_ship_max_days: 5 } } })
    expect(state.fired.map((r) => r.id)).toContain(after[2].id)
    // Exactly once: a second resume finds nothing left.
    expect(await reassertAmazonFulfilment(['ful-paused'])).toEqual({ sent: [], stillHeld: [], closed: [] })
    expect(await queue('ful-paused')).toHaveLength(3)
  }))

  it('a still-draft → saved; Publish sends it', () => scoped(async () => {
    const rows = await seed('ful-draft', ['IT'], () => ({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null }))
    expect(await set(rows.IT, { restock_date: day(10) })).toMatchObject({ outcome: 'applied', queueIds: [],
      notSent: 'The restock date is saved in Nexus. Nothing was sent: this listing is a draft that has not been published; Publish sends it.' })
    expect(await queue('ful-draft')).toEqual([])
  }))

  it('no quantity Nexus can send → saved, and it goes with the next quantity push', () => scoped(async () => {
    const rows = await seed('ful-no-qty', ['IT'], () => ({ quantity: null, quantityOverride: null, followMasterQuantity: true }))
    const result = await set(rows.IT, { lead_time_to_ship_max_days: 2 })
    expect(result).toMatchObject({ outcome: 'applied', queueIds: [] })
    expect(result.notSent).toMatch(/^The handling time is saved in Nexus and goes with the next quantity push: /)
  }))
})

describe('tx mode: inside the caller\'s transaction', () => {
  it('a rollback leaves nothing — no write, no row, no job, no event; a commit fires the job and the event after it', () => scoped(async () => {
    const rows = await seed('ful-tx', ['IT', 'DE'])
    await expect(inDatabaseTransaction(prisma as never, async () => {
      const r = await set(rows.IT, { lead_time_to_ship_max_days: 6 }, { tx: activeDatabaseTransaction() })
      expect(r.queueIds).toHaveLength(1)
      throw new Error('the caller rolls back')
    })).rejects.toThrow('the caller rolls back')
    await settle()
    expect((await fresh(rows.IT.id)).version).toBe(rows.IT.version)
    expect(await queue('ful-tx')).toEqual([])
    expect(state.fired).toEqual([])
    expect(state.published).toEqual([])

    let queueId = ''
    await inDatabaseTransaction(prisma as never, async () => {
      queueId = (await set(rows.IT, { lead_time_to_ship_max_days: 6 }, { tx: activeDatabaseTransaction() })).queueIds[0]
      await settle()
      expect(state.fired).toEqual([])
      expect(state.published).toEqual([])
    })
    await settle()
    expect(state.fired.map((r) => r.id)).toEqual([queueId])
    expect(state.published).toHaveLength(1)
    expect((await fresh(rows.DE.id)).platformAttributes).toMatchObject({ amazonFulfillment: { lead_time_to_ship_max_days: 6 } })
  }))
})

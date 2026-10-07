import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S10 (per-channel SKU, Owner D2 = A) — moving a LIVE Amazon listing to its own SKU is ONE Publish: NEW is created whole as
 * a new offer on the same ASIN, and only after Amazon ACCEPTS NEW is OLD deleted there (this market only). If Amazon
 * refuses NEW, OLD stays and nothing is deleted. FBA: NEW starts with no FBA units; Amazon's stay under OLD.
 *
 *   - the builder (`prepareAmazonPublication`, real, on PGlite): which rows move, and NEW's create;
 *   - the finisher (`finishAmazonMoves` / `recoverAmazonMoves`, real, on PGlite): Amazon's delete of OLD is stubbed
 *     (`deleteAmazonListingOnChannel`, the Delete path's channel half); the claim release is recorded.
 * Parity: a live row with no own SKU publishes exactly as before (no move). Every id is invented; nothing reaches Amazon.
 */
const state = vi.hoisted(() => ({ db: null as any, del: vi.fn(), live: vi.fn(async () => ({ read: 'ok', fulfillmentChannels: ['DEFAULT'] })), release: vi.fn(async () => true) }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
vi.mock('../channel-delist.service.js', async original => ({ ...(await original<object>()), deleteAmazonListingOnChannel: state.del }))
vi.mock('../amazon/purchasable-offer.js', async original => ({ ...(await original<object>()), readAmazonOfferLive: state.live }))
vi.mock('../listing-claim.service.js', async original => ({ ...(await original<object>()), releaseCoordinate: state.release }))
// The cached category schemas below are fresh, so no provider call is made — any fetch is a failure of the fixture.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { merchantQuantityEntries } from '../../lib/amazon-fba-boundary.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { amazonMovesWithoutPublication, prepareAmazonPublication } from './studio-publication-amazon.js'
import { skuMoveRows } from './studio-publication.service.js'
import { amazonMoveReview, deleteOldSkuAgain, fbaUnitsUnderSku, finishAmazonMoves, historySkuMoves, recoverAmazonMoves, SKU_MOVE_MARKER } from './studio-publication-amazon-move.js'
import { PUBLICATION_KIND } from './studio-publication-settle.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = '', warehouse = ''

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: code.toLowerCase(), languages: [code.toLowerCase()], marketplaceId: `TEST_MARKET_${code}` } as never })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000), schemaDefinition: { properties: {} } } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'sku-move', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'SKU-MOVE-WH', name: 'Move warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(() => { state.del.mockReset(); state.release.mockClear(); state.live.mockClear() })

/** A merchant product with 7 in stock and its LIVE Amazon row on `market` (ASIN `B0…`), with optional extra facts. */
async function product(sku: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM', totalStock: 7, ...extra } as never })
  await prisma.stockLevel.create({ data: { productId: row.id, locationId: warehouse, quantity: 7, available: 7 } })
  await prisma.productImage.create({ data: { productId: row.id, url: `https://img.example/${sku}.jpg`, type: 'MAIN' } as never })
  return row.id
}
async function liveRow(productId: string, market: string, listing: Record<string, unknown> = {}, offers: Array<{ sku: string; method: 'FBA' | 'FBM' }> = []) {
  const row = await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU', channelConnectionId: account,
    externalListingId: `B0MOVE${productId.slice(-4).toUpperCase()}`, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, fulfillmentMethod: 'FBM',
    followMasterPrice: true, followMasterQuantity: true, price: 10, platformAttributes: {}, ...listing } as never })
  for (const offer of offers) await prisma.offer.create({ data: { channelListingId: row.id, sku: offer.sku, fulfillmentMethod: offer.method, isActive: true } })
  return row
}
const publish = (productId: string, market = 'IT') => scoped(async () =>
  prepareAmazonPublication(await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: market, accountId: account })))

describe('the builder: which live rows move, and NEW\'s create', () => {
  it('a live row with its own SKU moves: NEW is created whole (offer, stock) on the live ASIN', async () => {
    const { id, listing } = await scoped(async () => { const pid = await product('mv-fbm'); return { id: pid, listing: await liveRow(pid, 'IT', { channelSku: 'mv-fbm-IT' }) } })
    const publication = await publish(id)
    expect(publication.moves).toEqual([{ productId: id, listingId: listing.id, from: 'mv-fbm', to: 'mv-fbm-IT', asin: listing.externalListingId, fba: false }])
    expect(publication.products).toEqual([{ productId: id, sku: 'mv-fbm-IT' }])
    const message = publication.feed.messages[0]
    expect(message).toMatchObject({ sku: 'mv-fbm-IT', operationType: 'UPDATE' })
    expect(message.attributes!.merchant_suggested_asin).toEqual([{ value: listing.externalListingId, marketplace_id: 'TEST_MARKET_IT' }])
    expect(message.attributes!.purchasable_offer).toBeDefined()
    expect(message.attributes!.fulfillment_availability).toEqual([expect.objectContaining({ fulfillment_channel_code: 'DEFAULT', quantity: 7 })])
  })

  it('FBA: NEW keeps Amazon\'s fulfilment channel and NEVER a quantity (Amazon\'s units stay under OLD)', async () => {
    const id = await scoped(async () => { const pid = await product('mv-fba', { fulfillmentMethod: 'FBA' })
      await liveRow(pid, 'IT', { channelSku: 'mv-fba-IT', fulfillmentMethod: 'FBA', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }); return pid })
    const publication = await publish(id)
    expect(publication.moves).toEqual([expect.objectContaining({ from: 'mv-fba', to: 'mv-fba-IT', fba: true })])
    const message = publication.feed.messages[0]
    expect(message.attributes!.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    expect(merchantQuantityEntries(message)).toEqual([])
  })

  it('the SKU Amazon confirmed is OLD: a confirmed live SKU is what gets deleted, not the product SKU', async () => {
    const id = await scoped(async () => { const pid = await product('mv-conf'); await liveRow(pid, 'IT', { channelSku: 'mv-conf-NEW', liveChannelSku: 'mv-conf-HELD' }); return pid })
    expect((await publish(id)).moves).toEqual([expect.objectContaining({ from: 'mv-conf-HELD', to: 'mv-conf-NEW' })])
  })

  it('parity: a live row with no own SKU does not move and is not re-created', async () => {
    const id = await scoped(async () => { const pid = await product('mv-plain'); await liveRow(pid, 'IT'); return pid })
    const publication = await publish(id)
    expect(publication.moves).toBeUndefined()
    expect(publication.feed.messages.map(message => message.sku)).toEqual(['mv-plain'])
    expect(publication.feed.messages[0].attributes?.merchant_suggested_asin).toBeUndefined()
  })

  it('per market: the IT row moves; the DE row of the same product (no own SKU there) publishes as before', async () => {
    const id = await scoped(async () => { const pid = await product('mv-eu'); await liveRow(pid, 'IT', { channelSku: 'mv-eu-IT' }); await liveRow(pid, 'DE'); return pid })
    expect((await publish(id, 'IT')).moves).toEqual([expect.objectContaining({ from: 'mv-eu', to: 'mv-eu-IT' })])
    const de = await publish(id, 'DE')
    expect(de.moves).toBeUndefined()
    expect(de.feed.messages.map(message => message.sku)).toEqual(['mv-eu'])
  })

  it('refused by name: Nexus does not know the live listing\'s ASIN yet', async () => {
    const id = await scoped(async () => { const pid = await product('mv-noasin'); await liveRow(pid, 'IT', { channelSku: 'mv-noasin-IT', externalListingId: null }); return pid })
    await expect(publish(id)).rejects.toThrow('Nexus does not know the ASIN of mv-noasin here yet, so it cannot create mv-noasin-IT on the same Amazon product.')
  })

  it('refused by name: a family\'s main row cannot move (its variations hang under the old parent SKU)', async () => {
    const id = await scoped(async () => {
      const parent = await product('mv-fam', { isParent: true })
      const child = await product('mv-fam-M', { parentId: parent })
      await liveRow(parent, 'IT', { channelSku: 'mv-fam-IT' }); await liveRow(child, 'IT')
      return parent
    })
    await expect(publish(id)).rejects.toThrow('Nexus cannot move a family\'s main listing on Amazon to a new SKU yet (mv-fam → mv-fam-IT)')
  })
})

describe('the review: the move, its FBA note, and the typed confirmation', () => {
  it('says what happens, names Amazon\'s FBA units under OLD, and asks for the family SKU like Delete', async () => {
    await scoped(async () => {
      for (const [condition, quantity] of [['SELLABLE', 12], ['INBOUND', 2]] as const) await prisma.fbaInventoryDetail.create({ data: {
        sku: 'rv-old', marketplaceId: 'TEST_MARKET_IT', fulfillmentCenterId: 'MXP6', condition, quantity, lastSyncedAt: new Date(Date.now() - 2 * 3_600_000) } })
    })
    const review = await scoped(() => amazonMoveReview({ scope: { channel: 'AMAZON', marketplace: 'IT', accountId: account }, parent: { sku: 'rv-fam' } } as never,
      { marketplaceId: 'TEST_MARKET_IT', moves: [{ productId: 'p1', listingId: 'l1', from: 'rv-old', to: 'rv-new', asin: 'B0RV', fba: true }] }))
    expect(review.rows.get('p1')).toEqual({ from: 'rv-old', to: 'rv-new', kind: 'create-delete',
      sentence: 'Creates rv-new on Amazon · IT as a new offer, then deletes rv-old there.',
      warning: 'rv-new starts with no FBA units; Amazon\'s 14 FBA units stay under rv-old (12 sellable, 2 on the way), read 2 hours ago. Once rv-old is deleted they cannot sell until you list rv-old here again, and Amazon still charges storage.' })
    expect(review.confirm).toEqual({ kind: 'type', expected: 'rv-fam', token: 'DELETE',
      sentence: 'This Publish deletes rv-old on Amazon · IT once Amazon accepts its new SKU. If Amazon refuses a new SKU, its old one stays and nothing is deleted. It cannot be undone.' })
  })

  it('Step 4: only the FBA sweep\'s INBOUND row (centre ALL) under OLD is no count — the warning names no number, never "0" or "N on the way" alone', async () => {
    await scoped(() => prisma.fbaInventoryDetail.create({ data: {
      sku: 'rv-inb-old', marketplaceId: 'TEST_MARKET_IT', fulfillmentCenterId: 'ALL', condition: 'INBOUND', quantity: 5, rawData: { working: 3, shipped: 2, receiving: 0 } } }))
    expect(await scoped(() => fbaUnitsUnderSku('TEST_MARKET_IT', 'rv-inb-old'))).toBeNull()
    const review = await scoped(() => amazonMoveReview({ scope: { channel: 'AMAZON', marketplace: 'IT', accountId: account }, parent: { sku: 'rv-inb' } } as never,
      { marketplaceId: 'TEST_MARKET_IT', moves: [{ productId: 'p2', listingId: 'l2', from: 'rv-inb-old', to: 'rv-inb-new', asin: 'B0RVI', fba: true }] }))
    expect(review.rows.get('p2')!.warning).toBe('rv-inb-new starts with no FBA units; any FBA units Amazon holds stay under rv-inb-old. Once rv-inb-old is deleted they cannot sell until you list rv-inb-old here again, and Amazon still charges storage.')
  })
})

describe('F5 — a review that cannot be prepared still says the move (browser check 2026-10-05)', () => {
  it('a family whose publication fails for another reason: the moved row still reads "Move to NEW", with the typed confirmation', async () => {
    const id = await scoped(async () => {
      const parent = await product('gt-fam', { isParent: true })
      const moved = await product('gt-fam-L', { parentId: parent })
      // Another variation Publish would create, with no fulfilment method anywhere: the publication refuses it by name.
      const unready = await product('gt-fam-M', { parentId: parent, fulfillmentMethod: null })
      await liveRow(parent, 'IT'); await liveRow(moved, 'IT', { channelSku: 'gt-fam-L-IT' })
      await liveRow(unready, 'IT', { externalListingId: null, listingStatus: 'DRAFT', isPublished: false, fulfillmentMethod: null })
      return { parent, moved }
    })
    const facts = await scoped(() => readPublicationFacts(id.parent, { channel: 'AMAZON', marketplace: 'IT', accountId: account }))
    await expect(scoped(() => prepareAmazonPublication(facts))).rejects.toThrow()
    const found = await scoped(() => amazonMovesWithoutPublication(facts))
    expect(found).toMatchObject({ marketplaceId: 'TEST_MARKET_IT', refusal: null, moves: [expect.objectContaining({ productId: id.moved, from: 'gt-fam-L', to: 'gt-fam-L-IT', fba: false })] })
    // What the review builds from it when the publication is missing (`prepared` null).
    const review = await scoped(() => skuMoveRows(facts, null, null))
    expect(review.rows.get(id.moved)).toEqual({ from: 'gt-fam-L', to: 'gt-fam-L-IT', kind: 'create-delete',
      sentence: 'Creates gt-fam-L-IT on Amazon · IT as a new offer, then deletes gt-fam-L there.', warning: null })
    expect(review.confirm).toMatchObject({ kind: 'type', expected: 'gt-fam', token: 'DELETE' })
    expect(review.issues).toEqual([])
  })

  it('a move that cannot be made is said by name, never hidden: the family\'s main row', async () => {
    const parent = await scoped(async () => {
      const pid = await product('gt-main', { isParent: true }); const child = await product('gt-main-S', { parentId: pid })
      await liveRow(pid, 'IT', { channelSku: 'gt-main-IT' }); await liveRow(child, 'IT')
      return pid
    })
    const facts = await scoped(() => readPublicationFacts(parent, { channel: 'AMAZON', marketplace: 'IT', accountId: account }))
    const review = await scoped(() => skuMoveRows(facts, null, null))
    expect(review.rows.size).toBe(0)
    expect(review.confirm).toBeNull()
    expect(review.issues).toEqual([{ severity: 'error', message: expect.stringContaining('Nexus cannot move a family\'s main listing on Amazon to a new SKU yet (gt-main → gt-main-IT)') }])
  })
})

describe('the finisher: OLD is deleted only after Amazon accepted NEW', () => {
  /** A settled publication that moved `from` → `to` on a live row, with Amazon's per-SKU answer. */
  async function settled(name: string, answer: 'ACCEPTED' | 'FAILED', options: { completedAt?: Date } = {}) {
    return scoped(async () => {
      const pid = await product(`fin-${name}`)
      const listing = await liveRow(pid, 'IT', { channelSku: `fin-${name}-IT`, liveChannelSku: `fin-${name}-IT` }, [{ sku: `fin-${name}`, method: 'FBM' }])
      const move = { productId: pid, listingId: listing.id, from: `fin-${name}`, to: `fin-${name}-IT`, asin: listing.externalListingId, fba: false, marketplaceId: 'TEST_MARKET_IT' }
      const result = { id: `pub-${name}`, status: answer, message: answer === 'ACCEPTED' ? 'Amazon processed feed F1.' : '1 products were rejected by Amazon.',
        results: [{ sku: move.to, status: answer, message: answer === 'ACCEPTED' ? 'Amazon processed this product.' : 'Refused.', reference: 'F1' }] }
      await prisma.bulkOperation.create({ data: { id: `pub-${name}`, userId: 'user-a', status: answer, productCount: 1, changeCount: 1, kind: PUBLICATION_KIND, channel: 'AMAZON',
        marketplace: 'IT', channelConnectionId: account, aliasKey: '', productId: pid, completedAt: options.completedAt ?? new Date(),
        summary: { message: result.message, products: 1 }, changes: { kind: PUBLICATION_KIND, scope: { channel: 'AMAZON', marketplace: 'IT', accountId: account }, skuMoves: [move], result } } as never })
      return { move, result: result as any, listing }
    })
  }
  const stored = (id: string) => scoped(async () => (await prisma.bulkOperation.findUnique({ where: { id } }))!)

  it('NEW accepted → OLD deleted on Amazon (this market), its claim released, its offer closed, an audit record kept — once', async () => {
    const { move, result, listing } = await settled('ok', 'ACCEPTED')
    state.del.mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-1' })
    const moves = await scoped(() => finishAmazonMoves('pub-ok', result, { actor: 'user-a' }))
    expect(moves).toEqual([expect.objectContaining({ state: 'deleted', message: 'fin-ok-IT is live on Amazon · IT; fin-ok was deleted there.' })])
    expect(state.del).toHaveBeenCalledWith({ sellerId: 'TEST-SELLER', sku: 'fin-ok', marketplaceId: 'TEST_MARKET_IT' })
    if (process.env.NEXUS_WORKSPACES_ENABLED === '1') expect(state.release).toHaveBeenCalledWith({ connectionId: account, marketplace: 'IT', sellerSku: 'fin-ok' })
    expect(result.warnings).toEqual(['fin-ok-IT is live on Amazon · IT; fin-ok was deleted there.'])
    const row = await stored('pub-ok')
    expect((row.changes as any)[SKU_MOVE_MARKER]).toBe('done')
    expect((row.changes as any).result.warnings).toEqual(['fin-ok-IT is live on Amazon · IT; fin-ok was deleted there.'])
    expect((row.summary as any).message).toBe('Amazon processed feed F1. fin-ok-IT is live on Amazon · IT; fin-ok was deleted there.')
    await scoped(async () => {
      expect(await prisma.offer.findMany({ where: { channelListingId: listing.id }, select: { sku: true, isActive: true } })).toEqual([{ sku: 'fin-ok', isActive: false }])
      expect(await prisma.channelListingSnapshot.findMany({ where: { channelListingId: listing.id }, select: { reason: true, outcome: true, publishEventId: true } }))
        .toEqual([{ reason: 'sku-move', outcome: 'ACCEPTED', publishEventId: 'pub-ok' }])
      // The row stays the same live listing: never returned to draft.
      expect(await prisma.channelListing.findUnique({ where: { id: listing.id }, select: { listingStatus: true, externalListingId: true, liveChannelSku: true } }))
        .toEqual({ listingStatus: 'ACTIVE', externalListingId: listing.externalListingId, liveChannelSku: 'fin-ok-IT' })
    })
    // Exactly once: a second run (the sweep, a second status read) does nothing.
    expect(await scoped(() => finishAmazonMoves('pub-ok', result, { actor: 'user-a' }))).toBeNull()
    expect(state.del).toHaveBeenCalledOnce()
  })

  it('NEW refused → nothing is deleted; OLD stays, and the result says so', async () => {
    const { result } = await settled('refused', 'FAILED')
    const moves = await scoped(() => finishAmazonMoves('pub-refused', result, { actor: 'user-a' }))
    expect(moves).toEqual([expect.objectContaining({ state: 'kept', message: 'Amazon did not accept fin-refused-IT, so fin-refused stays on Amazon · IT and nothing was deleted.' })])
    expect(state.del).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled()
  })

  it('a delete Amazon does not confirm is said, and tried again by the result sweep', async () => {
    const { result } = await settled('retry', 'ACCEPTED', { completedAt: new Date(Date.now() - 5 * 60_000) })
    state.del.mockResolvedValueOnce({ success: false, outcome: 'UNKNOWN', error: 'Amazon timed out' })
    const first = await scoped(() => finishAmazonMoves('pub-retry', result, { actor: 'user-a' }))
    expect(first).toEqual([expect.objectContaining({ state: 'failed', message: 'fin-retry-IT is live on Amazon · IT. fin-retry was not deleted yet: Amazon did not confirm it (Amazon timed out). '
      + 'Nexus tries again by itself; to try now, open this publish in Publish history and choose "Delete the old SKU again". Until fin-retry is gone, fin-retry and fin-retry-IT can both sell on Amazon · IT.' })])
    expect((await stored('pub-retry')).changes).toMatchObject({ [SKU_MOVE_MARKER]: null, skuMoveTries: 1 })
    state.del.mockResolvedValueOnce({ success: true, outcome: 'SUCCESS', submissionId: 'sub-2' })
    const swept = await scoped(() => recoverAmazonMoves(new Date()))
    expect(swept.finished).toBeGreaterThanOrEqual(1)
    const after = (await stored('pub-retry')).changes as any
    expect(after[SKU_MOVE_MARKER]).toBe('done')
    expect(after.skuMoves[0].state).toBe('deleted')
    // The newest outcome replaces the earlier one in the result's notes.
    expect(after.result.warnings).toEqual(['fin-retry-IT is live on Amazon · IT; fin-retry was deleted there.'])
  })

  it('OLD still sold by another listing of this business here → not deleted', async () => {
    const { result } = await settled('shared', 'ACCEPTED')
    await scoped(async () => { const other = await product('fin-shared-other'); await liveRow(other, 'IT', { channelSku: 'fin-shared', liveChannelSku: 'fin-shared' }) })
    const moves = await scoped(() => finishAmazonMoves('pub-shared', result, { actor: 'user-a' }))
    expect(moves).toEqual([expect.objectContaining({ state: 'shared', message: 'fin-shared-IT is live on Amazon · IT. fin-shared is still the SKU of another listing here, so Nexus did not delete it.' })])
    expect(state.del).not.toHaveBeenCalled()
  })

  it('Amazon writes in preview mode on this server: OLD is not deleted, and the result says why', async () => {
    const { result } = await settled('dry', 'ACCEPTED')
    state.del.mockResolvedValue({ success: true, outcome: 'NOT_SENT', dryRun: true })
    expect(await scoped(() => finishAmazonMoves('pub-dry', result, { actor: 'user-a' })))
      .toEqual([expect.objectContaining({ state: 'not-sent', message: 'fin-dry-IT is live on Amazon · IT. Amazon writes are in preview mode on this server, so fin-dry was not deleted.' })])
    expect(state.release).not.toHaveBeenCalled()
  })

  it('after the last automatic try the result names the Nexus action (never Seller Central); that action tries the delete again', async () => {
    const { result, move } = await settled('gaveup', 'ACCEPTED', { completedAt: new Date(Date.now() - 5 * 60_000) })
    state.del.mockResolvedValue({ success: false, outcome: 'UNKNOWN', error: 'Amazon timed out' })
    // Four automatic tries already failed: this run is the last one.
    await scoped(async () => {
      const row = await prisma.bulkOperation.findUniqueOrThrow({ where: { id: 'pub-gaveup' } })
      await prisma.bulkOperation.update({ where: { id: 'pub-gaveup' }, data: { changes: { ...(row.changes as object), skuMoveTries: 4 } } })
    })
    const last = await scoped(() => finishAmazonMoves('pub-gaveup', result, { actor: 'user-a' }))
    const sentence = 'fin-gaveup-IT is live on Amazon · IT. Amazon did not confirm the delete of fin-gaveup after 5 tries, so Nexus stopped trying by itself. '
      + 'To try again, open this publish in Publish history and choose "Delete the old SKU again". Until fin-gaveup is gone, fin-gaveup and fin-gaveup-IT can both sell on Amazon · IT.'
    expect(last).toEqual([expect.objectContaining({ state: 'failed', message: sentence })])
    expect(sentence).not.toMatch(/Seller Central/)
    const kept = (await stored('pub-gaveup')).changes as any
    expect(kept[SKU_MOVE_MARKER]).toBe('done')
    // The history offers the action on that move.
    expect(historySkuMoves(kept)).toEqual([{ productId: move.productId, from: 'fin-gaveup', to: 'fin-gaveup-IT', state: 'failed', message: sentence, canDeleteAgain: true }])
    // The sweep no longer tries by itself…
    state.del.mockClear()
    await scoped(() => recoverAmazonMoves(new Date()))
    expect(state.del).not.toHaveBeenCalled()
    // …and "Delete the old SKU again" tries it now, through the same Delete channel half.
    state.del.mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-3' })
    const again = await scoped(() => deleteOldSkuAgain(move.productId, 'pub-gaveup', 'user-b'))
    expect(state.del).toHaveBeenCalledWith({ sellerId: 'TEST-SELLER', sku: 'fin-gaveup', marketplaceId: 'TEST_MARKET_IT' })
    expect(again.moves).toEqual([expect.objectContaining({ state: 'deleted', canDeleteAgain: false, message: 'fin-gaveup-IT is live on Amazon · IT; fin-gaveup was deleted there.' })])
    const after = (await stored('pub-gaveup')).changes as any
    expect(after.result.warnings).toEqual(['fin-gaveup-IT is live on Amazon · IT; fin-gaveup was deleted there.'])
  })

  it('"Delete the old SKU again" refuses when nothing is left to delete, and for another product\'s publish', async () => {
    const { result, move } = await settled('nothing', 'ACCEPTED')
    state.del.mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-4' })
    await scoped(() => finishAmazonMoves('pub-nothing', result, { actor: 'user-a' }))
    await expect(scoped(() => deleteOldSkuAgain(move.productId, 'pub-nothing', 'user-a'))).rejects.toThrow(/^Nothing is left to delete again/)
    const other = await scoped(() => product('fin-nothing-other'))
    await expect(scoped(() => deleteOldSkuAgain(other, 'pub-nothing', 'user-a'))).rejects.toThrow('Publication not found.')
    expect(state.del).toHaveBeenCalledOnce()
  })
})

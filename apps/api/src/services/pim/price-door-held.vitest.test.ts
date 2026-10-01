/**
 * Round 5 (2026-10-01) — a price change kept in Nexus while a listing is paused, or a draft, is sent EXACTLY ONCE when
 * the listing resumes or is published: the follower (rule) price, a typed pin and a sale.
 *
 * 🔴 WHAT THIS GUARDS. The price door and the master-price cascade store a change on a paused listing or a still-draft
 * and queue nothing (`holdsCascadedPrice`). Nothing sent it afterwards: Sync Control's Resume, the Matrix's resume and
 * a pause's end time all run `recascadeAfterSyncControlChange`, which re-sent the QUANTITY only; a dispatcher that met a
 * row of a listing paused inside its 30 s hold skipped it (PUSH_SYNC_PAUSED) and nothing replayed it either. So a price
 * changed during a pause stayed in Nexus after the resume — LOST — until some unrelated change pushed one. And Publish
 * carries a pinned price but sends a following draft the MASTER price and an Amazon draft no sale at all.
 *
 * Now the held change is a PRICE_UPDATE row that is never dispatched (SKIPPED, `PUSH_SYNC_PAUSED` / `PRICE_HELD_DRAFT`;
 * `follower-price.ts`), and `sendHeldPrices` (the door's module) sends it ONCE through the door's SEND mode when the
 * listing can be sent to again — at the price the listing carries THEN (never the stale number the held row recorded),
 * with its sale — and closes the held rows in the same transaction, so a second resume sends nothing.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-follower.vitest.test.ts`. Every id is invented.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { sendHeldPrices, writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { MasterPriceService } from '../master-price.service.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { recordLiveListingsInTransaction } from './live-listing.service.js'
import { resetSaleWindowColumnCache } from './sale-window.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}

beforeAll(async () => {
  // The two MX.1 window columns are raw SQL, not in schema.prisma; the deployed databases carry them.
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
    await market('AMAZON', 'IT', 'EUR')
    await market('EBAY', 'DE', 'EUR')
    for (const channel of ['AMAZON', 'EBAY']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `held-${channel}`, isActive: true } })).id
    }
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

interface Seed {
  channel?: 'AMAZON' | 'EBAY'
  /** A pinned listing's own price; `undefined` = following the master. */
  pinned?: number
  rule?: 'FIXED' | 'PERCENT_OF_MASTER'
  adj?: number
  paused?: boolean
  draft?: boolean
}
/** A product at master 10 and one listing (Amazon IT unless told otherwise): live, or a still-draft (born paused). */
async function seed(id: string, s: Seed = {}) {
  const channel = s.channel ?? 'AMAZON'
  const marketplace = channel === 'AMAZON' ? 'IT' : 'DE'
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } as never })
  const pinned = s.pinned !== undefined
  const followerPrice = s.rule === 'PERCENT_OF_MASTER' ? Math.round(10 * (1 + (s.adj ?? 0) / 100) * 100) / 100 : 10
  return prisma.channelListing.create({ data: {
    productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
    ...(s.draft
      ? { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true }
      : { listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, syncPaused: s.paused ?? false }),
    price: pinned ? s.pinned : followerPrice, priceOverride: pinned ? s.pinned : null, followMasterPrice: !pinned, masterPrice: 10,
    pricingRule: s.rule ?? 'FIXED', priceAdjustmentPercent: s.adj ?? null,
  } as never })
}
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const priceRows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE' }, orderBy: { createdAt: 'asc' } })
const pending = async (channelListingId: string) => (await priceRows(channelListingId)).filter((row) => row.syncStatus === 'PENDING')
const held = async (channelListingId: string) => (await priceRows(channelListingId)).filter((row) => row.syncStatus === 'SKIPPED' && ['PUSH_SYNC_PAUSED', 'PRICE_HELD_DRAFT'].includes(row.errorCode ?? ''))
const write = (target: PriceWriteTarget) => writeChannelPrices({ targets: [target], actor: 'person-1', source: 'MANUAL_OVERRIDE', reason: 'test' })
/** What every resume does (Sync Control's Resume, the Matrix's resume, a pause's end time): unpause, then the recascade. */
async function resume(l: { id: string; productId: string }) {
  await prisma.channelListing.update({ where: { id: l.id }, data: { syncPaused: false } })
  return recascadeAfterSyncControlChange([l.productId], 'person-2')
}
/** What Publish's acceptance does to a still-draft (`promoteAcceptedDrafts`), then its go-live hook. */
async function goLive(l: { id: string }) {
  await prisma.channelListing.update({ where: { id: l.id }, data: { isPublished: true, listingStatus: 'ACTIVE', syncPaused: false, version: { increment: 1 } } })
  return sendHeldPrices({ listingIds: [l.id], actor: 'person-2', cause: 'publish' })
}
const SALE = { value: 8, start: '2026-11-01', end: '2026-11-30' }

describe('🔴 a change made while a live listing is paused is sent ONCE when it resumes', () => {
  it('a pin: stored and held (nothing pending); the resume queues ONE row at the pin; a second resume sends nothing', () => scoped(async () => {
    const l = await seed('held-pin', { pinned: 20, paused: true })
    const r = await write({ listingId: l.id, price: 25, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null, notSent: 'The price 25.00 is saved in Nexus. Nothing was sent: this listing\'s sync is paused. It is sent when the listing resumes.' })
    expect(await pending(l.id)).toEqual([])
    const kept = await held(l.id)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ errorCode: 'PUSH_SYNC_PAUSED', holdUntil: null, payload: expect.objectContaining({ price: 25, held: 'PUSH_SYNC_PAUSED' }) })

    const first = await resume(l)
    expect(first.heldPricesSent).toBe(1)
    const sent = await pending(l.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 25, resend: true, actor: 'person-2', salePrice: null })
    expect(await held(l.id)).toEqual([])
    expect((await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id: kept[0].id } })).syncStatus).toBe('CANCELLED')
    const after = await listing(l.id)
    expect([Number(after.price), Number(after.priceOverride), after.followMasterPrice]).toEqual([25, 25, false])

    // Exactly once: the next resume (or any later Sync Control change of this product) finds nothing left to send.
    expect((await resume(l)).heldPricesSent).toBe(0)
    expect(await pending(l.id)).toHaveLength(1)
  }))

  it('a follower (master +10%): two master changes while paused; the resume sends the CURRENT rule price once, not the stale one', () => scoped(async () => {
    const l = await seed('held-follower', { rule: 'PERCENT_OF_MASTER', adj: 10, paused: true })
    const master = new MasterPriceService(prisma as never)
    await master.update(l.productId, 12, { reason: 'test' })
    expect(Number((await listing(l.id)).price)).toBe(13.2)
    await master.update(l.productId, 14, { reason: 'test' })
    expect(Number((await listing(l.id)).price)).toBe(15.4)
    expect(await pending(l.id)).toEqual([])
    // Round 6 — ONE held row per listing: the newer master price replaced the older held row (no pile-up while paused).
    expect((await held(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([15.4])
    expect((await priceRows(l.id)).map((row) => row.syncStatus)).toEqual(['CANCELLED', 'SKIPPED'])

    expect((await resume(l)).heldPricesSent).toBe(1)
    const sent = await pending(l.id)
    expect(sent.map((row) => (row.payload as { price: number }).price)).toEqual([15.4])
    expect(await held(l.id)).toEqual([])
    expect((await resume(l)).heldPricesSent).toBe(0)
    expect(await pending(l.id)).toHaveLength(1)
  }))

  it('a rule change while paused (the door\'s follower mode) is held and sent on resume', () => scoped(async () => {
    const l = await seed('held-rule', { paused: true })
    const r = await write({ listingId: l.id, rule: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 20 }, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect((await held(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([12])
    await resume(l)
    expect((await pending(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([12])
  }))

  it('a sale on a paused Amazon listing: the resume sends it once, with its window and the listing\'s price', () => scoped(async () => {
    const l = await seed('held-sale', { pinned: 20, paused: true })
    const r = await write({ listingId: l.id, sale: SALE, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(await held(l.id)).toHaveLength(1)
    await resume(l)
    const sent = await pending(l.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ price: 20, salePrice: 8, salePriceStart: SALE.start, salePriceEnd: SALE.end })
  }))

  it('🔴 removing Nexus\'s dated Amazon sale while paused: the resume\'s row names the removal (saleRemoved), so the offer merge drops it', () => scoped(async () => {
    const l = await seed('held-sale-off', { pinned: 20 })
    const on = await write({ listingId: l.id, sale: SALE, expectedVersion: l.version })
    expect(on.results[0].outcome).toBe('applied')
    // The sale left and succeeded; then the listing was paused, and the sale removed while paused.
    await prisma.outboundSyncQueue.updateMany({ where: { channelListingId: l.id, syncStatus: 'PENDING' }, data: { syncStatus: 'SUCCESS', syncedAt: new Date() } })
    const paused = await prisma.channelListing.update({ where: { id: l.id }, data: { syncPaused: true } })
    const off = await write({ listingId: l.id, sale: { value: null, start: null, end: null }, expectedVersion: paused.version })
    expect(off.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect((await held(l.id))[0].payload).toMatchObject({ salePrice: null, saleRemoved: true })
    // A later held change (a pin) keeps naming the removal.
    const pin = await write({ listingId: l.id, price: 21, expectedVersion: (await listing(l.id)).version })
    expect(pin.results[0].outcome).toBe('applied')
    expect(await held(l.id)).toHaveLength(1)
    await resume(l)
    const sent = await pending(l.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ price: 21, salePrice: null, saleRemoved: true })
  }))

  it('still paused: nothing is sent and the held row waits', () => scoped(async () => {
    const l = await seed('held-still', { pinned: 20, paused: true })
    await write({ listingId: l.id, price: 23, expectedVersion: l.version })
    const r = await recascadeAfterSyncControlChange([l.productId], 'person-2')
    expect(r.heldPricesSent).toBe(0)
    expect(await pending(l.id)).toEqual([])
    expect(await held(l.id)).toHaveLength(1)
  }))

  it('a price recorded from the channel\'s own file does not silently overtake a held change: refused, the held row kept', () => scoped(async () => {
    const l = await seed('held-record', { pinned: 20, paused: true })
    await write({ listingId: l.id, price: 26, expectedVersion: l.version })
    const recorded = await writeChannelPrices({ targets: [{ listingId: l.id, price: 19, unguardedReason: 'flat-file-import' }], actor: 'import', source: 'CHANNEL_FILE_IMPORT', recordOnly: 'channel-file-import' })
    expect(recorded.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('waiting to be sent') })
    expect(Number((await listing(l.id)).price)).toBe(26)
    expect(await held(l.id)).toHaveLength(1)
  }))

  it('a row the dispatcher skipped because the listing was paused inside its 30 s hold is sent once on resume', () => scoped(async () => {
    const l = await seed('held-dispatch', { pinned: 20 })
    const r = await write({ listingId: l.id, price: 24, expectedVersion: l.version })
    // Paused inside the hold; the dispatcher then refuses the row as it does (`syncToAmazon`: SKIPPED, PUSH_SYNC_PAUSED).
    await prisma.channelListing.update({ where: { id: l.id }, data: { syncPaused: true } })
    await prisma.outboundSyncQueue.update({ where: { id: r.results[0].queueId! }, data: { syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED', errorMessage: 'Listing sync is paused. Resume sync before sending changes.' } })
    expect(await pending(l.id)).toEqual([])
    expect((await resume(l)).heldPricesSent).toBe(1)
    expect((await pending(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([24])
    expect((await resume(l)).heldPricesSent).toBe(0)
  }))

  it('a held change a later price row already replaced is closed, not sent again', () => scoped(async () => {
    const l = await seed('held-spent', { pinned: 20, paused: true })
    await write({ listingId: l.id, price: 22, expectedVersion: l.version })
    // Resumed by a path that does not run the recascade, and a newer price left since.
    await prisma.channelListing.update({ where: { id: l.id }, data: { syncPaused: false } })
    const newer = await write({ listingId: l.id, price: 23, expectedVersion: (await listing(l.id)).version })
    expect(newer.results[0].queueId).toBeTruthy()
    // The door's own send replaced the held row in its transaction.
    expect(await held(l.id)).toEqual([])
    expect((await recascadeAfterSyncControlChange([l.productId], 'person-2')).heldPricesSent).toBe(0)
    expect((await pending(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([23])
  }))

  it('a pause and a resume with no change in between send no price at all', () => scoped(async () => {
    const l = await seed('held-none', { pinned: 20, paused: true })
    expect((await resume(l)).heldPricesSent).toBe(0)
    expect(await priceRows(l.id)).toEqual([])
  }))
})

describe('🔴 a draft\'s held change is sent ONCE when it goes live — only what its publication does not carry', () => {
  it('round 6 — a following draft at master +10%: nothing is held; Publish itself carries its rule price (13.20), so the go-live sends nothing more', () => scoped(async () => {
    const l = await seed('held-draft-percent', { rule: 'PERCENT_OF_MASTER', adj: 10, draft: true })
    await new MasterPriceService(prisma as never).update(l.productId, 12, { reason: 'test' })
    expect(Number((await listing(l.id)).price)).toBe(13.2)
    // Publish sends `listingSendPrice` (`studio-publication-send-price.vitest.test.ts`): the rule's 13.20 goes out once, with it.
    expect(await priceRows(l.id)).toEqual([])
    expect((await resume(l)).heldPricesSent).toBe(0)
    expect((await goLive(l)).sent).toEqual([])
    expect(await priceRows(l.id)).toEqual([])
  }))

  it('a sale on an eBay draft is not held: eBay\'s sender sends no sale, so the go-live would only send the price again', () => scoped(async () => {
    const l = await seed('held-draft-ebay-sale', { channel: 'EBAY', pinned: 30, draft: true })
    const r = await write({ listingId: l.id, sale: SALE, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(await priceRows(l.id)).toEqual([])
  }))

  it('a sale on a pinned draft is held and sent once at go-live, with the pinned price', () => scoped(async () => {
    const l = await seed('held-draft-sale', { pinned: 30, draft: true })
    const r = await write({ listingId: l.id, sale: SALE, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect((await held(l.id)).map((row) => row.errorCode)).toEqual(['PRICE_HELD_DRAFT'])
    await goLive(l)
    const sent = await pending(l.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ price: 30, salePrice: 8, salePriceStart: SALE.start, salePriceEnd: SALE.end })
  }))

  it('what Publish carries is NOT sent again: a pin on a draft, and a FIXED follower at the master price', () => scoped(async () => {
    const pin = await seed('held-draft-pin', { pinned: 30, draft: true })
    expect((await write({ listingId: pin.id, price: 31, expectedVersion: pin.version })).results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    const fixed = await seed('held-draft-fixed', { draft: true })
    await new MasterPriceService(prisma as never).update(fixed.productId, 11, { reason: 'test' })
    expect(Number((await listing(fixed.id)).price)).toBe(11)
    for (const l of [pin, fixed]) {
      expect(await priceRows(l.id), l.id).toEqual([])
      expect((await goLive(l)).sent, l.id).toEqual([])
      expect(await priceRows(l.id), l.id).toEqual([])
    }
  }))
})

describe('🔴 round 6 — the hook waits for every lock, and every go-live runs it', () => {
  it('a resumed listing whose offer is closed keeps its held change waiting: nothing is queued into a skip', () => scoped(async () => {
    const l = await seed('held-closed', { pinned: 20, paused: true })
    await write({ listingId: l.id, price: 27, expectedVersion: l.version })
    await prisma.channelListing.update({ where: { id: l.id }, data: { syncPaused: false, offerClosedAt: new Date() } })
    const r = await sendHeldPrices({ listingIds: [l.id], actor: 'person-2', cause: 'resume' })
    expect([r.sent, r.stillHeld]).toEqual([[], [l.id]])
    expect(await pending(l.id)).toEqual([])
    expect(await held(l.id)).toHaveLength(1)
    // The offer restored: the next run sends it, once.
    await prisma.channelListing.update({ where: { id: l.id }, data: { offerClosedAt: null } })
    expect((await sendHeldPrices({ listingIds: [l.id], actor: 'person-2', cause: 'resume' })).sent).toEqual([l.id])
    expect((await pending(l.id)).map((row) => (row.payload as { price: number }).price)).toEqual([27])
  }))

  it('a draft made live by the live-listing recorder (flat files, the wizard, reconciliation, eBay pushes) sends its held Amazon sale once', () => scoped(async () => {
    const l = await seed('held-recorder', { pinned: 30, draft: true })
    await write({ listingId: l.id, sale: SALE, expectedVersion: l.version })
    expect((await held(l.id)).map((row) => row.errorCode)).toEqual(['PRICE_HELD_DRAFT'])
    const [recorded] = await recordLiveListingsInTransaction({ channel: 'AMAZON', market: 'IT', accountId: accounts.AMAZON,
      rows: [{ productId: l.productId, listingStatus: 'ACTIVE', externalListingId: 'TEST-ASIN-RECORDER' }] }, 'person-2')
    expect(recorded).toMatchObject({ id: l.id, unpaused: true })
    const sent = await pending(l.id)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ price: 30, salePrice: 8, salePriceStart: SALE.start, salePriceEnd: SALE.end })
    expect(await held(l.id)).toEqual([])
  }))
})

describe('the hooks that run it', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('every resume\'s recascade sends the held prices of the products it re-works', () => {
    const body = source('../stock-movement.service.ts').split('export async function recascadeAfterSyncControlChange')[1]!.split('\nexport ')[0]!
    expect(body).toContain("sendHeldPrices({ productIds: unique, actor, cause: 'resume' })")
  })
  it('the stock import\'s FOLLOW/PINNED column clears a pause, and sends the held prices of those products', () => {
    const body = source('../stock-import.service.ts').split('export async function applyControlColumns')[1]!.split('\nexport ')[0]!
    expect(body).toMatch(/data: \{ syncPaused: false \}[\s\S]*sendHeldPrices\(\{ productIds: \[\.\.\.resumeProducts\], actor, cause: 'resume' \}\)/)
  })
  it('round 6 — every caller of the live-listing recorder sends the held prices after its transaction commits', () => {
    for (const [file, call] of [
      ['../amazon/flat-file-pull.service.ts', "sendHeldPricesAfterGoLive([recorded], 'amazon-pull')"],
      ['../amazon/flat-file.service.ts', "sendHeldPricesAfterGoLive([recorded], 'amazon-flat-file')"],
      ['../ebay-variation-push.service.ts', "sendHeldPricesAfterGoLive(recorded, 'ebay-push')"],
      ['../listing-wizard/submission.service.ts', "sendHeldPricesAfterGoLive(recorded, 'listing-wizard')"],
      ['../listing-reconciliation.service.ts', 'sendHeldPricesAfterGoLive(wentLive, reviewedBy)'],
      ['./live-listing.service.ts', 'await sendHeldPricesAfterGoLive(recorded, actor)'],
    ] as const) expect(source(file), file).toContain(call)
  })
  it('Publish sends the held prices of the drafts that went live: Amazon\'s acceptance and eBay\'s receipt', () => {
    const body = source('./studio-publication.service.ts')
    expect(body.split('async function storeResult')[1]!.split('\nasync function ')[0]).toMatch(/promoted = await promoteAcceptedDrafts\(tx, context\)[\s\S]*await heldPricesAfterGoLive\(promoted, userId\)/)
    expect(body.split('async function reconcileEbayReceipt')[1]!.split('\nasync function ')[0]).toMatch(/STILL_DRAFT_LISTING[\s\S]*await heldPricesAfterGoLive\(drafts, userId\)/)
  })
})

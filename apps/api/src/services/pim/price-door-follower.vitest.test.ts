/**
 * The channel price door's FOLLOWER mode (2026-10-01, "pricing rules reach the channels").
 *
 * 🔴 WHAT THIS GUARDS. A change to a listing's pricing rule, adjustment percent or follow-master flag was a plain
 * column write: nothing recomputed the price and nothing was queued, so a listing set to "master +10%" kept its old
 * price on Amazon / eBay / Shopify until something unrelated pushed it. A hand-back (`price: null`) sent the raw
 * master number, ignoring PERCENT_OF_MASTER, the currency refusal and the paused/draft hold, and stored `price: null`.
 *
 * Now the door writes the columns in its compare-and-set and applies the master-price cascade's own rules
 * (`follower-price.ts`): the computed price is stored and queued exactly like the cascade's row, held for a paused
 * listing or a draft, refused for a market in another currency, refused (nothing written) outside the product's
 * floor or ceiling.
 *
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-reset.vitest.test.ts`. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, failQueueRow: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
// A failure AFTER the column write: the queue row cannot be created, so the whole change must roll back.
vi.mock('../outbound-rows.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../outbound-rows.js')>()
  return { ...real, createOutboundRow: vi.fn(async (...args: Parameters<typeof real.createOutboundRow>) => {
    if (state.failQueueRow) throw new Error('queue row refused after the column write')
    return real.createOutboundRow(...args)
  }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { MasterPriceService } from '../master-price.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
  await market('AMAZON', 'IT', 'EUR')
  await market('EBAY', 'DE', 'EUR')
  await market('EBAY', 'UK', 'GBP')
  for (const channel of ['AMAZON', 'EBAY']) {
    accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `follower-${channel}`, isActive: true } })).id
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

interface Seed {
  channel?: 'AMAZON' | 'EBAY'
  marketplace?: string
  price?: number | null
  follow?: boolean
  rule?: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
  adj?: number | null
  listing?: Record<string, unknown>
  product?: Record<string, unknown>
}
/** A product at master 10 and one live listing following it at 10 (FIXED) unless told otherwise. */
async function seed(id: string, s: Seed = {}) {
  const channel = s.channel ?? 'EBAY'
  const marketplace = s.marketplace ?? 'DE'
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, ...s.product } as never })
  return prisma.channelListing.create({ data: {
    productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`,
    price: s.price === undefined ? 10 : s.price, masterPrice: 10, followMasterPrice: s.follow ?? true,
    priceOverride: s.follow === false ? (s.price ?? 10) : null,
    pricingRule: s.rule ?? 'FIXED', priceAdjustmentPercent: s.adj ?? null,
    ...s.listing,
  } as never })
}
const listing = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const queue = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const pending = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncStatus: 'PENDING' } })
const door = (target: Omit<PriceWriteTarget, 'expectedVersion' | 'unguardedReason'> & { expectedVersion: number }) =>
  writeChannelPrices({ targets: [target as PriceWriteTarget], actor: 'person-1', source: 'MANUAL_OVERRIDE', reason: 'test' })
const toPercent = (l: { id: string; version: number }, adj = 10) => door({ listingId: l.id, rule: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: adj }, expectedVersion: l.version })
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}
/** Everything a refused or rolled-back change must leave exactly as it was. */
const footprint = async (l: { id: string; productId: string }) => ({
  listing: await listing(l.id),
  queue: await queue(l.id),
  overrides: await prisma.channelListingOverride.count({ where: { channelListingId: l.id } }),
  timeline: await prisma.priceChangeEvent.count({ where: { productId: l.productId } }),
})

describe('a rule change on a following listing recomputes the price and sends it, once', () => {
  it('🔴 master 10, EUR, following at 10 → PERCENT_OF_MASTER +10: price 11.00 and ONE pending PRICE_UPDATE at 11 on the 30 s hold', () => scoped(async () => {
    const l = await seed('fw-percent')
    vi.mocked(fireOutboundJobs).mockClear()
    const r = await toPercent(l)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', guarded: true, version: l.version + 1 })
    expect(r.results[0].notSent).toBeUndefined()
    const stored = await listing(l.id)
    expect(Number(stored.price)).toBe(11)
    expect(Number(stored.masterPrice)).toBe(10)
    expect(stored).toMatchObject({ pricingRule: 'PERCENT_OF_MASTER', followMasterPrice: true, priceOverride: null, syncStatus: 'PENDING', lastOverrideBy: 'person-1' })
    expect(Number(stored.priceAdjustmentPercent)).toBe(10)
    const rows = await queue(l.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ syncType: 'PRICE_UPDATE', syncStatus: 'PENDING', id: r.results[0].queueId })
    expect(inThirtySeconds(rows[0].holdUntil)).toBe(true)
    // The cascade's payload fields (`followerPricePayload`), plus this door's sale window.
    expect(rows[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 11, oldPrice: 10, masterPrice: 10, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10,
      productId: 'fw-percent', productSku: 'FW-PERCENT', channel: 'EBAY', marketplace: 'DE', actor: 'person-1', salePrice: null })
    expect(fireOutboundJobs).toHaveBeenCalledTimes(1)
    // The audit names the rule and the price; the timeline the price.
    const overrides = await prisma.channelListingOverride.findMany({ where: { channelListingId: l.id }, orderBy: { fieldName: 'asc' } })
    expect(overrides.map((o) => [o.fieldName, o.previousValue, o.newValue])).toEqual([
      ['price', '10', '11'], ['priceAdjustmentPercent', null, '10'], ['pricingRule', 'FIXED', 'PERCENT_OF_MASTER'],
    ])
    expect((await prisma.priceChangeEvent.findMany({ where: { productId: l.productId } })).map((e) => [Number(e.oldPrice), Number(e.newPrice)])).toEqual([[10, 11]])

    // 🔴 The same change again is a no-op: nothing written, no new row.
    const again = await toPercent(stored)
    expect(again.results[0]).toMatchObject({ outcome: 'noop', version: stored.version, queueId: null })
    expect(await listing(l.id)).toEqual(stored)
    expect(await queue(l.id)).toEqual(rows)
  }))

  it('the cascade and the door queue the same payload fields for the same follower price', () => scoped(async () => {
    const viaDoor = await seed('fw-same-door', { rule: 'PERCENT_OF_MASTER', adj: 10, price: 11 })
    const viaCascade = await seed('fw-same-cascade', { rule: 'PERCENT_OF_MASTER', adj: 20, price: 12 })
    // The door: +10% → +20% on the master 10 → 12. The cascade: the master 10 → 20 under +20% → 24.
    await door({ listingId: viaDoor.id, rule: { priceAdjustmentPercent: 20 }, expectedVersion: viaDoor.version })
    await new MasterPriceService(prisma as never).update('fw-same-cascade', 20)
    const [d] = await queue(viaDoor.id)
    const [c] = await queue(viaCascade.id)
    // The door adds its actor and its sale window; every field the cascade's row carries, the door's carries too.
    const keys = (p: unknown) => Object.keys(p as object).filter((k) => !['actor', 'salePrice', 'salePriceStart', 'salePriceEnd'].includes(k)).sort()
    expect(keys(d.payload)).toEqual(keys(c.payload))
    expect(d.payload).toMatchObject({ price: 12, masterPrice: 10, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 20 })
    expect(c.payload).toMatchObject({ price: 24, masterPrice: 20, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 20 })
    expect(inThirtySeconds(d.holdUntil)).toBe(true)
    expect(inThirtySeconds(c.holdUntil)).toBe(true)
  }))
})

describe('the cascade\'s rules hold in the door', () => {
  it('a paused listing and a still-draft store 11 and queue nothing, and say so', () => scoped(async () => {
    const paused = await seed('fw-paused', { listing: { syncPaused: true } })
    const draft = await seed('fw-draft', { listing: { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } })
    // Round 5 — nothing is queued (no PENDING row): the paused listing's price is kept as ONE held row, never dispatched,
    // that the resume sends once (`price-door-held.vitest.test.ts`). Round 6 — the draft holds no row: its Publish
    // carries its rule price (`listingSendPrice`).
    const heldRows = async (id: string) => (await queue(id)).filter((row) => row.syncStatus !== 'CANCELLED').map((row) => [row.syncStatus, row.errorCode, (row.payload as { price?: number }).price])
    for (const [l, rows] of [[paused, [['SKIPPED', 'PUSH_SYNC_PAUSED', 11]]], [draft, []]] as const) {
      const r = await toPercent(l)
      expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
      expect(Number((await listing(l.id)).price)).toBe(11)
      expect(await pending(l.id)).toEqual([])
      expect(await heldRows(l.id)).toEqual(rows)
    }
    expect((await toPercent(await listing(paused.id), 20)).results[0].notSent).toMatch(/sync is paused/)
    expect((await toPercent(await listing(draft.id), 20)).results[0].notSent).toMatch(/draft .* Publish sends it/)
    // The newer held change replaces the older one: still ONE held row, at the newer price.
    expect(await heldRows(paused.id)).toEqual([['SKIPPED', 'PUSH_SYNC_PAUSED', 12]])
    expect(await heldRows(draft.id)).toEqual([])
    expect(await pending(paused.id)).toEqual([])
  }))

  it('🔴 a GBP market keeps 10, queues nothing and returns the cascade\'s refusal sentence; the rule is written', () => scoped(async () => {
    const l = await seed('fw-gbp', { marketplace: 'UK' })
    const r = await toPercent(l)
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(r.results[0].notSent).toBe('The master price EUR 10.00 was not sent to EBAY UK: that market sells in GBP. Set this listing\'s own GBP price. Nothing was queued.')
    const stored = await listing(l.id)
    expect(Number(stored.price)).toBe(10)
    expect(stored.pricingRule).toBe('PERCENT_OF_MASTER')
    expect(stored.syncStatus).not.toBe('PENDING')
    expect(await queue(l.id)).toEqual([])
    // Recorded once the change committed, as the cascade records it.
    const conflicts = await prisma.syncHealthLog.findMany({ where: { productId: l.productId, conflictType: 'MASTER_PRICE_CURRENCY_REFUSED' } })
    expect(conflicts.map((c) => c.errorMessage)).toEqual([r.results[0].notSent])
  }))

  it('MATCH_AMAZON, and a rule change on a listing that does not follow the master, write the rule and send nothing', () => scoped(async () => {
    const match = await seed('fw-match')
    const r = await door({ listingId: match.id, rule: { pricingRule: 'match_amazon' }, expectedVersion: match.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(r.results[0].notSent).toMatch(/Amazon’s pricing/)
    expect(await listing(match.id)).toMatchObject({ pricingRule: 'MATCH_AMAZON' })
    expect(Number((await listing(match.id)).price)).toBe(10)
    expect(await queue(match.id)).toEqual([])

    const pinned = await seed('fw-pinned', { follow: false, price: 25 })
    const p = await toPercent(pinned)
    expect(p.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(p.results[0].notSent).toMatch(/keeps its own price EUR 25.00/)
    expect(Number((await listing(pinned.id)).price)).toBe(25)
    expect(await queue(pinned.id)).toEqual([])
  }))
})

describe('refusals write nothing', () => {
  it('🔴 outside the product\'s floor or ceiling: refused by name, nothing written', () => scoped(async () => {
    const ceiling = await seed('fw-ceiling', { product: { maxPrice: 10.5 } })
    const floor = await seed('fw-floor', { product: { minPrice: 9.5 } })
    for (const [l, adj, words] of [[ceiling, 10, 'above its pricing ceiling of 10.50'], [floor, -10, 'below its pricing floor of 9.50']] as const) {
      const before = await footprint(l)
      const r = await toPercent(l, adj)
      expect(r.results[0]).toMatchObject({ outcome: 'refused', queueId: null })
      expect(r.results[0].reason).toContain(words)
      expect(r.results[0].reason).toContain('Nothing was changed.')
      expect(await footprint(l)).toEqual(before)
    }
  }))

  it('a stale version is a conflict and writes nothing', () => scoped(async () => {
    const l = await seed('fw-stale')
    const before = await footprint(l)
    const r = await door({ listingId: l.id, rule: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, expectedVersion: l.version - 1 })
    expect(r.results[0]).toMatchObject({ outcome: 'conflict', version: l.version })
    expect(await footprint(l)).toEqual(before)
  }))

  it('🔴 a failure after the column write leaves nothing behind: no rule, no price, no audit, no row, nothing fired', () => scoped(async () => {
    const l = await seed('fw-rollback')
    const before = await footprint(l)
    vi.mocked(fireOutboundJobs).mockClear()
    state.failQueueRow = true
    try {
      await expect(toPercent(l)).rejects.toThrow('queue row refused after the column write')
    } finally { state.failQueueRow = false }
    expect(await footprint(l)).toEqual(before)
    expect(fireOutboundJobs).not.toHaveBeenCalled()
  }))

  it('the percent is checked the same everywhere: a number, 2 decimals, above -100, at most 999.99; the rule by name', () => scoped(async () => {
    const l = await seed('fw-percent-checks')
    const before = await footprint(l)
    for (const [rule, words] of [
      [{ priceAdjustmentPercent: -100 }, 'above -100%'],
      [{ priceAdjustmentPercent: 10.555 }, '2 decimals'],
      [{ priceAdjustmentPercent: 1000 }, '999.99'],
      [{ priceAdjustmentPercent: Number.NaN }, 'must be a number'],
      [{ pricingRule: 'CHEAPEST' }, 'Choose a pricing rule: Fixed, Match Amazon or Percent of master.'],
    ] as const) {
      const r = await door({ listingId: l.id, rule, expectedVersion: l.version })
      expect(r.results[0].outcome).toBe('refused')
      expect(r.results[0].reason).toContain(words)
    }
    expect(await footprint(l)).toEqual(before)
    // A follow flag and a pin in one change contradict each other.
    const both = await door({ listingId: l.id, price: 12, follow: true, expectedVersion: l.version })
    expect(both.results[0]).toMatchObject({ outcome: 'refused' })
    expect(await footprint(l)).toEqual(before)
  }))
})

describe('hand-back and stop-following', () => {
  it('🔴 a hand-back (price: null) of a PERCENT listing sends the RULE\'s price, not the raw master', () => scoped(async () => {
    const l = await seed('fw-handback', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 })
    const r = await door({ listingId: l.id, price: null, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied' })
    const stored = await listing(l.id)
    expect(Number(stored.price)).toBe(11)
    expect(stored).toMatchObject({ followMasterPrice: true, priceOverride: null })
    expect((await pending(l.id)).map((row) => (row.payload as any).price)).toEqual([11])
    // follow: true is the same hand-back.
    const viaFollow = await seed('fw-handback-follow', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 })
    await door({ listingId: viaFollow.id, follow: true, expectedVersion: viaFollow.version })
    expect(Number((await listing(viaFollow.id)).price)).toBe(11)
    expect((await pending(viaFollow.id)).map((row) => (row.payload as any).price)).toEqual([11])
  }))

  it('a hand-back to a GBP market follows the master but sends nothing, and says why', () => scoped(async () => {
    const l = await seed('fw-handback-gbp', { marketplace: 'UK', follow: false, price: 9 })
    const r = await door({ listingId: l.id, price: null, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(r.results[0].notSent).toMatch(/sells in GBP/)
    expect(await listing(l.id)).toMatchObject({ followMasterPrice: true, priceOverride: null })
    expect(Number((await listing(l.id)).price)).toBe(9)
    expect(await queue(l.id)).toEqual([])
  }))

  it('stop following keeps the price: the flag only, nothing sent', () => scoped(async () => {
    const l = await seed('fw-unfollow', { rule: 'PERCENT_OF_MASTER', adj: 10, price: 11 })
    const r = await door({ listingId: l.id, follow: false, expectedVersion: l.version })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    const stored = await listing(l.id)
    expect(stored.followMasterPrice).toBe(false)
    expect(Number(stored.price)).toBe(11)
    expect(await queue(l.id)).toEqual([])
    expect((await door({ listingId: l.id, follow: false, expectedVersion: stored.version })).results[0].outcome).toBe('noop')
  }))

  it('an Amazon sale removal waiting in the grace window is carried by the follower row that replaces it', () => scoped(async () => {
    const l = await seed('fw-sale-carry', { channel: 'AMAZON', marketplace: 'IT' })
    const waiting = await prisma.outboundSyncQueue.create({ data: { productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON', syncStatus: 'PENDING', syncType: 'PRICE_UPDATE',
      payload: { price: 10, salePrice: null, saleRemoved: true }, maxRetries: 3 } })
    await toPercent(l)
    const rows = await queue(l.id)
    expect(rows.find((row) => row.id === waiting.id)?.syncStatus).toBe('CANCELLED')
    expect((await pending(l.id)).map((row) => [(row.payload as any).price, (row.payload as any).saleRemoved])).toEqual([[11, true]])
  }))
})

describe('typed prices (pins) — above 0 and inside the floor/ceiling, in the master currency only', () => {
  const pin = (l: { id: string; version: number }, price: number) => door({ listingId: l.id, price, expectedVersion: l.version })

  it('🔴 a EUR pin above the product\'s ceiling is refused at the edit, nothing written; inside it is sent', () => scoped(async () => {
    const l = await seed('pin-eur-ceiling', { product: { maxPrice: 20 } })
    const before = await footprint(l)
    const r = await pin(l, 25)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', queueId: null })
    expect(r.results[0].reason).toBe('PIN-EUR-CEILING on EBAY DE cannot be pinned at 25.00: 25.00 is above its pricing ceiling of 20.00. Change the price, or the floor or ceiling on the product. Nothing was changed.')
    expect(await footprint(l)).toEqual(before)
    expect((await pin(l, 19.5)).results[0].outcome).toBe('applied')
    expect((await pending(l.id)).map((row) => (row.payload as any).price)).toEqual([19.5])
  }))

  it('🔴 a GBP pin above the EUR ceiling is NOT refused: the bounds are master-currency numbers (refuse, don\'t convert)', () => scoped(async () => {
    const l = await seed('pin-gbp-ceiling', { marketplace: 'UK', product: { maxPrice: 20, minPrice: 15 } })
    const r = await pin(l, 25)
    expect(r.results[0]).toMatchObject({ outcome: 'applied' })
    expect((await pending(l.id)).map((row) => (row.payload as any).price)).toEqual([25])
    // Below the EUR floor, in GBP: not compared either.
    expect((await pin(await listing(l.id), 9)).results[0].outcome).toBe('applied')
  }))

  it('a pin of 0 is refused; a price recorded from the channel\'s own file keeps the old rule (its fact, not a typed price)', () => scoped(async () => {
    const l = await seed('pin-zero', { product: { maxPrice: 20 } })
    const before = await footprint(l)
    const r = await pin(l, 0)
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/^PIN-ZERO on \w+ \w+ was not pinned: the new price would be 0\.00, and a price must be above 0\. Nothing was changed\.$/) })
    expect(await footprint(l)).toEqual(before)
    // Record-only (CFI-6): the channel already holds 25 — it is recorded, not refused for the ceiling, and nothing is sent.
    const recorded = await writeChannelPrices({ targets: [{ listingId: l.id, price: 25, expectedVersion: l.version }], actor: 'import', source: 'CHANNEL_FILE_IMPORT', recordOnly: 'channel-file-import' })
    expect(recorded.results[0].outcome).toBe('applied')
    expect(await queue(l.id)).toEqual([])
  }))
})

import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN Step 2.2, Gate (2) — two concurrent price edits give one `applied` and one `conflict`.
 *
 * On `concurrent-database.ts`, never PGlite: PGlite is one connection, so it serialises the two
 * writes and the test would pass whether or not the compare-and-set works. Here the race is FORCED,
 * not hoped for: a third connection holds the listing row, both writers read the same version and
 * block on the row, and the test waits until PostgreSQL reports both of them waiting before it
 * releases the row. Only then does the listing-version compare-and-set decide the winner.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  // R-VT-12 has verified this URL. The helper creates its own database, never uses the catalogue.
  process.env.NEXUS_TEST_CONCURRENT_PG_URL = process.env.DATABASE_URL
  const { concurrentDatabase } = await import('../../test-support/concurrent-database.js')
  state.db = await concurrentDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID,
  actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

async function seed(id: string) {
  const product = await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10 } })
  const listing = await prisma.channelListing.create({ data: { productId: id, channel: 'EBAY', channelMarket: 'EBAY_DE',
    marketplace: 'DE', region: 'EU', price: 25, priceOverride: 25, followMasterPrice: false } })
  return { product, listing }
}

type Attempt = { price: number; won: boolean; detail: unknown }
const door = (listingId: string, version: number, price: number) => async (): Promise<Attempt> => {
  const result = await writeChannelPrices({ targets: [{ listingId, price, expectedVersion: version }], actor: 'race', source: 'MANUAL_OVERRIDE' })
  return { price, won: result.results[0].outcome === 'applied', detail: result.results[0] }
}
const sheet = (productId: string, version: number, price: number) => async (): Promise<Attempt> => {
  try {
    const result = await applyProductBulkEdits({ changes: [{ id: productId, field: 'ebay_price', value: price, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE' }], expectedVersion: version },
    { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } })
    return { price, won: true, detail: result }
  } catch (error) {
    return { price, won: false, detail: error }
  }
}

/** Both writers must have READ the version and be BLOCKED on the row before it is released. */
async function race(listingId: string, attempts: Array<() => Promise<Attempt>>) {
  const locker = await state.db.pool.connect()
  try {
    await locker.query('BEGIN')
    await locker.query('SELECT id FROM "ChannelListing" WHERE id = $1 FOR UPDATE', [listingId])
    const running = attempts.map(attempt => scoped(attempt))
    let waiting = 0
    // Up to 15 s: the push hook runs ~870 files at once, and a starved writer must not read as no race.
    for (let i = 0; i < 600 && waiting < attempts.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    // The positive control: without this the "race" may have run one writer after the other.
    expect(waiting, 'both writers must be blocked on the row before it is released').toBe(attempts.length)
    await locker.query('COMMIT')
    return await Promise.all(running)
  } finally {
    locker.release()
  }
}

async function expectOneWinner(product: { id: string }, listing: { id: string; version: number }, results: Attempt[]) {
  expect(results.filter(r => r.won), JSON.stringify(results)).toHaveLength(1)
  const winner = results.find(r => r.won)!
  const loser = results.find(r => !r.won)!
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(winner.price)
  expect(stored.version).toBe(listing.version + 1)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(1)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(1)
  return loser.detail
}

it('door vs door: one applied, one conflict naming the version that won', () => scoped(async () => {
  const { product, listing } = await seed('race-door')
  const results = await race(listing.id, [door(listing.id, listing.version, 30), door(listing.id, listing.version, 40)])
  const loser = await expectOneWinner(product, listing, results)
  expect(loser).toMatchObject({ outcome: 'conflict', guarded: true, version: listing.version + 1, queueId: null })
}), 60_000)

it('sheet vs door: the sheet gets a 409 on the listing version, or wins cleanly', () => scoped(async () => {
  const { product, listing } = await seed('race-mixed')
  const results = await race(listing.id, [sheet(product.id, listing.version, 30), door(listing.id, listing.version, 40)])
  const loser = await expectOneWinner(product, listing, results)
  if (results[0].won) expect(loser).toMatchObject({ outcome: 'conflict', version: listing.version + 1 })
  else expect(loser).toMatchObject({ statusCode: 409, details: { code: 'VERSION_CONFLICT', versionOf: 'channelListing', currentVersion: listing.version + 1 } })
}), 60_000)

it('sheet vs sheet: one save lands, the other is a 409 and changes nothing', () => scoped(async () => {
  const { product, listing } = await seed('race-sheet')
  const results = await race(listing.id, [sheet(product.id, listing.version, 30), sheet(product.id, listing.version, 40)])
  const loser = await expectOneWinner(product, listing, results)
  expect(loser).toMatchObject({ statusCode: 409, details: { code: 'VERSION_CONFLICT', versionOf: 'channelListing' } })
}), 60_000)

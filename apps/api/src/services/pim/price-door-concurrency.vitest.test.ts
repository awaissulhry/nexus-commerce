import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
/**
 * A-31 (R-29) — NOTHING connects at load. This file used to build its database from `DATABASE_URL` inside this factory,
 * so on the CI runner (no PostgreSQL) it failed to LOAD and turned `main` red. Like every other `concurrentDatabase()`
 * file it now runs only when `NEXUS_TEST_CONCURRENT_PG_URL` names a server — the push hook's throwaway one
 * (`scripts/run-real-postgres-tests.mjs`) — and the client is created in `beforeAll`, behind the skip.
 */
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`price-door-concurrency: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID,
  actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!concurrentDatabaseUrl())(`Step 2.2 Gate 2 — concurrent price writes (needs ${CONCURRENT_PG_ENV})`, () => {
beforeAll(async () => {
  state.db = await concurrentDatabase()
  await scoped(() => prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } }))
}, 120_000)
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
async function race(listingId: string, attempts: Array<() => Promise<Attempt | unknown>>, during?: string) {
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
    // A-17: the locker's own write lands in the gap between the writers' read and their save.
    if (during) await locker.query(during, [listingId])
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

// ── A-17 (R-12) — `expectedPrice`: retry only when nobody touched the price ─────────────────────

const priceWrite = (listingId: string, target: Record<string, unknown>) =>
  writeChannelPrices({ targets: [{ listingId, ...target } as never], actor: 'A-17', source: 'MANUAL_OVERRIDE' }).then(r => r.results[0])
const bump = (id: string, data: Record<string, unknown>) =>
  prisma.channelListing.update({ where: { id }, data: { ...data, version: { increment: 1 } } })

it('A-17: a version moved by a quantity write is retried once when the price is the one the caller saw', () => scoped(async () => {
  const { product, listing } = await seed('a17-quantity')
  await bump(listing.id, { quantity: 5 })
  const outcome = await priceWrite(listing.id, { price: 30, expectedVersion: listing.version, expectedPrice: 25 })
  expect(outcome).toMatchObject({ outcome: 'applied', guarded: true, retried: true, version: listing.version + 2 })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(30)
  expect(stored.quantity).toBe(5)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
}), 60_000)

it('A-17: following the master (expectedPrice null) is retried too', () => scoped(async () => {
  const product = await prisma.product.create({ data: { sku: 'a17-follow', name: 'a17-follow', basePrice: 10 } })
  const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', channelMarket: 'EBAY_DE',
    marketplace: 'DE', region: 'EU', price: 10, priceOverride: null, followMasterPrice: true } })
  await bump(listing.id, { quantity: 5 })
  expect(await priceWrite(listing.id, { price: 30, expectedVersion: listing.version, expectedPrice: null }))
    .toMatchObject({ outcome: 'applied', retried: true, version: listing.version + 2 })
}), 60_000)

it.each([
  ['somebody changed the price', { price: 27, priceOverride: 27 }, { expectedPrice: 25 }],
  ['no expectedPrice was given', { quantity: 5 }, {}],
  ['the write also changes the sale', { quantity: 5 }, { expectedPrice: 25, sale: { value: 20, start: '2026-10-01', end: '2026-10-02' } }],
  ['a legacy price key is present', { quantity: 5, overrideData: { ebay_price: 98 } }, { expectedPrice: 25 }],
])('A-17: the conflict stands when %s', (_name, moved, extra) => scoped(async () => {
  const { product, listing } = await seed(`a17-${_name.replace(/\W+/g, '-')}`)
  const after = await bump(listing.id, moved)
  const outcome = await priceWrite(listing.id, { price: 30, expectedVersion: listing.version, ...extra })
  expect(outcome).toMatchObject({ outcome: 'conflict', version: listing.version + 1 })
  expect(outcome).not.toHaveProperty('retried')
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(after)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)
}), 60_000)

it('A-17 race: a quantity write that lands in the gap is retried on the re-read row', () => scoped(async () => {
  const { product, listing } = await seed('a17-race-quantity')
  const [outcome] = await race(listing.id, [() => priceWrite(listing.id, { price: 30, expectedVersion: listing.version, expectedPrice: 25 })],
    'UPDATE "ChannelListing" SET quantity = 5, version = version + 1 WHERE id = $1')
  expect(outcome).toMatchObject({ outcome: 'applied', retried: true, version: listing.version + 2 })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect([Number(stored.price), stored.quantity, stored.version]).toEqual([30, 5, listing.version + 2])
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
}), 60_000)

it('A-17 race: a price write that lands in the gap keeps the conflict and its price', () => scoped(async () => {
  const { product, listing } = await seed('a17-race-price')
  const [outcome] = await race(listing.id, [() => priceWrite(listing.id, { price: 30, expectedVersion: listing.version, expectedPrice: 25 })],
    'UPDATE "ChannelListing" SET price = 27, "priceOverride" = 27, version = version + 1 WHERE id = $1')
  expect(outcome).toMatchObject({ outcome: 'conflict', version: listing.version + 1 })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(27)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)
}), 60_000)
})

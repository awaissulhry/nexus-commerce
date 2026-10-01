import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  // A-31 (R-29) — real PostgreSQL in-process (PGlite). These arms test what a write STORES, not a race, so they need no
  // server: the old `concurrentDatabase()` built a database from `DATABASE_URL` at load, and CI has no server there, so
  // this file failed to load on every CI run of `main`.
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { channelOverrideKeys } from './channel-field-map.js'
import { channelValuePatch } from './channel-value-mutation.js'
import { resolveAttributes } from './attribute-resolver.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { produceReadiness } from './readiness-index.service.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID,
  actorUserId: null, membershipId: null, roleKeys: [] }, work)

let account = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'price-door-reset', isActive: true } })).id
}))

async function seed(id: string, following: boolean) {
  const product = await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10 } })
  // A-31 — the listing names its account, as a live listing does. The queue row's destination is then the listing's
  // (`outbound-destination.ts` step 2, read through the transaction). A listing with NO account falls to step 4, which
  // reads the channel's accounts through the OUTER client — a second connection that the one-connection PGlite cannot
  // give inside a transaction, so the door's direct arms timed out at 5,000 ms (recorded in A-31 for the P1.3 owner).
  const listing = await prisma.channelListing.create({ data: { productId: id, channel: 'EBAY', channelConnectionId: account,
    channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU',
    price: following ? null : 25, priceOverride: following ? null : 25, followMasterPrice: following,
    overrideData: { price: 99, ebay_price: 98, unrelated: 'keep' } } })
  return { product, listing }
}

it('control: the existing sheet reset removes legacy keys and preserves unrelated data', () => scoped(async () => {
  const { product, listing } = await seed('price-reset-control', false)
  const patch = channelValuePatch(listing as any, { kind: 'listingColumn', column: 'price',
    followFlag: 'followMasterPrice' }, channelOverrideKeys('ebay_price'), 'INHERIT')
  await prisma.channelListing.update({ where: { id: listing.id }, data: patch as any })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(stored.overrideData).toEqual({ unrelated: 'keep' })
  expect(resolveAttributes({ product: product as any, parent: null, channelListing: stored as any, marketLanguages: ['de'], locale: 'de' }).price).toBeUndefined()
}))

// A-18: two distinct reset paths. Each must fail when its cleanup is removed.
it.each([false, true])('cleans a dirty reset when already following = %s; a clean repeat spends nothing', following => scoped(async () => {
  const { product, listing } = await seed(`price-reset-${following}`, following)
  const reset = (version: number) => writeChannelPrices({ targets: [{ listingId: listing.id, price: null,
    expectedVersion: version }], actor: 'A-18 gate', source: 'MANUAL_OVERRIDE' })
  const result = await reset(listing.version)
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(result.results[0]).toMatchObject({ outcome: 'applied', guarded: true, version: listing.version + 1 })
  // 2026-10-01 — a hand-back is the door's follower mode: it STORES the price it sends (the rule's price from the
  // master, 10 here), where it used to store `price: null` and send the master number. Still no own price.
  expect(stored).toMatchObject({ priceOverride: null, followMasterPrice: true, overrideData: { unrelated: 'keep' } })
  expect(Number(stored.price)).toBe(10)
  expect(stored.overrideData).toEqual({ unrelated: 'keep' })
  expect(resolveAttributes({ product: product as any, parent: null, channelListing: stored as any, marketLanguages: ['de'], locale: 'de' }).price).toBeUndefined()
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(1)
  const queue = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: listing.id } })
  expect(queue).toHaveLength(1)
  expect(queue[0]).toMatchObject({ syncType: 'PRICE_UPDATE', payload: { price: 10 } })

  expect((await reset(stored.version)).results[0]).toMatchObject({ outcome: 'noop', version: stored.version, queueId: null })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(stored)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(1)
  expect(await prisma.outboundSyncQueue.findMany({ where: { channelListingId: listing.id } })).toEqual(queue)
}))

it.each([false, true])('a stale reset preserves every value and creates no event or queue row (following = %s)', following => scoped(async () => {
  const { product, listing } = await seed(`price-reset-stale-${following}`, following)
  const result = await writeChannelPrices({ targets: [{ listingId: listing.id, price: null,
    expectedVersion: listing.version - 1 }], actor: 'A-18 gate', source: 'MANUAL_OVERRIDE' })
  expect(result.results[0]).toMatchObject({ outcome: 'conflict', version: listing.version, guarded: true })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(listing)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(0)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(0)
}))

const bulkContext = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
const sheetWrite = (productId: string, field: string, value: number | null, version?: number, intent: 'set' | 'reset' = 'set', cascade = false) =>
  applyProductBulkEdits({ changes: [{ id: productId, field, value, target: 'channel', intent, cascade }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE' }], expectedVersion: version }, bulkContext)

it.each(['ebay_price', 'attr_price'])('both sheet wire paths clean dirty resets, including already-following: %s', field => scoped(async () => {
  for (const following of [false, true]) {
    const { product, listing } = await seed(`sheet-reset-${field}-${following}`, following)
    const result = await sheetWrite(product.id, field, null, listing.version, 'reset')
    expect(result).toMatchObject({ updated: 1, currentVersion: listing.version + 1, versionOf: 'channelListing' })
    // The follower price it sends is the price it stores (2026-10-01; was `price: null`).
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({
      priceOverride: null, followMasterPrice: true, overrideData: { unrelated: 'keep' },
    })
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).price)).toBe(10)
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).overrideData).toEqual({ unrelated: 'keep' })
    expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(1)
  }
}))

it.each(['ebay_price', 'attr_price'])('the sheet refuses stale, missing and parent-cascade versions at the price boundary: %s', field => scoped(async () => {
  const { product, listing } = await seed(`sheet-guard-${field}`, false)
  for (const intent of ['set', 'reset'] as const) {
    const value = intent === 'reset' ? null : 12
    await expect(sheetWrite(product.id, field, value, listing.version - 1, intent)).rejects.toMatchObject({
      statusCode: 409, details: { versionOf: 'channelListing', currentVersion: listing.version },
    })
    await expect(sheetWrite(product.id, field, value, undefined, intent)).rejects.toMatchObject({
      statusCode: 400, details: { errors: [expect.objectContaining({ error: expect.stringContaining('expectedVersion') })] },
    })
    // A reset with a cascade is refused earlier, by the reset validator; a set reaches the price guard.
    await expect(sheetWrite(product.id, field, value, listing.version, intent, true)).rejects.toMatchObject({
      statusCode: 400, details: { errors: [expect.objectContaining({ error: expect.stringContaining(
        intent === 'reset' ? 'without a family cascade' : 'parent version') })] },
    })
  }
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(listing)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(0)
}))

it('a price and quantity paste shares the original listing guard; a quantity-only write spends no price event', () => scoped(async () => {
  const { product, listing } = await seed('sheet-mixed', false)
  const result = await applyProductBulkEdits({ changes: [
    { id: product.id, field: 'ebay_price', value: 12, target: 'channel' },
    { id: product.id, field: 'ebay_quantity', value: 7, target: 'channel' },
  ], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE' }], expectedVersion: listing.version }, bulkContext)
  expect(result).toMatchObject({ updated: 2, versionOf: 'channelListing' })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(12)
  expect(stored.quantity).toBe(7)
  expect(result.currentVersion).toBe(stored.version)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
  expect(await sheetWrite(product.id, 'ebay_quantity', 8, stored.version)).toMatchObject({ updated: 1 })
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
}))

it('a later failure rolls back price, cleanup, event and queue, and dispatches no job', () => scoped(async () => {
  const { product, listing } = await seed('sheet-rollback', true)
  vi.mocked(fireOutboundJobs).mockClear()
  vi.mocked(produceReadiness).mockRejectedValueOnce(new Error('readiness rollback control'))
  await expect(sheetWrite(product.id, 'ebay_price', null, listing.version, 'reset')).rejects.toMatchObject({ statusCode: 500 })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(listing)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(0)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(0)
  expect(fireOutboundJobs).not.toHaveBeenCalled()
}))

// The displayed number cannot decide price equality: a pinned value can hide a stale legacy key.
it('a same-value attr_price set is a door no-op when clean, and an applied cleanup when dirty', () => scoped(async () => {
  const product = await prisma.product.create({ data: { sku: 'sheet-same-clean', name: 'Same value', basePrice: 10 } })
  const clean = await prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', channelConnectionId: account, channelMarket: 'EBAY_DE',
    marketplace: 'DE', region: 'EU', price: 25, priceOverride: 25, followMasterPrice: false } })
  const repeat = await sheetWrite(product.id, 'attr_price', 25, clean.version)
  expect(repeat).toMatchObject({ updated: 0, unchanged: 1, currentVersion: clean.version, versionOf: 'channelListing' })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: clean.id } })).toEqual(clean)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(0)

  const dirty = await seed('sheet-same-dirty', false)
  const cleaned = await sheetWrite(dirty.product.id, 'attr_price', 25, dirty.listing.version)
  expect(cleaned).toMatchObject({ updated: 1, currentVersion: dirty.listing.version + 1, versionOf: 'channelListing' })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: dirty.listing.id } })
  expect(stored.overrideData).toEqual({ unrelated: 'keep' })
  expect(Number(stored.price)).toBe(25)
  expect(await prisma.priceChangeEvent.count({ where: { productId: dirty.product.id } })).toBe(1)
}))

it('the sheet set, pin and reset use the price door and report the listing version', () => scoped(async () => {
  const { product, listing } = await seed('price-sheet', true)
  const save = (value: number | null, version: number, intent: 'set' | 'pin' | 'reset') => applyProductBulkEdits({
    changes: [{ id: product.id, field: 'ebay_price', value, intent, target: 'channel' }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE' }], expectedVersion: version,
  }, bulkContext)
  // The displayed number alone cannot decide equality: pinning it must break inheritance.
  await prisma.channelListing.update({ where: { id: listing.id }, data: { price: 10 } })
  const pinned = await save(10, listing.version, 'pin')
  expect(pinned).toMatchObject({ updated: 1, currentVersion: listing.version + 1, versionOf: 'channelListing' })
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(stored.price)).toBe(10)
  expect(Number(stored.priceOverride)).toBe(10)
  expect(stored.followMasterPrice).toBe(false)
  expect(stored.overrideData).toEqual({ unrelated: 'keep' })
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(1)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(1)
  const set = await save(12, stored.version, 'set')
  expect(set).toMatchObject({ updated: 1, currentVersion: stored.version + 1 })
  const reset = await save(null, stored.version + 1, 'reset')
  expect(reset).toMatchObject({ updated: 1, currentVersion: stored.version + 2 })
  const resetRow = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  // The reset stores the follower price it sends (the master's 10), where it used to store `price: null`.
  expect(resetRow).toMatchObject({ priceOverride: null, followMasterPrice: true })
  expect(Number(resetRow.price)).toBe(10)
  const repeat = await save(null, resetRow.version, 'reset')
  expect(repeat).toMatchObject({ updated: 0, unchanged: 1, currentVersion: resetRow.version, versionOf: 'channelListing' })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toEqual(resetRow)
  expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(3)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(3)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id, syncStatus: 'PENDING' } })).toBe(1)
  expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).version).toBe(product.version)
}))

it.each(['ebay_price', 'attr_price'])('reset stays on the selected account and alias, with a primary-listing control: %s', field => scoped(async () => {
  const product = await prisma.product.create({ data: { sku: `scope-${field}`, name: 'Scope control', basePrice: 10 } })
  const accounts = await Promise.all(['a', 'b'].map(suffix => prisma.channelConnection.create({
    data: { channelType: 'EBAY', accountLabel: `scope-${field}-${suffix}`, externalAccountId: `scope-${field}-${suffix}`,  isActive: true },
  })))
  const aliases = await Promise.all(accounts.map(account => prisma.productListingAlias.create({ data: {
    productId: product.id, channel: 'EBAY', marketplace: 'DE', channelConnectionId: account.id, label: 'Second offer',
  } })))
  for (const [i, account] of accounts.entries()) for (const aliasKey of ['', aliases[i].id]) {
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE',
      channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account.id, aliasKey, aliasId: aliasKey || null,
      price: 25, priceOverride: 25, followMasterPrice: false, overrideData: { price: 99, ebay_price: 98, unrelated: account.id } } })
  }
  const all = () => prisma.channelListing.findMany({ where: { productId: product.id }, orderBy: { id: 'asc' } })
  for (const aliasKey of [aliases[1].id, '']) {
    const before = await all()
    const target = before.find(row => row.channelConnectionId === accounts[1].id && row.aliasKey === aliasKey)!
    const result = await applyProductBulkEdits({ changes: [{ id: product.id, field, value: null, target: 'channel', intent: 'reset' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', accountId: accounts[1].id, aliasKey }], expectedVersion: target.version }, bulkContext)
    expect(result).toMatchObject({ updated: 1, currentVersion: target.version + 1, versionOf: 'channelListing' })
    const after = await all()
    expect(after.filter(row => row.id !== target.id)).toEqual(before.filter(row => row.id !== target.id))
    expect(after.find(row => row.id === target.id)?.overrideData).toEqual({ unrelated: accounts[1].id })
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: target.id } })).toBe(1)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: target.id } })).toBe(1)
  }
}))

it('one request over two aliases of the same account writes each alias listing once', () => scoped(async () => {
  const product = await prisma.product.create({ data: { sku: 'two-alias', name: 'Two aliases', basePrice: 10 } })
  const account = await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'two-alias', externalAccountId: 'two-alias', isActive: true } })
  const alias = await prisma.productListingAlias.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE',
    channelConnectionId: account.id, label: 'Second offer' } })
  const rows = []
  for (const aliasKey of ['', alias.id]) rows.push(await prisma.channelListing.create({ data: { productId: product.id,
    channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account.id, aliasKey,
    aliasId: aliasKey || null, price: 25, priceOverride: 25, followMasterPrice: false, overrideData: { price: 99 } } }))
  expect(rows[0].version).toBe(rows[1].version)
  const result = await applyProductBulkEdits({ changes: [{ id: product.id, field: 'ebay_price', value: null, target: 'channel', intent: 'reset' }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', accountId: account.id, aliasKey: '' },
      { channel: 'EBAY', marketplace: 'DE', accountId: account.id, aliasKey: alias.id }], expectedVersion: rows[0].version }, bulkContext)
  expect(result).toMatchObject({ updated: 1 })
  for (const row of rows) {
    const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: row.id } })
    expect(stored).toMatchObject({ followMasterPrice: true, version: row.version + 1, overrideData: {} })
    expect(await prisma.priceChangeEvent.count({ where: { productId: product.id } })).toBe(2)
  }
}))

afterAll(async () => { await state.db?.close() })

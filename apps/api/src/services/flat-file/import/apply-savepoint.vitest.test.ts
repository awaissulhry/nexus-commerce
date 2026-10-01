/**
 * FF2 import — one pricing cell, one savepoint (review 2026-10-01, item 4).
 *
 * 🔴 WHAT THIS GUARDS. The import applies every cell inside ONE transaction and catches a row's error to mark it
 * FAILED. With no savepoint, a cell that failed PART-WAY kept what it had already written: the price door stores the
 * listing's price and cancels its waiting PRICE_UPDATE, then the new queue row cannot be written — the row said FAILED,
 * yet the transaction committed a stored price that is never sent, and the earlier send was gone. The same for a
 * Products-sheet base_price whose cascade failed after the master price was stored. A refused cell for a NEW listing
 * left the empty listing it had created.
 *
 * Now each pricing cell and each base_price cell runs in a SAVEPOINT (`inSavepoint`): a failed cell rolls back to it
 * (the row is FAILED with the error's own message), and the rest of the import commits.
 *
 * Real PostgreSQL in-process (PGlite) through the import's own transaction (`applyChanges` opens it). Ids are invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, failListingId: null as string | null, failCascade: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(async () => undefined), emitManyTx: vi.fn(async () => undefined) } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// A failure AFTER the cell's first writes: the queue row (the door) or the cascade's queue rows (the master price).
vi.mock('../../outbound-rows.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../outbound-rows.js')>()
  return {
    ...real,
    createOutboundRow: vi.fn(async (...args: Parameters<typeof real.createOutboundRow>) => {
      const data = (args[1] as { data?: { channelListingId?: string } }).data
      if (state.failListingId && data?.channelListingId === state.failListingId) throw new Error('the queue row could not be written after the price was stored')
      return real.createOutboundRow(...args)
    }),
    createOutboundRows: vi.fn(async (...args: Parameters<typeof real.createOutboundRows>) => {
      if (state.failCascade) throw new Error('the cascade could not queue its rows after the master price was stored')
      return real.createOutboundRows(...args)
    }),
  }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { writeChannelPrices } from '../../pim/channel-price-write.service.js'
import { applyChanges } from './apply.js'
import type { CellChange, ImportDiff } from './diff.js'
import type { ImportScope } from './scope.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const SCOPE: ImportScope = { channel: 'AMAZON', markets: ['IT'], includeMaster: true }
let account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'ff2-savepoint', isActive: true } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const diff = (changes: CellChange[], masterChanges: CellChange[] = []): ImportDiff => ({
  changes, masterChanges, deletes: [], stats: { adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 },
})
const priceCell = (sku: string, to: string, kind: CellChange['kind'] = 'update'): CellChange =>
  ({ sku, sheet: 'Amazon', channel: 'AMAZON', market: 'IT', column: 'price@IT', base: 'price', from: null, to, kind } as CellChange)
const basePriceCell = (sku: string, to: string): CellChange =>
  ({ sku, sheet: 'Products', channel: undefined, market: undefined, column: 'base_price', base: 'base_price', from: null, to, kind: 'update' } as CellChange)

/** A product with a live Amazon IT listing: pinned at `price`, or following the master. */
async function seed(id: string, opts: { price?: number; follow?: boolean; product?: Record<string, unknown>; listing?: boolean } = {}) {
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, ...opts.product } as never })
  if (opts.listing === false) return null
  const follow = opts.follow ?? false
  return prisma.channelListing.create({ data: {
    productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'IT',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`,
    price: follow ? 10 : opts.price ?? 20, priceOverride: follow ? null : opts.price ?? 20, followMasterPrice: follow, masterPrice: 10, pricingRule: 'FIXED',
  } as never })
}
const listingOf = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
const priceRows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'PRICE_UPDATE' }, orderBy: { createdAt: 'asc' }, select: { syncStatus: true, payload: true } })
const audits = (channelListingId: string) => prisma.channelListingOverride.count({ where: { channelListingId } })
const timeline = (productId: string) => prisma.priceChangeEvent.count({ where: { productId } })

describe('🔴 a pricing cell that fails part-way leaves nothing behind; the rest of the import commits', () => {
  it('the first cell\'s queue row cannot be written: FAILED with that message, its price and its waiting send untouched; the second cell commits', () => scoped(async () => {
    const a = (await seed('ffsp-a', { price: 20 }))!
    const b = (await seed('ffsp-b', { price: 20 }))!
    // A's waiting send, queued before the import (the 30 s grace window): the import must not cancel it for nothing.
    expect((await writeChannelPrices({ targets: [{ listingId: a.id, price: 21, expectedVersion: a.version }], actor: 'person-1', source: 'MANUAL_OVERRIDE' })).results[0].outcome).toBe('applied')
    const aBefore = { listing: await listingOf(a.id), rows: await priceRows(a.id), audits: await audits(a.id), timeline: await timeline('ffsp-a') }

    state.failListingId = a.id
    try {
      const result = await applyChanges(prisma, diff([priceCell('FFSP-A', '25'), priceCell('FFSP-B', '30')]), { scope: SCOPE, actor: 'importer' })
      expect(result).toMatchObject({ applied: 1, failed: 1 })
      expect(result.rows).toEqual([
        { sku: 'FFSP-A', status: 'FAILED', detail: 'the queue row could not be written after the price was stored' },
        { sku: 'FFSP-B', status: 'SUCCESS' },
      ])
      // Only the committed cell is in the inverse.
      expect(result.inverseDiff.map((cell) => cell.sku)).toEqual(['FFSP-B'])
    } finally {
      state.failListingId = null
    }

    // A: exactly as before the import — the price 21, its waiting send still PENDING, no audit or timeline row.
    const aAfter = await listingOf(a.id)
    expect(Number(aAfter.price)).toBe(21)
    expect(Number(aAfter.priceOverride)).toBe(21)
    expect(aAfter.version).toBe(aBefore.listing.version)
    expect(await priceRows(a.id)).toEqual(aBefore.rows)
    expect((await priceRows(a.id)).map((r) => r.syncStatus)).toEqual(['PENDING'])
    expect(await audits(a.id)).toBe(aBefore.audits)
    expect(await timeline('ffsp-a')).toBe(aBefore.timeline)
    // B: stored and queued.
    expect(Number((await listingOf(b.id)).price)).toBe(30)
    expect((await priceRows(b.id)).map((r) => [r.syncStatus, (r.payload as { price?: number }).price])).toEqual([['PENDING', 30]])
  }))

  it('a refused cell for a NEW listing does not leave the empty listing it created', () => scoped(async () => {
    await seed('ffsp-new', { listing: false, product: { maxPrice: 20 } })
    const result = await applyChanges(prisma, diff([priceCell('FFSP-NEW', '25', 'add')]), { scope: SCOPE, actor: 'importer' })
    expect(result).toMatchObject({ applied: 0, failed: 1 })
    expect(result.rows[0]).toMatchObject({ sku: 'FFSP-NEW', status: 'FAILED', detail: expect.stringContaining('above its pricing ceiling of 20.00') })
    expect(await prisma.channelListing.count({ where: { productId: 'ffsp-new' } })).toBe(0)
  }))
})

describe('🔴 a base_price cell whose cascade fails part-way leaves the master price as it was', () => {
  it('FAILED with the cascade\'s message; the master price, the following listing and the audit untouched; the next cell commits', () => scoped(async () => {
    const failing = (await seed('ffsp-master', { follow: true }))!
    await seed('ffsp-master-ok', { listing: false })
    const before = { product: await prisma.product.findUniqueOrThrow({ where: { id: 'ffsp-master' } }), listing: await listingOf(failing.id), audits: await prisma.auditLog.count({ where: { entityId: 'ffsp-master' } }) }

    state.failCascade = true
    let result: Awaited<ReturnType<typeof applyChanges>>
    try {
      result = await applyChanges(prisma, diff([], [basePriceCell('FFSP-MASTER', '12')]), { scope: SCOPE, actor: 'importer' })
    } finally {
      state.failCascade = false
    }
    expect(result).toMatchObject({ applied: 0, failed: 1 })
    expect(result.rows).toEqual([{ sku: 'FFSP-MASTER', status: 'FAILED', detail: 'the cascade could not queue its rows after the master price was stored' }])
    expect(result.inverseDiff).toEqual([])
    const product = await prisma.product.findUniqueOrThrow({ where: { id: 'ffsp-master' } })
    expect(Number(product.basePrice)).toBe(10)
    expect(product.version).toBe(before.product.version)
    expect(await listingOf(failing.id)).toEqual(before.listing)
    expect(await priceRows(failing.id)).toEqual([])
    expect(await prisma.auditLog.count({ where: { entityId: 'ffsp-master' } })).toBe(before.audits)

    // The same import shape with the cascade working: a master price cell commits.
    const ok = await applyChanges(prisma, diff([], [basePriceCell('FFSP-MASTER-OK', '12')]), { scope: SCOPE, actor: 'importer' })
    expect(ok).toMatchObject({ applied: 1, failed: 0 })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: 'ffsp-master-ok' } })).basePrice)).toBe(12)
  }))
})

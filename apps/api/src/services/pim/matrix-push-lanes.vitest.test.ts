/**
 * 2026-10-08 (Owner: remove the Sync column, show push failures in the Qty / Price cells) — the Matrix read's per-lane
 * push state, over a real PostgreSQL in-process (PGlite). Every id and SKU is invented.
 *
 *   - `sync.pushFailed` / `price.pushFailed`: the NEWEST push of each lane of the listing, read on its own.
 *   - eBay's shared-stock pushes are saved WITHOUT a listing id (`ebay-shared-fanout.service.ts`): they are matched by what
 *     they carry — product, item id and market — so a newer real-time push clears an old dead listing row, and a failed
 *     one marks the cell. A shared push of another product, or of another item, never does.
 *   - `sync.euConflict`: the Amazon EU guard's verdict rides on the region's stock cell, no longer on a Sync cell's
 *     `writeBlockedReason`.
 *   - `queue` (the folded Sync state) stays on the wire, unchanged, for the MCP read and the Retry verb.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { getMatrixRead } from './matrix.service.js'
import { pushFailureReason } from './matrix-cells.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const JULY = new Date('2026-07-19T10:00:00.000Z')
const TODAY = new Date('2026-10-08T09:00:00.000Z')
const LATER = new Date('2026-10-08T09:30:00.000Z')
const ids: Record<string, string> = {}

async function push(row: { productId: string; listing?: string | null; channel: 'EBAY' | 'AMAZON'; syncType: 'QUANTITY_UPDATE' | 'PRICE_UPDATE'; status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'SKIPPED' | 'CANCELLED'; at: Date; error?: string; dead?: boolean; item?: string; market?: string }) {
  await prisma.outboundSyncQueue.create({ data: {
    productId: row.productId, channelListingId: row.listing ?? null, targetChannel: row.channel as never, targetRegion: row.market ?? 'IT',
    syncStatus: row.status as never, syncType: row.syncType, payload: row.listing ? {} : { pushVia: 'TRADING', itemId: row.item, market: row.market ?? 'IT', updates: [] },
    externalListingId: row.item ?? null, errorMessage: row.error ?? null, isDead: row.dead ?? false, createdAt: row.at, updatedAt: row.at,
  } as never })
}

beforeAll(() => scoped(async () => {
  for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  const acc: Record<string, string> = {}
  for (const channel of ['AMAZON', 'EBAY']) acc[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `lanes-${channel}`, isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'pl-p', sku: 'TEST-PL-P', name: 'lanes', basePrice: 50, isParent: true } as never })
  for (const c of ['a', 'b', 'c', 'd']) await prisma.product.create({ data: { id: `pl-${c}`, sku: `TEST-PL-${c.toUpperCase()}`, name: 'lanes', basePrice: 50, parentId: 'pl-p', fulfillmentMethod: 'FBM' } as never })
  const listing = async (key: string, productId: string, channel: string, marketplace: string, over: Record<string, unknown> = {}) => {
    ids[key] = (await prisma.channelListing.create({ data: {
      productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', channelConnectionId: acc[channel],
      listingStatus: 'ACTIVE', isPublished: true, price: 50, followMasterPrice: true, followMasterQuantity: true, quantity: 5, fulfillmentMethod: 'FBM', ...over,
    } as never })).id
  }
  await listing('a-ebay', 'pl-a', 'EBAY', 'IT', { externalListingId: '111' })
  await listing('b-ebay', 'pl-b', 'EBAY', 'IT', { externalListingId: '222' })
  await listing('c-ebay', 'pl-c', 'EBAY', 'IT', { externalListingId: '333', syncPaused: true })
  await listing('d-ebay', 'pl-d', 'EBAY', 'IT', { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
  /* Amazon EU: IT follows the pool, DE is pinned at 0 — the guard's conflict. */
  await listing('a-amz-it', 'pl-a', 'AMAZON', 'IT', { externalListingId: 'B0PLA' })
  await listing('a-amz-de', 'pl-a', 'AMAZON', 'DE', { externalListingId: 'B0PLA', followMasterQuantity: false, quantityOverride: 0, quantity: 0 })

  /* a · eBay: the July dead listing row (what the Sync column kept showing) and TODAY's shared-stock push that succeeded. */
  await push({ productId: 'pl-a', listing: ids['a-ebay'], channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: JULY, error: 'eBay publish circuit open' })
  await push({ productId: 'pl-a', channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'SUCCESS', at: TODAY, item: '111' })
  /* …and its price lane failed today (its own row). */
  await push({ productId: 'pl-a', listing: ids['a-ebay'], channel: 'EBAY', syncType: 'PRICE_UPDATE', status: 'FAILED', dead: true, at: TODAY, error: 'eBay: the price is below the floor' })
  /* b · eBay: its own row succeeded in July; TODAY's shared push for its item FAILED. */
  await push({ productId: 'pl-b', listing: ids['b-ebay'], channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'SUCCESS', at: JULY })
  await push({ productId: 'pl-b', channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: TODAY, item: '222', error: 'eBay: 21916750 — the listing has ended' })
  /* Negative controls: a shared push of ANOTHER product on b's item, and of a on ANOTHER item, LATER, both failed. */
  await push({ productId: 'pl-a', channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: LATER, item: '222', error: 'not b\'s' })
  await push({ productId: 'pl-a', channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: LATER, item: '999', error: 'not a\'s item' })
  /* c · eBay: a failed push, but the stock sync is held — the ⏸ says it; no ✗. */
  await push({ productId: 'pl-c', listing: ids['c-ebay'], channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: TODAY, error: 'held listing' })
  /* d · eBay: a draft (not on eBay) whose newest pushes failed long ago — nothing is sent to a draft: no ✗. */
  await push({ productId: 'pl-d', listing: ids['d-ebay'], channel: 'EBAY', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: JULY, error: 'eBay publish circuit open' })
  await push({ productId: 'pl-d', listing: ids['d-ebay'], channel: 'EBAY', syncType: 'PRICE_UPDATE', status: 'FAILED', dead: true, at: JULY, error: 'get offers 404' })
  /* a · Amazon IT: refused by the EU guard (the dispatcher saves the CODE); DE pushed fine. */
  await push({ productId: 'pl-a', listing: ids['a-amz-it'], channel: 'AMAZON', syncType: 'QUANTITY_UPDATE', status: 'FAILED', dead: true, at: TODAY, error: 'eu-shared-qty-conflict' })
  await push({ productId: 'pl-a', listing: ids['a-amz-de'], channel: 'AMAZON', syncType: 'QUANTITY_UPDATE', status: 'SUCCESS', at: TODAY })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const readOf = () => scoped(() => getMatrixRead({ productId: 'pl-p', canEditPrice: true }))
const cellsOf = async (row: string, key: string) => (await readOf()).rows.find((r) => r.id === row)!.cells[key]!

describe('the Matrix read — each listing\'s own last push per lane', () => {
  it('🔴 a newer eBay shared-stock push (saved without a listing id) clears the July dead row: no ✗ on Qty', async () => {
    const a = await cellsOf('pl-a', 'EBAY:IT')
    expect(a.sync!.pushFailed ?? null).toBeNull()
    /* The folded queue stays on the wire as it was (listing rows only) — the MCP read and Retry read it. */
    expect(a.queue!.state).toBe('dead')
  })
  it('🔴 a failed shared push for THIS product on THIS item marks Qty, reason first; another product\'s or another item\'s never does', async () => {
    const b = await cellsOf('pl-b', 'EBAY:IT')
    expect(b.sync!.pushFailed).toEqual({ reason: 'eBay: 21916750 — the listing has ended', at: TODAY.toISOString(), final: true, markets: [] })
  })
  it('the price lane is its own: a failed price push marks Price, never Qty', async () => {
    const a = await cellsOf('pl-a', 'EBAY:IT')
    expect(a.price!.pushFailed).toMatchObject({ reason: 'eBay: the price is below the floor', final: true })
    expect(a.sync!.pushFailed ?? null).toBeNull()
    const b = await cellsOf('pl-b', 'EBAY:IT')
    expect(b.price!.pushFailed ?? null).toBeNull()
  })
  it('a draft listing (not on the channel) carries no ✗ on either lane — nothing is sent to it', async () => {
    const d = await cellsOf('pl-d', 'EBAY:IT')
    expect(d.sync!.pushFailed ?? null).toBeNull()
    expect(d.price!.pushFailed ?? null).toBeNull()
  })
  it('a held listing shows its ⏸, not an old ✗', async () => {
    const c = await cellsOf('pl-c', 'EBAY:IT')
    expect(c.sync!.kind).toBe('PAUSED')
    expect(c.sync!.pushFailed ?? null).toBeNull()
  })
  it('🔴 Amazon EU: the conflict sentence rides on the region stock cell; the failed market is named, the code in words', async () => {
    const eu = await cellsOf('pl-a', 'AMAZON:EU')
    expect(eu.sync!.euConflict).toBe(MATRIX_COPY.euConflict('IT follow the pool while DE is pinned at 0 — Amazon keeps ONE quantity per SKU across EU markets, so these fight each other'))
    expect(eu.writeBlockedReason.syncState).toBeUndefined()
    expect(eu.sync!.pushFailed).toEqual({ reason: pushFailureReason('eu-shared-qty-conflict'), at: TODAY.toISOString(), final: true, markets: ['IT'] })
    /* The region still SERVES the Sync kind: the Edit dialog's "Stock sync" is offered where a group serves it. */
    const read = await readOf()
    expect(read.coordinates.find((c) => c.key === 'AMAZON:EU')!.cells).toContain('syncState')
  })
})

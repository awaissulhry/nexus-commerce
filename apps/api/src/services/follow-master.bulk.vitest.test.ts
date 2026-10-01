/**
 * SCT.3 — the P2028 regression suite. The original service wrapped an entire
 * bulk FOLLOW/PIN in ONE interactive transaction with a per-row findUnique;
 * above ~10 products it blew the 5s interactive-tx timeout and the operator
 * got a bare "Internal Server Error" (hit live from the 500/page bulk UI on
 * 2026-07-26). These tests pin the fixed shape:
 *   - bulk work runs in CHUNKED transactions with an explicit timeout
 *   - fresh buffers are read in ONE query per chunk (no per-row findUnique)
 *   - a rolled-back chunk contributes NOTHING (no counts, no BullMQ jobs)
 *   - a mid-bulk failure reports partial progress honestly via error/remaining
 *   - a first-chunk failure still throws (small callers keep old semantics)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const s = {
    txOpts: [] as Array<{ timeout?: number; maxWait?: number } | undefined>,
    txBufferReads: 0,
    txGrantReads: 0,
    updates: [] as string[],
    queueCreates: 0,
    queued: [] as any[],
    failOnTx: -1 as number, // index of the $transaction call that should fail AFTER running fn
    listings: [] as any[],
    addJob: vi.fn(async () => {}),
    coalesce: vi.fn(async () => {}),
  }
  const txStub = {
    channelListing: {
      // ONE buffer read per chunk — the per-row findUnique is deliberately
      // absent from this stub, so any regression to it throws a TypeError.
      findMany: async ({ where }: any) => {
        s.txBufferReads++
        return (where.id.in as string[]).map((id) => ({ id, stockBuffer: 0 }))
      },
      update: async ({ where }: any) => {
        s.updates.push(where.id)
        return {}
      },
    },
    outboundSyncQueue: {
      // P1.3 — a chunk's queue rows are written in ONE createManyAndReturn. The per-row
      // `create` is deliberately absent, like the per-row findUnique above: a regression
      // to a row-at-a-time write (whose BP.S3 preflight reads inside the tx) throws here.
      createManyAndReturn: async ({ data }: any) => {
        s.queued.push(...(data as any[]))
        return (data as any[]).map((d) => ({ id: `q${++s.queueCreates}`, channelListingId: d.channelListingId }))
      },
    },
    // BP.S3 — the shared-account gate reads through the caller's client. No account here
    // is shared, and the gate must ask ONCE per chunk (s.txGrantReads pins that).
    channelAccountGrant: {
      findMany: async () => { s.txGrantReads++; return [] },
    },
    // Per-chunk pool freshness read (added with the stale-snapshot fix). Since shared stock it goes
    // through loadSyncLedgers: this business's WAREHOUSE rows, the pool door (no product is pooled
    // here) and the product's link history (none).
    stockLevel: {
      findMany: async ({ where }: any) =>
        (where.productId.in as string[]).map((productId) => ({ productId, available: 10, quantity: 10, location: { type: 'WAREHOUSE', code: 'IT-MAIN', syncRoutes: [] } })),
    },
    stockPoolLink: { findMany: async () => [] },
    $queryRaw: async () => [],
  }
  let txCount = 0
  const prisma = {
    channelListing: {
      findMany: async () => s.listings,
    },
    stockLevel: {
      // The pre-read is FBA evidence only (AMAZON_FBA rows); these products hold none.
      findMany: async ({ where }: any) => where?.location?.type === 'AMAZON_FBA' ? [] :
        [...new Set(s.listings.map((l) => l.productId))].map((productId) => ({
          productId, available: 10, quantity: 10, location: { type: 'WAREHOUSE' },
        })),
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>, opts?: any) => {
      const idx = txCount++
      s.txOpts.push(opts)
      await fn(txStub)
      // Simulate a commit failure AFTER the callback ran — the acc-merge
      // guard must discard everything this chunk appeared to do.
      if (idx === s.failOnTx) throw new Error('simulated commit failure (P2028)')
    },
    __reset: () => { txCount = 0 },
  }
  // Return `s` ITSELF (not a spread — a spread copies the primitives, so the
  // closures above would mutate a different object than the tests read).
  return Object.assign(s, { prisma, reset() {
    s.txOpts.length = 0; s.txBufferReads = 0; s.txGrantReads = 0; s.updates.length = 0
    s.queueCreates = 0; s.queued.length = 0; s.failOnTx = -1; s.listings.length = 0
    s.addJob.mockClear(); s.coalesce.mockClear()
    prisma.__reset()
  } })
})

vi.mock('../db.js', () => ({ default: state.prisma }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: {}, addJobSafely: state.addJob }))
vi.mock('./sync-coalesce.js', () => ({ coalescePendingQuantityRows: state.coalesce }))
vi.mock('./outbound-sync.service.js', () => ({ isFbaListing: () => false }))

import { setFollowMasterQuantity, setStockBuffer } from './follow-master.service.js'

function makeListings(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `cl${i}`,
    productId: `p${i}`,
    channel: 'EBAY',
    region: 'EBAY_IT',
    marketplace: 'EBAY_IT',
    channelConnectionId: 'ebay-account-1', // P1.3 — a listing names its account (the queue row takes it, no extra read)
    quantity: 0,
    quantityOverride: 5, // pinned → FOLLOW is a real write, not a no-op
    followMasterQuantity: false,
    stockBuffer: 0,
    externalListingId: `ext${i}`,
    fulfillmentMethod: 'FBM',
    platformAttributes: null,
    product: { sku: `SKU-${i}`, fulfillmentMethod: 'FBM' },
  }))
}

beforeEach(() => state.reset())

describe('setFollowMasterQuantity — chunked transactions (P2028)', () => {
  it('splits 60 rows into 3 transactions, each with an explicit timeout, one buffer read per chunk', async () => {
    state.listings.push(...makeListings(60))
    const r = await setFollowMasterQuantity({
      productIds: state.listings.map((l) => l.productId),
      channel: 'EBAY', markets: 'ALL', follow: true, actor: 'test',
    })
    expect(r.updated).toBe(60)
    expect(r.error).toBeUndefined()
    expect(state.txOpts.length).toBe(3) // ceil(60 / 25)
    for (const o of state.txOpts) {
      expect(o?.timeout ?? 0, 'every chunk tx must carry an explicit timeout').toBeGreaterThanOrEqual(15_000)
    }
    expect(state.txBufferReads, 'ONE buffer findMany per chunk — never per-row').toBe(3)
    // With business profiles OFF the BP.S3 gate is not reached at all; with them ON it
    // asks once per chunk. Exact in both modes — never a ceiling.
    expect(state.txGrantReads, 'ONE BP.S3 gate read per chunk — never per-row').toBe(process.env.NEXUS_WORKSPACES_ENABLED === '1' ? 3 : 0)
    expect(state.addJob).toHaveBeenCalledTimes(60)
  })

  it('a mid-bulk commit failure keeps earlier chunks, reports error+remaining, and leaks NOTHING from the rolled-back chunk', async () => {
    state.listings.push(...makeListings(60))
    state.failOnTx = 1 // second chunk "commits" then fails
    const r = await setFollowMasterQuantity({
      productIds: state.listings.map((l) => l.productId),
      channel: 'EBAY', markets: 'ALL', follow: true, actor: 'test',
    })
    expect(r.updated, 'only chunk 1 counts').toBe(25)
    expect(r.error).toMatch(/simulated commit failure/)
    expect(r.remaining, '60 total − 25 committed').toBe(35)
    // The failed chunk ran its callback, but none of its queue rows may reach
    // BullMQ — those DB rows rolled back with the transaction.
    expect(state.addJob).toHaveBeenCalledTimes(25)
    expect(r.results.filter((x) => x.action === 'FOLLOW').length).toBe(25)
  })

  it('a FIRST-chunk failure throws — nothing was written, small callers keep clean failure semantics', async () => {
    state.listings.push(...makeListings(10))
    state.failOnTx = 0
    await expect(
      setFollowMasterQuantity({
        productIds: state.listings.map((l) => l.productId),
        channel: 'EBAY', markets: 'ALL', follow: true, actor: 'test',
      }),
    ).rejects.toThrow(/simulated commit failure/)
    expect(state.addJob).not.toHaveBeenCalled()
  })

  it('a single-product call stays one transaction (the flat-file save path is unchanged)', async () => {
    state.listings.push(...makeListings(1))
    const r = await setFollowMasterQuantity({
      productIds: ['p0'], channel: 'EBAY', markets: 'ALL', follow: true, actor: 'test',
    })
    expect(r.updated).toBe(1)
    expect(state.txOpts.length).toBe(1)
  })
})

// 2026-10-01 — Etsy was missing from this file's channel list: an Etsy Matrix Mode / Qty / Buffer edit, or a Sync Control
// bulk Follow / Pin / Buffer, wrote the listing, answered "applied", and queued nothing. It now uses the one shared set.
describe('Etsy listings are queued like every other channel', () => {
  const etsy = (n: number) => makeListings(n).map((l) => ({ ...l, channel: 'ETSY', region: 'GLOBAL', marketplace: 'GLOBAL', channelConnectionId: 'etsy-account-1' }))

  it('Follow on pinned Etsy listings writes them AND queues one quantity row each, on the listing\'s own account', async () => {
    state.listings.push(...etsy(3))
    const r = await setFollowMasterQuantity({ productIds: state.listings.map((l) => l.productId), channel: 'ETSY' as never, markets: ['GLOBAL'], follow: true, actor: 'test' })
    expect(r.updated).toBe(3)
    expect(state.queued.map((q) => [q.targetChannel, q.channelListingId, q.channelConnectionId, q.syncType, q.payload.quantity, q.payload.source]))
      .toEqual([0, 1, 2].map((i) => ['ETSY', `cl${i}`, 'etsy-account-1', 'QUANTITY_UPDATE', 10, 'FOLLOW_MASTER']))
    expect(state.addJob).toHaveBeenCalledTimes(3)
    // A newer value supersedes any older pending one for the same listings.
    expect(state.coalesce).toHaveBeenCalledWith(expect.anything(), ['cl0', 'cl1', 'cl2'])
  })

  it('a buffer on following Etsy listings queues pool − buffer', async () => {
    state.listings.push(...etsy(2).map((l) => ({ ...l, followMasterQuantity: true, quantityOverride: null, quantity: 10 })))
    const r = await setStockBuffer({ productIds: state.listings.map((l) => l.productId), channel: 'ETSY' as never, markets: ['GLOBAL'], buffer: 3, actor: 'test' })
    expect(r.updated).toBe(2)
    expect(state.queued.map((q) => [q.targetChannel, q.payload.quantity, q.payload.stockBuffer, q.payload.source])).toEqual([['ETSY', 7, 3, 'STOCK_BUFFER'], ['ETSY', 7, 3, 'STOCK_BUFFER']])
    expect(state.addJob).toHaveBeenCalledTimes(2)
  })
})

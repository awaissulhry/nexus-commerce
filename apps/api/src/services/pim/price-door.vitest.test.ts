import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ findMany: vi.fn(), marketplaces: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) }))
// A transaction that runs its body against a stub. The write path is not what this file is about —
// the GUARD is — so it is present enough to complete and quiet enough to assert nothing.
vi.mock('../../db.js', () => ({
  default: {
    channelListing: { findMany: db.findMany, findUnique: vi.fn(async () => null) },
    marketplace: { findMany: db.marketplaces },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      // `findMany`/`findUnique` on the tx too: with business profiles ON the write path reads the
      // row back inside the transaction, and a stub that only has `updateMany` fails there and
      // nowhere else. The ratchet caught exactly that.
      channelListing: { updateMany: db.updateMany, findMany: db.findMany, findUnique: vi.fn(async () => null) },
      channelListingOverride: { create: vi.fn(async () => ({})) },
      priceChangeEvent: { create: vi.fn(async () => ({})) },
      outboundSyncQueue: { create: vi.fn(async () => ({ id: 'q1' })), findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
      auditLog: { create: vi.fn(async () => ({})) },
    }),
  },
}))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../price-history.service.js', () => ({ priceChangeData: vi.fn(() => ({})) }))
vi.mock('./sale-window.js', () => ({
  readSaleWindows: vi.fn(async (_db: unknown, ids: readonly string[]) => new Map(ids.map(id => [id, { start: '2026-01-01', end: '2026-02-01' }]))),
  saleWindowColumnsExist: vi.fn(async () => true),
  validateSaleWindow: vi.fn(() => null),
  writeSaleWindow: vi.fn(async () => undefined),
}))
import { writeChannelPrices } from './channel-price-write.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

/**
 * 🔴 Production runs with business profiles ON, and the profiles-ON ratchet refused the first
 * version of this file for running without one. Every call goes through a business, exactly as the
 * real callers do: a request through the workspace hook, scheduled work through the clustered
 * cron, a job through WorkspaceWorker.
 */
const write = (input: Parameters<typeof writeChannelPrices>[0]) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] },
    () => writeChannelPrices(input))

/**
 * PLAN Step 2.2 + 15.5 — the price door.
 *
 * 🔴 WHAT THIS GUARDS. `expectedVersion` was OPTIONAL, so a caller with no version simply omitted
 * it and the compare-and-set quietly did nothing: three surfaces, one column, one version check
 * between them. The step's **Rejected (c)** names the tempting wrong fix — *"defaulting
 * `expectedVersion` to the row's current version — that is a compare-and-set that always succeeds.
 * It looks safe and is not."*
 *
 * So the type now demands one of two things, and the OUTCOME says which it got.
 *
 * 🔴 The real concurrency arm belongs on `concurrent-database.ts`, never on PGlite, which is one
 * connection and would pass whether or not the code is safe. These are the CONTRACT arms: that an
 * unguarded write cannot happen without being named, and that it cannot hide afterwards.
 */

const listing = (id: string, version: number) => ({
  id, productId: `p-${id}`, channel: 'EBAY', marketplace: 'DE', region: 'DE', externalListingId: null,
  price: 10, priceOverride: null, salePrice: null, followMasterPrice: false, version,
  fulfillmentMethod: null, product: { sku: `SKU-${id}`, basePrice: 10 },
})

beforeEach(() => {
  db.findMany.mockReset(); db.marketplaces.mockReset()
  db.marketplaces.mockResolvedValue([{ channel: 'EBAY', code: 'DE', currency: 'EUR' }])
})

describe('the price door', () => {
  it('🔴 a STALE version is a conflict, not a write — and it reports itself guarded', async () => {
    db.findMany.mockResolvedValue([listing('a', 7)])
    const r = await write({
      targets: [{ listingId: 'a', price: 20, expectedVersion: 6 }],
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    expect(r.conflict).toBe(1)
    expect(r.applied).toBe(0)
    expect(r.results[0]).toMatchObject({ outcome: 'conflict', version: 7, guarded: true })
  })

  it('🔴 an UNGUARDED write is reported as unguarded — it must not look checked', async () => {
    db.findMany.mockResolvedValue([listing('a', 7)])
    const r = await write({
      targets: [{ listingId: 'a', price: 20, unguardedReason: 'bulk-override-snapshot' }],
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    // It runs — the snapshot bulk override still works — but nothing pretends it was compare-and-set checked.
    expect(r.results[0].guarded).toBe(false)
    expect(r.results[0].outcome).not.toBe('conflict')
  })

  it('a matching version is guarded and is not a conflict', async () => {
    db.findMany.mockResolvedValue([listing('a', 7)])
    const r = await write({
      targets: [{ listingId: 'a', price: 20, expectedVersion: 7 }],
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    expect(r.conflict).toBe(0)
    expect(r.results[0].guarded).toBe(true)
  })

  it('🔴 15.5 (a) — a big edit is CHUNKED, and the chunks are re-joined without losing a row', async () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => `L${i}`)
    // Guarded: with profiles ON the same delegate is also called inside the transaction with a
    // different `where`, and an unguarded `args.where.id.in` throws there instead of returning.
    db.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      (args?.where?.id?.in ?? []).map(id => listing(id, 1)))
    const r = await write({
      targets: ids.map(id => ({ listingId: id, price: 20, expectedVersion: 1 })),
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    // Three reads of 500, 500, 200 — not one 1,200-long IN list. Filtered to the id-list reads,
    // because the same delegate also serves in-transaction reads with a different `where`.
    const idReads = db.findMany.mock.calls.map(c => c[0]?.where?.id?.in).filter(Boolean) as string[][]
    expect(idReads.slice(0, 3).map(list => list.length)).toEqual([500, 500, 200])
    // 🔴 The invariant, not just the first three: NO read ever gets a list longer than the chunk.
    // That is what 15.5 (a) is about and it cannot be satisfied by accident.
    expect(Math.max(...idReads.map(list => list.length))).toBeLessThanOrEqual(500)
    // 🔴 And every row came back. The chunk join is where a row goes missing, and the first
    // version of it merged Maps with `Object.assign` — which type-checks and merges nothing.
    expect(r.results).toHaveLength(1_200)
    expect(new Set(r.results.map(o => o.listingId)).size).toBe(1_200)
    expect(r.results.every(o => o.outcome !== 'refused')).toBe(true)
  })

  it('🔴 15.5 (a) — the sale WINDOWS survive the chunk join too, not just the listings', async () => {
    // The arm that catches the join bug. `readSaleWindows` returns a MAP; merging the chunks with
    // `Object.assign` type-checks and merges NOTHING, so every existing window reads as absent.
    // The symptom is not a crash — it is a re-submit of the SAME sale being treated as a change
    // and written again, instead of being the no-op it is. Silent, and only above 500 rows.
    const ids = Array.from({ length: 600 }, (_, i) => `S${i}`)
    db.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      (args?.where?.id?.in ?? []).map(id => ({ ...listing(id, 1), salePrice: 8 })))
    const r = await write({
      targets: ids.map(id => ({ listingId: id, sale: { value: 8, start: '2026-01-01', end: '2026-02-01' }, expectedVersion: 1 })),
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    // Every row already holds exactly this sale, so every row is a no-op.
    expect(r.noop).toBe(600)
    expect(r.applied).toBe(0)
  })

  it('a listing that does not exist is refused by name rather than silently skipped', async () => {
    db.findMany.mockResolvedValue([])
    const r = await write({
      targets: [{ listingId: 'ghost', price: 20, expectedVersion: 1 }],
      actor: 'test', source: 'MANUAL_OVERRIDE',
    })
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'No listing with this id' })
  })
})

/**
 * E3 — the pure restore plan, and the pool branch's cap: what a cancellation gives back is what the
 * order took, net of what already came back. The ledger itself is proven on real PostgreSQL in
 * order-cancellation-postgres.vitest.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ putBacks: [] as Array<{ quantity: number }>, answers: [] as unknown[], shippedAt: null as Date | null }))
vi.mock('../../db.js', () => ({ default: {
  // One read serves both the shipment evidence and the channel's line data (C1): an eBay order whose lines say nothing.
  order: { findUnique: vi.fn(async () => ({ shippedAt: state.shippedAt, deliveredAt: null, channel: 'EBAY', shopifyMetadata: null, etsyMetadata: null, items: [] })) },
  orderItem: { findMany: vi.fn(async () => [{ productId: 'jacket', quantity: 1 }, { productId: 'jacket', quantity: 2 }]) },
  stockMovement: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
  stockReservation: { count: vi.fn(async () => 0) },
  shipment: { count: vi.fn(async () => 0) },
  stockPoolLink: { findFirst: vi.fn(async () => null) },
  return: { findMany: vi.fn(async () => []) },
} }))
vi.mock('../stock-pool/order-routing.js', () => ({
  putBackForOrder: vi.fn(async (args: { quantity: number }) => { state.putBacks.push({ quantity: args.quantity }); return state.answers.shift() }),
}))
const { planOwnRestore, restoreCancelledOrderStock } = await import('./index.js')

const taken = (id: string, productId: string, units: number, locationId = 'loc') => ({ id, productId, locationId, change: -units })

describe('planOwnRestore', () => {
  it('owes every taking movement once, per line, at its own location', () => {
    expect(planOwnRestore([taken('m1', 'p', 1, 'a'), taken('m2', 'p', 2, 'b')], [])).toEqual([
      { movementId: 'm1', productId: 'p', locationId: 'a', units: 1 }, { movementId: 'm2', productId: 'p', locationId: 'b', units: 2 }])
  })

  it('skips a movement already given back (the marker) and owes the rest', () => {
    expect(planOwnRestore([taken('m1', 'p', 1), taken('m2', 'p', 2)], [{ productId: 'p', change: 1, referenceType: 'StockMovement', referenceId: 'm1' }]))
      .toEqual([{ movementId: 'm2', productId: 'p', locationId: 'loc', units: 2 }])
  })

  it('caps by what a return or an older per-order restore already gave back', () => {
    expect(planOwnRestore([taken('m1', 'p', 2), taken('m2', 'p', 1)], [{ productId: 'p', change: 2, referenceType: 'Return', referenceId: 'r1' }]))
      .toEqual([{ movementId: 'm1', productId: 'p', locationId: 'loc', units: 1 }])
    expect(planOwnRestore([taken('m1', 'p', 2)], [{ productId: 'p', change: 2, referenceType: 'Order', referenceId: 'o' }])).toEqual([])
  })

  it('owes nothing for an order that took nothing', () => {
    expect(planOwnRestore([], [])).toEqual([])
  })
})

describe('restoreCancelledOrderStock — the pool branch', () => {
  beforeEach(() => { state.putBacks.length = 0; state.answers.length = 0; state.shippedAt = null })

  it('gives back what the pool took when a reused line asked for more', async () => {
    state.answers.push({ via: 'none', refusal: { code: 'more_than_sold', error: 'x', status: 409, taken: 2, returned: 0 } }, { via: 'pool', reused: false })
    expect(await restoreCancelledOrderStock('order-1')).toEqual({ itemsRestocked: 1, units: 2, shipped: false, kept: [], errors: [] })
    expect(state.putBacks).toEqual([{ quantity: 3 }, { quantity: 2 }])
  })

  it('asks nothing more when everything the pool took is already back', async () => {
    state.answers.push({ via: 'none', refusal: { code: 'more_than_sold', error: 'x', status: 409, taken: 2, returned: 2 } })
    expect(await restoreCancelledOrderStock('order-1')).toEqual({ itemsRestocked: 0, units: 0, shipped: false, kept: [], errors: [] })
    expect(state.putBacks).toEqual([{ quantity: 3 }])
  })

  it('R4: asks the pool for nothing once the order shipped (shipped units come back only through a return)', async () => {
    state.shippedAt = new Date('2026-09-25T10:00:00Z')
    expect(await restoreCancelledOrderStock('order-1')).toEqual({ itemsRestocked: 0, units: 0, shipped: true, kept: [], errors: [] })
    expect(state.putBacks).toEqual([])
  })
})

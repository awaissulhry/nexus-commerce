/**
 * Shared stock step 4 — the routing layer when a door THROWS (the database, the network). The doors
 * themselves are proven on a real database (stock-pool-orders.vitest.test.ts); this pins what happens
 * around a failure: a product that never sold from a pool keeps its own-stock path exactly as before
 * (a business that does not use shared stock never loses a deduction to it), and a pooled product's
 * unknown outcome reaches its owners.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ everPooled: false, linkCheckFails: false, notices: [] as Array<{ type: string; body?: string | null }> }))

vi.mock('../../db.js', () => ({
  default: {
    stockPoolLink: {
      findFirst: vi.fn(async () => {
        if (state.linkCheckFails) throw new Error('database unreachable')
        return state.everPooled ? { id: 'link-1' } : null
      }),
    },
    product: { findUnique: vi.fn(async () => ({ sku: 'JACKET' })) },
  },
}))
vi.mock('./pool-doors.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pool-doors.js')>()
  const boom = async () => { throw new Error('connection reset') }
  return { ...real, poolTake: vi.fn(boom), poolReserve: vi.fn(boom), poolPutBack: vi.fn(boom) }
})
vi.mock('./pool-tasks.js', () => ({ afterPoolChange: vi.fn() }))
vi.mock('./pool-notify.js', () => ({
  notifyOwners: vi.fn(async (notice: { type: string; body?: string | null }) => { state.notices.push(notice); return { created: 1, deduped: 0 } }),
}))

import { holdForOrder, putBackForOrder, takeForOrder } from './order-routing.js'

describe('Shared stock step 4 — a door that throws', () => {
  beforeEach(() => { state.everPooled = false; state.linkCheckFails = false; state.notices.length = 0 })

  it('a product that never sold from a pool keeps its own-stock path, and nobody is told about shared stock', async () => {
    expect(await takeForOrder({ productId: 'p', quantity: 1, orderId: 'o', actor: 't' })).toEqual({ via: 'own' })
    expect(await holdForOrder({ productId: 'p', quantity: 1, orderId: 'o', actor: 't' })).toEqual({ via: 'own' })
    expect(await putBackForOrder({ productId: 'p', quantity: 1, orderId: 'o', putBackRef: 'o', reason: 'ORDER_CANCELLED', actor: 't' })).toEqual({ via: 'own' })
    expect(state.notices).toEqual([])
  })

  it('a pooled product: an unknown outcome — nothing falls to own stock, and the owners are told to check', async () => {
    state.everPooled = true
    expect(await takeForOrder({ productId: 'p', quantity: 1, orderId: 'o', actor: 't' })).toMatchObject({ via: 'refused', refusal: { code: 'door_failed' } })
    expect(await holdForOrder({ productId: 'p', quantity: 1, orderId: 'o', actor: 't' })).toMatchObject({ via: 'refused', refusal: { code: 'door_failed' } })
    await expect(putBackForOrder({ productId: 'p', quantity: 1, orderId: 'o', putBackRef: 'o', reason: 'ORDER_CANCELLED', actor: 't' })).rejects.toThrow(/connection reset/)
    expect(state.notices.map((n) => n.type)).toEqual(['stock-pool-order-refused', 'stock-pool-order-refused'])
    expect(state.notices[0].body).toMatch(/may or may not have been taken/)
  })

  it('when even the check fails, the outcome stays unknown (never a silent own-stock write)', async () => {
    state.linkCheckFails = true
    expect(await takeForOrder({ productId: 'p', quantity: 1, orderId: 'o', actor: 't' })).toMatchObject({ via: 'refused', refusal: { code: 'door_failed' } })
  })
})

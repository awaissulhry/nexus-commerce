/**
 * takeForOrderInTx — the eBay order writer's pool take. Inside the caller's transaction a door that
 * throws is not an unknown outcome (the whole order rolls back), so there is no own-stock fallback;
 * a refusal's owner notice is written through the SAME transaction, never the global client; and
 * the pool worker is woken by the caller only after its commit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ answer: null as unknown, throws: false, kicks: 0 }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: () => { throw new Error('Global database client used inside the order transaction') } }) }))
vi.mock('./pool-doors.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pool-doors.js')>()
  return { ...real, poolTake: vi.fn(async () => { if (state.throws) throw new Error('connection reset'); return state.answer }) }
})
vi.mock('./pool-tasks.js', () => ({ afterPoolChange: vi.fn(() => { state.kicks++ }) }))

const { takeForOrderInTx } = await import('./order-routing.js')

function fakeTx() {
  const created: Array<Record<string, unknown>> = []
  const tx = {
    product: { findUnique: vi.fn(async () => ({ sku: 'JACKET' })) },
    workspaceMembership: { findMany: vi.fn(async () => [{ userId: 'owner-a' }, { userId: 'owner-b' }]) },
    notification: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }) },
  }
  return { tx: tx as never, created, raw: tx }
}
const args = { productId: 'p', quantity: 9, orderId: 'order-1', actor: 'ebay-orders-sync', workspaceId: 'ws-b' }

describe('takeForOrderInTx', () => {
  beforeEach(() => { state.answer = null; state.throws = false; state.kicks = 0 })

  it('a product that does not sell from a pool uses its own stock; nobody is told', async () => {
    state.answer = { ok: false, refusal: { code: 'not_pooled', error: 'x', status: 409 } }
    const { tx, created } = fakeTx()
    expect(await takeForOrderInTx(tx, args)).toEqual({ via: 'own', changed: false })
    expect(created).toEqual([])
  })

  it('a refusal tells every owner of the order\'s business through the same transaction', async () => {
    state.answer = { ok: false, refusal: { code: 'insufficient', error: 'Only 8 available in shared stock; 9 sold.', status: 409 } }
    const { tx, created, raw } = fakeTx()
    expect(await takeForOrderInTx(tx, args)).toMatchObject({ via: 'refused', refusal: { code: 'insufficient' }, changed: false })
    expect(raw.workspaceMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws-b' }) }))
    expect(created.map(n => [n.userId, n.type, n.title, n.entityId])).toEqual([
      ['owner-a', 'stock-pool-order-refused', 'Shared stock refused the sale of 9 × JACKET', 'order-1'],
      ['owner-b', 'stock-pool-order-refused', 'Shared stock refused the sale of 9 × JACKET', 'order-1'],
    ])
  })

  it('a take reports a change for the caller to announce after commit, and does not wake the worker itself', async () => {
    state.answer = { ok: true, taken: 9, reused: false }
    expect(await takeForOrderInTx(fakeTx().tx, args)).toEqual({ via: 'pool', result: { taken: 9, reused: false }, changed: true })
    state.answer = { ok: true, taken: 9, reused: true }
    expect(await takeForOrderInTx(fakeTx().tx, args)).toEqual({ via: 'pool', result: { taken: 9, reused: true }, changed: false })
    expect(state.kicks).toBe(0)
  })

  it('a door that throws rolls the order back: no own-stock fallback and no notice', async () => {
    state.throws = true
    const { tx, created } = fakeTx()
    await expect(takeForOrderInTx(tx, args)).rejects.toThrow(/connection reset/)
    expect(created).toEqual([])
  })
})

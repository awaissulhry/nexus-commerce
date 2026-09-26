/**
 * CX A0/A4 — a caller that stamps or locks by an Amazon account must read through THAT account.
 * `amazonSpClient()` pins lazily to whichever account the resolver chooses on the first call; an
 * explicit account pins it from the start, so the stamp and the data cannot come from two accounts.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonCredsConfigured: async () => true,
  amazonSpClient: m.client,
}))
vi.mock('amazon-sp-api', () => ({ SellingPartner: class {} }))

const { AmazonService } = await import('./amazon.service.js')

beforeEach(() => {
  m.client.mockReset()
  m.client.mockImplementation(() => ({
    callAPI: async (params: { operation: string }) => params.operation === 'getOrders'
      ? { payload: { Orders: [] } }
      : { FinancialEvents: {} },
  }))
})

it('fetchOrders pins the client to the named account', async () => {
  await new AmazonService().fetchOrders({ since: new Date('2026-09-20T00:00:00Z'), accountId: 'acct-A' })
  expect(m.client).toHaveBeenCalledWith('acct-A')
})

it('fetchOrders without an account keeps the resolver default', async () => {
  await new AmazonService().fetchOrders({ since: new Date('2026-09-20T00:00:00Z') })
  expect(m.client).toHaveBeenCalledWith(undefined)
})

it('fetchOrderById and fetchOrderItems pin the client to the named account (review #9)', async () => {
  m.client.mockImplementation(() => ({ callAPI: async () => ({ payload: {} }) }))
  await new AmazonService().fetchOrderById('404-1', 'acct-A')
  await new AmazonService().fetchOrderItems('404-1', 'acct-A')
  expect(m.client.mock.calls).toEqual([['acct-A'], ['acct-A']])
})

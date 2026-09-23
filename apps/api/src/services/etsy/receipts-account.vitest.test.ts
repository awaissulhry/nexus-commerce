import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ get: vi.fn(), reader: vi.fn() }))
vi.mock('./read-client.js', () => ({ etsyReader: state.reader }))
const { pullEtsyReceipt } = await import('./receipts.service.js')
beforeEach(() => {
  vi.clearAllMocks()
  state.get.mockResolvedValue({ receipt_id: 456 })
  state.reader.mockResolvedValue({ get: state.get, shopId: '123' })
})
it('reconstructs the receipt path from the selected account and validated IDs', async () => {
  expect(await pullEtsyReceipt('account-2', '456', '123')).toEqual({ receipt_id: 456 })
  expect(state.reader).toHaveBeenCalledWith('account-2')
  expect(state.get).toHaveBeenCalledWith('/shops/123/receipts/456')
})
it('refuses a webhook shop that differs from its persisted account without a request', async () => {
  await expect(pullEtsyReceipt('account-2', '456', '999')).rejects.toThrow(/different shop/)
  expect(state.get).not.toHaveBeenCalled()
})
it('rejects path injection before resolving an account', async () => {
  await expect(pullEtsyReceipt('account-2', '../123')).rejects.toThrow(/positive whole number/)
  expect(state.reader).not.toHaveBeenCalled()
})
it('registers all four documented events and retains legacy replay names', async () => {
  const { canReplayInbound } = await import('../cx/ingress/handlers.js')
  for (const type of ['order.paid', 'order.canceled', 'order.shipped', 'order.delivered', 'order.cancelled', 'order.refunded']) {
    expect(canReplayInbound('ETSY', type)).toBe(true)
  }
})

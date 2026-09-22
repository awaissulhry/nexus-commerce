import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ events: [] as any[], handle: vi.fn(), deadLetter: vi.fn(), complete: vi.fn(), workspace: vi.fn() }))
vi.mock('../services/cx/ingress/ledger.js', async (original) => ({
  ...await original<object>(),
  dueInboundEvents: async () => state.events,
  deadLetterInbound: state.deadLetter,
  completeInbound: state.complete,
}))
vi.mock('../services/cx/ingress/handlers.js', () => ({ canReplayInbound: () => true, inboundHandlerFor: async () => state.handle }))
vi.mock('../lib/workspace-ingress.js', () => ({ withIngressWorkspace: async (id: string, work: () => Promise<unknown>) => { state.workspace(id); return work() } }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { runInboundRetrySweep } = await import('./inbound-retry.job.js')
beforeEach(() => { vi.clearAllMocks(); state.events = [] })

it.each([
  ['EBAY', 'AUTHORIZATION_REVOCATION', false, 'ebay_ecdsa'],
  ['EBAY', 'ORDER_CONFIRMATION', false, 'ebay_ecdsa'],
  ['ETSY', 'order.paid', false, 'none'],
  ['SHOPIFY', 'app/uninstalled', null, 'none'],
])('does not execute unverified %s/%s even if it was previously queued', async (channel, eventType, signatureOk, verifiedBy) => {
  state.events = [{ id: 'forged', workspaceId: 'owner', channel, eventType, signatureOk, verifiedBy, payload: {}, connectionId: 'account' }]
  expect(await runInboundRetrySweep()).toMatchObject({ succeeded: 0, unreplayable: 1 })
  expect(state.handle).not.toHaveBeenCalled()
  expect(state.complete).not.toHaveBeenCalled()
  expect(state.deadLetter).toHaveBeenCalledWith('forged', expect.stringMatching(/verification/i))
  expect(state.workspace).toHaveBeenCalledWith('owner')
})

it('runs verified events in their owning profile with the persisted account', async () => {
  state.events = [{ id: 'verified', workspaceId: 'motovento', channel: 'ETSY', eventType: 'order.paid', signatureOk: true, verifiedBy: 'none', payload: { shop_id: 2 }, connectionId: 'etsy-2' }]
  expect(await runInboundRetrySweep()).toMatchObject({ succeeded: 1, unreplayable: 0 })
  expect(state.workspace).toHaveBeenCalledWith('motovento')
  expect(state.handle).toHaveBeenCalledWith({ shop_id: 2 }, { connectionId: 'etsy-2', eventType: 'order.paid', channel: 'ETSY' })
  expect(state.complete).toHaveBeenCalledWith('verified', true)
})

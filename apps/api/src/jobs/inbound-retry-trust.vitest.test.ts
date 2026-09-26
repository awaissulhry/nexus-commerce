import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ events: [] as any[], handle: vi.fn(), deadLetter: vi.fn(), complete: vi.fn(), workspace: vi.fn(), finished: vi.fn(), claimedElsewhere: new Set<string>() }))
vi.mock('../services/cx/ingress/ledger.js', async (original) => ({
  ...await original<object>(),
  dueInboundEvents: async () => state.events,
  deadLetterInbound: state.deadLetter,
  completeInbound: state.complete,
}))
vi.mock('../services/cx/ingress/handlers.js', () => ({ canReplayInbound: () => true, inboundHandlerFor: async () => state.handle }))
// Claims are covered against a real database in claims.vitest.test.ts. Here a claim is
// the claimed row itself, so the test proves the handler runs what the claim returned.
vi.mock('../services/cx/ingress/claims.js', () => ({
  inboundDatabaseNow: async () => new Date('2026-09-25T12:00:00Z'),
  claimInbound: async (id: string) => {
    if (state.claimedElsewhere.has(id)) return null
    const row = state.events.find(event => event.id === id)
    return row && { id, token: 'token', attempt: 1, payload: row.payload, connectionId: row.connectionId, eventType: row.eventType, channel: row.channel }
  },
  runWithInboundClaim: async (claim: { id: string }, work: (claim: unknown, signal: AbortSignal) => Promise<unknown>) => {
    const result = await work(claim, new AbortController().signal)
    state.finished(claim.id)
    return result
  },
}))
vi.mock('../lib/workspace-ingress.js', () => ({ withIngressWorkspace: async (id: string, work: () => Promise<unknown>) => { state.workspace(id); return work() } }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { runInboundRetrySweep } = await import('./inbound-retry.job.js')
beforeEach(() => { vi.clearAllMocks(); state.events = []; state.claimedElsewhere.clear() })

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
  expect(state.handle).toHaveBeenCalledWith({ shop_id: 2 }, { connectionId: 'etsy-2', eventType: 'order.paid', channel: 'ETSY', signal: expect.any(AbortSignal) })
  expect(state.finished).toHaveBeenCalledWith('verified')
  expect(state.complete).not.toHaveBeenCalled()
})

it('counts an event another worker claimed first as neither run nor failed', async () => {
  state.events = [{ id: 'taken', workspaceId: 'motovento', channel: 'ETSY', eventType: 'order.paid', signatureOk: true, verifiedBy: 'none', payload: {}, connectionId: 'etsy-2' }]
  state.claimedElsewhere.add('taken')
  expect(await runInboundRetrySweep()).toEqual({ due: 1, succeeded: 0, failed: 0, unreplayable: 0 })
  expect(state.handle).not.toHaveBeenCalled()
  expect(state.finished).not.toHaveBeenCalled()
})

import { beforeEach, expect, it, vi } from 'vitest'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
const state = vi.hoisted(() => ({ events: [] as Array<{ id: string; workspaceId: string }>, process: vi.fn(), due: vi.fn(), payload: vi.fn(), complete: vi.fn(), dead: vi.fn(), claimed: vi.fn(), finished: vi.fn() }))
vi.mock('../services/cx/ingress/ebay-processing.js', () => ({ dueEbayInboundEvents: async () => state.events,
  processEbayInbound: state.process, ebayInboundProcessingEnabled: () => true }))
vi.mock('../services/cx/ingress/ledger.js', () => ({ dueInboundEvents: state.due, isVerifiedInbound: (row: any) => row.signatureOk === true,
  completeInbound: state.complete, deadLetterInbound: state.dead }))
vi.mock('../services/cx/ingress/handlers.js', () => ({ canReplayInbound: () => true, inboundHandlerFor: async () => state.payload }))
// Generic rows run under #4's claim (proved against PostgreSQL in claims.vitest.test.ts); here a
// claim is the selected row itself, so the sweep's routing is what is under test.
vi.mock('../services/cx/ingress/claims.js', () => ({
  inboundDatabaseNow: async () => new Date('2026-09-26T12:00:00Z'),
  claimInbound: async (id: string) => { state.claimed(id)
    return { id, token: 'token', attempt: 1, payload: { product: 'existing' }, connectionId: id === 'shopify' ? 'shop' : 'preserved-shopify', eventType: 'product/update', channel: 'SHOPIFY' } },
  runWithInboundClaim: async (claim: { id: string }, work: (claim: unknown, signal: AbortSignal) => Promise<unknown>) => {
    const result = await work(claim, new AbortController().signal); state.finished(claim.id); return result },
}))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/cron/clustered.js', () => ({ default: {} }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { runInboundRetrySweep } = await import('./inbound-retry.job.js')
beforeEach(() => { vi.clearAllMocks(); state.events = []; state.due.mockResolvedValue([]) })

it('runs stored receipts in their own profiles and never invokes legacy completion for them', async () => {
  const outcomes = ['done', 'deferred', 'dead_letter', 'retry']
  state.events = outcomes.map((id, index) => ({ id, workspaceId: `profile-${index}` }))
  state.process.mockImplementation(async id => {
    await Promise.resolve()
    expect(workspaceIdForQuery()).toBe(state.events.find(event => event.id === id)!.workspaceId)
    return { kind: id }
  })
  state.due.mockResolvedValue([{ id: 'shopify-receipt', workspaceId: 'shopify-profile', channel: 'SHOPIFY', eventType: 'product/update',
    signatureOk: true, payload: { product: 'existing' }, connectionId: 'preserved-shopify' }])
  expect(await runInboundRetrySweep()).toEqual({ due: 5, succeeded: 2, failed: 1, unreplayable: 1, deferred: 1, skipped: 0 })
  expect(state.process).toHaveBeenCalledTimes(4)
  expect(state.due).toHaveBeenCalledWith(50, expect.any(Date), { excludeVerifiedEbay: true })
  // #4: a generic row finishes through its claim, never through legacy completion.
  expect(state.claimed).toHaveBeenCalledExactlyOnceWith('shopify-receipt')
  expect(state.finished).toHaveBeenCalledExactlyOnceWith('shopify-receipt')
  expect(state.complete).not.toHaveBeenCalled()
  expect(state.dead).not.toHaveBeenCalled()
  expect(state.payload).toHaveBeenCalledExactlyOnceWith({ product: 'existing' }, { connectionId: 'preserved-shopify', eventType: 'product/update', channel: 'SHOPIFY', signal: expect.any(AbortSignal) })
  // One owner per row type: the eBay processor never saw the generic row, the claimant never saw an eBay row.
  expect(state.process.mock.calls.map(call => call[0])).not.toContain('shopify-receipt')
  expect(state.claimed.mock.calls.map(call => call[0])).toEqual(['shopify-receipt'])
})

it('leaves a failed required write to durable lease recovery instead of a legacy completion', async () => {
  state.events = [{ id: 'stored-receipt', workspaceId: 'owner' }]
  state.process.mockRejectedValueOnce(new Error('synthetic private database failure'))
  expect(await runInboundRetrySweep()).toMatchObject({ failed: 1, succeeded: 0 })
  expect(state.complete).not.toHaveBeenCalled()
  expect(state.dead).not.toHaveBeenCalled()
})

it('reports a claim owned by another worker as skipped', async () => {
  state.events = [{ id: 'stored-receipt', workspaceId: 'owner' }]
  state.process.mockResolvedValueOnce({ kind: 'not_claimed' })
  expect(await runInboundRetrySweep()).toMatchObject({ skipped: 1, succeeded: 0, failed: 0 })
  expect(state.complete).not.toHaveBeenCalled()
})

it('does not delay an existing Shopify event behind a slow eBay inspection', async () => {
  state.events = [{ id: 'slow-ebay', workspaceId: 'ebay-owner' }]
  state.due.mockResolvedValue([{ id: 'shopify', workspaceId: 'shopify-owner', channel: 'SHOPIFY', eventType: 'product/update', signatureOk: true, payload: {}, connectionId: 'shop' }])
  let release!: () => void, shopifyRan!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { shopifyRan = resolve })
  state.process.mockImplementationOnce(async () => { await held; return { kind: 'done' } })
  state.payload.mockImplementationOnce(async () => { shopifyRan() })
  const sweep = runInboundRetrySweep()
  let independent = false
  try { independent = await Promise.race([ready.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]) }
  finally { release() }
  expect(await sweep).toMatchObject({ succeeded: 2 })
  expect(independent).toBe(true)
})

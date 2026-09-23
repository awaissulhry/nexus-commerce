import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ row: {} as any, queued: { ok: true, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION' } as any,
  replay: vi.fn(), receipt: vi.fn(), payload: vi.fn(), complete: vi.fn(), dead: vi.fn(), sweep: vi.fn() }))
vi.mock('../db.js', () => ({ default: { webhookEvent: { findUnique: async () => state.row } } }))
vi.mock('../services/cx/ingress/ledger.js', () => ({ replayInbound: state.replay, completeInbound: state.complete, deadLetterInbound: state.dead }))
vi.mock('../services/cx/ingress/handlers.js', () => ({
  canReplayInbound: (_channel: string, event: string) => event === 'AUTHORIZATION_REVOCATION',
  inboundReceiptHandlerFor: async (_channel: string, event: string) => event === 'AUTHORIZATION_REVOCATION' ? state.receipt : null,
  inboundHandlerFor: async () => state.payload,
  ReplayUnsupported: class extends Error {},
}))
vi.mock('../services/cx/ingress/ebay-processing.js', () => ({ ebayInboundProcessingReady: () => process.env.NEXUS_ENABLE_EBAY_INBOUND_PROCESSING === '1' && process.env.NEXUS_CX_TOKEN_SERVICE !== '0' }))
vi.mock('../services/ebay-orders.service.js', () => ({ ebayOrdersService: { syncEbayOrders: state.sweep } }))
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: async () => [{ id: 'wrong-account' }] }))
vi.mock('../services/amazon-orders.service.js', () => ({ amazonOrdersService: {} }))
vi.mock('../services/sync-logs-events.service.js', () => ({ subscribeSyncLogEvents: vi.fn() }))
vi.mock('../jobs/cron-registry.js', () => ({ CRON_REGISTRY: [], isKnownCron: () => false, listKnownCrons: () => [] }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn() }))
const Fastify = (await import('fastify')).default
const routes = (await import('./sync-logs.routes.js')).default
async function request(path: string, method: 'GET' | 'POST' = 'POST') {
  const app = Fastify()
  await app.register(routes)
  try { return await app.inject({ method, url: `/sync-logs/webhooks/stored-receipt${path}`, ...(method === 'POST' ? { payload: { connectionId: 'caller-forged-account', payload: { userId: 'wrong-seller' } } } : {}) }) }
  finally { await app.close() }
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1'); vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
  state.row = { id: 'stored-receipt', channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', connectionId: 'owned-account',
    signatureOk: true, verifiedBy: 'ebay_ecdsa', payload: { original: true }, leaseToken: 'private-worker-fence' }
  state.queued = { ok: true, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION' }
  state.replay.mockImplementation(async () => state.queued)
  state.receipt.mockResolvedValue({ kind: 'done' })
})
afterEach(() => vi.unstubAllEnvs())

describe('stored eBay operator replay', () => {
  it.each(['/retry', '/replay'])('holds %s before resetting attempts until processing is enabled', async path => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0')
    const result = await request(path)
    expect(result.statusCode).toBe(409)
    expect(state.replay).not.toHaveBeenCalled()
    expect(state.receipt).not.toHaveBeenCalled()
  })

  it('passes only the persisted receipt ID and never sweeps accounts or completes outside the claim', async () => {
    const result = await request('/replay')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ success: true, queued: false })
    expect(state.replay).toHaveBeenCalledWith({ id: 'stored-receipt' })
    expect(state.receipt).toHaveBeenCalledExactlyOnceWith('stored-receipt')
    expect(state.payload).not.toHaveBeenCalled()
    expect(state.complete).not.toHaveBeenCalled()
    expect(state.dead).not.toHaveBeenCalled()
    expect(state.sweep).not.toHaveBeenCalled()
  })

  it.each(['/retry', '/replay'])('holds %s before a reset when the canonical token service is disabled', async path => {
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '0')
    expect((await request(path)).statusCode).toBe(409)
    expect(state.replay).not.toHaveBeenCalled()
    expect(state.receipt).not.toHaveBeenCalled()
  })

  it.each(['retry', 'deferred', 'not_claimed'])('reports %s as queued, never completed', async kind => {
    state.receipt.mockResolvedValueOnce({ kind })
    const result = await request('/replay')
    expect(result.statusCode).toBe(202)
    expect(result.json()).toEqual({ success: true, queued: true })
    expect(state.complete).not.toHaveBeenCalled()
  })

  it('returns the unresolved dead letter without a second status mutation', async () => {
    state.receipt.mockResolvedValueOnce({ kind: 'dead_letter' })
    const result = await request('/replay')
    expect(result.statusCode).toBe(409)
    expect(result.json()).toMatchObject({ success: false, queued: false })
    expect(state.complete).not.toHaveBeenCalled()
    expect(state.dead).not.toHaveBeenCalled()
  })

  it('retains the verification refusal before any processor is invoked', async () => {
    state.row.signatureOk = false; state.queued = { ok: false, reason: 'unverified' }
    const result = await request('/replay')
    expect(result.statusCode).toBe(409)
    expect(result.json().error).toMatch(/not verified/)
    expect(state.receipt).not.toHaveBeenCalled()
    expect(state.sweep).not.toHaveBeenCalled()
  })

  it('does not reset an unsupported event while its business handler is missing', async () => {
    state.row.eventType = 'ORDER_CONFIRMATION'
    expect((await request('/replay')).statusCode).toBe(409)
    expect(state.replay).not.toHaveBeenCalled()
    expect(state.receipt).not.toHaveBeenCalled()
  })

  it('omits the private lease token from the authenticated detail response', async () => {
    const result = await request('', 'GET')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ id: 'stored-receipt', payload: { original: true } })
    expect(result.json()).not.toHaveProperty('leaseToken')
    expect(result.body).not.toContain('private-worker-fence')
  })

  it('keeps arbitrary processor errors out of the public response', async () => {
    state.receipt.mockRejectedValueOnce(new Error('sensitive-provider-token'))
    const result = await request('/replay')
    expect(result.statusCode).toBe(503)
    expect(result.body).not.toContain('sensitive-provider-token')
    expect(state.complete).not.toHaveBeenCalled()
  })
})

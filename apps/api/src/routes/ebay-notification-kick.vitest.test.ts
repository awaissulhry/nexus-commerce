/**
 * eBay order notices, Phase 4 — the receiver's 200 never waits for, and never depends on, the "run it now" kick.
 * Admission is a stub; the queue is a stub that can hang or fail. The receipt itself stays with the minute sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ receive: vi.fn(), add: vi.fn(), kicks: [] as Array<Promise<unknown>> }))
class AdmissionError extends Error { constructor(readonly reason: string) { super('Static admission refusal') } }
vi.mock('../services/cx/ingress/ebay-admission.js', () => ({ receiveEbayNotice: state.receive, EbayAdmissionError: AdmissionError }))
vi.mock('../services/cx/ingress/ebay-signature.js', () => ({ verifyEbayNotification: async () => ({ ok: true }), ebayChallengeResponse: () => 'stub-response' }))
vi.mock('../lib/queue.js', () => ({ ebayOrderNoticeQueue: { name: 'ebay-order-notice' }, addJobSafely: state.add }))
// The real kick, with each call's promise kept so a test can wait for the not-awaited work to finish.
vi.mock('../services/cx/ebay-order-notice-kick.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/cx/ebay-order-notice-kick.js')>()
  return { ...actual, kickStoredEbayOrderNotice: (...args: Parameters<typeof actual.kickStoredEbayOrderNotice>) => {
    const kick = actual.kickStoredEbayOrderNotice(...args); state.kicks.push(kick); return kick } }
})
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: async () => [] }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const Fastify = (await import('fastify')).default
const routes = (await import('./ebay-notification.routes.js')).default

const order = { metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' },
  notification: { notificationId: 'synthetic-notice', publishDate: '2026-10-06T10:00:01.000Z', data: { user: { userId: 'synthetic-seller' }, order: { orderId: 'synthetic-order' } } } }
const accepted = { kind: 'accepted', receiptId: 'synthetic-receipt', workspaceId: 'synthetic-business', duplicate: false }

async function post(payload = JSON.stringify(order)) {
  const app = Fastify()
  await app.register(routes as never)
  try {
    const started = Date.now()
    const response = await app.inject({ method: 'POST', url: '/webhooks/ebay-notification', headers: { 'content-type': 'application/json', 'x-ebay-signature': 'synthetic-signature' }, payload })
    return { status: response.statusCode, body: response.json(), ms: Date.now() - started }
  } finally { await app.close() }
}
/** Waits for the not-awaited kicks to finish (a hanging queue add is bounded by the caller's own wait). */
const settle = async () => { await Promise.race([Promise.all(state.kicks), new Promise(resolve => setTimeout(resolve, 2_000))]) }

beforeEach(() => {
  vi.clearAllMocks()
  state.kicks = []
  state.receive.mockResolvedValue(accepted)
  state.add.mockResolvedValue({ enqueued: true })
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
  vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
  vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('eBay receiver: run a stored order notice now, after the 200', () => {
  it('answers 200 and then asks for one job for the stored receipt', async () => {
    expect(await post()).toMatchObject({ status: 200, body: { received: true } })
    await settle()
    expect(state.add).toHaveBeenCalledExactlyOnceWith({ name: 'ebay-order-notice' }, 'process-receipt', { receiptId: 'synthetic-receipt' }, { jobId: 'ebay-order-notice-synthetic-receipt' })
  })

  it('answers 200 at once while the queue hangs: the 200 never waits for the kick', async () => {
    state.add.mockImplementation(() => new Promise(() => undefined))
    const answer = await post()
    expect(answer).toMatchObject({ status: 200, body: { received: true } })
    expect(answer.ms).toBeLessThan(1_000)
    await settle()
    expect(state.add).toHaveBeenCalledTimes(1)
  })

  it('answers 200 when the queue fails (the minute sweep runs the stored receipt)', async () => {
    state.add.mockRejectedValue(new Error('synthetic redis failure'))
    expect(await post()).toMatchObject({ status: 200, body: { received: true } })
    await settle()
    expect(state.add).toHaveBeenCalledTimes(1)
  })

  it('kicks nothing for a quarantined order notice, and still answers 200', async () => {
    state.receive.mockResolvedValueOnce({ kind: 'quarantined', quarantineId: 'synthetic-quarantine', reason: 'owner_unknown' })
    expect(await post()).toMatchObject({ status: 200, body: { received: true } })
    await settle()
    expect(state.add).not.toHaveBeenCalled()
  })

  it('kicks nothing while order notices are held, and still answers 200', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '0')
    expect(await post()).toMatchObject({ status: 200, body: { received: true } })
    await settle()
    expect(state.add).not.toHaveBeenCalled()
  })

  it('kicks nothing for a rejected signature or a failed storage, whose answers are unchanged', async () => {
    state.receive.mockResolvedValueOnce({ kind: 'rejected', quarantineId: 'synthetic-quarantine', reason: 'signature_mismatch' })
    expect(await post()).toMatchObject({ status: 412 })
    state.receive.mockRejectedValueOnce(new AdmissionError('storage_unavailable'))
    expect(await post()).toMatchObject({ status: 503 })
    await settle()
    expect(state.add).not.toHaveBeenCalled()
  })
})

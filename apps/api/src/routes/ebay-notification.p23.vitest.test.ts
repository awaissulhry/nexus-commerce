/** Durable HTTP admission is distinct from completing a business effect. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const receive = vi.fn()
class AdmissionError extends Error { constructor(readonly reason: string) { super('Static admission refusal') } }
vi.mock('../services/cx/ingress/ebay-admission.js', () => ({ receiveEbayNotice: receive, EbayAdmissionError: AdmissionError }))
vi.mock('../services/cx/ingress/ebay-signature.js', () => ({ verifyEbayNotification: async () => ({ ok: true }), ebayChallengeResponse: () => 'stub-response' }))
// Negative control for the old receiver: persistence failed but it still acknowledged completion.
vi.mock('../services/cx/ingress/ledger.js', () => ({ recordInbound: async () => ({ id: null, duplicate: false }) }))
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: async () => [] }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const Fastify = (await import('fastify')).default
const routes = (await import('./ebay-notification.routes.js')).default
const { logger } = await import('../utils/logger.js')
const body = { metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' }, notification: { notificationId: 'n-1', data: { userId: 'synthetic-seller', revocationDate: '2026-09-23T01:02:03Z' } } }
async function post(payload = JSON.stringify(body), url = '/webhooks/ebay-notification') {
  const app = Fastify()
  await app.register(routes as any)
  try { return await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-ebay-signature': 'synthetic-signature' }, payload }) }
  finally { await app.close() }
}
beforeEach(() => { vi.clearAllMocks(); receive.mockResolvedValue({ kind: 'accepted', receiptId: 'private-receipt', workspaceId: 'private-profile', duplicate: false }); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1') })
afterEach(() => vi.unstubAllEnvs())

describe('eBay durable receiver contract', () => {
  it('acknowledges only durable receipt without exposing internal routing IDs', async () => {
    const result = await post()
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ received: true })
    expect(receive).toHaveBeenCalledWith({ rawBody: Buffer.from(JSON.stringify(body)), header: 'synthetic-signature' })
  })
  it('acknowledges recoverable quarantine without claiming an account action or erasure', async () => {
    receive.mockResolvedValueOnce({ kind: 'quarantined', quarantineId: 'private-quarantine', reason: 'subject_or_topic_unresolved' })
    const result = await post(JSON.stringify({ ...body, metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0' } }))
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ received: true })
  })
  it('rejects a failed signature after recording metadata, without accepting the event', async () => {
    receive.mockResolvedValueOnce({ kind: 'rejected', quarantineId: 'private-quarantine', reason: 'signature_mismatch' })
    const result = await post()
    expect(result.statusCode).toBe(412)
    expect(result.json()).toEqual({ error: 'Signature verification failed.' })
  })
  it.each(['app_token_unavailable', 'public_key_forbidden', 'public_key_not_found'])('requests redelivery when verification is unavailable: %s', async reason => {
    receive.mockResolvedValueOnce({ kind: 'rejected', quarantineId: 'private-quarantine', reason })
    const result = await post()
    expect(result.statusCode).toBe(503)
    expect(result.json()).toEqual({ error: 'Notification verification is temporarily unavailable.' })
  })
  it.each(['storage_unavailable', 'cipher_unavailable', 'identity_conflict', 'owner_unavailable'])('never acknowledges failed durable admission: %s', async reason => {
    receive.mockRejectedValueOnce(new AdmissionError(reason))
    const result = await post()
    expect(result.statusCode).toBe(503)
    expect(result.json()).toEqual({ error: 'Notification could not be stored safely. Retry delivery.' })
  })
  it('does not expose arbitrary storage errors, request data or internal identifiers in errors/logs', async () => {
    receive.mockRejectedValueOnce(new Error('sensitive-provider-body synthetic-private-token'))
    const result = await post()
    expect(result.statusCode).toBe(503)
    expect(result.body).not.toContain('sensitive')
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('sensitive')
  })
  it('refuses an oversized body before starting provider verification', async () => {
    const result = await post(JSON.stringify({ padding: 'x'.repeat(1_048_576) }))
    expect(result.statusCode).toBe(413)
    expect(receive).not.toHaveBeenCalled()
  })
  it('sends malformed JSON bytes through admission and returns only a static verification refusal', async () => {
    const raw = '{"sensitive-private-field":'
    receive.mockResolvedValueOnce({ kind: 'rejected', quarantineId: 'private', reason: 'body_unparseable' })
    const result = await post(raw)
    expect(result.statusCode).toBe(412)
    expect(result.json()).toEqual({ error: 'Signature verification failed.' })
    expect(receive).toHaveBeenCalledWith({ rawBody: Buffer.from(raw), header: 'synthetic-signature' })
    expect(result.body).not.toContain('sensitive')
  })
  it('keeps storage failure mapping static even when the original JSON is malformed', async () => {
    receive.mockRejectedValueOnce(new AdmissionError('storage_unavailable'))
    const result = await post('{"sensitive-private-field":')
    expect(result.statusCode).toBe(503)
    expect(result.body).not.toContain('sensitive')
  })
  it('retains normal JSON validation on admin routes in the same plugin', async () => {
    const result = await post('{"invalid":', '/admin/setup-ebay-notifications')
    expect(result.statusCode).toBe(400)
    expect(receive).not.toHaveBeenCalled()
  })
})

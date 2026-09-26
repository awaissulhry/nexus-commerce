/**
 * CX Etsy E1 — the receiver's acknowledgement contract is unchanged, but its ledger row now names
 * WHY a receipt could not be read back.
 *
 * End to end through the route, the handler, `pullEtsyReceipt` and the real reader; only the
 * gateway (Etsy's answer), the ledger, routing, the account and the token are stubbed. Before E1 a
 * 401, a 429 and a 503 were all recorded as "could not be read back for this shop".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = `whsec_${Buffer.from('an-etsy-signing-key-for-tests!!').toString('base64')}`
const h = vi.hoisted(() => ({
  completed: [] as Array<{ id: unknown; ok: boolean; error?: string }>,
  answer: null as null | (() => Response),
  calls: [] as string[],
  deferred: [] as Array<{ id: unknown; reason: string; delayMs: number }>,
  stored: null as null | Record<string, any>,
}))

vi.mock('../services/cx/ingress/ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cx/ingress/ledger.js')>()),
  recordInbound: async (rec: Record<string, any>) => { h.stored = rec; return { id: 'row-1', duplicate: false } },
}))
// Every execution path runs under a processing claim (PR #4). This double mirrors the real claim's
// outcomes — done, a failure closed out, a deferral that gives the attempt back; the real claim is
// proven on PostgreSQL (claims.vitest.test.ts).
vi.mock('../services/cx/ingress/claims.js', async () => {
  const { InboundDeferred } = await import('../services/cx/ingress/ledger.js')
  return {
    claimInbound: async (id: string) => h.stored ? { id, token: 'claim', attempt: 1, payload: h.stored.payload, connectionId: h.stored.connectionId ?? null, eventType: h.stored.eventType, channel: 'ETSY' } : null,
    runWithInboundClaim: async (claim: any, work: any) => {
      try {
        const result = await work(claim, new AbortController().signal)
        h.completed.push({ id: claim.id, ok: true, error: undefined })
        return result
      } catch (error) {
        if (error instanceof InboundDeferred) h.deferred.push({ id: claim.id, reason: error.message, delayMs: error.delayMs })
        else h.completed.push({ id: claim.id, ok: false, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
  }
})
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: () => unknown) => work(),
  withIngressWorkspace: (_id: string, work: () => unknown) => work(),
  verifiedChannelWorkspace: async () => ({ workspaceId: 'ws-1', connectionId: 'conn-etsy' }),
}))
vi.mock('../services/gateway/gateway.js', () => ({
  gatewayFetch: vi.fn(async (req: { url: string }) => {
    h.calls.push(req.url)
    if (!h.answer) throw new Error('no answer configured')
    return h.answer()
  }),
}))
vi.mock('../services/etsy/account.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/etsy/account.js')>()),
  etsyAccount: vi.fn(async (accountId: string) => ({ accountId, shopId: '12345', apiKey: 'key:secret' })),
}))
vi.mock('../services/cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'etsy-token') }))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => [] }) }) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const Fastify = (await import('fastify')).default
const etsyWebhookRoutes = (await import('./etsy-webhooks.routes.js')).default
const { signStandardWebhook } = await import('../services/cx/ingress/standard-webhooks.js')

const RECEIPT = 3344556677
async function post() {
  const payload = JSON.stringify({ event_type: 'order.paid', shop_id: 12345, resource_url: `https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}` })
  const app = Fastify()
  await app.register(etsyWebhookRoutes)
  const ts = String(Math.floor(Date.now() / 1000))
  const res = await app.inject({
    method: 'POST', url: '/webhooks/etsy', payload,
    headers: { 'content-type': 'application/json', 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': signStandardWebhook('msg_1', Number(ts), payload, SECRET) },
  })
  await app.close()
  return res
}

beforeEach(() => {
  h.completed.length = 0; h.calls.length = 0; h.answer = null
  vi.stubEnv('ETSY_WEBHOOK_SIGNING_SECRET', SECRET)
})

describe('an Etsy order event whose receipt read-back fails', () => {
  it.each([401, 403, 429, 500, 503])('HTTP %i: still 500 and retryable, and the ledger names the HTTP status — not "not found"', async (code) => {
    h.answer = () => new Response('{"error":"x"}', { status: code })
    const res = await post()
    expect(res.statusCode).toBe(500)
    expect(h.calls).toEqual([`https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}`])
    expect(h.completed).toHaveLength(1)
    expect(h.completed[0]).toMatchObject({ id: 'row-1', ok: false })
    expect(h.completed[0].error).toContain(`HTTP ${code}`)
    expect(h.completed[0].error).not.toMatch(/not found|could not be read back for this shop/)
  })

  it('HTTP 404: still 500 and retryable, recorded as not found in this shop', async () => {
    h.answer = () => new Response('{"error":"Receipt not found"}', { status: 404 })
    const res = await post()
    expect(res.statusCode).toBe(500)
    expect(h.completed[0]).toMatchObject({ ok: false })
    expect(h.completed[0].error).toMatch(/not found in this shop/)
  })

  it('HTTP 200: acknowledged as before (ingest itself is still not implemented)', async () => {
    h.answer = () => new Response(JSON.stringify({ receipt_id: RECEIPT, status: 'paid', is_paid: true, transactions: [] }), { status: 200 })
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(h.completed).toEqual([{ id: 'row-1', ok: true, error: undefined }])
  })
})

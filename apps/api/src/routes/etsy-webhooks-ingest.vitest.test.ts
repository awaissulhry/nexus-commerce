/**
 * CX Etsy E4 — the receiver's contract with order ingest switched ON
 * (`NEXUS_ENABLE_ETSY_ORDER_INGEST=1`), at the HTTP boundary. The writer itself is proved on real
 * PostgreSQL (etsy-order-ingest-postgres); here it is replaced so the route's own decisions show:
 * which account and receipt it hands over, what a sign-in hold answers, what a refusal records,
 * and that the OFF switch leaves the old behaviour untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = `whsec_${Buffer.from('an-etsy-signing-key-for-tests!!').toString('base64')}`
const h = vi.hoisted(() => ({
  completed: [] as Array<{ id: unknown; ok: boolean; error?: string }>,
  deferred: [] as Array<{ id: unknown; reason: string; delayMs: number }>,
  stamped: [] as unknown[],
  pulled: [] as string[],
  ingested: [] as Array<Record<string, unknown>>,
  pull: null as null | (() => unknown),
  outcome: { kind: 'written', status: 'PROCESSING', created: true, warnings: [] } as Record<string, unknown>,
  stored: null as null | Record<string, any>,
}))

vi.mock('../services/cx/ingress/ledger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/cx/ingress/ledger.js')>()
  return {
    ...original,
    recordInbound: async (rec: Record<string, any>) => { h.stored = rec; return { id: 'row-1', duplicate: false } },
  }
})
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
vi.mock('../db.js', () => ({ default: { $executeRaw: (...args: unknown[]) => { h.stamped.push(args); return Promise.resolve(1) } } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/etsy/receipts.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/etsy/receipts.service.js')>()
  return {
    ...original,
    pullEtsyReceipt: async (_accountId: string, receiptId: string) => { h.pulled.push(receiptId); return h.pull ? h.pull() : { receipt_id: Number(receiptId) } },
  }
})
vi.mock('../services/etsy/receipt-ingest.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/etsy/receipt-ingest.js')>()
  return {
    ...original,
    etsyIngestBinding: async () => ({ shopId: '12345', sellerUserId: '900000001' }),
    requireEtsyIngestActivation: async () => new Date(),
    ingestEtsyReceipt: async (args: Record<string, unknown>) => { h.ingested.push(args); return h.outcome },
  }
})

const Fastify = (await import('fastify')).default
const etsyWebhookRoutes = (await import('./etsy-webhooks.routes.js')).default
const { signStandardWebhook } = await import('../services/cx/ingress/standard-webhooks.js')
const { EtsyReceiptReadError } = await import('../services/etsy/receipts.service.js')

const RECEIPT = 3344556677
async function post(event_type = 'order.paid') {
  const payload = JSON.stringify({ event_type, shop_id: 12345, resource_url: `https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}` })
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
  h.completed.length = 0; h.deferred.length = 0; h.stamped.length = 0; h.pulled.length = 0; h.ingested.length = 0
  h.pull = null
  h.outcome = { kind: 'written', status: 'PROCESSING', created: true, warnings: [] }
  vi.stubEnv('ETSY_WEBHOOK_SIGNING_SECRET', SECRET)
  vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1')
})

describe('order ingest ON', () => {
  it('hands the writer exactly the routed account and the event\'s receipt; its claim completes the row; 200; the last delivery stamped', async () => {
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(h.pulled).toEqual([String(RECEIPT)])
    expect(h.ingested[0]).not.toHaveProperty('ledgerRowId')
    expect(h.ingested).toEqual([expect.objectContaining({
      connectionId: 'conn-etsy', source: 'webhook', deliveredEvent: false,
      expectedReceiptId: String(RECEIPT), claimedShopId: '12345', binding: { shopId: '12345', sellerUserId: '900000001' },
    })])
    expect(h.completed).toEqual([{ id: 'row-1', ok: true, error: undefined }])
    expect(h.stamped).toHaveLength(1)
  })

  it('marks an order.delivered event as one, for the writer to believe only if the receipt shipped', async () => {
    expect((await post('order.delivered')).statusCode).toBe(200)
    expect(h.ingested[0]).toMatchObject({ deliveredEvent: true })
  })

  it('a sign-in problem (401) is deferred without spending an attempt: 503, never closed out as a failure', async () => {
    h.pull = () => { throw new EtsyReceiptReadError('unauthorized', 401, String(RECEIPT), null) }
    const res = await post()
    expect(res.statusCode).toBe(503)
    expect(h.deferred).toEqual([{ id: 'row-1', reason: expect.stringContaining('auth hold'), delayMs: 30 * 60 * 1000 }])
    expect(h.completed).toEqual([])
    expect(h.ingested).toEqual([])
  })

  it.each([[429, 'rate_limited'], [503, 'server_error']] as const)('HTTP %i fails with the normal back-off (an attempt is spent)', async (status, kind) => {
    h.pull = () => { throw new EtsyReceiptReadError(kind, status, String(RECEIPT), null) }
    const res = await post()
    expect(res.statusCode).toBe(500)
    expect(h.deferred).toEqual([])
    expect(h.completed).toEqual([{ id: 'row-1', ok: false, error: expect.stringContaining(`HTTP ${status}`) }])
  })

  it('Etsy\'s 404 and a refused receipt fail with their code', async () => {
    h.pull = () => null
    expect((await post()).statusCode).toBe(500)
    expect(h.completed[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^\[not_found\]/) })
    h.completed.length = 0
    h.pull = null
    h.outcome = { kind: 'receipt_refused', refusal: { code: 'seller_mismatch', message: 'The receipt was sold by a different Etsy user from this account.', path: 'seller_user_id' } }
    expect((await post()).statusCode).toBe(500)
    expect(h.completed[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^\[seller_mismatch\]/) })
  })
})

describe('order ingest OFF (the default)', () => {
  it('reads back and logs exactly as before: no writer, no activation, no stamp', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    const res = await post()
    expect(res.statusCode).toBe(200)
    expect(h.pulled).toEqual([String(RECEIPT)])
    expect(h.ingested).toEqual([])
    expect(h.stamped).toEqual([])
    expect(h.completed).toEqual([{ id: 'row-1', ok: true, error: undefined }])
  })
})

/**
 * P2.5 — the Etsy receiver. There was no Etsy webhook route at all before this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

const SECRET = `whsec_${Buffer.from('an-etsy-signing-key-for-tests!!').toString('base64')}`
const recorded: any[] = []
const completed: any[] = []
const pulled: any[] = []
const expectedShops: Array<string | undefined> = []
const routed: unknown[][] = []
let nextWrite: any = { id: 'row-1', duplicate: false }
let routingThrows = false
let receiptExists = true
const storedRecords = new Map<string, any>()
const activeClaims = new Set<string>()
let claimDue = true
let receiptPause: Promise<void> | undefined
let receiptEntered: (() => void) | undefined

vi.mock('../services/cx/ingress/ledger.js', () => ({
  recordInbound: async (rec: any) => {
    recorded.push(rec)
    if (nextWrite.id && !storedRecords.has(nextWrite.id)) storedRecords.set(nextWrite.id, rec)
    return nextWrite
  },
  completeInbound: async (id: any, ok: boolean, error?: string) => { completed.push({ id, ok, error }) },
}))
// Real claim/CAS behavior has its own database suite; this double preserves the
// original arrival and active ownership while the real receiver and handler run.
vi.mock('../services/cx/ingress/claims.js', () => ({
  claimInbound: async (id: string) => {
    const stored = storedRecords.get(id)
    if (!stored || !claimDue || activeClaims.has(id)) return null
    activeClaims.add(id)
    return { ...stored, id, token: `claim-${id}`, attempt: 1, connectionId: stored.connectionId ?? null }
  },
  runWithInboundClaim: async (claim: any, work: any) => {
    try {
      const result = await work(claim, new AbortController().signal)
      completed.push({ id: claim.id, ok: true })
      return result
    } catch (error) {
      completed.push({ id: claim.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { activeClaims.delete(claim.id) }
  },
}))
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: async (...args: unknown[]) => {
    routed.push(args)
    if (routingThrows) throw new Error('ingress_account_ambiguous')
    return { workspaceId: 'ws-1', connectionId: 'conn-etsy' }
  },
}))
vi.mock('../services/etsy/receipts.service.js', () => ({
  pullEtsyReceipt: async (accountId: string, receiptId: string, expectedShopId?: string) => {
    pulled.push({ accountId, receiptId })
    expectedShops.push(expectedShopId)
    receiptEntered?.()
    await receiptPause
    return receiptExists ? { receipt_id: Number(receiptId), status: 'Paid', is_paid: true, transactions: [] } : null
  },
}))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => [] }) }) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const Fastify = (await import('fastify')).default
const etsyWebhookRoutes = (await import('./etsy-webhooks.routes.js')).default
const { signStandardWebhook } = await import('../services/cx/ingress/standard-webhooks.js')

const RECEIPT = 3344556677
const body = (event = 'order.paid') => JSON.stringify({ event, shop_id: 12345, receipt_id: RECEIPT })

async function post(payload: string, over: Record<string, string> = {}) {
  const app = Fastify()
  await app.register(etsyWebhookRoutes)
  const id = over.id ?? 'msg_1'
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000))
  const res = await app.inject({
    method: 'POST', url: '/webhooks/etsy',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': over.signature ?? signStandardWebhook(id, Number(ts), payload, SECRET),
      ...(over.eventHeader ? { 'x-etsy-event': over.eventHeader } : {}),
    },
    payload,
  })
  await app.close()
  return res
}

beforeEach(() => {
  recorded.length = 0; completed.length = 0; pulled.length = 0
  routed.length = 0; expectedShops.length = 0
  nextWrite = { id: 'row-1', duplicate: false }
  routingThrows = false
  receiptExists = true
  storedRecords.clear()
  activeClaims.clear()
  claimDue = true
  receiptPause = undefined
  receiptEntered = undefined
  vi.stubEnv('ETSY_WEBHOOK_SIGNING_SECRET', SECRET)
})

describe('a verified Etsy order event', () => {
  // Reduced from Etsy's documented envelope, not the historical synthetic body().
  it.each(['order.paid', 'order.canceled', 'order.shipped', 'order.delivered'])('handles documented %s resource URLs', async event_type => {
    const res = await post(JSON.stringify({ event_type, shop_id: 12345, resource_url: `https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}` }))
    expect(res.statusCode).toBe(200)
    expect(recorded[0]).toMatchObject({ eventType: event_type, connectionId: 'conn-etsy', status: 'pending' })
    expect(pulled).toEqual([{ accountId: 'conn-etsy', receiptId: String(RECEIPT) }])
    expect(expectedShops).toEqual(['12345'])
    expect(routed).toEqual([['ETSY', '12345']])
  })

  it('does not let an unsigned event header override the signed event type', async () => {
    const res = await post(JSON.stringify({ event_type: 'order.paid', shop_id: 12345, resource_url: `https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}` }), { eventHeader: 'listing.updated' })
    expect(res.statusCode).toBe(200)
    expect(recorded[0].eventType).toBe('order.paid')
    expect(pulled).toHaveLength(1)
  })

  it.each([
    `https://evil.example/v3/application/shops/12345/receipts/${RECEIPT}`,
    `https://api.etsy.com/v3/application/shops/67890/receipts/${RECEIPT}`,
    `https://api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}?redirect=bad`,
    `https://user:pass@api.etsy.com/v3/application/shops/12345/receipts/${RECEIPT}`,
  ])('retains a failed event for an invalid receipt resource without fetching it', async resource_url => {
    const res = await post(JSON.stringify({ event_type: 'order.paid', shop_id: 12345, resource_url, receipt_id: RECEIPT }))
    expect(res.statusCode).toBe(500)
    expect(completed[0]).toMatchObject({ ok: false })
    expect(pulled).toHaveLength(0)
  })

  it('refuses a missing shop instead of routing to the only connected shop', async () => {
    const res = await post(JSON.stringify({ event_type: 'order.paid', receipt_id: RECEIPT }))
    expect(res.statusCode).toBe(503)
    expect(pulled).toHaveLength(0)
  })

  it('records it on ETSY\'s own delivery id, then reads the receipt back from Etsy', async () => {
    const res = await post(body())
    expect(res.statusCode).toBe(200)
    expect(recorded[0]).toMatchObject({ channel: 'ETSY', eventType: 'order.paid', externalId: 'msg_1', signatureOk: true })
    // The notification body is a CLAIM. The shop's own API is the record, so the
    // receipt is read back rather than trusted.
    expect(pulled).toEqual([{ accountId: 'conn-etsy', receiptId: String(RECEIPT) }])
    expect(completed[0]).toMatchObject({ ok: true })
  })

  it('fails the event, and keeps it retryable, when the receipt cannot be read back', async () => {
    receiptExists = false
    const res = await post(body())
    expect(res.statusCode).toBe(500)
    expect(completed[0].ok).toBe(false)
  })

  it('records an event it has no handler for, and acknowledges it', async () => {
    const res = await post(body('listing.updated'))
    expect(res.statusCode).toBe(200)
    // Recorded WITH its payload: this is how a real event name and shape are learned,
    // instead of being guessed at the way the eBay topic names were.
    expect(recorded[0].eventType).toBe('listing.updated')
    expect(completed[0]).toMatchObject({ ok: true })
    expect(pulled).toHaveLength(0)
  })
})

describe('a delivery that fails verification', () => {
  it('is recorded and refused, and never names itself', async () => {
    const res = await post(body(), { signature: 'v1,' + crypto.randomBytes(32).toString('base64') })
    expect(res.statusCode).toBe(401)
    expect(recorded[0]).toMatchObject({ signatureOk: false, status: 'failed' })
    // Keyed on the body digest, not the id the sender claims: `(channel, externalId)`
    // is unique, and a forgery naming a real delivery id would occupy that slot and
    // make the genuine delivery look like a duplicate.
    expect(recorded[0].externalId).toBeNull()
    expect(pulled).toHaveLength(0)
  })

  it('refuses when no signing secret is configured, rather than trusting the body', async () => {
    vi.stubEnv('ETSY_WEBHOOK_SIGNING_SECRET', '')
    const res = await post(body())
    expect(res.statusCode).toBe(401)
    expect(recorded[0].lastError).toContain('missing_secret')
  })
})

describe('when the shop cannot be identified', () => {
  it('records the event and refuses to ack, so Etsy retries', async () => {
    routingThrows = true
    const res = await post(body())
    expect(res.statusCode).toBe(503)
    expect(recorded[0]).toMatchObject({ signatureOk: true, status: 'failed' })
    expect(recorded[0].lastError).toContain('no connected Etsy shop')
    expect(pulled).toHaveLength(0)
  })
})

describe('duplicate deliveries', () => {
  it('short-circuits only a FINISHED event', async () => {
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'done' }
    expect((await post(body())).statusCode).toBe(200)
    expect(pulled).toHaveLength(0)

    // The durable retry remains queued while its backoff is not due.
    recorded.length = 0; pulled.length = 0
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'failed' }
    claimDue = false
    const deferred = await post(body())
    expect(deferred.statusCode).toBe(200)
    expect(deferred.json()).toMatchObject({ success: true, queued: true })
    expect(pulled).toHaveLength(0)
    expect(completed).toHaveLength(0)
  })

  it('uses the stored receipt and account for a due duplicate', async () => {
    storedRecords.set('row-1', { channel: 'ETSY', eventType: 'order.paid', payload: { shop_id: 98765, receipt_id: 112233 }, connectionId: 'stored-account' })
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'failed' }
    const res = await post(body())
    expect(res.statusCode).toBe(200)
    expect(recorded[0].connectionId).toBe('conn-etsy')
    expect(recorded[0].payload.receipt_id).toBe(RECEIPT)
    expect(pulled).toEqual([{ accountId: 'stored-account', receiptId: '112233' }])
    expect(expectedShops).toEqual(['98765'])
    expect(completed).toEqual([{ id: 'row-1', ok: true }])
  })

  it('acknowledges an overlapping delivery without reading a second receipt', async () => {
    const entered = new Promise<void>(resolve => { receiptEntered = resolve })
    let resume!: () => void
    receiptPause = new Promise<void>(resolve => { resume = resolve })
    const first = post(body())
    await entered
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'pending' }
    const second = await post(JSON.stringify({ event: 'order.paid', shop_id: 12345, receipt_id: 999 }))
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ queued: true })
    expect(pulled).toEqual([{ accountId: 'conn-etsy', receiptId: String(RECEIPT) }])
    resume()
    expect((await first).statusCode).toBe(200)
    expect(completed).toEqual([{ id: 'row-1', ok: true }])
  })
})

describe('a replay gets its account from the ledger row, not from a lookup', () => {
  it('does not let a stored payload override its persisted connection', async () => {
    const { handleEtsyOrderEvent } = await import('./etsy-webhooks.routes.js')
    await handleEtsyOrderEvent({ receipt_id: RECEIPT, __nexusAccountId: 'different-account' }, { connectionId: 'conn-from-ledger' })
    expect(pulled).toEqual([{ accountId: 'conn-from-ledger', receiptId: String(RECEIPT) }])
  })
  it('uses the connectionId the receiver recorded at arrival', async () => {
    const { handleEtsyOrderEvent } = await import('./etsy-webhooks.routes.js')
    await handleEtsyOrderEvent({ receipt_id: RECEIPT }, { connectionId: 'conn-from-ledger' })
    expect(pulled).toEqual([{ accountId: 'conn-from-ledger', receiptId: String(RECEIPT) }])
  })

  it('refuses rather than guessing when the row names no account', async () => {
    // The first draft fell back to "the only connected Etsy shop in this workspace",
    // and the MAP.3 ratchet refused the push — a site that resolves a connection
    // without being told which account it means is how a write lands in the wrong
    // store the day a second one is connected.
    const { handleEtsyOrderEvent } = await import('./etsy-webhooks.routes.js')
    await expect(handleEtsyOrderEvent({ receipt_id: RECEIPT }, { connectionId: null }))
      .rejects.toThrow(/no connected account on its ledger row/)
    expect(pulled).toHaveLength(0)
  })
})

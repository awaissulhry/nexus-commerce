/**
 * P2.1 — what the Shopify receiver records, and when.
 *
 * Measured before this package: a receiver's own ledger write left ZERO rows behind.
 * Both `WebhookProcessor` methods called `db.webhookEvent` from a route that ran with
 * no business profile, each threw `Select a business profile`, and each caught its own
 * throw — so no Shopify event was ever recorded and no delivery was ever recognised as
 * a duplicate. These tests are the first thing in the repository that would notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

const SECRET = 'p21-test-secret'
const recorded: any[] = []
const completed: any[] = []
const handled: any[] = []
let nextWrite: any = { id: 'row-1', duplicate: false }
let routeThrowsFor: string | null = null
let handlerThrows = false

vi.mock('../services/cx/ingress/ledger.js', () => ({
  recordInbound: vi.fn(async (rec: any) => { recorded.push(rec); return nextWrite }),
  completeInbound: vi.fn(async (id: any, ok: boolean, error?: string) => { completed.push({ id, ok, error }) }),
}))
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: vi.fn(async (_channel: string, id?: string) => {
    if (routeThrowsFor !== null && id === routeThrowsFor) throw new Error('ingress_account_ambiguous')
    if (routeThrowsFor === '*') throw new Error('ingress_account_ambiguous')
    return { workspaceId: 'ws-1', connectionId: 'conn-1' }
  }),
}))
vi.mock('../utils/config.js', () => ({
  ConfigManager: { getConfig: () => ({ webhookSecret: SECRET }) },
}))
vi.mock('../services/shopify/schema-sync.service.js', () => ({ registerShopifySchemaWebhook: () => {} }))
// The route calls the REAL handler, so the handler's own first call is what tells us
// it ran. `recordManagedContentChange` is the first thing handleProductUpdate does.
vi.mock('../services/shopify/content-webhook.service.js', () => ({
  recordManagedContentChange: async (id: string) => {
    handled.push(id)
    if (handlerThrows) throw new Error('handler exploded')
    return false
  },
}))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

const Fastify = (await import('fastify')).default
const { shopifyWebhookRoutes } = await import('./shopify-webhooks.js')

async function buildApp() {
  const app = Fastify()
  await app.register(shopifyWebhookRoutes)
  return app
}

const PATH = '/webhooks/shopify/products/update'
const BODY = JSON.stringify({ id: '555', title: 'A product', updated_at: '2026-09-20T00:00:00Z' })
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')

function headers(extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': sign(BODY),
    'x-shopify-shop-domain': 'a-shop.myshopify.com',
    'x-shopify-webhook-id': 'delivery-abc',
    ...extra,
  }
}

beforeEach(() => {
  recorded.length = 0
  completed.length = 0
  handled.length = 0
  nextWrite = { id: 'row-1', duplicate: false }
  routeThrowsFor = null
  handlerThrows = false
  vi.clearAllMocks()
})

describe('a verified Shopify webhook reaches the ledger', () => {
  it('records the arrival, keyed on the DELIVERY id, then closes it out', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    expect(res.statusCode).toBe(200)

    expect(recorded).toHaveLength(1)
    expect(recorded[0].channel).toBe('SHOPIFY')
    expect(recorded[0].eventType).toBe('product/update')
    // The delivery id, NOT `payload.id`. Keying on the resource id against a unique
    // (channel, externalId) would have handled the first change to a product and
    // dropped every later change to it, permanently.
    expect(recorded[0].externalId).toBe('delivery-abc')
    expect(recorded[0].externalId).not.toBe('555')
    expect(recorded[0].signatureOk).toBe(true)
    expect(recorded[0].verifiedBy).toBe('shopify_hmac')
    expect(recorded[0].connectionId).toBe('conn-1')

    expect(completed).toEqual([{ id: 'row-1', ok: true, error: undefined }])
    await app.close()
  })

  it('records the failure when the handler throws, and answers 500 so Shopify retries', async () => {
    handlerThrows = true
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    expect(res.statusCode).toBe(500)
    expect(completed[0].ok).toBe(false)
    expect(completed[0].error).toContain('handler exploded')
    await app.close()
  })
})

describe('a REJECTED Shopify webhook is recorded too', () => {
  it('writes a failed row and answers 401', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: PATH,
      headers: headers({ 'x-shopify-hmac-sha256': 'not-the-right-signature' }),
      payload: BODY,
    })
    expect(res.statusCode).toBe(401)
    // The old path returned 401 and wrote nothing, so a forged webhook and one that
    // never arrived were indistinguishable afterwards.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].signatureOk).toBe(false)
    expect(recorded[0].status).toBe('failed')
    // An unverified body must not be allowed to name itself: the claimed delivery id
    // would occupy the unique slot and suppress the genuine delivery as a duplicate.
    expect(recorded[0].externalId).toBeNull()
    expect(recorded[0].lastError).toContain('signature rejected')
    // Nothing was handled.
    expect(handled).toHaveLength(0)
    await app.close()
  })
})

describe('duplicate deliveries', () => {
  it('short-circuits only a FINISHED event', async () => {
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'done' }
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toBe('Already processed')
    expect(handled).toHaveLength(0)
    await app.close()
  })

  it('handles a redelivery of an event that FAILED — that is the retry we asked for', async () => {
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'failed' }
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    expect(res.statusCode).toBe(200)
    // Shopify resends the same delivery id when we answered with a failure. Treating
    // that as "already processed" would drop it for good.
    expect(handled).toEqual(['555'])
    expect(completed[0].ok).toBe(true)
    await app.close()
  })
})

describe('when the ledger or the routing is unavailable', () => {
  it('does NOT ack a webhook it could not record', async () => {
    nextWrite = { id: null, duplicate: false }
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    // 200 would tell Shopify an unrecorded, unhandled event was dealt with.
    expect(res.statusCode).toBe(503)
    expect(handled).toHaveLength(0)
    await app.close()
  })

  it('falls back to the only connected shop when the domain matches no alias', async () => {
    routeThrowsFor = 'a-shop.myshopify.com'
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    // The channel-only lookup answers only when exactly one Shopify route exists, so
    // this recovers a connection saved before its domain was captured, and cannot
    // guess between two businesses.
    expect(res.statusCode).toBe(200)
    expect(handled).toEqual(['555'])
    await app.close()
  })

  it('records the event and refuses to ack when NO shop can be resolved', async () => {
    routeThrowsFor = '*'
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: PATH, headers: headers(), payload: BODY })
    expect(res.statusCode).toBe(503)
    // Verified, so it is genuinely Shopify's. It exists in the ledger even though
    // nothing could act on it.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].signatureOk).toBe(true)
    expect(recorded[0].status).toBe('failed')
    expect(recorded[0].lastError).toContain('no connected shop')
    expect(handled).toHaveLength(0)
    await app.close()
  })
})

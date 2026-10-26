/**
 * Shopify marketing consent (2026-10-26) at the Shopify receiver: the e-mail consent topic and customers/redact are
 * HMAC-verified like every Shopify topic, routed to their account and handed to the consent service; the replay registry
 * runs the same handlers; and a new Shopify order asks for its buyer's consent after the order work.
 *
 * The receiver and the handlers are the real code; the ledger, the claim, the routing, the app secret, the database and
 * the consent service are stood in (the service itself is proven on PGlite in
 * services/shopify/marketing-consent.service.vitest.test.ts). Made-up ids and addresses (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'

const SECRET = 'consent-receiver-test-secret'
const m = vi.hoisted(() => ({
  consent: vi.fn(async () => ({ written: 'created' })),
  redact: vi.fn(async () => 1),
  capture: vi.fn(async () => undefined),
  recorded: [] as any[],
}))

vi.mock('../services/shopify/marketing-consent.service.js', () => ({
  handleEmailConsentWebhook: m.consent,
  redactShopifyMarketingConsent: m.redact,
  captureBuyerConsentQuietly: m.capture,
}))
vi.mock('../services/cx/ingress/ledger.js', () => {
  class InboundDeferred extends Error {
    constructor(message: string, readonly delayMs: number) { super(message); this.name = 'InboundDeferred' }
  }
  return {
    InboundDeferred,
    recordInbound: vi.fn(async (rec: any) => { m.recorded.push(rec); return { id: `row-${m.recorded.length}`, duplicate: false } }),
    inboundNotRecorded: () => 'the inbound ledger is unavailable',
  }
})
vi.mock('../services/cx/ingress/claims.js', () => ({
  claimInbound: async (id: string) => {
    const rec = m.recorded.at(-1)
    return { id, token: `claim-${id}`, attempt: 1, payload: rec.payload, connectionId: rec.connectionId ?? null }
  },
  runWithInboundClaim: async (claim: any, work: any) => work(claim, new AbortController().signal),
}))
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: vi.fn(async () => ({ workspaceId: 'ws-1', connectionId: 'conn-1' })),
}))
vi.mock('../services/cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientSecret: SECRET }) }))
vi.mock('../services/shopify/schema-sync.service.js', () => ({ registerShopifySchemaWebhook: () => {} }))
vi.mock('../services/stock-level.service.js', () => ({
  reserveOpenOrder: vi.fn(async () => undefined), consumeOpenOrder: vi.fn(async () => 0),
  resolveLocationByCode: vi.fn(async () => null), unitsPerProduct: vi.fn(() => []),
}))
vi.mock('../services/stock-movement.service.js', () => ({ recascadeProduct: vi.fn(async () => ({ ok: true })) }))
vi.mock('../services/order-events.service.js', () => ({ publishOrderEvent: vi.fn() }))
vi.mock('../services/customer-cache.service.js', () => ({ linkAndRefreshCustomerForOrder: vi.fn(async () => undefined) }))
vi.mock('../services/shopify-locations.service.js', () => ({ resolveByShopifyId: vi.fn() }))
vi.mock('../services/shopify/content-webhook.service.js', () => ({ recordManagedContentChange: vi.fn(async () => false) }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, method: string) => async () => (model === 'order' && method === 'upsert' ? { id: 'order-1' } : null),
    }),
  }),
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn() } }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

const Fastify = (await import('fastify')).default
const webhooks = await import('./shopify-webhooks.js')
const { inboundHandlerFor } = await import('../services/cx/ingress/handlers.js')
const { SHOPIFY_TOPIC_REGISTRATIONS } = await import('../services/shopify/webhook-registration.service.js')
const { logger } = await import('../utils/logger.js')

const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64')
let delivery = 0
async function deliver(path: string, payload: Record<string, unknown>, signature?: string) {
  const app = Fastify()
  await app.register(webhooks.shopifyWebhookRoutes)
  const body = JSON.stringify(payload)
  try {
    return await app.inject({ method: 'POST', url: path, payload: body, headers: {
      'content-type': 'application/json', 'x-shopify-hmac-sha256': signature ?? sign(body), 'x-shopify-shop-domain': 'store-a.myshopify.com',
      'x-shopify-webhook-id': `delivery-${++delivery}`,
    } })
  } finally { await app.close() }
}

const CONSENT_PATH = '/webhooks/shopify/customers_email_marketing_consent/update'
const CONSENT = { customer_id: 7012345678901, email_address: 'buyer.one@example.com', email_marketing_consent: { state: 'subscribed', opt_in_level: null, consent_updated_at: '2026-10-20T08:00:00Z' } }
const REDACT = { shop_id: 954889, shop_domain: 'store-a.myshopify.com', customer: { id: 7012345678901, email: 'buyer.one@example.com', phone: '555-0100' }, orders_to_redact: [1] }

beforeEach(() => {
  vi.clearAllMocks()
  m.recorded.length = 0
})

describe('the e-mail consent topic at the receiver', () => {
  it('is registered on the path the receiver listens on, with the event type the replay registry knows', () => {
    const row = SHOPIFY_TOPIC_REGISTRATIONS.find((r) => r.topic === 'CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE')
    expect(row).toEqual({ topic: 'CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE', path: CONSENT_PATH, eventType: 'customers_email_marketing_consent/update' })
  })

  it('a signed delivery is recorded and handed to the consent service with its account', async () => {
    const response = await deliver(CONSENT_PATH, CONSENT)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true, written: 'created' })
    expect(m.recorded).toEqual([expect.objectContaining({ channel: 'SHOPIFY', eventType: 'customers_email_marketing_consent/update', signatureOk: true, connectionId: 'conn-1' })])
    expect(m.consent).toHaveBeenCalledWith(CONSENT, { connectionId: 'conn-1' })
  })

  it('a delivery with a wrong signature is refused and reaches nothing', async () => {
    const response = await deliver(CONSENT_PATH, CONSENT, sign('another body'))
    expect(response.statusCode).toBe(401)
    expect(m.consent).not.toHaveBeenCalled()
    expect(m.recorded).toEqual([expect.objectContaining({ signatureOk: false, status: 'failed' })])
  })

  it('the replay registry runs the same handler as the receiver', async () => {
    expect(await inboundHandlerFor('SHOPIFY', 'customers_email_marketing_consent/update')).toBe(webhooks.handleEmailMarketingConsentUpdate)
  })
})

describe('customers/redact deletes the consent row and still says other erasure is not automated', () => {
  it('a signed notice deletes through the consent service, on the account it routed to', async () => {
    const response = await deliver('/webhooks/shopify/customers/redact', REDACT)
    expect(response.statusCode).toBe(200)
    expect(m.redact).toHaveBeenCalledWith(REDACT, { connectionId: 'conn-1' })
    const line = vi.mocked(logger.error).mock.calls.find(([message]) => String(message).includes('customers/redact received'))
    expect(line?.[0]).toMatch(/marketing-consent row is deleted, other erasure is NOT automated/)
    expect(line?.[1]).toMatchObject({ consentRowsDeleted: 1, connectionId: 'conn-1' })
  })

  it('the replay registry runs the same handler; the other privacy topics are unchanged', async () => {
    expect(await inboundHandlerFor('SHOPIFY', 'customers/redact')).toBe(webhooks.handleCustomersRedact)
    await (await inboundHandlerFor('SHOPIFY', 'shop/redact'))!({ shop_domain: 'store-a.myshopify.com' })
    expect(m.redact).not.toHaveBeenCalled()
  })
})

describe("a new Shopify order asks for its buyer's consent, after the order work", () => {
  it('handleOrderCreate hands the order and its account to the consent capture', async () => {
    const order = { id: 820001, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', financial_status: 'paid', fulfillment_status: null,
      total_price: '20', currency: 'EUR', email: 'buyer.one@example.com', customer: { id: 7012345678901 }, line_items: [] }
    await webhooks.handleOrderCreate(order as any, { connectionId: 'conn-1' })
    expect(m.capture).toHaveBeenCalledWith('conn-1', order)
  })
})

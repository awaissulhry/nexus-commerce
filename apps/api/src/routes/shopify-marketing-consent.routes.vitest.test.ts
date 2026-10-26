/**
 * The Shopify marketing consent backfill route: who may run it, what it takes, and how a refusal reaches the person.
 * The service is stood in (it is proven on PGlite in services/shopify/marketing-consent.service.vitest.test.ts).
 */
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const m = vi.hoisted(() => ({ backfill: vi.fn() }))
vi.mock('../services/shopify/marketing-consent.service.js', () => ({ backfillShopifyMarketingConsent: m.backfill }))
import shopifyMarketingConsentRoutes from './shopify-marketing-consent.routes.js'

const URL_A = '/api/shopify/marketing-consent/conn-shopify-a/backfill'
async function post(payload?: unknown) {
  const app = Fastify()
  await app.register(shopifyMarketingConsentRoutes, { prefix: '/api' })
  try { return await app.inject({ method: 'POST', url: URL_A, ...(payload === undefined ? {} : { payload: payload as any }) }) } finally { await app.close() }
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/shopify/marketing-consent/:accountId/backfill', () => {
  it('is for the people who manage channel connections, as Shopify order import', () => {
    expect(permissionForRoute('POST', '/api/shopify/marketing-consent/:accountId/backfill')).toBe('settings.integrations.manage')
    expect(permissionForRoute('POST', '/api/shopify/order-import/:accountId/start')).toBe('settings.integrations.manage')
  })

  it('runs the backfill for the account named, from the start or from `after`, and answers its counts', async () => {
    m.backfill.mockResolvedValue({ accountId: 'conn-shopify-a', created: 2, complete: true, resumeAfter: null })
    const fresh = await post()
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json()).toEqual({ ok: true, backfill: { accountId: 'conn-shopify-a', created: 2, complete: true, resumeAfter: null } })
    expect(m.backfill).toHaveBeenLastCalledWith('conn-shopify-a', { after: null })
    await post({ after: 'cursor-2' })
    expect(m.backfill).toHaveBeenLastCalledWith('conn-shopify-a', { after: 'cursor-2' })
  })

  it('refuses an `after` that is not text, before anything is read', async () => {
    const response = await post({ after: 42 })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, code: 'BAD_CURSOR' })
    expect(m.backfill).not.toHaveBeenCalled()
  })

  it("passes the service's refusal on with its status and words; anything else is a 500", async () => {
    m.backfill.mockRejectedValueOnce(Object.assign(new Error('This Shopify account has not granted read_customers.'), { code: 'SCOPE_MISSING', statusCode: 409 }))
    const refused = await post()
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ ok: false, code: 'SCOPE_MISSING', error: 'This Shopify account has not granted read_customers.' })
    m.backfill.mockRejectedValueOnce(new Error('boom'))
    const failed = await post()
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toMatchObject({ ok: false, code: 'SHOPIFY_CONSENT_BACKFILL_FAILED' })
  })
})

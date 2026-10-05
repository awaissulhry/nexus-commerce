/**
 * S1 (2026-09-26 review): the admin setup and test-notice routes obey the same arming gate as
 * the nightly reconcile. Before S1 the setup route ignored NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP.
 * eBay is stubbed at the gateway transport; no test reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn(), setup: vi.fn(), testNotice: vi.fn(), topics: vi.fn(), destinations: vi.fn(), subscriptions: vi.fn(), audit: vi.fn(), list: vi.fn(), findUnique: vi.fn() }))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { write: m.audit } }))
vi.mock('../services/cx/connectors/ebay/client.js', () => ({ ebayAppToken: m.token }))
// The third argument says whose token a call carries: null = the app-level transport, else that account's own.
vi.mock('../services/gateway/ebay.js', () => ({ ebayTransport: (connectionId: string | null) => (url: string, init: RequestInit) => m.transport(url, init, connectionId) }))
vi.mock('../services/cx/connectors/ebay/notifications.js', async original => {
  const actual = await original<Record<string, any>>()
  m.setup.mockImplementation(actual.setupEbayNotifications)
  m.testNotice.mockImplementation(actual.sendEbayTestNotice)
  // The status route reads these three with Promise.all. Concurrent first dynamic imports of a
  // mocked module can load the real one under vitest, so the status tests stub the readers.
  return { ...actual, setupEbayNotifications: m.setup, sendEbayTestNotice: m.testNotice,
    getEbayTopics: m.topics, getEbayDestinations: m.destinations, getEbaySubscriptions: m.subscriptions }
})
vi.mock('../services/cx/ingress/ebay-admission.js', () => ({ receiveEbayNotice: vi.fn(), EbayAdmissionError: class extends Error {} }))
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: m.list, isOwnConnection: () => true }))
vi.mock('../db.js', () => ({ default: { channelConnection: { findUnique: m.findUnique } } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const API = 'https://api.ebay.com/commerce/notification/v1'
const endpoint = 'https://example.test/api/webhooks/ebay-notification'
const verificationToken = 'AZaz09_-'.repeat(4)

async function call(method: 'GET' | 'POST', url: string) {
  const Fastify = (await import('fastify')).default
  const routes = (await import('./ebay-notification.routes.js')).default
  const app = Fastify()
  app.addHook('onRequest', async request => { (request as any).authUser = { id: 'user-fixture' } })
  await app.register(routes as any, { prefix: '/api' })
  try {
    const res = await app.inject({ method, url })
    return { statusCode: res.statusCode, body: res.json() as Record<string, any>, raw: res.body }
  } finally { await app.close() }
}

beforeEach(() => {
  m.transport.mockReset(); m.token.mockReset(); m.setup.mockClear(); m.testNotice.mockClear(); m.audit.mockReset().mockResolvedValue(undefined)
  m.list.mockReset().mockResolvedValue([]); m.findUnique.mockReset()
  for (const reader of [m.topics, m.destinations, m.subscriptions]) reader.mockReset().mockRejectedValue(new Error('status reader not stubbed'))
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', endpoint)
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', verificationToken)
  vi.stubEnv('EBAY_NOTIFICATION_ALERT_EMAIL', 'alerts-fixture@example.test')
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', undefined)
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', undefined)
  m.token.mockResolvedValue('fixture-app-token')
  m.transport.mockRejectedValue(new Error('No eBay call is allowed in this test'))
})
afterEach(() => vi.unstubAllEnvs())

const unarmed: Array<[string, string | undefined, string | undefined]> = [
  ['nothing set', undefined, undefined],
  ['the old switch alone (stale environment)', '1', undefined],
  ['the old switch with a portal topic', '1', 'MARKETPLACE_ACCOUNT_DELETION'],
  ['the topic list without the old switch', undefined, 'AUTHORIZATION_REVOCATION'],
  ['the old switch set to 0', '0', 'AUTHORIZATION_REVOCATION'],
]

describe('POST /api/admin/setup-ebay-notifications', () => {
  it.each(unarmed)('answers 403 and makes no call when unarmed: %s', async (_label, setup, armed) => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', setup)
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', armed)
    const res = await call('POST', '/api/admin/setup-ebay-notifications')
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, armed: false, error: expect.stringMatching(/not armed/i) })
    expect(m.audit).toHaveBeenCalledOnce()
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-fixture', entityType: 'EbayNotificationSetup', entityId: 'ebay-notifications:production', action: 'ebay.notification.setup',
      metadata: expect.objectContaining({ outcome: 'refused_not_armed', topics: [] }),
    }))
    expect(m.setup).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('positive control: armed, it runs the setup and reaches the stubbed transport', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
    m.transport.mockResolvedValueOnce(new Response('{"errors":[{"errorId":195000}]}', { status: 500 }))
    const res = await call('POST', '/api/admin/setup-ebay-notifications')
    expect(m.setup).toHaveBeenCalledOnce()
    expect(m.transport).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: false, armed: true, error: expect.stringContaining('500') })
    expect(m.audit).toHaveBeenCalledOnce()
    const row = m.audit.mock.calls[0][0]
    expect(row).toMatchObject({ userId: 'user-fixture', action: 'ebay.notification.setup',
      metadata: { outcome: 'failed', topics: ['AUTHORIZATION_REVOCATION'], error: expect.stringContaining('500') } })
    expect(JSON.stringify(row)).not.toContain(verificationToken)
  })
})

const S = 'https://api.ebay.com/oauth/api_scope'
const sellerAccount = (grantedScopes = [`${S}/sell.fulfillment`, `${S}/commerce.notification.subscription`]) =>
  ({ id: 'conn-a', channelType: 'EBAY', isActive: true, authStatus: 'connected', grantedScopes })
const orderTopic = { topicId: 'ORDER_CONFIRMATION', scope: 'USER', supportedPayloads: [{ format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }] }

describe('POST /api/admin/setup-ebay-notifications — GAP2 phase 2, ORDER_CONFIRMATION armed', () => {
  it("creates the destination with the app token, then subscribes this business's account with ITS OWN sign-in", async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'ORDER_CONFIRMATION')
    m.list.mockResolvedValue([{ id: 'conn-a', ebaySignInName: 'seller_a' }])
    m.findUnique.mockResolvedValue(sellerAccount())
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    const created = (resource: string, id: string) => new Response(null, { status: 201, headers: { Location: `${API}/${resource}/${id}` } })
    m.transport.mockImplementation(async (url: string, request: RequestInit, connectionId: string | null) => {
      const method = request.method ?? 'GET'
      if (connectionId === null) {
        if (method === 'GET' && url === `${API}/topic?limit=100`) return json({ topics: [orderTopic] })
        if (method === 'GET' && url === `${API}/destination?limit=100`) return json({ destinations: [] })
        if (method === 'GET' && url === `${API}/config`) return json({ alertEmail: 'alerts-fixture@example.test' })
        if (method === 'POST' && url === `${API}/destination`) return created('destination', 'd-new')
      } else if (connectionId === 'conn-a') {
        if (method === 'GET' && url === `${API}/subscription?limit=100`) return json({ subscriptions: [] })
        if (method === 'POST' && url === `${API}/subscription`) return created('subscription', 'sub-a')
      }
      throw new Error(`Unexpected ${method} ${url} as ${connectionId}`)
    })
    const res = await call('POST', '/api/admin/setup-ebay-notifications')
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true, armed: true, destinationId: 'd-new', perTopic: [],
      sellers: { accounts: [{ connectionId: 'conn-a', signInName: 'seller_a', topicId: 'ORDER_CONFIRMATION', status: 'created', subscriptionId: 'sub-a' }] } })
    // Every subscription call went as the seller's own account, never as the app.
    const subscriptionCalls = m.transport.mock.calls.filter(([url]) => String(url).includes('/subscription'))
    expect(subscriptionCalls.map(([, request, connectionId]) => [request.method, connectionId])).toEqual([['GET', 'conn-a'], ['POST', 'conn-a']])
    for (const [, request] of subscriptionCalls) expect(JSON.stringify(request.headers)).not.toMatch(/authorization/i)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ebay.notification.setup',
      metadata: expect.objectContaining({ outcome: 'succeeded', topics: ['ORDER_CONFIRMATION'], perSeller: [{ connectionId: 'conn-a', status: 'created' }] }) }))
  })

  it('reports an account whose sign-in lacks the permission as reconnect needed, with no seller call', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'ORDER_CONFIRMATION')
    m.list.mockResolvedValue([{ id: 'conn-a', ebaySignInName: 'seller_a' }])
    m.findUnique.mockResolvedValue(sellerAccount([`${S}/sell.fulfillment`]))
    m.transport.mockImplementation(async (url: string, request: RequestInit, connectionId: string | null) => {
      if (connectionId !== null) throw new Error('No seller call is allowed for an account that needs Reconnect')
      if (url === `${API}/topic?limit=100`) return new Response(JSON.stringify({ topics: [orderTopic] }), { status: 200 })
      if (url === `${API}/destination?limit=100`) return new Response(JSON.stringify({ destinations: [{ destinationId: 'd-1', status: 'ENABLED', deliveryConfig: { endpoint } }] }), { status: 200 })
      if (url === `${API}/config`) return new Response(JSON.stringify({ alertEmail: 'alerts-fixture@example.test' }), { status: 200 })
      throw new Error(`Unexpected ${request.method} ${url}`)
    })
    const res = await call('POST', '/api/admin/setup-ebay-notifications')
    expect(res.body).toMatchObject({ ok: true, sellers: { accounts: [{ connectionId: 'conn-a', status: 'reconnect_needed' }] } })
    expect(m.transport.mock.calls.every(([, , connectionId]) => connectionId === null)).toBe(true)
  })
})

describe('POST /api/admin/ebay-notification-test', () => {
  it.each(unarmed)('answers 403 and makes no call when unarmed: %s', async (_label, setup, armed) => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', setup)
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', armed)
    const res = await call('POST', '/api/admin/ebay-notification-test?topicId=AUTHORIZATION_REVOCATION')
    expect(res.statusCode).toBe(403)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-fixture', action: 'ebay.notification.test',
      metadata: expect.objectContaining({ outcome: 'refused_not_armed', topics: ['AUTHORIZATION_REVOCATION'] }) }))
    expect(m.testNotice).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it.each([undefined, 'ORDER_CONFIRMATION', 'MARKETPLACE_ACCOUNT_DELETION'])('answers 400 for a topic that is not armed: %s', async topicId => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
    const res = await call('POST', `/api/admin/ebay-notification-test${topicId ? `?topicId=${topicId}` : ''}`)
    expect(res.statusCode).toBe(400)
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ebay.notification.test',
      metadata: expect.objectContaining({ outcome: 'refused_topic_not_armed', topics: topicId ? [topicId] : [] }) }))
    expect(m.testNotice).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('positive control: armed, it asks eBay to test our revocation subscription', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    m.transport.mockImplementation(async (url: string, request: RequestInit) => {
      if (url === `${API}/destination?limit=100`) return json({ destinations: [{ destinationId: 'd-1', status: 'ENABLED', deliveryConfig: { endpoint } }] })
      if (url === `${API}/subscription?limit=100`) return json({ subscriptions: [{ subscriptionId: 's-1', topicId: 'AUTHORIZATION_REVOCATION', destinationId: 'd-1', status: 'ENABLED' }] })
      if (request.method === 'POST' && url === `${API}/subscription/s-1/test`) return new Response(null, { status: 202 })
      throw new Error(`Unexpected ${request.method} ${url}`)
    })
    const res = await call('POST', '/api/admin/ebay-notification-test?topicId=AUTHORIZATION_REVOCATION')
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, topicId: 'AUTHORIZATION_REVOCATION', subscriptionId: 's-1' })
    expect(m.audit).toHaveBeenCalledOnce()
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-fixture', action: 'ebay.notification.test',
      metadata: expect.objectContaining({ outcome: 'sent', topics: ['AUTHORIZATION_REVOCATION'], subscriptionId: 's-1' }) }))
  })
})

describe('GET /api/admin/ebay-notification-status', () => {
  it('reports the arming gate and the local token check even when eBay cannot be read', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    m.topics.mockRejectedValue(new Error('eBay topics returned 500'))
    m.destinations.mockResolvedValue([]); m.subscriptions.mockResolvedValue([])
    const res = await call('GET', '/api/admin/ebay-notification-status')
    expect(res.statusCode).toBe(500)
    expect(res.body.configured).toEqual({ hasEndpoint: true, hasVerificationToken: true, verificationTokenValid: true, hasAlertEmail: true })
    expect(res.body.setupGate).toMatchObject({ armed: false, topics: [], reason: expect.stringContaining('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS') })
    expect(res.raw).not.toContain(verificationToken)
  })

  it.each([
    ['before arming, an account without the permission', undefined, [`${S}/sell.fulfillment`], 'reconnect_needed'],
    ['before arming, a ready account', undefined, undefined, 'not_armed'],
    ['armed for revocation only, a ready account', 'AUTHORIZATION_REVOCATION', undefined, 'not_armed'],
  ])('lists each eBay account of this business: %s', async (_label, armed, scopes, status) => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', armed)
    m.topics.mockResolvedValue([orderTopic]); m.destinations.mockResolvedValue([]); m.subscriptions.mockResolvedValue([])
    m.list.mockResolvedValue([{ id: 'conn-a', ebaySignInName: 'seller_a', externalAccountId: 'ebay-user-fixture' }])
    m.findUnique.mockResolvedValue(sellerAccount(scopes))
    const res = await call('GET', '/api/admin/ebay-notification-status')
    expect(res.statusCode).toBe(200)
    expect(res.body.sellers).toEqual({ topicId: 'ORDER_CONFIRMATION', armed: false, accounts: [{ connectionId: 'conn-a', signInName: 'seller_a', status, reason: expect.any(String) }] })
    expect(res.raw).not.toContain('ebay-user-fixture')
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('reports deletion as portal-only and the order topic as per-seller', async () => {
    m.topics.mockResolvedValue([{ topicId: 'AUTHORIZATION_REVOCATION', scope: 'APPLICATION' }])
    m.destinations.mockResolvedValue([]); m.subscriptions.mockResolvedValue([])
    const res = await call('GET', '/api/admin/ebay-notification-status')
    expect(res.statusCode).toBe(200)
    const delivery = Object.fromEntries(res.body.wanted.map((w: any) => [w.topicId, w.delivery]))
    expect(delivery).toEqual({ MARKETPLACE_ACCOUNT_DELETION: 'portal', AUTHORIZATION_REVOCATION: 'application', ORDER_CONFIRMATION: 'user' })
    expect(m.transport).not.toHaveBeenCalled()
  })
})

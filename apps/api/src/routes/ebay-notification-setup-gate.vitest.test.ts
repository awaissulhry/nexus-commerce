/**
 * S1 (2026-09-26 review): the admin setup and test-notice routes obey the same arming gate as
 * the nightly reconcile. Before S1 the setup route ignored NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP.
 * eBay is stubbed at the gateway transport; no test reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn(), setup: vi.fn(), testNotice: vi.fn(), topics: vi.fn(), destinations: vi.fn(), subscriptions: vi.fn(), audit: vi.fn() }))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { write: m.audit } }))
vi.mock('../services/cx/connectors/ebay/client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../services/gateway/ebay.js', () => ({ ebayTransport: () => m.transport }))
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
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: async () => [] }))
vi.mock('../db.js', () => ({ default: {} }))
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
  ['the old switch with a USER topic', '1', 'ORDER_CONFIRMATION'],
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

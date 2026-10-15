/**
 * The Shopify order import switch per account: GET its state, POST /start to record the start date (once) and
 * register the order webhooks. The route and the start service are the real code; the account lookup, the start-date
 * store and the registration are stood in, so the order of what happens is visible.
 */
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { FEATURES } from '@nexus/shared/permissions'

const FLAG = 'NEXUS_ENABLE_SHOPIFY_ORDER_INGEST'
const SINCE = new Date('2026-10-15T10:00:00.000Z')
const m = vi.hoisted(() => ({ steps: [] as string[], connection: vi.fn(), start: vi.fn(), record: vi.fn(), register: vi.fn() }))

vi.mock('../services/connection-resolver.service.js', () => {
  class NoConnectionError extends Error {}
  return { NoConnectionError, resolveConnection: async (scope: { accountId: string }) => { m.steps.push('account'); return m.connection(scope) } }
})
vi.mock('../services/shopify/order-ingest-switch.js', async (original) => ({
  ...(await original<object>()),
  shopifyOrderIngestStart: async (id: string) => { m.steps.push('read start'); return m.start(id) },
  recordShopifyOrderIngestStart: async (id: string, by: string | null) => { m.steps.push('record start'); return m.record(id, by) },
}))
vi.mock('../services/shopify/webhook-registration.service.js', () => ({
  ensureShopifyWebhookSubscriptions: async (id: string) => { m.steps.push('register'); return m.register(id) },
}))

import routes from './shopify-order-import.routes.js'
const { NoConnectionError } = await import('../services/connection-resolver.service.js')

async function call(method: 'GET' | 'POST', url: string) {
  const app = Fastify()
  app.addHook('preHandler', async (request) => { (request as { authUser?: unknown }).authUser = { id: 'user-7' } })
  await app.register(routes, { prefix: '/api' })
  try { return await app.inject({ method, url }) } finally { await app.close() }
}

beforeEach(() => {
  m.steps.length = 0
  vi.clearAllMocks()
  vi.stubEnv(FLAG, '1')
  m.connection.mockResolvedValue({ id: 'acct-1', channelType: 'SHOPIFY', authStatus: 'connected' })
  m.start.mockResolvedValue(null)
  m.record.mockResolvedValue({ since: SINCE, by: 'user-7', newlyStarted: true })
  m.register.mockResolvedValue({ accountId: 'acct-1', live: true, perTopic: [{ topic: 'ORDERS_CREATE', status: 'created' }], leftInPlace: [] })
})
afterEach(() => vi.unstubAllEnvs())

it('is mapped to the integrations permission, both paths, any method', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    expect(permissionForRoute(method, '/api/shopify/order-import/:accountId')).toBe(FEATURES.settingsIntegrationsManage)
    expect(permissionForRoute(method, '/api/shopify/order-import/:accountId/start')).toBe(FEATURES.settingsIntegrationsManage)
  }
})

describe('POST /start', () => {
  it('records the start date for the signed-in person, then registers the order webhooks', async () => {
    const r = await call('POST', '/api/shopify/order-import/acct-1/start')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, start: {
      accountId: 'acct-1', switchOn: true, since: '2026-10-15T10:00:00.000Z', by: 'user-7', newlyStarted: true,
      registration: { accountId: 'acct-1', live: true, perTopic: [{ topic: 'ORDERS_CREATE', status: 'created' }], leftInPlace: [] },
    } })
    expect(m.steps).toEqual(['account', 'record start', 'register'])
    expect(m.record).toHaveBeenCalledWith('acct-1', 'user-7')
  })

  it('a second start keeps the first start date and says so', async () => {
    m.record.mockResolvedValue({ since: SINCE, by: 'user-1', newlyStarted: false })
    const r = await call('POST', '/api/shopify/order-import/acct-1/start')
    expect(r.json().start).toMatchObject({ since: '2026-10-15T10:00:00.000Z', by: 'user-1', newlyStarted: false })
  })

  it('switch off: 409, and nothing is read, recorded or registered', async () => {
    for (const value of ['', '0', 'true']) {
      vi.stubEnv(FLAG, value)
      const r = await call('POST', '/api/shopify/order-import/acct-1/start')
      expect(r.statusCode).toBe(409)
      expect(r.json()).toEqual({ ok: false, code: 'shopify_order_ingest_off', error: expect.stringContaining(FLAG) })
    }
    expect(m.steps).toEqual([])
  })

  it.each([
    ['not a Shopify account', { id: 'acct-1', channelType: 'EBAY', authStatus: 'connected' }, 400, 'NOT_SHOPIFY'],
    ['an account that must sign in again', { id: 'acct-1', channelType: 'SHOPIFY', authStatus: 'needs_reauth' }, 409, 'ACCOUNT_NEEDS_SIGNIN'],
  ])('%s: refused before any start date is recorded', async (_label, connection, status, code) => {
    m.connection.mockResolvedValue(connection)
    const r = await call('POST', '/api/shopify/order-import/acct-1/start')
    expect(r.statusCode).toBe(status)
    expect(r.json()).toMatchObject({ ok: false, code })
    expect(m.steps).toEqual(['account'])
  })

  it('an account not in this business: 404, nothing recorded', async () => {
    m.connection.mockRejectedValue(new NoConnectionError('ChannelConnection acct-x not found (explicit accountId).'))
    const r = await call('POST', '/api/shopify/order-import/acct-x/start')
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' })
    expect(m.steps).toEqual(['account'])
  })

  it('a registration that throws after the start date was recorded: 500, and running it again finishes it', async () => {
    m.register.mockRejectedValueOnce(new Error('Shopify refused the subscription read'))
    const r = await call('POST', '/api/shopify/order-import/acct-1/start')
    expect(r.statusCode).toBe(500)
    expect(r.json()).toEqual({ ok: false, code: 'SHOPIFY_ORDER_IMPORT_START_FAILED', error: 'Shopify refused the subscription read' })
    m.record.mockResolvedValue({ since: SINCE, by: 'user-7', newlyStarted: false })
    expect((await call('POST', '/api/shopify/order-import/acct-1/start')).statusCode).toBe(200)
  })
})

describe('GET (read only)', () => {
  it('the switch and the start date; nothing recorded, nothing registered', async () => {
    m.start.mockResolvedValue({ since: SINCE, by: 'user-1' })
    const r = await call('GET', '/api/shopify/order-import/acct-1')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, status: { accountId: 'acct-1', switchOn: true, since: '2026-10-15T10:00:00.000Z', by: 'user-1' } })
    expect(m.steps).toEqual(['account', 'read start'])
  })

  it('never started, switch off', async () => {
    vi.stubEnv(FLAG, '')
    const r = await call('GET', '/api/shopify/order-import/acct-1')
    expect(r.json()).toEqual({ ok: true, status: { accountId: 'acct-1', switchOn: false, since: null, by: null } })
  })
})

/**
 * Meta ads step 1 — the connection routes (meta-connection.routes.ts): each calls its service and maps its errors; the
 * connect body (app secret, token) is never answered back nor logged, also when Nexus itself fails; C3 answers 409
 * `taken_by_other_business` without naming the other business. Services stubbed; made-up ids only.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class MetaConnectError extends Error { constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message) } }
  class MetaSelectionError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string, readonly product: string | null = null) { super(message) } }
  class MetaConnectionNotFound extends Error {}
  return {
    MetaConnectError, MetaSelectionError, MetaConnectionNotFound,
    connect: vi.fn(async (_input: unknown) => ({ connectionId: 'conn-1', placement: 'new' }) as unknown),
    recheck: vi.fn(async (_id: string) => ({ isValid: true }) as unknown),
    list: vi.fn(async () => [] as unknown[]),
    choices: vi.fn(async () => ({ adAccounts: { items: [], error: null } }) as unknown),
    save: vi.fn(async () => ({ connection: { connectionId: 'conn-1' }, changed: true }) as unknown),
    logged: [] as unknown[],
  }
})
vi.mock('../services/cx/connectors/meta/connect.js', () => ({ connectMeta: h.connect, MetaConnectError: h.MetaConnectError, recheckMetaToken: h.recheck }))
vi.mock('../services/meta/meta-accounts.service.js', () => ({
  listMetaConnections: h.list, getMetaChoices: h.choices, metaChoicesAnswer: async (c: unknown) => c, saveMetaSelection: h.save,
  MetaConnectionNotFound: h.MetaConnectionNotFound, MetaSelectionError: h.MetaSelectionError,
}))
vi.mock('../utils/logger.js', () => ({ logger: { error: vi.fn((...a: unknown[]) => { h.logged.push(a) }), warn: vi.fn(), info: vi.fn() } }))

import metaConnectionRoutes from './meta-connection.routes.js'

let app: FastifyInstance
const SECRET = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
const TOKEN = 'fixture-system-user-token-000000'

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', async (request) => { (request as unknown as { authUser: unknown }).authUser = { id: 'user-1' } })
  await app.register(metaConnectionRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { h.logged.length = 0; vi.clearAllMocks() })

describe('connect and replace', () => {
  it('passes the body to the connect service with the signed-in person; replace names the connection', async () => {
    const body = { appId: '1234567', appSecret: SECRET, systemUserToken: TOKEN }
    expect((await app.inject({ method: 'POST', url: '/api/meta-ads/connect', payload: body })).statusCode).toBe(200)
    expect(h.connect).toHaveBeenLastCalledWith({ body, actor: { kind: 'operator', userId: 'user-1' } })
    await app.inject({ method: 'PUT', url: '/api/meta-ads/connections/conn-1/credentials', payload: body })
    expect(h.connect).toHaveBeenLastCalledWith({ body, targetConnectionId: 'conn-1', actor: { kind: 'operator', userId: 'user-1' } })
  })
  it('a refusal keeps its status, code and sentence', async () => {
    h.connect.mockRejectedValueOnce(new h.MetaConnectError('wrong_app', 'This token was made for another Meta app.', 409))
    const res = await app.inject({ method: 'POST', url: '/api/meta-ads/connect', payload: { appId: '1', appSecret: SECRET, systemUserToken: TOKEN } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'wrong_app', error: 'This token was made for another Meta app.' })
  })
  it('a fault of Nexus\'s own answers in words; neither the answer nor the log holds the secret or the token', async () => {
    h.connect.mockRejectedValueOnce(new Error('database down'))
    const res = await app.inject({ method: 'POST', url: '/api/meta-ads/connect', payload: { appId: '1', appSecret: SECRET, systemUserToken: TOKEN } })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain(SECRET)
    expect(res.body).not.toContain(TOKEN)
    expect(JSON.stringify(h.logged)).not.toContain(SECRET)
    expect(JSON.stringify(h.logged)).not.toContain(TOKEN)
  })
})

describe('health, choices and the choice', () => {
  it('lists the connections, checks a token, lists choices (refresh=1 forces) and saves a choice', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/meta-ads/connections' })).json()).toEqual({ items: [] })
    expect((await app.inject({ method: 'POST', url: '/api/meta-ads/connections/conn-1/token-check' })).json()).toEqual({ token: { isValid: true } })
    await app.inject({ method: 'GET', url: '/api/meta-ads/connections/conn-1/choices?refresh=1' })
    expect(h.choices).toHaveBeenLastCalledWith('conn-1', { force: true })
    const saved = await app.inject({ method: 'PUT', url: '/api/meta-ads/connections/conn-1/selection', payload: { adAccountId: '1234567890' } })
    expect(saved.json()).toEqual({ connection: { connectionId: 'conn-1' } })
    expect(h.save).toHaveBeenLastCalledWith('conn-1', { adAccountId: '1234567890' }, { userId: 'user-1' })
  })
  it('an id another business holds answers 409 taken_by_other_business; a foreign connection 404', async () => {
    h.save.mockRejectedValueOnce(new h.MetaSelectionError(409, 'taken_by_other_business', 'Another business in Nexus already reads this Meta ad account.', 'AD_ACCOUNT'))
    const res = await app.inject({ method: 'PUT', url: '/api/meta-ads/connections/conn-1/selection', payload: { adAccountId: '1234567890' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'taken_by_other_business', product: 'AD_ACCOUNT' })
    h.choices.mockRejectedValueOnce(new h.MetaConnectionNotFound('This Meta connection is not connected to this business.'))
    expect((await app.inject({ method: 'GET', url: '/api/meta-ads/connections/other/choices' })).statusCode).toBe(404)
  })
})

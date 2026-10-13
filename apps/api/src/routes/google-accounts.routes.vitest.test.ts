/**
 * Google Ads step 1a — the C1–C3 routes (google-accounts.routes.ts): each calls its service and maps its errors —
 * C2's `refresh=1` forces a new read from Google and its answer is awaited (it marks what another business picked), C3
 * answers 409 `{ code, error }` for a choice Google did not offer or another sign-in holds, 404 for a sign-in that is not
 * this business's, and a fault of Nexus's own in words without its internals. The person who saved the choice is the
 * signed-in user.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class GoogleSelectionError extends Error {
    constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
  }
  class GoogleConnectionNotFound extends Error {}
  return {
    GoogleSelectionError,
    GoogleConnectionNotFound,
    list: vi.fn(async () => [] as unknown[]),
    choices: vi.fn(async (_id: string, _options: unknown) => ({ missingProducts: [], ads: { customers: [], error: null }, merchantCenter: { accounts: [], error: null }, analytics: { properties: [], error: null } }) as unknown),
    save: vi.fn(async (_id: string, _body: unknown, _actor: unknown) => ({ account: { connectionId: 'g-1', state: 'first_read_pending' } }) as unknown),
  }
})
vi.mock('../services/google/google-accounts.service.js', () => ({
  GoogleSelectionError: h.GoogleSelectionError,
  GoogleConnectionNotFound: h.GoogleConnectionNotFound,
  listGoogleAccounts: h.list,
  getChoices: h.choices,
  // C2's answer adds what another business already picked, read from the database: it is async.
  choicesAnswer: async (choices: unknown) => ({ ...(choices as object), answered: true }),
  saveSelection: h.save,
}))

import googleAccountsRoutes from './google-accounts.routes.js'

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', async (request) => { (request as unknown as { authUser: unknown }).authUser = { id: 'user-1' } })
  await app.register(googleAccountsRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close() })
beforeEach(() => { h.list.mockClear(); h.choices.mockClear(); h.save.mockClear() })

describe('C1 GET /api/google-ads/connections', () => {
  it('answers { items }', async () => {
    h.list.mockResolvedValueOnce([{ connectionId: 'g-1', state: 'choose_account' }])
    const res = await app.inject({ method: 'GET', url: '/api/google-ads/connections' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [{ connectionId: 'g-1', state: 'choose_account' }] })
  })

  it('a fault of Nexus\'s own: 500 in words, never its internals', async () => {
    h.list.mockRejectedValueOnce(new Error('relation "GoogleAccountLink" does not exist'))
    const res = await app.inject({ method: 'GET', url: '/api/google-ads/connections' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Nexus could not load the Google sign-ins. Try again in a minute.' })
  })
})

describe('C2 GET /api/google-ads/connections/:id/choices', () => {
  it('kept answers by default; refresh=1 asks Google again', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/google-ads/connections/g-1/choices' })
    expect(res.statusCode).toBe(200)
    // The awaited answer (with the marks of what another business picked), never an unresolved promise.
    expect(res.json()).toMatchObject({ answered: true, ads: { customers: [] } })
    expect(h.choices).toHaveBeenLastCalledWith('g-1', { force: false })
    await app.inject({ method: 'GET', url: '/api/google-ads/connections/g-1/choices?refresh=1' })
    expect(h.choices).toHaveBeenLastCalledWith('g-1', { force: true })
  })

  it('a sign-in that is not this business\'s: 404', async () => {
    h.choices.mockRejectedValueOnce(new h.GoogleConnectionNotFound('no'))
    const res = await app.inject({ method: 'GET', url: '/api/google-ads/connections/other/choices' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'not_found', error: 'This Google sign-in is not connected to this business.' })
  })
})

describe('C3 PUT /api/google-ads/connections/:id/selection', () => {
  const body = { adsCustomerId: '1234567890', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }

  it('saves as the signed-in person and answers { account }', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/google-ads/connections/g-1/selection', payload: body })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ account: { connectionId: 'g-1', state: 'first_read_pending' } })
    expect(h.save).toHaveBeenCalledWith('g-1', body, { userId: 'user-1' })
  })

  it.each([
    [409, 'not_offered', 'Google does not offer this Google Ads account to this sign-in. Reload the list and choose again.'],
    [409, 'customer_taken', 'This business already reads a Google Ads account through another Google sign-in.'],
    [400, 'invalid', 'Choose the Google Ads account Nexus reads.'],
    [404, 'not_found', 'This Google sign-in is not connected to this business.'],
  ])('a refused choice: %i %s, in words', async (status, code, error) => {
    h.save.mockRejectedValueOnce(new h.GoogleSelectionError(status, code, error))
    const res = await app.inject({ method: 'PUT', url: '/api/google-ads/connections/g-1/selection', payload: body })
    expect(res.statusCode).toBe(status)
    expect(res.json()).toEqual({ code, error })
  })
})

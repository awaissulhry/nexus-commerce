/**
 * CX.0 (S4) — the Amazon Ads LWA callback must reject any request whose
 * `state` was not minted by this server, and must always send the PKCE
 * verifier. Before CX.0 the callback exchanged any `code` it was handed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../db.js', () => ({ default: {} }))

process.env.AMAZON_ADS_CLIENT_ID = 'test-client-id'
process.env.AMAZON_ADS_CLIENT_SECRET = 'test-client-secret'
process.env.AMAZON_ADS_REDIRECT_URI = 'https://example.test/api/amazon-ads/auth/callback'

let app: FastifyInstance
const exchanges: URLSearchParams[] = []

beforeAll(async () => {
  // Capture the LWA token exchange instead of calling Amazon.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    exchanges.push(new URLSearchParams(String(init?.body ?? '')))
    return new Response('{"error":"stubbed"}', { status: 500 })
  }))
  const { default: routes } = await import('./amazon-ads-auth.routes.js')
  app = Fastify()
  await app.register(routes, { prefix: '/api' })
})

afterAll(async () => {
  await app.close()
  vi.unstubAllGlobals()
})

describe('GET /api/amazon-ads/auth/callback', () => {
  it('rejects a callback without state before any exchange', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/amazon-ads/auth/callback?code=abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing_state' })
    expect(exchanges).toHaveLength(0)
  })

  it('rejects an unknown state before any exchange', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/amazon-ads/auth/callback?code=abc&state=not-ours' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_state' })
    expect(exchanges).toHaveLength(0)
  })

  it('accepts a state minted by /connect exactly once and sends the PKCE verifier', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/amazon-ads/auth/connect' })
    expect(start.statusCode).toBe(302)
    const location = new URL(start.headers.location as string)
    const state = location.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')

    const first = await app.inject({ method: 'GET', url: `/api/amazon-ads/auth/callback?code=abc&state=${state}` })
    // The stubbed exchange fails, but the exchange was ATTEMPTED with a verifier.
    expect(first.statusCode).not.toBe(400)
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].get('grant_type')).toBe('authorization_code')
    expect(exchanges[0].get('code_verifier')).toBeTruthy()

    // Replay of the same state is refused (one-time use).
    const replay = await app.inject({ method: 'GET', url: `/api/amazon-ads/auth/callback?code=abc&state=${state}` })
    expect(replay.statusCode).toBe(400)
    expect(replay.json()).toEqual({ error: 'invalid_state' })
    expect(exchanges).toHaveLength(1)
  })
})

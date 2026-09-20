/**
 * P6.1 — the app-level (grantless) token uses the secret stored in ChannelApp — the one rotation
 * replaces — and never the env copy, which a rotation cannot update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ secret: 'stored-secret-1', bodies: [] as string[] }))
vi.mock('../services/cx/apps.service.js', () => ({
  getChannelApp: vi.fn(async () => ({ channelKey: 'AMAZON_SP', environment: 'production', clientId: 'stored-client', clientSecret: h.secret, redirectUris: [], extra: {}, signingKey: null })),
}))

import { AmazonSpApiClient } from './amazon-sp-api.client.js'

beforeEach(() => {
  vi.stubEnv('AMAZON_LWA_CLIENT_ID', 'env-client')
  vi.stubEnv('AMAZON_LWA_CLIENT_SECRET', 'env-secret-STALE')
  h.bodies = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    h.bodies.push(String(init.body))
    return new Response(JSON.stringify({ access_token: 'grantless', expires_in: 3600 }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P6.1 — grantless tokens read the stored (rotating) secret', () => {
  it('sends the ChannelApp id and secret, not the env copy', async () => {
    await new AmazonSpApiClient().getGrantlessToken('sellingpartnerapi::notifications')
    const form = new URLSearchParams(h.bodies[0])
    expect(form.get('client_id')).toBe('stored-client')
    expect(form.get('client_secret')).toBe('stored-secret-1')
    expect(h.bodies[0]).not.toContain('env-secret-STALE')
  })
  it('after a rotation stores a new secret, the next exchange uses it', async () => {
    h.secret = 'stored-secret-2'
    await new AmazonSpApiClient().getGrantlessToken('sellingpartnerapi::notifications')
    expect(new URLSearchParams(h.bodies[0]).get('client_secret')).toBe('stored-secret-2')
  })
})

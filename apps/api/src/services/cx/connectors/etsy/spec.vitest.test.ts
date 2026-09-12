import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '../../catalog.js'

const mocks = vi.hoisted(() => ({
  getChannelApp: vi.fn(async () => ({
    channelKey: 'ETSY' as const,
    environment: 'production' as const,
    clientId: 'etsy-keystring',
    clientSecret: 'etsy-shared-secret',
    redirectUris: [],
    extra: {},
    signingKey: null,
  })),
}))

vi.mock('../../apps.service.js', () => ({ getChannelApp: mocks.getChannelApp }))

const { ETSY_REQUIRED_SCOPES, etsySpec } = await import('./spec.js')

const grantedScopes = [...ETSY_REQUIRED_SCOPES]
const handle = (identity: ConnectionHandle['identity'] = null): ConnectionHandle => ({
  id: 'etsy-connection',
  channelKey: 'ETSY',
  channelType: 'ETSY',
  region: null,
  grantedScopes,
  identity,
  token: async () => 'etsy-access-token',
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  mocks.getChannelApp.mockResolvedValue({
    channelKey: 'ETSY',
    environment: 'production',
    clientId: 'etsy-keystring',
    clientSecret: 'etsy-shared-secret',
    redirectUris: [],
    extra: {},
    signingKey: null,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function successfulAccountLookup(): void {
  fetchMock
    .mockResolvedValueOnce(json({ user_id: 101, shop_id: 202 }))
    .mockResolvedValueOnce(json({
      user_id: 101,
      shop_id: 202,
      shop_name: 'Studio Ceramica',
      login_name: 'studio-owner',
      currency_code: 'EUR',
      shop_location_country_iso: 'IT',
    }))
}

describe('Etsy connector contract', () => {
  it('is live and requests exactly Etsy’s 12 currently published scopes', () => {
    expect(etsySpec.available).toBe(true)
    expect(ETSY_REQUIRED_SCOPES).toEqual([
      'address_r', 'address_w', 'email_r', 'listings_d', 'listings_r', 'listings_w',
      'profile_r', 'profile_w', 'shops_r', 'shops_w', 'transactions_r', 'transactions_w',
    ])
    expect(ETSY_REQUIRED_SCOPES).not.toEqual(expect.arrayContaining([
      'billing_r', 'cart_r', 'cart_w', 'favorites_r', 'favorites_w', 'feedback_r', 'recommend_r', 'recommend_w',
    ]))
  })

  it('pins PKCE, refresh rotation, token lifetimes, and secret-free OAuth requests', () => {
    expect(etsySpec.auth.mode).toBe('oauth2_pkce')
    expect(etsySpec.auth.pkce).toBe(true)
    expect(etsySpec.auth.identityRequired).toBe(true)
    expect(etsySpec.auth.refreshTokenRequired).toBe(true)
    expect(etsySpec.auth.rotatesRefreshToken).toBe(true)
    expect(etsySpec.auth.accessTokenLifetimeSec).toBe(3600)
    expect(etsySpec.auth.refreshTokenLifetimeSec).toBe(90 * 86_400)
    expect(etsySpec.auth.includeClientSecretInTokenRequest).toBe(false)
    expect(etsySpec.auth.authorizeUrl?.({ region: null, environment: 'production' })).toBe('https://www.etsy.com/oauth/connect')
    expect(etsySpec.auth.tokenUrl({ region: null, environment: 'production' })).toBe('https://api.etsy.com/v3/public/oauth/token')
    expect(etsySpec.sandbox.available).toBe(false)
  })
})

describe('Etsy identity and heartbeat', () => {
  it('verifies /users/me against the shop and sends the required 2026 API-key header', async () => {
    successfulAccountLookup()
    await expect(etsySpec.identity(handle())).resolves.toEqual({
      userId: '101',
      username: 'studio-owner',
      storeName: 'Studio Ceramica',
      storeUrl: 'https://www.etsy.com/shop/Studio%20Ceramica',
      extra: { shopId: '202', shopName: 'Studio Ceramica', currencyCode: 'EUR', countryCode: 'IT' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [selfUrl, selfInit] = fetchMock.mock.calls[0]
    expect(selfUrl).toBe('https://api.etsy.com/v3/application/users/me')
    expect(selfInit.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer etsy-access-token',
      'x-api-key': 'etsy-keystring:etsy-shared-secret',
    })
    const [shopUrl, shopInit] = fetchMock.mock.calls[1]
    expect(shopUrl).toBe('https://api.etsy.com/v3/application/shops/202')
    expect(shopInit.headers).toMatchObject({ Accept: 'application/json', 'x-api-key': 'etsy-keystring:etsy-shared-secret' })
    expect(shopInit.headers).not.toHaveProperty('Authorization')
  })

  it('returns a healthy account without pretending cached scopes were introspected', async () => {
    successfulAccountLookup()
    const result = await etsySpec.heartbeat(handle())
    expect(result).toMatchObject({
      ok: true,
      identity: { userId: '101', storeName: 'Studio Ceramica' },
    })
    expect(result).not.toHaveProperty('scopes')
  })

  it('classifies revoked access and does not continue to the shop request', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_token' }, 401))
    await expect(etsySpec.heartbeat(handle())).resolves.toMatchObject({ ok: false, status: 401, errorClass: 'auth_revoked' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched shop identity instead of attaching the grant to the wrong account', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ user_id: 101, shop_id: 202 }))
      .mockResolvedValueOnce(json({ user_id: 999, shop_id: 202, shop_name: 'Wrong Shop' }))
    await expect(etsySpec.identity(handle())).resolves.toBeNull()
  })

  it('reports incomplete Seller App credentials as configuration, before a network request', async () => {
    mocks.getChannelApp.mockResolvedValueOnce({
      channelKey: 'ETSY',
      environment: 'production',
      clientId: 'etsy-keystring',
      clientSecret: '',
      redirectUris: [],
      extra: {},
      signingKey: null,
    })
    await expect(etsySpec.heartbeat(handle())).resolves.toMatchObject({ ok: false, errorClass: 'configuration' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Etsy shop scope and quota telemetry', () => {
  it('persists the verified shop as the connection scope', async () => {
    await expect(etsySpec.discoverScopes?.(handle({
      userId: '101',
      storeName: 'Studio Ceramica',
      storeUrl: 'https://www.etsy.com/shop/StudioCeramica',
      extra: { shopId: '202' },
    }))).resolves.toEqual([{
      kind: 'shop',
      externalId: '202',
      label: 'Studio Ceramica',
      metadata: { storeUrl: 'https://www.etsy.com/shop/StudioCeramica' },
    }])
  })

  it('parses daily quota headers and provides a safe retry fallback', () => {
    expect(etsySpec.rateLimit.parse(new Headers({ 'x-remaining-today': '48', 'x-limit-per-day': '100' }), 200))
      .toEqual({ model: 'daily_quota', remaining: 48, limit: 100, retryAfterSec: undefined })
    expect(etsySpec.rateLimit.parse(new Headers({ 'retry-after': 'not-a-number' }), 429))
      .toEqual({ model: 'daily_quota', remaining: undefined, limit: undefined, retryAfterSec: 1 })
  })
})

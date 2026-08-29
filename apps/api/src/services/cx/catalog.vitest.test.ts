/**
 * CX.1 — the ChannelCatalog: registry round-trip, channelType ↔ key mapping,
 * scope drift (required − granted, with eBay's manage⇒readonly and Shopify's
 * write_⇒read_ implications) and the shared OAuth error classifier.
 *
 * Pure module: no prisma, no fetch, nothing registered unless this file does it.
 */
import { describe, it, expect } from 'vitest'
import {
  CHANNEL_TYPE_OF,
  channelKeyOf,
  classifyAuthError,
  getChannelSpec,
  listChannelSpecs,
  registerChannel,
  scopeDriftOf,
  tryGetChannelSpec,
  type ChannelSpec,
} from './catalog.js'

function fakeSpec(overrides: Partial<ChannelSpec> & { requiredScopes?: string[] } = {}): ChannelSpec {
  const { requiredScopes = ['a', 'b', 'c'], ...rest } = overrides
  return {
    key: 'SHOPIFY',
    channelType: 'SHOPIFY',
    displayName: 'Fake',
    available: false,
    auth: {
      mode: 'oauth2_code',
      tokenUrl: () => 'https://token.example.test/oauth/token',
      tokenRequestAuth: 'body',
      scopeSeparator: ' ',
      codeParamInCallback: 'code',
      pkce: false,
      requiredScopes,
      rotatesRefreshToken: false,
    },
    identity: async () => null,
    heartbeat: async () => ({ ok: true, latencyMs: 0 }),
    rateLimit: { parse: () => null, model: 'token_bucket' },
    webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] },
    apiVersion: 'test',
    sandbox: { available: false },
    ...rest,
  }
}

describe('registry', () => {
  it('getChannelSpec throws for a key nothing has registered', () => {
    expect(tryGetChannelSpec('ETSY')).toBeNull()
    expect(() => getChannelSpec('ETSY')).toThrow(/No ChannelSpec registered for ETSY/)
  })

  it('registerChannel → getChannelSpec / tryGetChannelSpec / listChannelSpecs round-trip', () => {
    const spec = fakeSpec({ key: 'SHOPIFY', channelType: 'SHOPIFY' })
    registerChannel(spec)
    expect(getChannelSpec('SHOPIFY')).toBe(spec)
    expect(tryGetChannelSpec('SHOPIFY')).toBe(spec)
    expect(listChannelSpecs()).toContain(spec)
  })

  it('re-registering a key replaces the previous entry (last write wins)', () => {
    const first = fakeSpec({ key: 'ETSY', channelType: 'ETSY', displayName: 'first' })
    const second = fakeSpec({ key: 'ETSY', channelType: 'ETSY', displayName: 'second' })
    registerChannel(first)
    registerChannel(second)
    expect(getChannelSpec('ETSY')).toBe(second)
    expect(listChannelSpecs().filter((s) => s.key === 'ETSY')).toHaveLength(1)
  })

  it('tryGetChannelSpec returns null for an unknown string, never throws', () => {
    expect(tryGetChannelSpec('NOT_A_CHANNEL')).toBeNull()
  })
})

describe('channelKeyOf', () => {
  it('maps the stored channelType back to its catalogue key', () => {
    expect(channelKeyOf('EBAY')).toBe('EBAY')
    expect(channelKeyOf('AMAZON')).toBe('AMAZON_SP')
    expect(channelKeyOf('AMAZON_ADS')).toBe('AMAZON_ADS')
    expect(channelKeyOf('SHOPIFY')).toBe('SHOPIFY')
    expect(channelKeyOf('ETSY')).toBe('ETSY')
  })

  it('returns null for a channelType the catalogue does not know', () => {
    expect(channelKeyOf('WALMART')).toBeNull()
    expect(channelKeyOf('')).toBeNull()
    expect(channelKeyOf('ebay')).toBeNull() // case-sensitive: the DB value is upper-case
  })

  it('is the inverse of CHANNEL_TYPE_OF for every key', () => {
    for (const [key, type] of Object.entries(CHANNEL_TYPE_OF)) {
      expect(channelKeyOf(type)).toBe(key)
    }
  })
})

describe('scopeDriftOf', () => {
  it('returns exactly the required scopes that were not granted, in spec order', () => {
    const spec = fakeSpec({ requiredScopes: ['a', 'b', 'c', 'd'] })
    expect(scopeDriftOf(spec, ['a', 'c'])).toEqual(['b', 'd'])
    expect(scopeDriftOf(spec, [])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is empty when every required scope was granted', () => {
    const spec = fakeSpec({ requiredScopes: ['a', 'b', 'c'] })
    expect(scopeDriftOf(spec, ['a', 'b', 'c'])).toEqual([])
    expect(scopeDriftOf(spec, ['c', 'b', 'a'])).toEqual([])
  })

  it('ignores granted scopes the spec never asked for', () => {
    const spec = fakeSpec({ requiredScopes: ['a', 'b'] })
    expect(scopeDriftOf(spec, ['a', 'b', 'extra', 'another'])).toEqual([])
    expect(scopeDriftOf(spec, ['extra'])).toEqual(['a', 'b'])
  })

  it('a manage scope implies its .readonly twin (eBay rule)', () => {
    const S = 'https://api.ebay.com/oauth/api_scope'
    const spec = fakeSpec({ requiredScopes: [`${S}/sell.inventory`, `${S}/sell.inventory.readonly`, `${S}/sell.finances`] })
    expect(scopeDriftOf(spec, [`${S}/sell.inventory`])).toEqual([`${S}/sell.finances`])
  })

  it('a .readonly grant does NOT imply the manage scope', () => {
    const S = 'https://api.ebay.com/oauth/api_scope'
    const spec = fakeSpec({ requiredScopes: [`${S}/sell.inventory`, `${S}/sell.inventory.readonly`] })
    expect(scopeDriftOf(spec, [`${S}/sell.inventory.readonly`])).toEqual([`${S}/sell.inventory`])
  })

  it('write_x implies read_x (Shopify rule) but not the other way round', () => {
    const spec = fakeSpec({ requiredScopes: ['read_orders', 'write_orders', 'read_products'] })
    expect(scopeDriftOf(spec, ['write_orders'])).toEqual(['read_products'])
    expect(scopeDriftOf(spec, ['read_orders', 'read_products'])).toEqual(['write_orders'])
  })
})

describe('classifyAuthError', () => {
  it('429 is rate_limited regardless of body', () => {
    expect(classifyAuthError(429, '')).toBe('rate_limited')
    expect(classifyAuthError(429, '{"error":"invalid_grant"}')).toBe('rate_limited')
  })

  it('401 with invalid_grant / revoked / invalid refresh token is auth_revoked', () => {
    expect(classifyAuthError(401, '{"error":"invalid_grant","error_description":"..."}')).toBe('auth_revoked')
    expect(classifyAuthError(400, 'token has been REVOKED by the user')).toBe('auth_revoked')
    expect(classifyAuthError(400, 'Invalid refresh token')).toBe('auth_revoked')
  })

  it('a body that says expired is auth_expired, even on 401', () => {
    expect(classifyAuthError(401, '{"error":"invalid_token","error_description":"The access token expired"}')).toBe('auth_expired')
    expect(classifyAuthError(400, 'refresh token EXPIRED')).toBe('auth_expired')
  })

  it('a bare 401 with no recognisable body is auth_revoked', () => {
    expect(classifyAuthError(401, '')).toBe('auth_revoked')
    expect(classifyAuthError(401, 'Unauthorized')).toBe('auth_revoked')
  })

  it('403 with an eBay 215001 (signature) error is a SIGNING defect, never a revoked grant', () => {
    const body = JSON.stringify({ errors: [{ errorId: 215001, domain: 'ACCESS', category: 'REQUEST', message: 'Signature validation failed' }] })
    expect(classifyAuthError(403, body)).toBe('signature')
    expect(classifyAuthError(403, JSON.stringify({ errors: [{ errorId: 215122 }] }))).toBe('signature')
    expect(classifyAuthError(403, JSON.stringify({ errors: [{ errorId: 215123 }] }))).toBe('forbidden')
    // a plain 403 is a permission problem on a LIVE grant — degrade by count, not needs_reauth
    expect(classifyAuthError(403, 'Forbidden')).toBe('forbidden')
  })

  it('5xx is transient — the channel is unwell, the grant is not', () => {
    expect(classifyAuthError(500, 'Internal Server Error')).toBe('transient')
    expect(classifyAuthError(502, '')).toBe('transient')
    expect(classifyAuthError(503, '{"error":"server_error"}')).toBe('transient')
  })

  it('no status at all (the request never got an answer) is network', () => {
    expect(classifyAuthError(undefined, '')).toBe('network')
    expect(classifyAuthError(undefined, 'ECONNRESET')).toBe('network')
  })

  it('body matching is case-insensitive', () => {
    expect(classifyAuthError(400, 'INVALID_GRANT')).toBe('auth_revoked')
    expect(classifyAuthError(400, 'Token Expired')).toBe('auth_expired')
  })
})

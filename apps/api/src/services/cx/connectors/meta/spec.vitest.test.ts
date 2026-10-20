/**
 * Meta's catalogue entry (step 1): no consent screen (a person enters the token), no refresh token required, renewal
 * once 30 days are left; the heartbeat checks the token with debug_token at most twice a day and keeps the answer
 * (never the token); a token Meta calls invalid is a dead sign-in, an app Meta refuses is setup, no answer is network.
 * Expiry alerts fire at 14, 7 and 1 days. No network: the gateway call and prisma are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  metadata: null as unknown,
  saved: [] as unknown[],
  checks: 0,
  check: null as null | (() => Record<string, unknown> | Error),
}))
vi.mock('../../../../db.js', () => ({
  default: {
    channelConnection: {
      findUnique: vi.fn(async () => ({ connectionMetadata: h.metadata })),
      update: vi.fn(async ({ data }: { data: { connectionMetadata: unknown } }) => { h.saved.push(data.connectionMetadata); return {} }),
    },
  },
}))
vi.mock('../../token.service.js', () => ({
  RefreshFailed: class RefreshFailed extends Error { constructor(readonly connectionId: string, readonly errorClass: string, message: string) { super(message) } },
  metaAppIdOf: vi.fn(async () => '1234567'),
}))
vi.mock('./token-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./token-check.js')>()
  return {
    ...actual,
    checkMetaToken: vi.fn(async () => {
      h.checks++
      const out = h.check?.()
      if (out instanceof Error) throw out
      return actual.tokenHealthOf(out ?? { app_id: '1234567', is_valid: true, expires_at: 0, scopes: ['ads_read'], user_id: '120000000000001' }, '1234567')
    }),
  }
})

import { metaSpec, CHECK_EVERY_MS, META_RENEW_WITHIN_SEC } from './spec.js'
import { MetaTokenCheckError } from './token-check.js'
import { metaTokenExpiryLevel } from '../../../../jobs/cx-heartbeat.job.js'
import { deprecationOf } from '../../deprecation-readings.js'

const handle = { id: 'conn-1', channelKey: 'META' as const, channelType: 'META', region: null, grantedScopes: [], identity: { userId: '120000000000001' }, token: async () => 'stored-token' }

beforeEach(() => { h.metadata = null; h.saved = []; h.checks = 0; h.check = null })

describe('the catalogue entry', () => {
  it('has no consent screen, needs no refresh token, renews 30 days before expiry, and never revokes at Meta', () => {
    // Step 1: no Settings card yet, so no Connect button that would fail; the card (step 2) switches it on.
    expect(metaSpec.available).toBe(false)
    expect(metaSpec.connectException?.reason).toMatch(/system-user token/)
    expect(metaSpec.auth.authorizeUrl).toBeUndefined()
    expect(metaSpec.auth).toMatchObject({ mode: 'api_key', refreshTokenRequired: false, accessTokenLifetimeSec: null, requiredScopes: ['ads_read'] })
    expect(metaSpec.tokenExpirationBufferSec).toBe(META_RENEW_WITHIN_SEC)
    expect(META_RENEW_WITHIN_SEC).toBe(30 * 86_400)
    expect(metaSpec.auth.revokeUrl).toBeUndefined()
    expect(metaSpec.auth.revokeHint?.url).toMatch(/business\.facebook\.com/)
    expect(metaSpec.discoverOnHeartbeat).toBe(false)
    expect(metaSpec.apiVersion).toBe('v26.0')
  })
})

describe('the heartbeat', () => {
  it('a check kept less than 12 h ago is used: no call to Meta', async () => {
    h.metadata = { metaToken: { checkedAt: new Date(Date.now() - CHECK_EVERY_MS / 2).toISOString(), isValid: true, expiresAt: null, scopes: ['ads_read'], userId: '120000000000001' } }
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: true, scopes: ['ads_read'], identity: { userId: '120000000000001' } })
    expect(h.checks).toBe(0)
  })
  it('an older check asks debug_token again and keeps the answer, never the token', async () => {
    h.metadata = { environment: 'production', metaToken: { checkedAt: new Date(Date.now() - CHECK_EVERY_MS - 1000).toISOString(), isValid: true } }
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: true })
    expect(h.checks).toBe(1)
    expect(h.saved).toEqual([expect.objectContaining({ environment: 'production', metaToken: expect.objectContaining({ isValid: true, neverExpires: true }) })])
    expect(JSON.stringify(h.saved)).not.toContain('stored-token')
  })
  it('a token Meta calls invalid is a dead sign-in; another app\'s token is an identity mismatch', async () => {
    h.check = () => ({ app_id: '1234567', is_valid: false })
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: false, errorClass: 'auth_revoked' })
    h.check = () => ({ app_id: '7654321', is_valid: true })
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: false, errorClass: 'identity_mismatch' })
  })
  it('an app Meta refuses is setup (configuration); no answer is network — neither asks for a new token', async () => {
    h.check = () => new MetaTokenCheckError('meta_error', 'Meta refused the token check: Invalid OAuth access token')
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: false, errorClass: 'configuration' })
    h.check = () => new MetaTokenCheckError('no_answer', 'Meta did not answer the token check.')
    await expect(metaSpec.heartbeat(handle)).resolves.toMatchObject({ ok: false, errorClass: 'network' })
  })
})

describe('expiry and version warnings', () => {
  it('warns at 14, 7 and 1 days before a token expires; a never-expiring token never', () => {
    const now = Date.UTC(2026, 9, 20, 12)
    const at = (days: number) => new Date(now + days * 86_400_000 + 3_600_000)
    expect([14, 7, 1].map((d) => metaTokenExpiryLevel(at(d), now))).toEqual([14, 7, 1])
    expect(metaTokenExpiryLevel(at(20), now)).toBeNull()
    expect(metaTokenExpiryLevel(null, now)).toBeNull()
  })
  it('Meta\'s X-Ad-Api-Version-Warning is a deprecation notice (the pinned version expired)', () => {
    expect(deprecationOf(new Headers({ 'x-ad-api-version-warning': 'Upgraded from v24.0 to v26.0' }))).toMatchObject({ deprecated: true, via: 'meta', reason: expect.stringMatching(/Upgraded from v24\.0/) })
  })
})

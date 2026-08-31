/**
 * SC.1 — the session cache's two load-bearing promises.
 *
 * Redis is unreachable in the test environment, which is deliberate here rather than a
 * limitation: it exercises the degradation path every one of these assertions depends on.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCachedSession,
  setCachedSession,
  dropCachedSessions,
  __clearSessionMemCache,
  __reviveForTest,
} from './session-cache.js'
import type { ValidatedSession } from './session.js'

const HASH = 'a'.repeat(64)

function session(over: Partial<ValidatedSession['user']> = {}): ValidatedSession {
  return {
    sessionId: 'sess_1',
    mfaSatisfied: true,
    user: {
      id: 'usr_1',
      email: 'op@example.com',
      displayName: 'Operator',
      status: 'active',
      mfaRequired: false,
      twoFactorEnabledAt: new Date('2026-01-02T03:04:05.000Z'),
      permissionsVersion: 7,
      roleKeys: ['OWNER'],
      ...over,
    },
  }
}

beforeEach(() => __clearSessionMemCache())

describe('cached and uncached results are indistinguishable', () => {
  it('revives twoFactorEnabledAt as a Date across the JSON tier', () => {
    // JSON has no Date. Without reviving, a cache HIT would hand callers a string where a MISS
    // hands them a Date — a bug that only appears under load, which is the worst kind.
    const original = session()
    const roundTripped = __reviveForTest(JSON.parse(JSON.stringify(original)))
    expect(roundTripped?.user.twoFactorEnabledAt).toBeInstanceOf(Date)
    expect(roundTripped?.user.twoFactorEnabledAt?.toISOString()).toBe(
      original.user.twoFactorEnabledAt?.toISOString(),
    )
  })

  it('keeps a null twoFactorEnabledAt null rather than epoch-zero', () => {
    const revived = __reviveForTest(
      JSON.parse(JSON.stringify(session({ twoFactorEnabledAt: null }))),
    )
    expect(revived?.user.twoFactorEnabledAt).toBeNull()
  })

  it('rejects a malformed payload instead of returning a half-session', () => {
    expect(__reviveForTest(null)).toBeNull()
    expect(__reviveForTest({})).toBeNull()
    expect(__reviveForTest({ sessionId: 'x' })).toBeNull()
  })
})

describe('the cache never becomes an authority', () => {
  it('returns null for an unknown hash so the caller falls through to the database', async () => {
    await expect(getCachedSession(HASH)).resolves.toBeNull()
  })

  it('serves a stored session from the in-process tier with Redis down', async () => {
    await setCachedSession(HASH, session())
    const hit = await getCachedSession(HASH)
    expect(hit?.sessionId).toBe('sess_1')
    expect(hit?.user.roleKeys).toEqual(['OWNER'])
  })

  it('drops an entry on revocation, so a revoked session stops validating', async () => {
    await setCachedSession(HASH, session())
    expect(await getCachedSession(HASH)).not.toBeNull()
    await dropCachedSessions([HASH])
    expect(await getCachedSession(HASH)).toBeNull()
  })

  it('tolerates an empty drop list without touching Redis', async () => {
    await expect(dropCachedSessions([])).resolves.toBeUndefined()
  })
})

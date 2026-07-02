/**
 * Phase S1 (auth core) — unit tests for the pure + crypto logic.
 * DB-touching functions (sessions, lockout writes) are covered by the
 * manual verification steps in the S1 gate report; here we prove the
 * primitives that must be exactly right.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import bcrypt from 'bcryptjs'
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  MIN_PASSWORD_LENGTH,
} from './password.js'
import { generateToken, hashToken, tokenPrefix, constantTimeEqualHex } from './tokens.js'
import { computeLockMs, MAX_ACCOUNT_FAILURES } from './lockout.js'
import { truncateIp } from './session.js'
import {
  sessionCookieName,
  csrfCookieName,
  sessionCookieOptions,
  csrfCookieOptions,
} from './cookies.js'
import { verifyCsrf, issueCsrfToken } from './csrf.js'

describe('password hashing', () => {
  it('argon2id round-trips and needs no rehash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('$argon2')).toBe(true)
    const r = await verifyPassword('correct horse battery staple', hash)
    expect(r.ok).toBe(true)
    expect(r.needsRehash).toBe(false)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    const r = await verifyPassword('wrong password entirely', hash)
    expect(r.ok).toBe(false)
    expect(r.needsRehash).toBe(false)
  })

  it('verifies a legacy bcrypt hash and flags rehash', async () => {
    const legacy = await bcrypt.hash('legacy-bcrypt-pw-123', 10)
    const r = await verifyPassword('legacy-bcrypt-pw-123', legacy)
    expect(r.ok).toBe(true)
    expect(r.needsRehash).toBe(true)
  })

  it('verifies a legacy sha256 hash and flags rehash', async () => {
    const legacy = createHash('sha256').update('legacy-sha-pw').digest('hex')
    const r = await verifyPassword('legacy-sha-pw', legacy)
    expect(r.ok).toBe(true)
    expect(r.needsRehash).toBe(true)
  })

  it('empty stored hash never matches', async () => {
    const r = await verifyPassword('anything', '')
    expect(r.ok).toBe(false)
  })
})

describe('password strength gate', () => {
  it('rejects short passwords regardless of complexity', () => {
    const r = checkPasswordStrength('aB3$xY7!')
    expect(r.ok).toBe(false)
    expect(r.message).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('rejects a weak long password', () => {
    const r = checkPasswordStrength('password123456')
    expect(r.ok).toBe(false)
  })

  it('accepts a strong passphrase', () => {
    const r = checkPasswordStrength('trombone-galaxy-pickle-vault-92')
    expect(r.ok).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(3)
  })

  it('penalises a password derived from the account email', () => {
    const r = checkPasswordStrength('john.smith@acme.com!!', ['john.smith@acme.com'])
    expect(r.ok).toBe(false)
  })
})

describe('opaque tokens', () => {
  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
    expect(hashToken('abc')).toHaveLength(64)
  })

  it('generateToken is url-safe and unique', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('tokenPrefix is 8 chars of the hash', () => {
    expect(tokenPrefix('abc')).toBe(hashToken('abc').slice(0, 8))
  })

  it('constantTimeEqualHex compares correctly', () => {
    const h = hashToken('x')
    expect(constantTimeEqualHex(h, h)).toBe(true)
    expect(constantTimeEqualHex(h, hashToken('y'))).toBe(false)
    expect(constantTimeEqualHex(h, h.slice(0, 10))).toBe(false)
    expect(constantTimeEqualHex('', '')).toBe(false)
  })
})

describe('progressive lockout math', () => {
  it('no lock below the failure threshold', () => {
    expect(computeLockMs(MAX_ACCOUNT_FAILURES - 1)).toBe(0)
  })
  it('locks with exponential backoff at/after the threshold', () => {
    expect(computeLockMs(MAX_ACCOUNT_FAILURES)).toBe(60_000)
    expect(computeLockMs(MAX_ACCOUNT_FAILURES + 1)).toBe(120_000)
    expect(computeLockMs(MAX_ACCOUNT_FAILURES + 2)).toBe(240_000)
  })
  it('caps at one hour', () => {
    expect(computeLockMs(MAX_ACCOUNT_FAILURES + 20)).toBe(60 * 60_000)
  })
})

describe('IP truncation for privacy', () => {
  it('truncates IPv4 to /24', () => {
    expect(truncateIp('203.0.113.55')).toBe('203.0.113.0')
  })
  it('unwraps IPv4-mapped IPv6', () => {
    expect(truncateIp('::ffff:203.0.113.55')).toBe('203.0.113.0')
  })
  it('truncates IPv6 to /64', () => {
    expect(truncateIp('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678::')
  })
  it('null in → null out', () => {
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp(undefined)).toBeNull()
  })
})

describe('cookie config (env-driven)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env.COOKIE_DOMAIN = saved.COOKIE_DOMAIN
    process.env.COOKIE_SAMESITE = saved.COOKIE_SAMESITE
    process.env.COOKIE_SECURE = saved.COOKIE_SECURE
    delete process.env.COOKIE_DOMAIN
    delete process.env.COOKIE_SAMESITE
    delete process.env.COOKIE_SECURE
  })

  it('interim mode: __Host- prefix + SameSite=None + Secure', () => {
    delete process.env.COOKIE_DOMAIN
    delete process.env.COOKIE_SAMESITE
    delete process.env.COOKIE_SECURE
    expect(sessionCookieName()).toBe('__Host-nexus_session')
    const o = sessionCookieOptions()
    expect(o.sameSite).toBe('none')
    expect(o.secure).toBe(true)
    expect(o.domain).toBeUndefined()
    expect(o.httpOnly).toBe(true)
  })

  it('Option A: custom domain drops __Host-, uses SameSite=Lax + Domain', () => {
    process.env.COOKIE_DOMAIN = '.xavia.it'
    expect(sessionCookieName()).toBe('nexus_session')
    const o = sessionCookieOptions()
    expect(o.sameSite).toBe('lax')
    expect(o.domain).toBe('.xavia.it')
  })

  it('CSRF cookie is readable (not httpOnly)', () => {
    const o = csrfCookieOptions()
    expect(o.httpOnly).toBe(false)
  })
})

describe('CSRF double-submit', () => {
  it('passes when header equals cookie', () => {
    const token = issueCsrfToken()
    const req: any = { cookies: { [csrfCookieName()]: token }, headers: { 'x-nexus-csrf': token } }
    expect(verifyCsrf(req)).toBe(true)
  })
  it('fails when header is missing', () => {
    const req: any = { cookies: { [csrfCookieName()]: 'abc' }, headers: {} }
    expect(verifyCsrf(req)).toBe(false)
  })
  it('fails when they differ', () => {
    const req: any = { cookies: { [csrfCookieName()]: 'abc' }, headers: { 'x-nexus-csrf': 'def' } }
    expect(verifyCsrf(req)).toBe(false)
  })
})

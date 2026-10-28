import { describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { mfaSatisfied } from './grants'
import { holdAuthMail, memoryAuthMailer } from './mail'
import { createOfficeAuth } from './office-auth'
import { authSecrets, mintToken, parseToken, sameSecret, shortenIp, tokenHash } from './secrets'
import { idleExpiryAt, SESSION_LIFETIME } from './session-store'

// Ported from Commerce's apps/api/src/lib/auth/auth.vitest.test.ts (opaque tokens, IP truncation, CSRF compare),
// plus the factory's token layout, the sealed TOTP secrets and the two-factor rule of the grants.
const TENANT = '01a18208-e882-70ce-8bb6-0d4afb932bc1'
const USER = '01a18208-e882-70ce-8bb6-0d4afb932bc2'

describe('tokens', () => {
  it('carry the tenant and the user, and 256 random bits', () => {
    const token = mintToken(TENANT, USER)
    expect(token.value).toMatch(new RegExp(`^${TENANT}\\.${USER}\\.[A-Za-z0-9_-]{43}$`))
    expect(parseToken(token.value)).toEqual(token)
    expect(mintToken(TENANT, USER).value).not.toBe(token.value)
  })

  it('refuse anything else', () => {
    const { value } = mintToken(TENANT, USER)
    for (const bad of [undefined, '', 'x', `${TENANT}.${USER}`, `${value}.extra`, `not-a-uuid.${USER}.${'a'.repeat(43)}`, `${TENANT}.${USER}.${'a'.repeat(42)}`, `${TENANT}.${USER}.${'a'.repeat(42)}=`, value + 'x'.repeat(200)]) {
      expect(parseToken(bad), String(bad)).toBeNull()
    }
  })

  it('are stored as SHA-256 hex, deterministically', () => {
    expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(tokenHash('abc')).toBe(tokenHash('abc'))
  })

  it('compare in constant time, and never match empty or different values', () => {
    expect(sameSecret('same-value', 'same-value')).toBe(true)
    expect(sameSecret('same-value', 'same-valuf')).toBe(false)
    expect(sameSecret('short', 'longer-value')).toBe(false)
    expect(sameSecret('', '')).toBe(false)
    expect(sameSecret(undefined, 'x')).toBe(false)
  })
})

describe('client addresses', () => {
  it('shorten IPv4 to /24 and IPv6 to /64, expanding "::" first', () => {
    expect(shortenIp('203.0.113.77')).toBe('203.0.113.0')
    expect(shortenIp('::ffff:203.0.113.77')).toBe('203.0.113.0')
    expect(shortenIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::')
    expect(shortenIp('2001:db8::1')).toBe('2001:db8:0:0::')
    expect(shortenIp('2001:0db8:0000:0000::1')).toBe('2001:db8:0:0::')
    expect(shortenIp(undefined)).toBeNull()
    expect(shortenIp('nonsense')).toBeNull()
  })

  it('are stored only as an HMAC of the short form, one key per cookie secret', () => {
    const secrets = authSecrets(LOCAL_COOKIE_SECRET)
    expect(secrets.ipHash('203.0.113.77')).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets.ipHash('203.0.113.77')).toBe(secrets.ipHash('203.0.113.1'))
    expect(secrets.ipHash('203.0.114.1')).not.toBe(secrets.ipHash('203.0.113.1'))
    expect(authSecrets('another-secret-of-enough-length').ipHash('203.0.113.77')).not.toBe(secrets.ipHash('203.0.113.77'))
    expect(secrets.ipHash(undefined)).toBeNull()
  })
})

describe('sealed secrets', () => {
  const secrets = authSecrets(LOCAL_COOKIE_SECRET)

  it('round-trip, with a new IV each time', () => {
    const sealed = secrets.seal('JBSWY3DPEHPK3PXP')
    expect(sealed).toMatch(/^l1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(secrets.seal('JBSWY3DPEHPK3PXP')).not.toBe(sealed)
    expect(secrets.open(sealed)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('refuse a changed value, another key, or another format', () => {
    const sealed = secrets.seal('JBSWY3DPEHPK3PXP')
    const [keyId, iv, body, tag] = sealed.split('.')
    // The first character: every one of its 6 bits is data (the last one may hold padding bits only).
    const flipped = (body!.startsWith('A') ? 'B' : 'A') + body!.slice(1)
    expect(() => secrets.open([keyId, iv, flipped, tag].join('.'))).toThrow()
    expect(() => authSecrets('another-secret-of-enough-length').open(sealed)).toThrow()
    expect(() => secrets.open(sealed.replace(/^l1\./, 'k9.'))).toThrow(/not readable/)
    expect(() => authSecrets('short')).toThrow(/too short/)
  })

  it('hash recovery codes with their own key', () => {
    expect(secrets.recoveryCodeHash('ABCDEFGHJK')).toBe(secrets.recoveryCodeHash('ABCDEFGHJK'))
    expect(secrets.recoveryCodeHash('ABCDEFGHJK')).not.toBe(authSecrets('another-secret-of-enough-length').recoveryCodeHash('ABCDEFGHJK'))
  })
})

describe('session lifetime', () => {
  it('slides the idle expiry 8 hours from now, never past the absolute expiry', () => {
    const now = new Date('2026-10-28T09:00:00.000Z')
    expect(idleExpiryAt(now, new Date('2026-11-04T09:00:00.000Z'))).toEqual(new Date('2026-10-28T17:00:00.000Z'))
    expect(idleExpiryAt(now, new Date('2026-10-28T12:00:00.000Z'))).toEqual(new Date('2026-10-28T12:00:00.000Z'))
    expect(SESSION_LIFETIME).toEqual({ idleMs: 8 * 3_600_000, absoluteMs: 7 * 24 * 3_600_000, slideEveryMs: 60_000 })
  })
})

describe('two-factor on the session', () => {
  const NO_MFA = { mfaAt: null }
  const PROVED = { mfaAt: new Date() }

  it('is satisfied when not required, or proved on the session (the role grants: auth/roles tests)', () => {
    expect(mfaSatisfied({ requireMfa: true }, NO_MFA)).toBe(false)
    expect(mfaSatisfied({ requireMfa: true }, PROVED)).toBe(true)
    expect(mfaSatisfied({ requireMfa: false }, NO_MFA)).toBe(true)
  })
})

describe('createOfficeAuth', () => {
  const database = {} as FactoryDatabase
  const base = { database, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: 'http://localhost:3200/' }

  it('refuses the memory mailer outside tests: links stay unreadable', () => {
    for (const environment of ['local', 'staging', 'production'] as const) {
      expect(() => createOfficeAuth({ ...base, environment, mailer: memoryAuthMailer() })).toThrow(/refused with FACTORY_ENV/)
    }
    expect(() => createOfficeAuth({ ...base, environment: 'production', mailer: holdAuthMail })).not.toThrow()
    expect(() => createOfficeAuth({ ...base, environment: 'test', mailer: memoryAuthMailer() })).not.toThrow()
  })

  it('puts link tokens in the fragment, never in the path or query', () => {
    const auth = createOfficeAuth({ ...base, environment: 'test' })
    expect(auth.link('/accept-invitation', 'a.b.c+d')).toBe('http://localhost:3200/accept-invitation#token=a.b.c%2Bd')
  })
})

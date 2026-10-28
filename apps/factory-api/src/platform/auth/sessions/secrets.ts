import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { isUuid } from '@nexus/factory-domain/core/ids'

/**
 * The secrets of office sign-in (plan A1 §3.10, §5.4), ported from Commerce (apps/api/src/lib/auth/tokens.ts and the
 * IP truncation of session.ts):
 *
 *   tokens     a session cookie, an invitation link and a reset link carry `<tenantId>.<userId>.<secret>`, the secret
 *              256 random bits (base64url). The ids say where to look (the tenant's office scope), the secret proves
 *              the holder; only SHA-256 of the whole value is stored, so a database read gives no working token.
 *              SHA-256, not a slow hash: the secret is random, there is nothing to guess.
 *   keys       derived with HKDF-SHA-256 from FACTORY_COOKIE_SECRET, one per use (the "session pepper" of A1 §5.4):
 *              AES-256-GCM for the TOTP secrets at rest, HMAC for client addresses and recovery codes. Changing the
 *              cookie secret makes the stored TOTP secrets unreadable: the KMS step replaces this key source and
 *              re-encrypts (a sealed value names its key, `l1`).
 *   addresses  never stored: an IPv4 address is shortened to its /24, IPv6 to its /64, then HMAC-ed.
 */

const TOKEN_SECRET = /^[A-Za-z0-9_-]{43}$/
const TOKEN_BYTES = 32

export interface AuthToken {
  readonly tenantId: string
  readonly userId: string
  /** The whole token, as it goes into the cookie or link (never stored, never logged). */
  readonly value: string
}

/** A new token for a user of a tenant. */
export function mintToken(tenantId: string, userId: string): AuthToken {
  return { tenantId, userId, value: `${tenantId}.${userId}.${randomBytes(TOKEN_BYTES).toString('base64url')}` }
}

/** Reads a token sent by a client; null for anything that is not one. */
export function parseToken(value: unknown): AuthToken | null {
  if (typeof value !== 'string' || value.length > 160) return null
  const [tenantId, userId, secret, extra] = value.split('.')
  if (extra !== undefined || !isUuid(tenantId) || !isUuid(userId) || !TOKEN_SECRET.test(secret ?? '')) return null
  return { tenantId: tenantId!.toLowerCase(), userId: userId!.toLowerCase(), value }
}

/** What is stored for a token: SHA-256, hex. */
export function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Compares two strings in constant time (for equal lengths; different lengths answer no at once). */
export function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** An address shortened for privacy: IPv4 to /24, IPv6 to /64 (ported from Commerce's truncateIp). */
export function shortenIp(ip: string | undefined | null): string | null {
  if (!ip) return null
  const clean = ip.replace(/^::ffff:/i, '')
  if (clean.includes('.')) {
    const parts = clean.split('.')
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : null
  }
  if (clean.includes(':')) {
    // Expand "::" first, so 2001:db8::1 and 2001:db8:0:0::1 give the same /64.
    const [head, tail] = clean.toLowerCase().split('::')
    const front = head ? head.split(':') : []
    const back = tail ? tail.split(':') : []
    const full = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back]
    return `${full.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '') || '0').join(':')}::`
  }
  return null
}

export interface AuthSecrets {
  /** Seals a secret for storage (AES-256-GCM): `l1.<iv>.<ciphertext>.<tag>`, base64url. */
  seal(plain: string): string
  /** Opens a sealed value; throws when it was changed or sealed with another key. */
  open(sealed: string): string
  /** The stored form of a client address (null without one). */
  ipHash(ip: string | undefined | null): string | null
  /** The stored form of a recovery code (its normalized form). */
  recoveryCodeHash(code: string): string
}

const KEY_ID = 'l1'
const derive = (secret: string, use: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'nexus-factory-auth', use, 32))

/** The keys of one cookie secret. */
export function authSecrets(cookieSecret: string): AuthSecrets {
  if (typeof cookieSecret !== 'string' || cookieSecret.length < 16) throw new Error('The cookie secret is too short to derive keys from.')
  const sealKey = derive(cookieSecret, 'totp-secret-seal v1')
  const ipKey = derive(cookieSecret, 'client-address v1')
  const recoveryKey = derive(cookieSecret, 'recovery-code v1')
  return {
    seal(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', sealKey, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return [KEY_ID, iv, body, cipher.getAuthTag()].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
    },
    open(sealed) {
      const [keyId, iv, body, tag, extra] = sealed.split('.')
      if (keyId !== KEY_ID || iv === undefined || body === undefined || tag === undefined || extra !== undefined) {
        throw new Error('The sealed value is not readable with this key.')
      }
      const decipher = createDecipheriv('aes-256-gcm', sealKey, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
    },
    ipHash(ip) {
      const short = shortenIp(ip)
      return short === null ? null : createHmac('sha256', ipKey).update(short).digest('hex')
    },
    recoveryCodeHash(code) {
      return createHmac('sha256', recoveryKey).update(code).digest('hex')
    },
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isUuid } from '../../core/ids'

/**
 * The two portal tokens (B-W2b-159; the shape of A1 §3.10's office tokens and W0's link tokens): random, long, never
 * stored (only SHA-256 of the whole value), compared in constant time.
 *
 *   session  `ps1.<tenantId>.<partyId>.<userId>.<secret>` in the `__Host-factory_portal` cookie. The ids say where to look:
 *            the tenant, and the party whose row-level-security wall the session is read behind (factory_partner_runtime:
 *            a cookie that names another party finds nothing), and the person; the secret proves the holder.
 *   link     `pl1.<tenantId>.<companyId>.<userId>.<secret>` in the sign-in e-mail's link (`/p/signin/continue#token=…`,
 *            a fragment no server ever sees). It names the company whose portal it opens. Opening the page reads it
 *            without using it; only Continue signs in (a mail scanner that pre-opens the link never burns it).
 *
 * The secret is 256 random bits (base64url, 43 characters): there is nothing to guess, so SHA-256, not a slow hash.
 */

export type PortalTokenKind = 'session' | 'link'

const PREFIX: Readonly<Record<PortalTokenKind, string>> = { session: 'ps1', link: 'pl1' }
const SECRET = /^[A-Za-z0-9_-]{43}$/
const SECRET_BYTES = 32
const LENGTH = 3 + 1 + 3 * 37 + 43

export interface PortalToken {
  readonly kind: PortalTokenKind
  readonly tenantId: string
  /** session: the party; link: the company. */
  readonly scopeId: string
  readonly userId: string
  /** The whole token (never stored, never logged). */
  readonly value: string
}

/** A new token. `random` (tests) defaults to node:crypto's randomBytes. */
export function mintPortalToken(
  kind: PortalTokenKind,
  ids: { readonly tenantId: string; readonly scopeId: string; readonly userId: string },
  random: (size: number) => Uint8Array = randomBytes,
): PortalToken {
  for (const [name, value] of Object.entries(ids)) if (!isUuid(value)) throw new Error(`A portal token needs a UUID ${name}.`)
  const bytes = random(SECRET_BYTES)
  if (bytes.length !== SECRET_BYTES) throw new Error(`A portal token's secret is ${SECRET_BYTES} random bytes.`)
  const tenantId = ids.tenantId.toLowerCase()
  const scopeId = ids.scopeId.toLowerCase()
  const userId = ids.userId.toLowerCase()
  return { kind, tenantId, scopeId, userId, value: `${PREFIX[kind]}.${tenantId}.${scopeId}.${userId}.${Buffer.from(bytes).toString('base64url')}` }
}

/** Reads a token a client sent; null for anything that is not one of this kind (never an error). */
export function parsePortalToken(kind: PortalTokenKind, value: unknown): PortalToken | null {
  if (typeof value !== 'string' || value.length !== LENGTH) return null
  const [prefix, tenantId, scopeId, userId, secret, extra] = value.split('.')
  if (extra !== undefined || prefix !== PREFIX[kind] || !isUuid(tenantId) || !isUuid(scopeId) || !isUuid(userId) || !SECRET.test(secret ?? '')) return null
  return { kind, tenantId: tenantId!.toLowerCase(), scopeId: scopeId!.toLowerCase(), userId: userId!.toLowerCase(), value }
}

/** What is stored for a token: SHA-256 of the whole value, hex. */
export function portalTokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The stored hash is the token's (constant time). */
export function matchesPortalToken(token: PortalToken, stored: unknown): boolean {
  if (typeof stored !== 'string') return false
  const expected = Buffer.from(portalTokenHash(token.value), 'utf8')
  const actual = Buffer.from(stored, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

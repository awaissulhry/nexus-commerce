import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isUuid } from '../core/ids'

/**
 * The token of a one-off link (plan A1 §3.10 "Links"; feature SAL-099). It is the whole credential: whoever holds it
 * opens the link, so it is random, long, and never stored.
 *
 *   form     `<tenantId>.<partyId>.<linkId>.<secret>`; the secret is 256 random bits, base64url (43 characters), so
 *            the whole token is URL-safe. The ids say where to look: the tenant, and the party whose wall the lookup
 *            runs behind (a token naming another party finds nothing); the secret proves the holder.
 *   stored   SHA-256 (hex) of the whole value, never the value: a database read gives no working link. SHA-256, not a
 *            slow hash: the secret is random, there is nothing to guess.
 *   compared in constant time.
 *
 * The web link carries it in the fragment (`/l#token=…`), which a browser never sends to a server, so it is in no
 * access log; the web hands it to the API in a header.
 */

export const LINK_SECRET_BYTES = 32
const SECRET = /^[A-Za-z0-9_-]{43}$/
const MAX_LENGTH = 3 * 36 + 43 + 3

export interface LinkTokenIds {
  readonly tenantId: string
  readonly partyId: string
  readonly linkId: string
}

export interface LinkToken extends LinkTokenIds {
  /** The whole token, as it goes into the link (never stored, never logged). */
  readonly value: string
}

/** A new token for a link. `random` (tests) defaults to node:crypto's randomBytes. */
export function mintLinkToken(ids: LinkTokenIds, random: (size: number) => Uint8Array = randomBytes): LinkToken {
  for (const [name, id] of Object.entries(ids)) if (!isUuid(id)) throw new Error(`A link token needs a UUID ${name}.`)
  const bytes = random(LINK_SECRET_BYTES)
  if (bytes.length !== LINK_SECRET_BYTES) throw new Error(`A link secret is ${LINK_SECRET_BYTES} random bytes.`)
  const secret = Buffer.from(bytes).toString('base64url')
  const tenantId = ids.tenantId.toLowerCase()
  const partyId = ids.partyId.toLowerCase()
  const linkId = ids.linkId.toLowerCase()
  return { tenantId, partyId, linkId, value: `${tenantId}.${partyId}.${linkId}.${secret}` }
}

/** Reads a token a client sent; null for anything that is not one (never an error: every bad link answers alike). */
export function parseLinkToken(value: unknown): LinkToken | null {
  if (typeof value !== 'string' || value.length !== MAX_LENGTH) return null
  const [tenantId, partyId, linkId, secret, extra] = value.split('.')
  if (extra !== undefined || !isUuid(tenantId) || !isUuid(partyId) || !isUuid(linkId) || !SECRET.test(secret ?? '')) return null
  return { tenantId: tenantId!.toLowerCase(), partyId: partyId!.toLowerCase(), linkId: linkId!.toLowerCase(), value }
}

/** What is stored for a token: SHA-256 of the whole value, hex. */
export function linkTokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** The stored hash matches the token's (constant time; anything malformed answers no). */
export function matchesLinkHash(token: LinkToken, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false
  return timingSafeEqual(Buffer.from(linkTokenHash(token.value), 'hex'), Buffer.from(storedHash, 'hex'))
}

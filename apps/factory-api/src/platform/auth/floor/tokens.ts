import { randomBytes } from 'node:crypto'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { sameSecret, tokenHash } from '../sessions/secrets'

/**
 * The floor's secrets (plan A1 §3.10 "Floor"; features PLT-056, PLT-057): random, so only SHA-256 of each is stored
 * (sessions/secrets.ts tokenHash) and a database read gives nothing that works.
 *
 *   device token     `<tenantId>.<siteId>.<deviceId>.<secret>`: the enrolled device's long-lived credential (an HttpOnly
 *                    cookie). The ids say where to look (the FLOOR scope of that tenant and site: a token that names
 *                    another site finds nothing there), the 256-bit secret proves the holder.
 *   enrolment code   `<tenantId>.<siteId>.<enrolmentId>.<secret>`: the one-time code in the Office's QR code; the
 *                    tablet trades it for its device token within minutes.
 *   session token    256 random bits: the operator's floor session (an HttpOnly cookie), looked up by its hash in the
 *                    device's site and valid only with that device's token.
 */

const SECRET = /^[A-Za-z0-9_-]{43}$/
const SECRET_BYTES = 32

export interface SiteToken {
  readonly tenantId: string
  readonly siteId: string
  /** The device (device token) or the enrolment (enrolment code). */
  readonly id: string
  /** The whole value, as it travels (never stored, never logged). */
  readonly value: string
}

const secret = (): string => randomBytes(SECRET_BYTES).toString('base64url')

/** A new device token or enrolment code for a row of a site. */
export function mintSiteToken(tenantId: string, siteId: string, id: string): SiteToken {
  return { tenantId, siteId, id, value: `${tenantId}.${siteId}.${id}.${secret()}` }
}

/** Reads a device token or enrolment code sent by a client; null for anything that is not one. */
export function parseSiteToken(value: unknown): SiteToken | null {
  if (typeof value !== 'string' || value.length > 200) return null
  const [tenantId, siteId, id, part, extra] = value.split('.')
  if (extra !== undefined || !isUuid(tenantId) || !isUuid(siteId) || !isUuid(id) || !SECRET.test(part ?? '')) return null
  return { tenantId: tenantId!.toLowerCase(), siteId: siteId!.toLowerCase(), id: id!.toLowerCase(), value }
}

/** A new floor session token. */
export const mintSessionToken = (): string => secret()

/** A floor session token sent by a client, or null. */
export const parseSessionToken = (value: unknown): string | null => (typeof value === 'string' && SECRET.test(value) ? value : null)

/** The stored form of any floor secret. */
export const floorHash = (value: string): string => tokenHash(value)

/** A stored hash matches this secret (constant time). */
export const matchesHash = (stored: string | null | undefined, value: string): boolean => typeof stored === 'string' && sameSecret(stored, tokenHash(value))

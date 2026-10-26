/**
 * A customer's e-mail as Meta matches a customer list: trimmed, lower-cased, then SHA-256 in lowercase hex
 * (developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/custom-audiences, "Hashing and
 * normalization": EMAIL trim + lowercase). ONE normaliser for every place Nexus keeps or sends a hashed e-mail, so a hash
 * Nexus stores (ShopifyMarketingConsent.emailSha256) is the very value a Meta customer list receives
 * (marketing/meta-ads/audience-members.ts). Pure: no database, no call. The plain address is never returned by
 * `emailSha256`, only its hash.
 */
import { createHash } from 'node:crypto'

/** An e-mail as Meta matches it (trim, lower case), or null when it is no e-mail address at all. */
export function normalisedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** The SHA-256 of the normalised e-mail, or null when `raw` holds no e-mail address. */
export function emailSha256(raw: unknown): string | null {
  const email = normalisedEmail(raw)
  return email ? sha256Hex(email) : null
}

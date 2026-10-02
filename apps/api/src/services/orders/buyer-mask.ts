/**
 * MCP full control 07 O-1 — the buyer as Claude may see them: first name, city, country and a masked e-mail. Never the
 * full name, the street, the postal code, the phone or the e-mail itself; the tools that need those find them inside
 * Nexus. One place, so every order and customer tool masks the same way.
 */

export interface MaskedBuyer {
  firstName: string | null
  city: string | null
  country: string | null
  /** "m***@example.test": the first character and the domain. */
  email: string | null
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** The first word of a name; null when the "name" is an e-mail address or empty. */
export function firstNameOf(fullName: unknown): string | null {
  const name = text(fullName)
  if (!name || name.includes('@')) return null
  return name.split(/\s+/)[0] ?? null
}

/** "m***@example.test"; null when there is no address. A value without "@" shows nothing of itself. */
export function maskEmail(email: unknown): string | null {
  const value = text(email)
  if (!value) return null
  const at = value.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${value[0]}***@${value.slice(at + 1)}`
}

/** City and country of a shipping address, in the spellings the channels store (Amazon, eBay, Shopify, Etsy). */
export function cityAndCountry(address: unknown): { city: string | null; country: string | null } {
  const a = (address && typeof address === 'object' ? address : {}) as Record<string, unknown>
  return {
    city: text(a.city) ?? text(a.City) ?? text(a.cityName) ?? null,
    country:
      text(a.countryCode) ?? text(a.CountryCode) ?? text(a.country_code) ?? text(a.country) ?? text(a.Country) ?? null,
  }
}

/** The masked buyer of an order or a customer record. */
export function maskBuyer(input: { name?: unknown; email?: unknown; address?: unknown }): MaskedBuyer {
  return { firstName: firstNameOf(input.name), ...cityAndCountry(input.address), email: maskEmail(input.email) }
}

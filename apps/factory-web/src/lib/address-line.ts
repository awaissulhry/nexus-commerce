/**
 * A delivery address in one line: "Via Esempio 12, 20100 Seedville (MI), IT" (od-w1.1 — moved out of the portal account's model so
 * the ONE draft order, which both doors draw, names its ship-to without importing a portal file; the account re-exports it).
 */
export interface AddressLineParts {
  readonly line1: string
  readonly line2: string | null
  readonly postalCode: string
  readonly city: string
  readonly province: string | null
  readonly country: string
}

export function addressLine(address: AddressLineParts): string {
  const city = [address.postalCode, address.city].filter(Boolean).join(' ') + (address.province ? ` (${address.province})` : '')
  return [address.line1, address.line2, city, address.country].filter((part) => part && part.trim() !== '').join(', ')
}

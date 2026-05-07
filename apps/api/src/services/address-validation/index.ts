/**
 * O.17 — Address validation.
 *
 * Heuristic-only for v0: regex-based postal-code checks per country +
 * required-field gates. Cheap, deterministic, no external deps.
 * Catches the common failure modes (operator typed wrong postal code
 * format, missing city, missing country code) that Sendcloud would
 * reject 502 on otherwise.
 *
 * A future commit can add a real third-party verifier (Sendcloud's
 * /addresses/verify, Postmen, Lob) gated behind
 * NEXUS_ENABLE_ADDRESS_VERIFY=true. For now the heuristic catches
 * ~80% of malformed addresses before they cost a Sendcloud round-trip.
 */

export interface AddressInput {
  name?: string | null
  address?: string | null
  address2?: string | null
  city?: string | null
  postalCode?: string | null
  country?: string | null // ISO-2 country code
  state?: string | null
  phone?: string | null
  email?: string | null
}

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  field: keyof AddressInput | 'address_block'
  severity: ValidationSeverity
  code: string
  message: string
}

export interface ValidationResult {
  valid: boolean // false iff at least one error-severity issue
  issues: ValidationIssue[]
}

// Postal code regex per country. Not exhaustive — covers the markets
// Xavia ships to. Anything not in the map skips postal validation.
const POSTAL_RE: Record<string, RegExp> = {
  IT: /^\d{5}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  ES: /^\d{5}$/,
  PT: /^\d{4}-\d{3}$/,
  NL: /^\d{4} ?[A-Z]{2}$/i,
  BE: /^\d{4}$/,
  AT: /^\d{4}$/,
  CH: /^\d{4}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
  UK: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
  SE: /^\d{3} ?\d{2}$/,
  PL: /^\d{2}-\d{3}$/,
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i,
}

const ISO2_RE = /^[A-Z]{2}$/

export function validateAddress(addr: AddressInput): ValidationResult {
  const issues: ValidationIssue[] = []
  const required: Array<{ field: keyof AddressInput; label: string }> = [
    { field: 'name', label: 'Name' },
    { field: 'address', label: 'Street address' },
    { field: 'city', label: 'City' },
    { field: 'postalCode', label: 'Postal code' },
    { field: 'country', label: 'Country code' },
  ]
  for (const { field, label } of required) {
    const v = addr[field]
    if (!v || (typeof v === 'string' && !v.trim())) {
      issues.push({
        field,
        severity: 'error',
        code: 'MISSING_REQUIRED',
        message: `${label} is required`,
      })
    }
  }

  if (addr.country && !ISO2_RE.test(addr.country.trim().toUpperCase())) {
    issues.push({
      field: 'country',
      severity: 'error',
      code: 'INVALID_COUNTRY_CODE',
      message: `Country code must be 2 letters (got "${addr.country}")`,
    })
  }

  if (addr.country && addr.postalCode) {
    const cc = addr.country.trim().toUpperCase()
    const re = POSTAL_RE[cc]
    if (re && !re.test(addr.postalCode.trim())) {
      issues.push({
        field: 'postalCode',
        severity: 'warning', // not blocking — Sendcloud may accept
        code: 'POSTAL_FORMAT_MISMATCH',
        message: `Postal code "${addr.postalCode}" doesn't match the typical ${cc} format`,
      })
    }
  }

  // Phone: not required, but if present, basic length check.
  if (addr.phone && addr.phone.replace(/\D/g, '').length < 6) {
    issues.push({
      field: 'phone',
      severity: 'warning',
      code: 'PHONE_LOOKS_INVALID',
      message: 'Phone looks too short — couriers often need a real number for delivery',
    })
  }

  // Long unbroken street strings often signal a comma-merged address
  // that lost its line-2 split during channel ingestion. Warn so the
  // operator can review.
  if (addr.address && addr.address.length > 80) {
    issues.push({
      field: 'address',
      severity: 'warning',
      code: 'ADDRESS_VERY_LONG',
      message: 'Street address is unusually long — verify line-2 split was preserved',
    })
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  }
}

/** Convenience: extract a flat AddressInput from an Order's
 *  shippingAddress JSON (handles both Amazon-PascalCase and generic
 *  camelCase shapes — same normalization as print-label uses). */
export function extractAddressFromOrder(order: {
  customerName?: string | null
  customerEmail?: string | null
  shippingAddress: any
}): AddressInput {
  const ship = (order.shippingAddress ?? {}) as any
  return {
    name: order.customerName,
    address: ship.AddressLine1 ?? ship.addressLine1 ?? ship.street ?? null,
    address2: ship.AddressLine2 ?? ship.addressLine2 ?? null,
    city: ship.City ?? ship.city ?? null,
    postalCode: ship.PostalCode ?? ship.postalCode ?? null,
    country: ship.CountryCode ?? ship.countryCode ?? ship.country ?? null,
    state: ship.StateOrRegion ?? ship.stateOrProvince ?? ship.state ?? null,
    phone: ship.Phone ?? ship.phone ?? null,
    email: order.customerEmail,
  }
}

export const __test = { POSTAL_RE, ISO2_RE }

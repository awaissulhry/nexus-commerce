/**
 * Settings rebuild — Phase D
 *
 * Italian fiscal validators. Pure, deterministic — same function
 * runs in the browser (instant field-level feedback) and on the
 * Fastify side (strict server reject before save).
 *
 * Reference algorithms:
 *   • P.IVA (Partita IVA) — Agenzia delle Entrate spec. 11 digits,
 *     mod-11 Luhn-style with double-odd-positions.
 *   • Codice Fiscale (natural persons) — 16 alphanumeric:
 *       3 letters (surname) + 3 letters (given name) + 2 digits
 *       (year) + 1 month-letter + 2 digits (day, +40 for female)
 *       + 4 alphanumeric (place code) + 1 checksum letter.
 *     For companies, Codice Fiscale === P.IVA (11 digits).
 *     We accept both shapes and validate each accordingly.
 *   • SDI code — 7 uppercase alphanumeric. No checksum, but we
 *     enforce length + charset. "0000000" is the "no SDI, route by
 *     PEC" sentinel and is accepted as valid.
 *   • PEC email — standard email format; we don't gate on the
 *     ".pec." substring (some operators have legacy non-conformant
 *     PEC addresses and validating the domain would be more
 *     restrictive than the Agenzia delle Entrate accepts).
 */

export type FiscalCheck =
  | { valid: true }
  | { valid: false; reason: string }

const CODICE_FISCALE_RE = /^[A-Z0-9]{16}$/i
const SDI_RE = /^[A-Z0-9]{7}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ─── Partita IVA ──────────────────────────────────────────────────
// 11 digits. Sum of:
//   - odd positions (1,3,5,...,11) as-is
//   - even positions doubled; if doubled > 9, subtract 9
// Total mod 10 must be 0.

export function validatePiva(input: string): FiscalCheck {
  const piva = input.replace(/\s/g, '')
  if (piva.length === 0) return { valid: true } // empty = "not provided"
  if (!/^\d{11}$/.test(piva)) {
    return {
      valid: false,
      reason: 'P.IVA must be exactly 11 digits (no spaces, no IT prefix).',
    }
  }
  let sum = 0
  for (let i = 0; i < 11; i++) {
    const n = Number(piva[i])
    if (i % 2 === 0) {
      sum += n
    } else {
      const doubled = n * 2
      sum += doubled > 9 ? doubled - 9 : doubled
    }
  }
  if (sum % 10 !== 0) {
    return {
      valid: false,
      reason: 'P.IVA checksum failed — last digit does not match the others.',
    }
  }
  return { valid: true }
}

// ─── Codice Fiscale ───────────────────────────────────────────────
// Two valid forms:
//   1. Natural persons: 16 alphanumeric, with letter checksum at pos 16
//   2. Companies: identical to the P.IVA (11 digits)
//
// The 16-char checksum uses two lookup tables (odd vs even position),
// summed and mapped to A–Z. Reference:
// https://www.agenziaentrate.gov.it/portale/...

const CF_ODD_TABLE: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
}
const CF_EVEN_TABLE: Record<string, number> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
  U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
}
const CF_CHECK = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function validateCodiceFiscale(input: string): FiscalCheck {
  const cf = input.replace(/\s/g, '').toUpperCase()
  if (cf.length === 0) return { valid: true }
  // Company branch — identical to P.IVA.
  if (/^\d{11}$/.test(cf)) {
    return validatePiva(cf)
  }
  if (!CODICE_FISCALE_RE.test(cf)) {
    return {
      valid: false,
      reason:
        'Codice Fiscale must be 16 alphanumeric characters (natural person) or 11 digits (company).',
    }
  }
  // Natural-person path — checksum.
  let sum = 0
  for (let i = 0; i < 15; i++) {
    const ch = cf[i]
    const table = i % 2 === 0 ? CF_ODD_TABLE : CF_EVEN_TABLE
    const v = table[ch]
    if (v === undefined) {
      return {
        valid: false,
        reason: `Character "${ch}" at position ${i + 1} is invalid.`,
      }
    }
    sum += v
  }
  const expected = CF_CHECK[sum % 26]
  if (cf[15] !== expected) {
    return {
      valid: false,
      reason: `Checksum failed — expected "${expected}" but got "${cf[15]}".`,
    }
  }
  return { valid: true }
}

// ─── SDI code ──────────────────────────────────────────────────────
// 7 uppercase alphanumeric characters. "0000000" = "no SDI; route via
// PEC" — Agenzia delle Entrate explicitly accepts this when a PEC is
// also on file. We accept both.

export function validateSdi(input: string): FiscalCheck {
  const sdi = input.replace(/\s/g, '').toUpperCase()
  if (sdi.length === 0) return { valid: true }
  if (!SDI_RE.test(sdi)) {
    return {
      valid: false,
      reason: 'SDI code must be exactly 7 uppercase letters or digits.',
    }
  }
  return { valid: true }
}

// ─── PEC email ────────────────────────────────────────────────────
export function validatePec(input: string): FiscalCheck {
  const pec = input.trim()
  if (pec.length === 0) return { valid: true }
  if (!EMAIL_RE.test(pec)) {
    return { valid: false, reason: 'PEC must be a valid email address.' }
  }
  return { valid: true }
}

// ─── VAT scheme ────────────────────────────────────────────────────
export const VAT_SCHEMES = [
  {
    value: 'ORDINARIO',
    label: 'Ordinario',
    description: 'Regime IVA ordinario — standard 22% (or product-specific) rate.',
  },
  {
    value: 'FORFETTARIO',
    label: 'Forfettario',
    description: 'Regime forfettario per piccole imprese (revenue < €85k/yr).',
  },
  {
    value: 'OSS',
    label: 'OSS (Cross-border EU)',
    description: 'One-Stop Shop for B2C sales to other EU countries.',
  },
  {
    value: 'IOSS',
    label: 'IOSS (Import < €150)',
    description:
      'Import One-Stop Shop for goods ≤ €150 from outside the EU sold to consumers.',
  },
  {
    value: 'ESENTE',
    label: 'Esente IVA',
    description: 'VAT-exempt activity (art. 10 DPR 633/72).',
  },
] as const

export type VatScheme = (typeof VAT_SCHEMES)[number]['value']

export function isVatScheme(v: unknown): v is VatScheme {
  return (
    typeof v === 'string' &&
    VAT_SCHEMES.some((s) => s.value === v)
  )
}

// ─── B2B compliance gate ─────────────────────────────────────────
// Italian Agenzia delle Entrate requires every B2B invoice to route
// either through SDI OR a PEC mailbox. When the operator has provided
// P.IVA but no destination, surface a hard error.

export function validateInvoicingRouting(input: {
  piva: string
  sdiCode: string
  pecEmail: string
}): FiscalCheck {
  if (!input.piva.trim()) return { valid: true } // no P.IVA = not in Italian B2B scope
  const hasSdi = input.sdiCode.trim().length > 0
  const hasPec = input.pecEmail.trim().length > 0
  if (!hasSdi && !hasPec) {
    return {
      valid: false,
      reason:
        'Italian B2B invoicing requires either an SDI code or a PEC email (one of the two is mandatory).',
    }
  }
  return { valid: true }
}

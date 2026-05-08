// AU.8 — Italian Codice Fiscale + Partita IVA checksum validators.
//
// Replaces FU.3's format-only check (length + character class) with
// proper algorithmic validation. Why it matters:
//   - Customers will mistype their CF/PIVA. Format-only validators
//     accept "RSSMRA85T10A562X" even when the control char is wrong,
//     and the bad data only fails downstream when SDI rejects the
//     FatturaPA — by which point the buyer is gone.
//   - "ABCDEFGHIJKLMNOP" passes a [A-Z0-9]{16} check. The checksum
//     catches pure typos before they reach FatturaPA generation.
//
// Sources:
//   CF — DM 23 Dec 1976 + Agenzia delle Entrate guidance
//   PIVA — Italian fiscal code Mod-11 (a.k.a. Luhn-mod-10)
//
// Both functions are pure and synchronous — no DB lookups; we don't
// validate that the CF actually corresponds to a real registered
// person (that requires AdE's lookup service, separate integration).

const CF_ODD: Record<string, number> = {
  '0': 1,  '1': 0,  '2': 5,  '3': 7,  '4': 9,
  '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1,  B: 0,  C: 5,  D: 7,  E: 9,  F: 13, G: 15, H: 17,
  I: 19, J: 21, K: 2,  L: 4,  M: 18, N: 20, O: 11, P: 3,
  Q: 6,  R: 8,  S: 12, T: 14, U: 16, V: 10, W: 22, X: 25,
  Y: 24, Z: 23,
}

const CF_EVEN: Record<string, number> = {
  '0': 0,  '1': 1,  '2': 2,  '3': 3,  '4': 4,
  '5': 5,  '6': 6,  '7': 7,  '8': 8,  '9': 9,
  A: 0,  B: 1,  C: 2,  D: 3,  E: 4,  F: 5,  G: 6,  H: 7,
  I: 8,  J: 9,  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15,
  Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23,
  Y: 24, Z: 25,
}

/**
 * Validate an Italian Codice Fiscale (16-char form for individuals).
 *
 * Returns null on success, or an error string for surfacing to the
 * user. Caller should already have uppercased + trimmed.
 *
 * Note: we accept ONLY the 16-char individual form. Companies use
 * the 11-digit form which is identical to a PIVA — validate those
 * with validatePartitaIva instead.
 */
export function validateCodiceFiscale(cf: string): string | null {
  if (cf.length !== 16) {
    return 'Codice Fiscale must be 16 characters'
  }
  if (!/^[A-Z0-9]{16}$/.test(cf)) {
    return 'Codice Fiscale must be uppercase letters + digits only'
  }
  let sum = 0
  for (let i = 0; i < 15; i++) {
    const ch = cf[i]
    // 1-based position parity: position 1 (i=0) is "odd" per spec.
    const v = (i % 2 === 0 ? CF_ODD : CF_EVEN)[ch]
    if (v === undefined) {
      return `Codice Fiscale has invalid character "${ch}"`
    }
    sum += v
  }
  const expected = String.fromCharCode('A'.charCodeAt(0) + (sum % 26))
  if (cf[15] !== expected) {
    return `Codice Fiscale checksum failed (expected control char "${expected}", got "${cf[15]}")`
  }
  return null
}

/**
 * Validate an Italian Partita IVA (11 digits, Luhn-mod-10 / "Mod 11
 * fiscale" — same algorithm despite the misleading legacy name).
 *
 * Caller should already have stripped any leading "IT" / spaces.
 */
export function validatePartitaIva(piva: string): string | null {
  if (!/^[0-9]{11}$/.test(piva)) {
    return 'Partita IVA must be 11 digits'
  }
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const d = piva.charCodeAt(i) - 48
    if (i % 2 === 0) {
      // Odd positions (1st, 3rd, …) → digit as-is.
      sum += d
    } else {
      // Even positions → double; if >9, subtract 9 (== sum of digits).
      const x = d * 2
      sum += x > 9 ? x - 9 : x
    }
  }
  const control = (10 - (sum % 10)) % 10
  const last = piva.charCodeAt(10) - 48
  if (control !== last) {
    return `Partita IVA checksum failed (expected control digit ${control}, got ${last})`
  }
  return null
}

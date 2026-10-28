/**
 * Italian tax identifiers, checked offline: format and check character. Whether a number is registered is checked
 * by SDI against the tax register (errors 00305, 00306) and, for EU numbers, by VIES (B-W1-07); not here.
 */

/** Uppercase, without spaces: the form the checks and FatturaPA use. */
export function normalizeTaxId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

/**
 * Partita IVA: 11 digits, the last a check digit (Luhn-style: odd positions as they are, even positions doubled
 * with 9 subtracted above 9). Also the form of a company's numeric codice fiscale.
 */
export function isValidPartitaIva(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false
  let total = 0
  for (let i = 0; i < 10; i++) {
    const digit = value.charCodeAt(i) - 48
    if (i % 2 === 0) total += digit
    else total += digit * 2 > 9 ? digit * 2 - 9 : digit * 2
  }
  return (10 - (total % 10)) % 10 === value.charCodeAt(10) - 48
}

// Codice fiscale check character tables (DM 23.12.1976): values of the characters in odd and even positions.
const ODD_VALUES: Readonly<Record<string, number>> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
}

function evenValue(char: string): number {
  const code = char.charCodeAt(0)
  return code >= 48 && code <= 57 ? code - 48 : code - 65
}

// Surname (3), name (3), year (2), month letter, day (2, +40 for women), place code (letter + 3), check letter.
// Digits may be replaced by the letters LMNPQRSTUV (omocodia).
const PERSONAL_CODICE_FISCALE =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/

/** A person's codice fiscale: 16 characters with a valid check letter. */
export function isValidPersonalCodiceFiscale(value: string): boolean {
  if (!PERSONAL_CODICE_FISCALE.test(value)) return false
  let total = 0
  for (let i = 0; i < 15; i++) {
    const char = value[i]!
    total += i % 2 === 0 ? ODD_VALUES[char]! : evenValue(char)
  }
  return String.fromCharCode(65 + (total % 26)) === value[15]
}

/** Any codice fiscale: a person's (16 characters) or a company's or body's (11 digits). */
export function isValidCodiceFiscale(value: string): boolean {
  return value.length === 11 ? isValidPartitaIva(value) : isValidPersonalCodiceFiscale(value)
}

/**
 * A foreign tax identifier as FatturaPA carries it in IdCodice: 1 to 28 letters or digits, without the country
 * prefix (an EU VAT number DE123456789 is IdPaese DE, IdCodice 123456789). SDI does not check foreign numbers.
 */
export function isValidForeignTaxId(value: string): boolean {
  return /^[A-Z0-9]{1,28}$/.test(value)
}

/** IBAN: country, check digits, account; checked with ISO 7064 mod 97-10. */
export function isValidIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false
  const rearranged = value.slice(4) + value.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const code = char.charCodeAt(0)
    const digits = code >= 65 ? String(code - 55) : char
    for (const digit of digits) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
  }
  return remainder === 1
}

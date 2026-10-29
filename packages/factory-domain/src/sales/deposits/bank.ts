import type { Issue } from '../../core/errors'
import { isValidIban } from '../../tax/tax-ids'
import type { BankDetails } from './deposits'

/**
 * A company's bank account (Q12: deposits are paid by bank transfer; FatturaPA DatiPagamento MP05), pure: what may be
 * stored (factory-db Company.bankAccountHolder, iban, bic, bankName; the …_company_bank_details_guards trigger holds the
 * shape for every login) and how a change is shown. A changed IBAN is a classic fraud vector: the API writes it only with
 * a step-up, audits it from → to and tells the owners and administrators (event company.bank_details_changed, which
 * carries the IBAN masked).
 *
 *   IBAN     ISO 13616: a country of the IBAN registry (the SEPA countries below) with its exact length, two check digits
 *            (ISO 7064 mod 97-10, tax/tax-ids isValidIban); stored upper case without spaces
 *   BIC      ISO 9362, optional: 4 letters (bank), 2 letters (country), 2 letters or digits (location), 3 optional (branch)
 *   holder   who the account is in the name of: 2 to 70 characters (SEPA credit transfer: 70)
 *   bank     the bank's name, optional: at most 100 characters
 */

/** The IBAN length of each SEPA country (the SWIFT IBAN registry). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23,
  GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
})

const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/

/** An IBAN as stored: upper case, without spaces. */
export const normaliseIban = (value: string): string => value.replace(/\s+/g, '').toUpperCase()

/** An IBAN as a notice shows it: the country, the check digits and the last four characters (`IT60…3456`). */
export const maskIban = (iban: string | null): string | null => (iban === null ? null : `${iban.slice(0, 4)}…${iban.slice(-4)}`)

export interface BankDetailsInput {
  readonly accountHolder: string | null
  readonly iban: string | null
  readonly bic: string | null
  readonly bankName: string | null
}

/** The account as stored (normalised), or null to remove it; a ValidationError's issues otherwise. */
export function bankDetailsOf(input: BankDetailsInput, at = 'body'): { readonly value: BankDetails | null } | { readonly issues: Issue[] } {
  const trimmed = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim())
  const holder = trimmed(input.accountHolder)
  const iban = input.iban === null || input.iban.trim() === '' ? null : normaliseIban(input.iban)
  const bic = input.bic === null || input.bic.trim() === '' ? null : input.bic.replace(/\s+/g, '').toUpperCase()
  const bankName = trimmed(input.bankName)
  if (iban === null) {
    if (holder === null && bic === null && bankName === null) return { value: null }
    return { issues: [{ path: `${at}/iban`, message: 'Give the IBAN, or clear every bank field to remove the account.' }] }
  }
  const issues: Issue[] = []
  const length = IBAN_LENGTHS[iban.slice(0, 2)]
  if (length === undefined) issues.push({ path: `${at}/iban`, message: 'Not an IBAN of a SEPA country.' })
  else if (iban.length !== length) issues.push({ path: `${at}/iban`, message: `An IBAN of ${iban.slice(0, 2)} has ${length} characters.` })
  else if (!isValidIban(iban)) issues.push({ path: `${at}/iban`, message: 'The IBAN check digits do not match: check it again.' })
  if (holder === null || holder.length < 2 || holder.length > 70) issues.push({ path: `${at}/accountHolder`, message: 'Name the account holder (2 to 70 characters).' })
  if (bic !== null && !BIC.test(bic)) issues.push({ path: `${at}/bic`, message: 'A BIC has 8 or 11 letters and digits.' })
  if (bankName !== null && bankName.length > 100) issues.push({ path: `${at}/bankName`, message: 'At most 100 characters.' })
  if (issues.length > 0) return { issues }
  return { value: { accountHolder: holder!, iban, bic, bankName } }
}

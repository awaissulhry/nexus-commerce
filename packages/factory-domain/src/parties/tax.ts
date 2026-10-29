import type { Issue } from '../core/errors'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { isEuMemberState } from '../tax/eu'
import { isValidCodiceFiscale, isValidForeignTaxId, isValidPartitaIva, normalizeTaxId } from '../tax/tax-ids'
import { countryFitsTaxMode, type CustomerTaxProfile } from '../tax/vat-treatment'
import { isCountryCode } from './geo'
import type { PartyKind } from './rules'

/**
 * A party's tax identity (feature SAL-005; D.Lgs. 127/2015, DPR 633/1972), pure: what an e-invoice to it needs and
 * which VAT rules apply to it. A change from a date is a new identity; the identity at a date is the one with the
 * newest `validFrom` on or before it (`identityAt`). Issued documents keep their own copy.
 *
 * One canonical form for every number (`normaliseTaxIdentity`), so equal numbers compare equal and the duplicate check
 * (`taxKeysOf`) holds: no spaces, dots, dashes or slashes, capital letters; an Italian or EU VAT number WITH its VAT prefix (IT…,
 * DE…; EL for Greece, which is GR as a country), a codice fiscale in capitals, a PEC in lower case.
 *
 *   IT_B2B    Italian business: a Partita IVA (IT + 11 digits with its check digit); optional codice fiscale (a
 *             company's 11 digits or a sole trader's 16 characters); an SDI recipient code (7 characters) and/or a PEC.
 *             Without either, invoices land in the customer's fiscal drawer (code 0000000): allowed, warned about.
 *   IT_B2C    Italian consumer, or a body with a codice fiscale only: the codice fiscale, no VAT number.
 *   EU_B2B    business in another EU state: its VAT number in that state's format (VIES checks it; ./vies.ts).
 *   EU_B2C    consumer in another EU state: no tax number.
 *   EXTRA_EU  outside the EU: optionally its foreign tax id (FatturaPA IdCodice, 1 to 28 letters and digits).
 * SDI codes and PEC are Italian: a foreign customer's invoice carries XXXXXXX (the FatturaPA builder writes it).
 * A 6-character code is a public administration's office code: invoicing the public administration is not built.
 *
 * Offline checks only (format and check digits where they exist); whether a number is registered is SDI's and VIES's.
 */

export const PARTY_TAX_MODES = ['IT_B2B', 'IT_B2C', 'EU_B2B', 'EU_B2C', 'EXTRA_EU'] as const
export type PartyTaxMode = (typeof PARTY_TAX_MODES)[number]

/** "Invoices go to the fiscal drawer / to the PEC": the code an Italian invoice carries without a real one. */
export const NO_SDI_CODE = '0000000'

export interface TaxIdentityFields {
  readonly country: string
  readonly taxMode: PartyTaxMode
  readonly vatNumber: string | null
  readonly fiscalCode: string | null
  readonly sdiRecipientCode: string | null
  readonly pec: string | null
  readonly validFrom: BusinessDate
}
export type TaxIdentityField = keyof TaxIdentityFields
export const TAX_IDENTITY_FIELDS: readonly TaxIdentityField[] = Object.freeze(['country', 'taxMode', 'vatNumber', 'fiscalCode', 'sdiRecipientCode', 'pec', 'validFrom'])

/** The VAT prefix of a country: its ISO code, but EL for Greece (VIES and the VAT directive). */
export const vatPrefixOf = (country: string): string => (country === 'GR' ? 'EL' : country)
/** The country of a VAT prefix: GR for EL. */
export const countryOfVatPrefix = (prefix: string): string => (prefix === 'EL' ? 'GR' : prefix)

/**
 * Each EU state's VAT number after its prefix (Council Directive 2006/112/EC art. 215; the formats VIES documents).
 * Only Italy's check digit is checked offline (tax/tax-ids); VIES answers for the rest.
 */
export const EU_VAT_FORMATS: Readonly<Record<string, { readonly pattern: RegExp; readonly shape: string }>> = Object.freeze({
  AT: { pattern: /^U\d{8}$/, shape: 'U and 8 digits' },
  BE: { pattern: /^[01]\d{9}$/, shape: '10 digits starting with 0 or 1' },
  BG: { pattern: /^\d{9,10}$/, shape: '9 or 10 digits' },
  CY: { pattern: /^\d{8}[A-Z]$/, shape: '8 digits and a letter' },
  CZ: { pattern: /^\d{8,10}$/, shape: '8 to 10 digits' },
  DE: { pattern: /^\d{9}$/, shape: '9 digits' },
  DK: { pattern: /^\d{8}$/, shape: '8 digits' },
  EE: { pattern: /^\d{9}$/, shape: '9 digits' },
  EL: { pattern: /^\d{9}$/, shape: '9 digits' },
  ES: { pattern: /^(?:[A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])$/, shape: '9 characters: a letter and 8 characters, or 8 digits and a letter' },
  FI: { pattern: /^\d{8}$/, shape: '8 digits' },
  FR: { pattern: /^[0-9A-HJ-NP-Z]{2}\d{9}$/, shape: '2 check characters and 9 digits' },
  HR: { pattern: /^\d{11}$/, shape: '11 digits' },
  HU: { pattern: /^\d{8}$/, shape: '8 digits' },
  IE: { pattern: /^(?:\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/, shape: '7 digits and 1 or 2 letters' },
  IT: { pattern: /^\d{11}$/, shape: '11 digits' },
  LT: { pattern: /^(?:\d{9}|\d{12})$/, shape: '9 or 12 digits' },
  LU: { pattern: /^\d{8}$/, shape: '8 digits' },
  LV: { pattern: /^\d{11}$/, shape: '11 digits' },
  MT: { pattern: /^\d{8}$/, shape: '8 digits' },
  NL: { pattern: /^\d{9}B\d{2}$/, shape: '9 digits, B and 2 digits' },
  PL: { pattern: /^\d{10}$/, shape: '10 digits' },
  PT: { pattern: /^\d{9}$/, shape: '9 digits' },
  RO: { pattern: /^[1-9]\d{1,9}$/, shape: '2 to 10 digits' },
  SE: { pattern: /^\d{10}01$/, shape: '12 digits ending in 01' },
  SI: { pattern: /^[1-9]\d{7}$/, shape: '8 digits' },
  SK: { pattern: /^[1-9]\d{9}$/, shape: '10 digits' },
})

const EU_PREFIXES = new Set(Object.keys(EU_VAT_FORMATS))

/** A tax number as typed, without spaces, dots, dashes or slashes, in capitals. */
export const compactTaxNumber = (value: string): string => normalizeTaxId(value).replace(/[./\-]/g, '')

/** "DE123456789" → { prefix: 'DE', number: '123456789' }; null when it starts with no EU VAT prefix. */
export function splitEuVatNumber(vatNumber: string): { readonly prefix: string; readonly number: string } | null {
  const prefix = vatNumber.slice(0, 2)
  return EU_PREFIXES.has(prefix) ? { prefix, number: vatNumber.slice(2) } : null
}

/**
 * A VAT number in its canonical form for the tax mode: an Italian or EU number gets its country's prefix when it was
 * typed without one (a number typed with another EU prefix keeps it, and the check names the mismatch); a foreign tax
 * id outside the EU stays as typed, compacted.
 */
export function canonicalVatNumber(value: string | null | undefined, country: string, taxMode: PartyTaxMode): string | null {
  if (value === null || value === undefined) return null
  const compact = compactTaxNumber(value)
  if (compact === '') return null
  if (taxMode === 'EXTRA_EU') return compact
  return splitEuVatNumber(compact) ? compact : `${vatPrefixOf(country)}${compact}`
}

/** What is wrong with an EU VAT number for its country (prefix and shape; Italy's check digit), or null. */
export function euVatNumberProblem(vatNumber: string, country: string): string | null {
  const expected = vatPrefixOf(country)
  const split = splitEuVatNumber(vatNumber)
  if (!split || split.prefix !== expected) return `A VAT number of ${country} starts with ${expected}.`
  const format = EU_VAT_FORMATS[expected]
  if (!format) return `${country} is not an EU member state.`
  if (!format.pattern.test(split.number)) return `A VAT number of ${country} is ${expected} and ${format.shape}.`
  if (expected === 'IT' && !isValidPartitaIva(split.number)) return 'This Partita IVA has a wrong check digit: compare it with the customer\'s invoices or visura.'
  return null
}

export interface TaxIdentityInput {
  readonly country: string
  readonly taxMode: PartyTaxMode
  readonly vatNumber?: string | null | undefined
  readonly fiscalCode?: string | null | undefined
  readonly sdiRecipientCode?: string | null | undefined
  readonly pec?: string | null | undefined
  readonly validFrom: BusinessDate
}

const compactOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const compact = compactTaxNumber(value)
  return compact === '' ? null : compact
}
const lowerOrNull = (value: string | null | undefined): string | null => {
  const text = value?.trim().toLowerCase() ?? ''
  return text === '' ? null : text
}

/** The canonical form of an identity (see the module comment). */
export function normaliseTaxIdentity(input: TaxIdentityInput): TaxIdentityFields {
  const country = input.country.trim().toUpperCase()
  return {
    country,
    taxMode: input.taxMode,
    vatNumber: canonicalVatNumber(input.vatNumber, country, input.taxMode),
    fiscalCode: compactOrNull(input.fiscalCode),
    sdiRecipientCode: compactOrNull(input.sdiRecipientCode),
    pec: lowerOrNull(input.pec),
    validFrom: input.validFrom,
  }
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/
export const isEmailAddress = (value: string): boolean => value.length <= 254 && EMAIL.test(value)

/** Every rule of a tax identity; issue paths are field names. */
export function taxIdentityProblems(identity: TaxIdentityFields): Issue[] {
  const issues: Issue[] = []
  const { country, taxMode, vatNumber, fiscalCode, sdiRecipientCode, pec } = identity
  if (!(PARTY_TAX_MODES as readonly string[]).includes(taxMode)) return [{ path: 'taxMode', message: `Expected one of ${PARTY_TAX_MODES.join(', ')}.` }]
  if (!isCountryCode(country)) issues.push({ path: 'country', message: 'Expected an ISO 3166-1 country code (IT, DE, FR…).' })
  else if (!countryFitsTaxMode(taxMode, country)) {
    const fits = taxMode.startsWith('IT_') ? 'IT' : taxMode.startsWith('EU_') ? 'an EU member state other than Italy' : 'a country outside the EU'
    issues.push({ path: 'country', message: `Tax mode ${taxMode} is for ${fits}.` })
  }
  if (!isBusinessDate(identity.validFrom)) issues.push({ path: 'validFrom', message: 'Expected a calendar day written YYYY-MM-DD.' })

  const italian = taxMode === 'IT_B2B' || taxMode === 'IT_B2C'
  const countryFits = isCountryCode(country) && countryFitsTaxMode(taxMode, country)
  // The VAT number (its shape only once the country fits the mode: one mistake, one message).
  if (taxMode === 'IT_B2B' || taxMode === 'EU_B2B') {
    if (vatNumber === null) issues.push({ path: 'vatNumber', message: taxMode === 'IT_B2B' ? 'An Italian business has a Partita IVA.' : 'A business in another EU state has a VAT number (VIES checks it).' })
    else if (countryFits && isEuMemberState(country)) {
      const problem = euVatNumberProblem(vatNumber, country)
      if (problem) issues.push({ path: 'vatNumber', message: problem })
    }
  } else if (taxMode === 'EXTRA_EU') {
    if (vatNumber !== null && !isValidForeignTaxId(vatNumber)) issues.push({ path: 'vatNumber', message: 'A foreign tax id is 1 to 28 letters or digits.' })
  } else if (vatNumber !== null) {
    issues.push({ path: 'vatNumber', message: taxMode === 'IT_B2C' ? 'A party with a Partita IVA is an Italian business (IT_B2B).' : 'A party with a VAT number is a business (EU_B2B).' })
  }
  // The codice fiscale.
  if (italian) {
    if (fiscalCode === null) {
      if (taxMode === 'IT_B2C') issues.push({ path: 'fiscalCode', message: 'An Italian consumer is invoiced with the codice fiscale.' })
    } else if (!isValidCodiceFiscale(fiscalCode)) {
      issues.push({ path: 'fiscalCode', message: 'Expected a codice fiscale: 16 characters for a person, 11 digits for a company, with its check character.' })
    }
  } else if (fiscalCode !== null) {
    issues.push({ path: 'fiscalCode', message: 'A codice fiscale is for an Italian party.' })
  }
  // Where SDI delivers.
  if (italian) {
    if (sdiRecipientCode !== null) {
      if (/^[A-Z0-9]{6}$/.test(sdiRecipientCode)) issues.push({ path: 'sdiRecipientCode', message: 'A 6-character code is a public administration office: invoicing the public administration is not built.' })
      else if (!/^[A-Z0-9]{7}$/.test(sdiRecipientCode) || sdiRecipientCode === 'XXXXXXX') issues.push({ path: 'sdiRecipientCode', message: 'Expected the 7-character SDI recipient code (codice destinatario), or 0000000.' })
    }
    if (pec !== null && !isEmailAddress(pec)) issues.push({ path: 'pec', message: 'Expected a PEC address.' })
  } else {
    if (sdiRecipientCode !== null && sdiRecipientCode !== 'XXXXXXX') issues.push({ path: 'sdiRecipientCode', message: 'An SDI recipient code is for an Italian party; a foreign invoice carries XXXXXXX.' })
    if (pec !== null) issues.push({ path: 'pec', message: 'A PEC address is for an Italian party.' })
  }
  return issues
}

/** XXXXXXX on a foreign identity is what the builder writes anyway: kept as null. */
export function storedSdiCode(identity: TaxIdentityFields): string | null {
  return identity.sdiRecipientCode === 'XXXXXXX' ? null : identity.sdiRecipientCode
}

export type TaxIdentityOutcome = { readonly ok: true; readonly identity: TaxIdentityFields } | { readonly ok: false; readonly issues: readonly Issue[] }

export function checkTaxIdentity(input: TaxIdentityInput): TaxIdentityOutcome {
  const normal = normaliseTaxIdentity(input)
  const identity = { ...normal, sdiRecipientCode: storedSdiCode(normal) }
  const issues = taxIdentityProblems(normal)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, identity }
}

/** The tax mode a party most likely has, for a form's default and an import that leaves it out. */
export function suggestTaxMode(party: { readonly country: string; readonly hasVatNumber: boolean }): PartyTaxMode {
  // A VAT number makes a business; an organisation without one in the EU is a body or a consumer-like customer
  // (invoiced with VAT), never zero-rated.
  if (party.country === 'IT') return party.hasVatNumber ? 'IT_B2B' : 'IT_B2C'
  if (isEuMemberState(party.country)) return party.hasVatNumber ? 'EU_B2B' : 'EU_B2C'
  return 'EXTRA_EU'
}

/** The identity in force on a day: the newest validFrom on or before it; null before the first. */
export function identityAt<Identity extends { readonly validFrom: BusinessDate }>(identities: readonly Identity[], date: BusinessDate): Identity | null {
  let found: Identity | null = null
  for (const identity of identities) if (identity.validFrom <= date && (found === null || identity.validFrom > found.validFrom)) found = identity
  return found
}

/**
 * The numbers another party of the tenant may not hold too (the duplicate check: one record per business partner).
 * A company's codice fiscale is usually its Partita IVA's 11 digits, so each counts as the other: another party whose
 * VAT number is in `vatNumbers` or whose codice fiscale is in `fiscalCodes` is the same partner.
 */
export function taxKeysOf(identity: Pick<TaxIdentityFields, 'vatNumber' | 'fiscalCode'>): { readonly vatNumbers: readonly string[]; readonly fiscalCodes: readonly string[] } {
  const vatNumbers = new Set<string>()
  const fiscalCodes = new Set<string>()
  if (identity.vatNumber !== null) {
    vatNumbers.add(identity.vatNumber)
    if (/^IT\d{11}$/.test(identity.vatNumber)) fiscalCodes.add(identity.vatNumber.slice(2))
  }
  if (identity.fiscalCode !== null) {
    fiscalCodes.add(identity.fiscalCode)
    if (/^\d{11}$/.test(identity.fiscalCode)) vatNumbers.add(`IT${identity.fiscalCode}`)
  }
  return { vatNumbers: [...vatNumbers].sort(), fiscalCodes: [...fiscalCodes].sort() }
}

/**
 * What the VAT treatment (tax/vat-treatment decideVatTreatment) needs to know of a customer: its tax mode, whether a
 * current VIES check proves its EU VAT number valid, and for a customer outside the EU whether it is a business (an
 * organisation, or anyone with a tax id).
 */
export function customerTaxProfile(party: { readonly kind: PartyKind }, identity: Pick<TaxIdentityFields, 'taxMode' | 'vatNumber'>, viesValid: boolean): CustomerTaxProfile {
  if (identity.taxMode === 'EU_B2B') return { taxMode: 'EU_B2B', viesValid }
  if (identity.taxMode === 'EXTRA_EU') return { taxMode: 'EXTRA_EU', extraEuBusiness: party.kind === 'ORGANISATION' || identity.vatNumber !== null }
  return { taxMode: identity.taxMode }
}

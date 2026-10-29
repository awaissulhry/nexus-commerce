import type { Issue } from '../core/errors'
import { isCountryCode, isItalianProvince } from './geo'
import { cleanNote, cleanText } from './rules'

/**
 * A party's addresses (feature SAL-003; plan A1 §2.4 A), pure: its registered office (FatturaPA's Sede), where its
 * invoices go (BILL_TO), where goods are delivered (SHIP_TO: the DDT's destination and the carrier label) or collected
 * (PICKUP: a supplier's ship-from). Many per party; one address can serve several uses. One default bill-to and one
 * default ship-to per party (`isDefaultBillTo`, `isDefaultShipTo`): the module clears the old default in the same
 * command. An address in use is archived, never deleted (quotes and shipments point at it).
 *
 *   line 1, line 2   at most 60 characters each (FatturaPA's Indirizzo and a carrier label carry no more)
 *   postal code      Italy: 5 digits (CAP); elsewhere 1 to 12 letters, digits, spaces or dashes
 *   city             at most 60 characters (FatturaPA's Comune)
 *   province         Italy: the two-letter sigla, required (FatturaPA's Provincia, the DDT); elsewhere an optional
 *                    region of at most 40 characters
 *   phone            digits with + ( ) . / - and spaces, 5 to 30 characters, at least 5 digits
 */

export const ADDRESS_KINDS = ['REGISTERED', 'BILL_TO', 'SHIP_TO', 'PICKUP'] as const
export type AddressKind = (typeof ADDRESS_KINDS)[number]
export const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type MasterStatus = (typeof MASTER_STATUSES)[number]

export interface AddressFields {
  readonly kinds: readonly AddressKind[]
  readonly name: string | null
  readonly line1: string
  readonly line2: string | null
  readonly postalCode: string
  readonly city: string
  readonly province: string | null
  readonly country: string
  readonly contactName: string | null
  readonly phone: string | null
  readonly deliveryNotes: string | null
}
export type AddressField = keyof AddressFields
export const ADDRESS_FIELDS: readonly AddressField[] = Object.freeze(['kinds', 'name', 'line1', 'line2', 'postalCode', 'city', 'province', 'country', 'contactName', 'phone', 'deliveryNotes'])

export type AddressInput = { readonly [Field in AddressField]?: AddressFields[Field] | undefined } & {
  readonly kinds: readonly AddressKind[]
  readonly line1: string
  readonly postalCode: string
  readonly city: string
  readonly country: string
}

const PHONE = /^\+?[0-9 ()./-]{5,30}$/
export const phoneProblem = (phone: string): string | null =>
  PHONE.test(phone) && (phone.match(/\d/g)?.length ?? 0) >= 5 ? null : 'Expected a phone number: digits, with + ( ) . / - and spaces.'

/** Each kind once, in the enum's order. */
export const normaliseKinds = (kinds: readonly AddressKind[]): AddressKind[] => ADDRESS_KINDS.filter((kind) => kinds.includes(kind))

export function normaliseAddress(input: AddressInput): AddressFields {
  const upper = (value: string | null | undefined) => cleanText(value)?.toUpperCase() ?? null
  return {
    kinds: normaliseKinds(input.kinds),
    name: cleanText(input.name),
    line1: cleanText(input.line1) ?? '',
    line2: cleanText(input.line2),
    postalCode: upper(input.postalCode) ?? '',
    city: cleanText(input.city) ?? '',
    province: upper(input.province),
    country: upper(input.country) ?? '',
    contactName: cleanText(input.contactName),
    phone: cleanText(input.phone),
    deliveryNotes: cleanNote(input.deliveryNotes),
  }
}

const tooLong = (path: string, value: string | null, max: number): Issue[] => (value !== null && value.length > max ? [{ path, message: `At most ${max} characters.` }] : [])

/** Every rule of an address; issue paths are field names. */
export function addressProblems(address: AddressFields): Issue[] {
  const issues: Issue[] = []
  if (address.kinds.length === 0) issues.push({ path: 'kinds', message: `Say what the address is for: ${ADDRESS_KINDS.join(', ')}.` })
  if (address.kinds.some((kind) => !(ADDRESS_KINDS as readonly string[]).includes(kind))) issues.push({ path: 'kinds', message: `Expected kinds from ${ADDRESS_KINDS.join(', ')}.` })
  if (address.line1 === '') issues.push({ path: 'line1', message: 'The street and number are needed.' })
  issues.push(...tooLong('name', address.name, 80), ...tooLong('line1', address.line1, 60), ...tooLong('line2', address.line2, 60), ...tooLong('city', address.city, 60))
  if (address.city === '') issues.push({ path: 'city', message: 'The city is needed.' })
  if (!isCountryCode(address.country)) issues.push({ path: 'country', message: 'Expected an ISO 3166-1 country code (IT, DE, FR…).' })
  if (address.country === 'IT') {
    if (!/^\d{5}$/.test(address.postalCode)) issues.push({ path: 'postalCode', message: 'An Italian CAP is 5 digits.' })
    if (address.province === null) issues.push({ path: 'province', message: 'An Italian address has its province (the two-letter sigla: MI, FI, PI…).' })
    else if (!isItalianProvince(address.province)) issues.push({ path: 'province', message: 'Expected the two-letter sigla of an Italian province (MI, FI, PI…).' })
  } else {
    if (!/^[A-Z0-9](?:[A-Z0-9 -]{0,10}[A-Z0-9])?$/.test(address.postalCode)) issues.push({ path: 'postalCode', message: 'Expected a postal code: 1 to 12 letters, digits, spaces or dashes.' })
    issues.push(...tooLong('province', address.province, 40))
  }
  issues.push(...tooLong('contactName', address.contactName, 100), ...tooLong('deliveryNotes', address.deliveryNotes, 500))
  if (address.phone !== null) {
    const problem = phoneProblem(address.phone)
    if (problem) issues.push({ path: 'phone', message: problem })
  }
  return issues
}

/** A default flag needs the use: the default bill-to is a BILL_TO address, the default ship-to a SHIP_TO one. */
export function defaultProblems(kinds: readonly AddressKind[], defaults: { readonly isDefaultBillTo: boolean; readonly isDefaultShipTo: boolean }): Issue[] {
  const issues: Issue[] = []
  if (defaults.isDefaultBillTo && !kinds.includes('BILL_TO')) issues.push({ path: 'isDefaultBillTo', message: 'The default invoice address is a BILL_TO address.' })
  if (defaults.isDefaultShipTo && !kinds.includes('SHIP_TO')) issues.push({ path: 'isDefaultShipTo', message: 'The default delivery address is a SHIP_TO address.' })
  return issues
}

export type AddressOutcome = { readonly ok: true; readonly address: AddressFields } | { readonly ok: false; readonly issues: readonly Issue[] }

export function checkAddress(input: AddressInput): AddressOutcome {
  const address = normaliseAddress(input)
  const issues = addressProblems(address)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, address }
}

const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b)

/** A change of an address: the patch over its fields, every rule, and the fields that changed. */
export function changeAddress(
  current: AddressFields,
  patch: { readonly [Field in AddressField]?: AddressFields[Field] | undefined },
): { readonly ok: true; readonly address: AddressFields; readonly changed: readonly AddressField[] } | { readonly ok: false; readonly issues: readonly Issue[] } {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<AddressFields>
  const outcome = checkAddress({ ...current, ...given })
  if (!outcome.ok) return outcome
  return { ok: true, address: outcome.address, changed: ADDRESS_FIELDS.filter((field) => !same(current[field], outcome.address[field])) }
}

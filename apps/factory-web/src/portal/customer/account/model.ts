import type { Locale } from '../../../lib/i18n/locales'
import { NAME_MAX, type Tone } from '../../shared/account/model'
import type { CompanyData, DeliveryAddress, PartyAddressLines } from './api'

/**
 * The customer's Account page, the pure part (B-W2b-196, SCR-188; design portal.customer.account): what each section shows
 * and why an action waits, with no API and no screen. Words are `portal-account` keys (the view translates them) or come
 * from the API in both languages; the API's English never reaches the screen. Colleagues, the hand-over, sessions and the
 * step-up are the shared account rules (../../shared/account/model.ts, lifted by B-W2b-193).
 */

export const ACCOUNT_PATH = '/account'
export const SECTIONS = ['profile', 'emails', 'users', 'addresses', 'company', 'security'] as const
export type AccountSection = (typeof SECTIONS)[number]

// ── my profile ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProfileDraft {
  displayName: string
  locale: Locale
}

/** How many fields of the profile differ from what is saved. */
export function profileChanges(saved: ProfileDraft, draft: ProfileDraft): number {
  return (draft.displayName.trim() !== saved.displayName ? 1 : 0) + (draft.locale !== saved.locale ? 1 : 0)
}

/** Why the profile cannot be saved as it is (a `portal-account` key), or null. */
export function profileProblem(draft: ProfileDraft): string | null {
  const name = draft.displayName.trim()
  if (name === '') return 'profile.nameNeeded'
  if (name.length > NAME_MAX) return 'profile.nameTooLong'
  return null
}

/** What the profile's Save sends: only what changed. */
export function profileBody(saved: ProfileDraft, draft: ProfileDraft): { displayName?: string; locale?: Locale } {
  return {
    ...(draft.displayName.trim() !== saved.displayName ? { displayName: draft.displayName.trim() } : {}),
    ...(draft.locale !== saved.locale ? { locale: draft.locale } : {}),
  }
}

// ── delivery addresses ───────────────────────────────────────────────────────────────────────────────────────────────────
export type AddressState = 'APPROVED' | 'OURS' | 'WAITING' | 'REFUSED' | 'REMOVED'

export interface AddressRow {
  id: string
  name: string | null
  /** The address on one line. */
  line: string
  contact: string | null
  notes: string | null
  isDefault: boolean
  state: AddressState
  tone: Tone
  /** Our refusal's reason (their words to us, as the office typed them). */
  reason: string | null
  /** Who added it: a colleague (named; `you`) or the factory. */
  addedBy: { kind: 'COLLEAGUE' | 'FACTORY'; name: string | null; you: boolean }
  requestedAt: string | null
  decidedAt: string | null
  /** May an order use it now (approved, or one of ours, and active). */
  usable: boolean
  version: number
}

export const ADDRESS_TONE: Readonly<Record<AddressState, Tone>> = { APPROVED: 'success', OURS: 'success', WAITING: 'warning', REFUSED: 'danger', REMOVED: 'neutral' }

/** The address on one line ("Via Esempio 1, 20100 Milano (MI), IT"). */
export function addressLine(address: Pick<PartyAddressLines, 'line1' | 'line2' | 'postalCode' | 'city' | 'province' | 'country'>): string {
  const city = [address.postalCode, address.city].filter(Boolean).join(' ') + (address.province ? ` (${address.province})` : '')
  return [address.line1, address.line2, city, address.country].filter((part) => part && part.trim() !== '').join(', ')
}

export function addressState(row: Pick<DeliveryAddress, 'status' | 'approval'>): AddressState {
  if (row.approval?.status === 'REFUSED') return 'REFUSED'
  if (row.status === 'ARCHIVED') return 'REMOVED'
  if (row.approval?.status === 'WAITING') return 'WAITING'
  return row.approval ? 'APPROVED' : 'OURS'
}

/** The list's rows: the default first, then usable ones, then waiting, then refused or removed. */
export function addressRows(addresses: readonly DeliveryAddress[]): AddressRow[] {
  const rank: Record<AddressState, number> = { APPROVED: 1, OURS: 1, WAITING: 2, REFUSED: 3, REMOVED: 4 }
  return addresses
    .map((row) => {
      const state = addressState(row)
      return {
        id: row.id,
        name: row.name,
        line: addressLine(row),
        contact: [row.contactName, row.phone].filter(Boolean).join(' · ') || null,
        notes: row.deliveryNotes,
        isDefault: row.isDefault,
        state,
        tone: ADDRESS_TONE[state],
        reason: state === 'REFUSED' ? (row.approval?.refuseReason ?? null) : null,
        addedBy: row.addedBy,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        usable: state === 'APPROVED' || state === 'OURS',
        version: row.version,
      }
    })
    .sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : rank[a.state] - rank[b.state]))
}

/** Why an address cannot be the default (a key), or null. */
export function defaultHeld(row: AddressRow): string | null {
  if (row.isDefault) return 'held.defaultAlready'
  if (row.state === 'WAITING') return 'held.defaultWaiting'
  if (row.state === 'REFUSED' || row.state === 'REMOVED') return 'held.defaultRemoved'
  return null
}

/** Why an address cannot be removed (a key), or null: once removed or refused it is gone already. */
export function removeHeld(row: AddressRow): string | null {
  return row.state === 'REFUSED' || row.state === 'REMOVED' ? 'held.removedAlready' : null
}

export interface AddressDraft {
  name: string
  line1: string
  line2: string
  postalCode: string
  city: string
  province: string
  country: string
  contactName: string
  phone: string
  deliveryNotes: string
}

export const EMPTY_ADDRESS: AddressDraft = { name: '', line1: '', line2: '', postalCode: '', city: '', province: '', country: 'IT', contactName: '', phone: '', deliveryNotes: '' }

/** The API's limits (portal-ordering contract): what holds the address, field by field (keys). */
export function addressProblems(draft: AddressDraft): Partial<Record<keyof AddressDraft, string>> {
  const problems: Partial<Record<keyof AddressDraft, string>> = {}
  if (draft.line1.trim() === '') problems.line1 = 'address.problem.line1'
  if (draft.postalCode.trim() === '') problems.postalCode = 'address.problem.postalCode'
  else if (draft.postalCode.trim().length > 20) problems.postalCode = 'address.problem.tooLong'
  if (draft.city.trim() === '') problems.city = 'address.problem.city'
  if (!/^[A-Za-z]{2}$/.test(draft.country.trim())) problems.country = 'address.problem.country'
  if (draft.country.trim().toUpperCase() === 'IT' && draft.postalCode.trim() !== '' && !/^\d{5}$/.test(draft.postalCode.trim())) problems.postalCode = 'address.problem.capIt'
  for (const [field, max] of [['name', 200], ['line1', 200], ['line2', 200], ['city', 100], ['province', 50], ['contactName', 200], ['phone', 50], ['deliveryNotes', 1000]] as const) {
    if (draft[field].trim().length > max) problems[field] = 'address.problem.tooLong'
  }
  return problems
}

export const addressTyped = (draft: AddressDraft): boolean => (Object.keys(EMPTY_ADDRESS) as (keyof AddressDraft)[]).some((field) => draft[field].trim() !== EMPTY_ADDRESS[field])

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** What "Save address" sends. */
export function addressBody(draft: AddressDraft) {
  return {
    name: orNull(draft.name),
    line1: draft.line1.trim(),
    line2: orNull(draft.line2),
    postalCode: draft.postalCode.trim(),
    city: draft.city.trim(),
    province: orNull(draft.province)?.toUpperCase() ?? null,
    country: draft.country.trim().toUpperCase(),
    contactName: orNull(draft.contactName),
    phone: orNull(draft.phone),
    deliveryNotes: orNull(draft.deliveryNotes),
  }
}

// ── company data ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CompanyRow {
  /** A `portal-account` key. */
  label: string
  value: string
  /** A key: a sub-line under the value. */
  hint?: string
}

/** What we hold for invoicing, row by row (values as the API keeps them; a missing one says so). */
export function companyRows(company: CompanyData, locale: Locale): CompanyRow[] {
  const tax = company.taxIdentity
  const rows: CompanyRow[] = [{ label: 'company.legalName', value: company.legalName }]
  if (company.tradeName && company.tradeName !== company.legalName) rows.push({ label: 'company.tradeName', value: company.tradeName })
  rows.push({ label: 'company.vatNumber', value: tax?.vatNumber ?? '—' })
  if (tax?.fiscalCode) rows.push({ label: 'company.fiscalCode', value: tax.fiscalCode })
  // Italian e-invoices go to the recipient code, else to the PEC ("0000000" means: by PEC).
  const code = tax?.sdiRecipientCode && tax.sdiRecipientCode !== '0000000' ? tax.sdiRecipientCode : null
  rows.push(code ? { label: 'company.sdiCode', value: code } : tax?.pec ? { label: 'company.pec', value: tax.pec } : { label: 'company.sdiCode', value: '—' })
  if (code && tax?.pec) rows.push({ label: 'company.pec', value: tax.pec })
  rows.push({ label: 'company.invoiceAddress', value: company.invoiceAddress ? [company.invoiceAddress.name, addressLine(company.invoiceAddress)].filter(Boolean).join(' — ') : '—' })
  if (company.registeredOffice) rows.push({ label: 'company.registeredOffice', value: addressLine(company.registeredOffice) })
  rows.push({ label: 'company.paymentTerms', value: company.paymentTerms ? company.paymentTerms[locale] : '—' })
  rows.push({ label: 'company.currency', value: company.currency })
  return rows
}

import type { Issue } from '../../core/errors'
import { ADDRESS_FIELDS, changeAddress, checkAddress, type AddressField, type AddressFields, type AddressInput, type AddressKind } from '../../parties/addresses'
import { changeContact, checkContact, CONTACT_FIELDS, duplicateEmails, type ContactField, type ContactFields, type ContactInput, type ContactRole } from '../../parties/contacts'
import { websiteProblem } from '../../parties/rules'
import { cleanLine } from './documents'

/**
 * A supplier's company profile in the portal (B-W2b-189; SCM-097 "Profile self-service"; design portal.supplier.profile ›
 * Company "Addresses and contacts; changes go to the buyer for a check", › Contacts "Who handles orders, invoices and
 * quality"), pure.
 *
 * The supplier sends a CHANGE REQUEST: up to 20 changes of its addresses (its registered office and pickup addresses) and
 * contacts — add one, change one's fields, remove one — checked here with the parties module's own rules (factory-domain
 * parties addresses/contacts). Nothing changes on our side until a buyer approves it (Home › Approvals); a refusal says
 * why. Each change of an existing address or contact names the version the supplier saw: when the row changed since, the
 * approval stops and says so (the buyer refuses and the supplier sends it again). Two open requests never touch the same
 * row. The legal name and the VAT number are read-only here (their change is a new tax identity, the office's); bank details
 * have their own control and call-back (SCM-007, W2b-5). Since W2b schema wave 23 (B-W2b-F13a) a request may also change
 * the company's website (Party.website: a COMPANY change, checked against the website the supplier saw, not a version:
 * the party's version moves with every office edit of the record).
 *
 *   OPEN → APPROVED (applied) | REFUSED (with the reason) | WITHDRAWN (by the supplier, while OPEN)
 */

/** The address uses a supplier sets itself: its registered office and where we collect. Invoice and delivery addresses are ours. */
export const SUPPLIER_ADDRESS_KINDS = ['REGISTERED', 'PICKUP'] as const satisfies readonly AddressKind[]
/** The contact roles a supplier sets itself (a rider is a customer's). */
export const SUPPLIER_CONTACT_ROLES = ['ORDERS', 'INVOICES', 'QUALITY', 'DESIGN', 'OWNER'] as const satisfies readonly ContactRole[]
export const MAX_PROFILE_CHANGES = 20
export const PROFILE_REQUEST_STATES = ['OPEN', 'APPROVED', 'REFUSED', 'WITHDRAWN'] as const
export type ProfileRequestState = (typeof PROFILE_REQUEST_STATES)[number]
export const PROFILE_NOTE_MAX = 1000

type AddressPatch = Partial<Omit<AddressInput, 'kinds'>>
type ContactPatch = Partial<ContactInput>

export type AddressChangeInput =
  | { readonly op: 'ADD'; readonly address: AddressInput }
  | { readonly op: 'CHANGE'; readonly addressId: string; readonly version: number; readonly address: AddressPatch }
  | { readonly op: 'REMOVE'; readonly addressId: string; readonly version: number }

export type ContactChangeInput =
  | { readonly op: 'ADD'; readonly contact: ContactInput }
  | { readonly op: 'CHANGE'; readonly contactId: string; readonly version: number; readonly contact: ContactPatch }
  | { readonly op: 'REMOVE'; readonly contactId: string; readonly version: number }

/** W2b wave 23: the company's own fields a supplier may change (its website; null or blank: none). */
export interface CompanyChangeInput {
  readonly website: string | null
}

export interface ProfileChangeInput {
  readonly addresses?: readonly AddressChangeInput[] | undefined
  readonly contacts?: readonly ContactChangeInput[] | undefined
  readonly company?: CompanyChangeInput | undefined
  /** A word for the buyer ("we moved our warehouse"). */
  readonly note?: string | null | undefined
}

/** The party's rows as they are now (ACTIVE and ARCHIVED). */
export interface CurrentAddress {
  readonly id: string
  readonly version: number
  readonly status: string
  readonly fields: AddressFields
  readonly isDefaultBillTo: boolean
  readonly isDefaultShipTo: boolean
}
export interface CurrentContact {
  readonly id: string
  readonly version: number
  readonly status: string
  readonly fields: ContactFields
}
/** The party itself (its id and website). */
export interface CurrentCompany {
  readonly id: string
  readonly website: string | null
}
export interface CurrentProfile {
  readonly addresses: readonly CurrentAddress[]
  readonly contacts: readonly CurrentContact[]
  /** Left out: no company change is possible (the request names addresses and contacts only). */
  readonly company?: CurrentCompany | undefined
}

export interface CompanyFields {
  readonly website: string | null
}

/** One change as kept in the request and shown to the buyer (old → new). JSON-safe. */
export type PlannedChange =
  | { readonly target: 'ADDRESS'; readonly op: 'ADD'; readonly id: null; readonly version: null; readonly before: null; readonly after: AddressFields; readonly changed: readonly AddressField[] }
  | { readonly target: 'ADDRESS'; readonly op: 'CHANGE'; readonly id: string; readonly version: number; readonly before: AddressFields; readonly after: AddressFields; readonly changed: readonly AddressField[] }
  | { readonly target: 'ADDRESS'; readonly op: 'REMOVE'; readonly id: string; readonly version: number; readonly before: AddressFields; readonly after: null; readonly changed: readonly AddressField[] }
  | { readonly target: 'CONTACT'; readonly op: 'ADD'; readonly id: null; readonly version: null; readonly before: null; readonly after: ContactFields; readonly changed: readonly ContactField[] }
  | { readonly target: 'CONTACT'; readonly op: 'CHANGE'; readonly id: string; readonly version: number; readonly before: ContactFields; readonly after: ContactFields; readonly changed: readonly ContactField[] }
  | { readonly target: 'CONTACT'; readonly op: 'REMOVE'; readonly id: string; readonly version: number; readonly before: ContactFields; readonly after: null; readonly changed: readonly ContactField[] }
  | { readonly target: 'COMPANY'; readonly op: 'CHANGE'; readonly id: string; readonly version: null; readonly before: CompanyFields; readonly after: CompanyFields; readonly changed: readonly 'website'[] }

export type PlanOutcome = { readonly ok: true; readonly changes: readonly PlannedChange[]; readonly note: string | null } | { readonly ok: false; readonly issues: readonly Issue[] }

const prefixed = (issues: readonly Issue[], at: string): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
const isWholeVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1
const supplierKinds = (kinds: readonly string[]): boolean => kinds.every((kind) => (SUPPLIER_ADDRESS_KINDS as readonly string[]).includes(kind))
const supplierRoles = (roles: readonly string[]): boolean => roles.every((role) => (SUPPLIER_CONTACT_ROLES as readonly string[]).includes(role))

/** The row a change names, ACTIVE, at the version the supplier saw; else the problem in words. */
function namedRow<Row extends { readonly id: string; readonly version: number; readonly status: string }>(rows: readonly Row[], id: string, version: unknown, what: string): { row: Row } | { problem: string } {
  const row = rows.find((candidate) => candidate.id === id)
  if (!row || row.status !== 'ACTIVE') return { problem: `This ${what} is not one of yours any more: read your profile again.` }
  if (!isWholeVersion(version)) return { problem: `Say which version of the ${what} you changed.` }
  if (row.version !== version) return { problem: `This ${what} changed since you read it: read your profile again.` }
  return { row }
}

/**
 * The supplier's request, checked against its profile now: every change valid by the parties module's rules, the supplier's
 * own address uses and contact roles only, one change per row, no two active contacts with one e-mail afterwards. Issue
 * paths under `body/`.
 */
export function planProfileChange(input: ProfileChangeInput, current: CurrentProfile): PlanOutcome {
  const issues: Issue[] = []
  const changes: PlannedChange[] = []
  const addresses = input.addresses ?? []
  const contacts = input.contacts ?? []
  const company = input.company === undefined || input.company === null ? 0 : 1
  if (addresses.length + contacts.length + company === 0) issues.push({ path: 'body', message: 'Change, add or remove at least one address or contact, or change your website.' })
  if (addresses.length + contacts.length + company > MAX_PROFILE_CHANGES) issues.push({ path: 'body', message: `At most ${MAX_PROFILE_CHANGES} changes at once.` })
  const note = cleanLine(input.note)
  if (note !== null && note.length > PROFILE_NOTE_MAX) issues.push({ path: 'body/note', message: `At most ${PROFILE_NOTE_MAX} characters.` })
  const seen = new Set<string>()
  const once = (key: string, at: string): boolean => {
    if (seen.has(key)) {
      issues.push({ path: at, message: 'One change per address or contact.' })
      return false
    }
    seen.add(key)
    return true
  }

  for (const [index, change] of addresses.entries()) {
    const at = `body/addresses/${index}`
    if (change.op === 'ADD') {
      const outcome = checkAddress(change.address)
      if (!outcome.ok) issues.push(...prefixed(outcome.issues, `${at}/address`))
      else if (!supplierKinds(outcome.address.kinds)) issues.push({ path: `${at}/address/kinds`, message: 'Your registered office or a pickup address; invoice and delivery addresses are ours to set.' })
      else changes.push({ target: 'ADDRESS', op: 'ADD', id: null, version: null, before: null, after: outcome.address, changed: [...ADDRESS_FIELDS] })
      continue
    }
    if (!once(`address:${change.addressId}`, at)) continue
    const found = namedRow(current.addresses, change.addressId, change.version, 'address')
    if ('problem' in found) {
      issues.push({ path: `${at}/addressId`, message: found.problem })
      continue
    }
    const { row } = found
    if (change.op === 'REMOVE') {
      if (!supplierKinds(row.fields.kinds) || row.isDefaultBillTo || row.isDefaultShipTo) issues.push({ path: at, message: 'We use this address for our invoices or deliveries: write to us to change it.' })
      else changes.push({ target: 'ADDRESS', op: 'REMOVE', id: row.id, version: row.version, before: row.fields, after: null, changed: [] })
      continue
    }
    const patch = { ...(change.address ?? {}) } as Record<string, unknown>
    if ('kinds' in patch) {
      issues.push({ path: `${at}/address/kinds`, message: 'What an address is used for stays as it is: add a new address instead.' })
      continue
    }
    const outcome = changeAddress(row.fields, patch as AddressPatch)
    if (!outcome.ok) issues.push(...prefixed(outcome.issues, `${at}/address`))
    else if (outcome.changed.length === 0) issues.push({ path: `${at}/address`, message: 'Nothing changes in this address.' })
    else changes.push({ target: 'ADDRESS', op: 'CHANGE', id: row.id, version: row.version, before: row.fields, after: outcome.address, changed: outcome.changed })
  }

  for (const [index, change] of contacts.entries()) {
    const at = `body/contacts/${index}`
    if (change.op === 'ADD') {
      const outcome = checkContact(change.contact)
      if (!outcome.ok) issues.push(...prefixed(outcome.issues, `${at}/contact`))
      else if (!supplierRoles(outcome.contact.roles)) issues.push({ path: `${at}/contact/roles`, message: 'Orders, invoices, quality, design or owner.' })
      else changes.push({ target: 'CONTACT', op: 'ADD', id: null, version: null, before: null, after: outcome.contact, changed: [...CONTACT_FIELDS] })
      continue
    }
    if (!once(`contact:${change.contactId}`, at)) continue
    const found = namedRow(current.contacts, change.contactId, change.version, 'contact')
    if ('problem' in found) {
      issues.push({ path: `${at}/contactId`, message: found.problem })
      continue
    }
    const { row } = found
    if (change.op === 'REMOVE') {
      changes.push({ target: 'CONTACT', op: 'REMOVE', id: row.id, version: row.version, before: row.fields, after: null, changed: [] })
      continue
    }
    const outcome = changeContact(row.fields, change.contact ?? {})
    if (!outcome.ok) issues.push(...prefixed(outcome.issues, `${at}/contact`))
    else if (!supplierRoles(outcome.contact.roles)) issues.push({ path: `${at}/contact/roles`, message: 'Orders, invoices, quality, design or owner.' })
    else if (outcome.changed.length === 0) issues.push({ path: `${at}/contact`, message: 'Nothing changes for this contact.' })
    else changes.push({ target: 'CONTACT', op: 'CHANGE', id: row.id, version: row.version, before: row.fields, after: outcome.contact, changed: outcome.changed })
  }

  if (input.company !== undefined && input.company !== null) {
    const website = cleanLine(input.company.website)
    const problem = websiteProblem(website)
    if (!current.company) issues.push({ path: 'body/company', message: 'Your company is not there any more: read your profile again.' })
    else if (problem !== null) issues.push({ path: 'body/company/website', message: problem })
    else if (website === current.company.website) issues.push({ path: 'body/company/website', message: 'Your website stays as it is.' })
    else changes.push({ target: 'COMPANY', op: 'CHANGE', id: current.company.id, version: null, before: { website: current.company.website }, after: { website }, changed: ['website'] })
  }

  if (issues.length === 0) {
    const twice = duplicateEmails(contactsAfter(current, changes))
    if (twice.length > 0) issues.push({ path: 'body/contacts', message: `Two of your contacts would have ${twice.join(', ')}: one address per contact.` })
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, changes, note }
}

/** The active contacts once the changes are applied (for the one-e-mail rule). */
export function contactsAfter(current: CurrentProfile, changes: readonly PlannedChange[]): ContactFields[] {
  const byId = new Map(current.contacts.filter((row) => row.status === 'ACTIVE').map((row) => [row.id, row.fields] as const))
  const added: ContactFields[] = []
  for (const change of changes) {
    if (change.target !== 'CONTACT') continue
    if (change.op === 'ADD') added.push(change.after)
    else if (change.op === 'REMOVE') byId.delete(change.id)
    else byId.set(change.id, change.after)
  }
  return [...byId.values(), ...added]
}

/** The rows a request touches ("address:<id>", "contact:<id>", "company:<party id>"): two open requests never share one. */
export const touchedKeysOf = (changes: readonly PlannedChange[]): string[] =>
  changes.filter((change) => change.id !== null).map((change) => `${change.target === 'ADDRESS' ? 'address' : change.target === 'CONTACT' ? 'contact' : 'company'}:${change.id}`)

/**
 * At approval: each change of an existing row against the row now. The same version means the same fields (every change
 * moves the version), so the request applies as the supplier sent it; another version, or a row archived since, stops it.
 */
export function staleProblems(changes: readonly PlannedChange[], current: CurrentProfile): string[] {
  const problems: string[] = []
  for (const change of changes) {
    if (change.id === null) continue
    if (change.target === 'COMPANY') {
      // The website as the supplier saw it (the party's version moves with every office edit of the record).
      if (!current.company || current.company.website !== change.before.website) problems.push('the website changed after the supplier sent this')
      continue
    }
    const rows: readonly { id: string; version: number; status: string }[] = change.target === 'ADDRESS' ? current.addresses : current.contacts
    const row = rows.find((candidate) => candidate.id === change.id)
    const what = change.target === 'ADDRESS' ? `the address ${addressLine(change.before)}` : `the contact ${change.before.name}`
    if (!row || row.status !== 'ACTIVE' || row.version !== change.version) problems.push(`${what} changed after the supplier sent this`)
  }
  if (problems.length === 0) {
    const twice = duplicateEmails(contactsAfter(current, changes))
    if (twice.length > 0) problems.push(`two contacts would have ${twice.join(', ')}`)
  }
  return problems
}

// ---- words (the buyer's review; the portal screens say their own, B-W2b-193) ----------------------------------------------

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ REGISTERED: 'Registered office', PICKUP: 'Pickup address', BILL_TO: 'Invoice address', SHIP_TO: 'Delivery address' })

/** "Via Roma 1, 36071 Arzignano VI (IT)". */
export function addressLine(fields: Pick<AddressFields, 'line1' | 'line2' | 'postalCode' | 'city' | 'province' | 'country'>): string {
  const street = [fields.line1, fields.line2].filter((part) => part !== null && part !== '').join(', ')
  const place = [fields.postalCode, fields.city, fields.province].filter((part) => part !== null && part !== '').join(' ')
  return `${street}, ${place} (${fields.country})`
}

const addressName = (fields: AddressFields): string => fields.kinds.map((kind) => KIND_WORDS[kind] ?? kind).join(' and ') || 'Address'
const contactLine = (fields: ContactFields): string => [fields.name, fields.email, fields.phone].filter((part) => part !== null && part !== '').join(', ')
const roleWords = (roles: readonly string[]): string => (roles.length === 0 ? 'no role' : roles.map((role) => role.toLowerCase()).join(', '))
const valueWords = (field: string, value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return field === 'roles' ? roleWords(value as string[]) : (value as string[]).join(', ')
  return String(value)
}

/** One change in words, old → new, for the buyer's review and the audit row. */
export function changeSentence(change: PlannedChange): string {
  if (change.target === 'COMPANY') return `Website ${valueWords('website', change.before.website)} → ${valueWords('website', change.after.website)}.`
  if (change.target === 'ADDRESS') {
    if (change.op === 'ADD') return `New ${addressName(change.after).toLowerCase()}: ${addressLine(change.after)}.`
    if (change.op === 'REMOVE') return `Remove the ${addressName(change.before).toLowerCase()} ${addressLine(change.before)}.`
    const parts = change.changed.map((field) => `${field} ${valueWords(field, change.before[field])} → ${valueWords(field, change.after[field])}`)
    return `${addressName(change.before)} ${addressLine(change.before)}: ${parts.join('; ')}.`
  }
  if (change.op === 'ADD') return `New contact: ${contactLine(change.after)} (${roleWords(change.after.roles)}).`
  if (change.op === 'REMOVE') return `Remove the contact ${contactLine(change.before)}.`
  const parts = change.changed.map((field) => `${field} ${valueWords(field, change.before[field])} → ${valueWords(field, change.after[field])}`)
  return `Contact ${change.before.name}: ${parts.join('; ')}.`
}

/** "1 address and 2 contacts", "the website and 1 contact". */
export function changeSummary(changes: readonly PlannedChange[]): string {
  const addresses = changes.filter((change) => change.target === 'ADDRESS').length
  const contacts = changes.filter((change) => change.target === 'CONTACT').length
  const website = changes.some((change) => change.target === 'COMPANY')
  const parts = [website ? 'the website' : null, addresses > 0 ? `${addresses} ${addresses === 1 ? 'address' : 'addresses'}` : null, contacts > 0 ? `${contacts} ${contacts === 1 ? 'contact' : 'contacts'}` : null].filter((part) => part !== null)
  return parts.join(' and ')
}

/** The buyer's refusal: the reason the supplier reads. */
export function profileRefuseProblems(reason: string | null | undefined): Issue[] {
  const text = cleanLine(reason)
  if (text === null || text.length < 3) return [{ path: 'body/reason', message: 'Say why, in words the supplier understands.' }]
  if (text.length > 500) return [{ path: 'body/reason', message: 'At most 500 characters.' }]
  return []
}

import { checkAddress, type AddressInput } from '@nexus/factory-domain/parties/addresses'
import { checkContact, type ContactInput } from '@nexus/factory-domain/parties/contacts'
import { websiteProblem } from '@nexus/factory-domain/parties/rules'
import { addressLine, MAX_PROFILE_CHANGES, SUPPLIER_ADDRESS_KINDS, SUPPLIER_CONTACT_ROLES } from '@nexus/factory-domain/purchasing/portal-profile/profile'
import type { AddressChangeBody, ChangeRequest, ChangesBody, ContactChangeBody, PlannedChange, ProfileAddress, ProfileContact, SupplierProfile } from './api'

/**
 * The supplier's Profile, the pure part (B-W2b-193, SCR-191; design portal.supplier.profile): the company's data, its
 * addresses and contacts as the page shows them with the changes typed and not yet sent, what "Send changes for our check"
 * sends (each existing row at the version the supplier saw), what holds a change (the API's own rules: factory-domain
 * parties checkAddress / checkContact / websiteProblem), what waits for our check, and our answers. No API, no screen.
 * Words are `portal-supplier-profile` keys (`profile.*`, `held.*`). Nothing changes on our side until a buyer approves.
 */

export const NS = 'portal-supplier-profile'
export const PROFILE_PATH = '/profile'
export const MAX_CHANGES = MAX_PROFILE_CHANGES
/** What a supplier's own address may be for (its registered office, a pickup address); invoices and deliveries are ours. */
export const OWN_KINDS: readonly string[] = SUPPLIER_ADDRESS_KINDS
/** What a contact handles. */
export const ROLES: readonly string[] = SUPPLIER_CONTACT_ROLES

export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AddressDraft {
  kinds: string[]
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
export type AddressText = Exclude<keyof AddressDraft, 'kinds'>
export const ADDRESS_TEXT: readonly AddressText[] = ['name', 'line1', 'line2', 'postalCode', 'city', 'province', 'country', 'contactName', 'phone', 'deliveryNotes']

export interface ContactDraft {
  name: string
  email: string
  phone: string
  roles: string[]
  language: string
}
export type ContactText = Exclude<keyof ContactDraft, 'roles'>

export const EMPTY_ADDRESS: AddressDraft = { kinds: ['PICKUP'], name: '', line1: '', line2: '', postalCode: '', city: '', province: '', country: 'IT', contactName: '', phone: '', deliveryNotes: '' }
export const EMPTY_CONTACT: ContactDraft = { name: '', email: '', phone: '', roles: [], language: '' }

export const addressDraftOf = (row: ProfileAddress): AddressDraft => ({
  kinds: [...row.kinds],
  name: row.name ?? '',
  line1: row.line1,
  line2: row.line2 ?? '',
  postalCode: row.postalCode,
  city: row.city,
  province: row.province ?? '',
  country: row.country,
  contactName: row.contactName ?? '',
  phone: row.phone ?? '',
  deliveryNotes: row.deliveryNotes ?? '',
})
export const contactDraftOf = (row: ProfileContact): ContactDraft => ({ name: row.name, email: row.email ?? '', phone: row.phone ?? '', roles: [...row.roles], language: row.language ?? '' })

// ── the changes typed (not sent yet) ─────────────────────────────────────────────────────────────────────────────────────
export type AddressEdit = { op: 'ADD'; key: string; draft: AddressDraft } | { op: 'CHANGE'; id: string; version: number; draft: AddressDraft } | { op: 'REMOVE'; id: string; version: number }
export type ContactEdit = { op: 'ADD'; key: string; draft: ContactDraft } | { op: 'CHANGE'; id: string; version: number; draft: ContactDraft } | { op: 'REMOVE'; id: string; version: number }

export interface ProfileEdits {
  /** The website typed; null: as it is. */
  website: string | null
  addresses: AddressEdit[]
  contacts: ContactEdit[]
}

export const NO_EDITS: ProfileEdits = { website: null, addresses: [], contacts: [] }

/** How many changes the page would send. */
export const editCount = (edits: ProfileEdits): number => (edits.website !== null ? 1 : 0) + edits.addresses.length + edits.contacts.length

const editIdOf = (edit: AddressEdit | ContactEdit): string => (edit.op === 'ADD' ? edit.key : edit.id)

/** One edit per row: a new one replaces the row's earlier edit (and a change back to what is saved drops it). */
export function withAddressEdit(edits: ProfileEdits, edit: AddressEdit, saved?: ProfileAddress): ProfileEdits {
  const others = edits.addresses.filter((entry) => editIdOf(entry) !== editIdOf(edit))
  if (edit.op === 'CHANGE' && saved && Object.keys(addressPatch(saved, edit.draft)).length === 0) return { ...edits, addresses: others }
  return { ...edits, addresses: [...others, edit] }
}
export function withContactEdit(edits: ProfileEdits, edit: ContactEdit, saved?: ProfileContact): ProfileEdits {
  const others = edits.contacts.filter((entry) => editIdOf(entry) !== editIdOf(edit))
  if (edit.op === 'CHANGE' && saved && Object.keys(contactPatch(saved, edit.draft)).length === 0) return { ...edits, contacts: others }
  return { ...edits, contacts: [...others, edit] }
}
/** A row's edit dropped (Undo on the row; a removed new row is simply forgotten). */
export const withoutEdit = (edits: ProfileEdits, target: 'addresses' | 'contacts', id: string): ProfileEdits => ({ ...edits, [target]: (edits[target] as (AddressEdit | ContactEdit)[]).filter((entry) => editIdOf(entry) !== id) })

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The fields of an address that differ from what is saved (the API's CHANGE patch; never the kinds). */
export function addressPatch(saved: ProfileAddress, draft: AddressDraft): Record<string, string | null> {
  const patch: Record<string, string | null> = {}
  for (const field of ADDRESS_TEXT) {
    const before = (saved[field] as string | null) ?? null
    const after = field === 'line1' || field === 'postalCode' || field === 'city' || field === 'country' ? draft[field].trim() : orNull(draft[field])
    const normal = field === 'country' || field === 'province' ? (after?.toUpperCase() ?? null) : after
    if ((normal ?? null) !== before) patch[field] = normal
  }
  return patch
}

export function contactPatch(saved: ProfileContact, draft: ContactDraft): Record<string, string | string[] | null> {
  const patch: Record<string, string | string[] | null> = {}
  if (draft.name.trim() !== saved.name) patch.name = draft.name.trim()
  const email = orNull(draft.email)?.toLowerCase() ?? null
  if (email !== saved.email) patch.email = email
  if (orNull(draft.phone) !== saved.phone) patch.phone = orNull(draft.phone)
  const language = orNull(draft.language)?.toLowerCase() ?? null
  if (language !== saved.language) patch.language = language
  const roles = [...draft.roles].sort()
  if (roles.join(',') !== [...saved.roles].sort().join(',')) patch.roles = roles
  return patch
}

const addressBodyOf = (draft: AddressDraft) => ({
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
})
const contactBodyOf = (draft: ContactDraft) => ({ name: draft.name.trim(), email: orNull(draft.email)?.toLowerCase() ?? null, phone: orNull(draft.phone), roles: [...draft.roles], language: orNull(draft.language)?.toLowerCase() ?? null })

/** What "Send changes for our check" sends: each existing row at the version the supplier saw. */
export function changesBody(edits: ProfileEdits, profile: Pick<SupplierProfile, 'addresses' | 'contacts'>, note: string): ChangesBody {
  const addresses: AddressChangeBody[] = edits.addresses.flatMap((edit): AddressChangeBody[] => {
    if (edit.op === 'ADD') return [{ op: 'ADD', address: { ...addressBodyOf(edit.draft), kinds: [...edit.draft.kinds] } }]
    if (edit.op === 'REMOVE') return [{ op: 'REMOVE', addressId: edit.id, version: edit.version }]
    const saved = profile.addresses.find((row) => row.id === edit.id)
    return saved ? [{ op: 'CHANGE', addressId: edit.id, version: edit.version, address: addressPatch(saved, edit.draft) }] : []
  })
  const contacts: ContactChangeBody[] = edits.contacts.flatMap((edit): ContactChangeBody[] => {
    if (edit.op === 'ADD') return [{ op: 'ADD', contact: contactBodyOf(edit.draft) }]
    if (edit.op === 'REMOVE') return [{ op: 'REMOVE', contactId: edit.id, version: edit.version }]
    const saved = profile.contacts.find((row) => row.id === edit.id)
    return saved ? [{ op: 'CHANGE', contactId: edit.id, version: edit.version, contact: contactPatch(saved, edit.draft) }] : []
  })
  return {
    ...(addresses.length > 0 ? { addresses } : {}),
    ...(contacts.length > 0 ? { contacts } : {}),
    ...(edits.website !== null ? { company: { website: orNull(edits.website) } } : {}),
    ...(orNull(note) ? { note: orNull(note) } : {}),
  }
}

// ── what holds a change ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChangeFacts {
  preview: boolean
  offline: boolean
  mayChange: boolean
}

/** Why the company data cannot be changed here (a `held.*` key), or null. */
export function changeHeld(facts: ChangeFacts): string | null {
  if (facts.preview) return 'held.previewChange'
  if (!facts.mayChange) return 'held.adminChanges'
  if (facts.offline) return 'held.offline'
  return null
}

/** Our address uses (invoices, deliveries, a default of ours) are ours to set: a supplier cannot remove them. */
export const isOurs = (row: Pick<ProfileAddress, 'kinds' | 'isDefaultBillTo' | 'isDefaultShipTo'>): boolean => row.isDefaultBillTo || row.isDefaultShipTo || row.kinds.some((kind) => !OWN_KINDS.includes(kind))

const FIELD_KEY = (field: string) => `profile.problem.${field}`

const italian = (draft: AddressDraft): boolean => draft.country.trim().toUpperCase() === 'IT'

/** Which of our words says an address field's problem (the parties module's issue is per field). */
function addressProblemOf(field: keyof AddressDraft, draft: AddressDraft): string {
  if (field === 'postalCode') return italian(draft) ? 'cap' : 'postalCode'
  if (field === 'province') return italian(draft) ? 'sigla' : 'tooLong'
  if (field === 'line1' || field === 'city') return draft[field].trim() === '' ? field : 'tooLong'
  if (field === 'name' || field === 'line2' || field === 'contactName' || field === 'deliveryNotes') return 'tooLong'
  return field
}

/** What holds an address, field by field (keys): the parties module's own rules; a new one is for the supplier's own uses. */
export function addressProblems(draft: AddressDraft, adding: boolean): Partial<Record<keyof AddressDraft, string>> {
  const problems: Partial<Record<keyof AddressDraft, string>> = {}
  const outcome = checkAddress({ ...addressBodyOf(draft), kinds: draft.kinds as AddressInput['kinds'] })
  if (!outcome.ok) {
    for (const issue of outcome.issues) {
      const field = issue.path.split('/')[0] as keyof AddressDraft
      if (field in draft && !problems[field]) problems[field] = FIELD_KEY(addressProblemOf(field, draft))
    }
  }
  if (adding && (draft.kinds.length === 0 || draft.kinds.some((kind) => !OWN_KINDS.includes(kind)))) problems.kinds = 'profile.problem.kinds'
  return problems
}

/** What holds a contact, field by field (keys). */
export function contactProblems(draft: ContactDraft): Partial<Record<keyof ContactDraft, string>> {
  const problems: Partial<Record<keyof ContactDraft, string>> = {}
  const outcome = checkContact({ ...contactBodyOf(draft), roles: draft.roles as ContactInput['roles'] })
  if (!outcome.ok) {
    for (const issue of outcome.issues) {
      const field = issue.path.split('/')[0] as keyof ContactDraft
      if (!(field in draft) || problems[field]) continue
      problems[field] = field === 'email' && orNull(draft.email) === null ? 'profile.problem.emailNeeded' : FIELD_KEY(field === 'name' && draft.name.trim() !== '' ? 'tooLong' : field)
    }
  }
  if (draft.roles.some((role) => !ROLES.includes(role))) problems.roles = 'profile.problem.roles'
  return problems
}

/** Why the website cannot be sent as typed (a key), or null. */
export const websiteProblemKey = (value: string): string | null => (websiteProblem(orNull(value)) ? 'profile.problem.website' : null)

/** Two contacts with one e-mail after the changes (the API refuses it): the addresses, or none. */
export function sameEmails(contacts: readonly ContactLine[]): string[] {
  const seen = new Map<string, number>()
  for (const row of contacts) if (row.state !== 'REMOVE' && row.email) seen.set(row.email.toLowerCase(), (seen.get(row.email.toLowerCase()) ?? 0) + 1)
  return [...seen.entries()].filter(([, count]) => count > 1).map(([email]) => email)
}

/** Why "Send changes for our check" waits (a key and its words' params), or null. */
export function sendHeld(edits: ProfileEdits, contacts: readonly ContactLine[], facts: ChangeFacts, busy: boolean): Words | null {
  const held = changeHeld(facts)
  if (held) return { key: held }
  if (busy) return { key: 'profile.sending' }
  if (editCount(edits) > MAX_CHANGES) return { key: 'held.tooMany', params: { max: MAX_CHANGES } }
  if (edits.website !== null && websiteProblemKey(edits.website)) return { key: 'profile.problem.website' }
  const twice = sameEmails(contacts)
  if (twice.length > 0) return { key: 'held.sameEmail', params: { emails: twice.join(', ') } }
  return null
}

// ── the rows as the page shows them ──────────────────────────────────────────────────────────────────────────────────────
/** CURRENT as saved; WAITING: a change of it waits for our check; NEW / CHANGED / REMOVE: typed here, not sent yet. */
export type LineState = 'CURRENT' | 'WAITING' | 'NEW' | 'CHANGED' | 'REMOVE'
export const LINE_TONE: Readonly<Record<LineState, Tone>> = { CURRENT: 'neutral', WAITING: 'warning', NEW: 'info', CHANGED: 'info', REMOVE: 'danger' }

export interface AddressLine {
  id: string
  /** The saved row (absent for a new one). */
  saved: ProfileAddress | null
  name: string | null
  line: string
  kinds: readonly string[]
  contact: string | null
  state: LineState
  draft: AddressDraft
  /** Why Edit waits (a key), or null. */
  editHeld: string | null
  /** Why Remove waits (a key), or null. */
  removeHeld: string | null
}

export interface ContactLine {
  id: string
  saved: ProfileContact | null
  name: string
  email: string | null
  phone: string | null
  roles: readonly string[]
  language: string | null
  state: LineState
  draft: ContactDraft
  editHeld: string | null
  removeHeld: string | null
}

const draftLine = (draft: AddressDraft) => addressLine({ line1: draft.line1.trim(), line2: orNull(draft.line2), postalCode: draft.postalCode.trim(), city: draft.city.trim(), province: orNull(draft.province), country: draft.country.trim().toUpperCase() })

/** The addresses with the typed changes on them: saved ones first (as the API orders them), new ones after. */
export function addressLines(profile: Pick<SupplierProfile, 'addresses'>, edits: ProfileEdits, held: string | null): AddressLine[] {
  const saved = profile.addresses.map((row): AddressLine => {
    const edit = edits.addresses.find((entry) => entry.op !== 'ADD' && entry.id === row.id)
    const draft = edit && edit.op === 'CHANGE' ? edit.draft : addressDraftOf(row)
    const state: LineState = edit ? (edit.op === 'REMOVE' ? 'REMOVE' : 'CHANGED') : row.waiting ? 'WAITING' : 'CURRENT'
    const waiting = row.waiting ? 'held.waitingCheck' : null
    return {
      id: row.id,
      saved: row,
      name: orNull(draft.name),
      line: draftLine(draft),
      kinds: row.kinds,
      contact: [orNull(draft.contactName), orNull(draft.phone)].filter(Boolean).join(' · ') || null,
      state,
      draft,
      editHeld: held ?? waiting ?? (state === 'REMOVE' ? 'held.removing' : null),
      removeHeld: held ?? waiting ?? (isOurs(row) ? 'held.ours' : null),
    }
  })
  const added = edits.addresses.flatMap((edit): AddressLine[] =>
    edit.op === 'ADD' ? [{ id: edit.key, saved: null, name: orNull(edit.draft.name), line: draftLine(edit.draft), kinds: edit.draft.kinds, contact: [orNull(edit.draft.contactName), orNull(edit.draft.phone)].filter(Boolean).join(' · ') || null, state: 'NEW', draft: edit.draft, editHeld: held, removeHeld: held }] : [],
  )
  return [...saved, ...added]
}

export function contactLines(profile: Pick<SupplierProfile, 'contacts'>, edits: ProfileEdits, held: string | null): ContactLine[] {
  const saved = profile.contacts.map((row): ContactLine => {
    const edit = edits.contacts.find((entry) => entry.op !== 'ADD' && entry.id === row.id)
    const draft = edit && edit.op === 'CHANGE' ? edit.draft : contactDraftOf(row)
    const state: LineState = edit ? (edit.op === 'REMOVE' ? 'REMOVE' : 'CHANGED') : row.waiting ? 'WAITING' : 'CURRENT'
    const waiting = row.waiting ? 'held.waitingCheck' : null
    return { id: row.id, saved: row, name: draft.name.trim() || row.name, email: orNull(draft.email), phone: orNull(draft.phone), roles: draft.roles, language: orNull(draft.language), state, draft, editHeld: held ?? waiting ?? (state === 'REMOVE' ? 'held.removing' : null), removeHeld: held ?? waiting }
  })
  const added = edits.contacts.flatMap((edit): ContactLine[] =>
    edit.op === 'ADD' ? [{ id: edit.key, saved: null, name: edit.draft.name.trim(), email: orNull(edit.draft.email), phone: orNull(edit.draft.phone), roles: edit.draft.roles, language: orNull(edit.draft.language), state: 'NEW', draft: edit.draft, editHeld: held, removeHeld: held }] : [],
  )
  return [...saved, ...added]
}

// ── what waits for our check, and our answers ────────────────────────────────────────────────────────────────────────────
const text = (value: unknown): string => (value === null || value === undefined || value === '' ? '—' : Array.isArray(value) ? value.join(', ') : String(value))
const fieldsLine = (values: Record<string, unknown> | null): string =>
  values ? addressLine({ line1: text(values.line1), line2: (values.line2 as string | null) ?? null, postalCode: text(values.postalCode), city: text(values.city), province: (values.province as string | null) ?? null, country: text(values.country) }) : '—'

/** One change of a request in our words: what, and old → new for each field that changes (field names are keys). */
export interface ChangeLine {
  words: Words
  fields: { field: string; before: string; after: string }[]
}

export function changeLines(changes: readonly PlannedChange[]): ChangeLine[] {
  return changes.map((change) => {
    if (change.target === 'COMPANY') return { words: { key: 'profile.change.website' }, fields: [{ field: 'website', before: text(change.before?.website), after: text(change.after?.website) }] }
    const values = change.after ?? change.before
    const label = change.target === 'ADDRESS' ? (typeof values?.name === 'string' && values.name ? values.name : fieldsLine(values)) : text(values?.name)
    const words = { key: `profile.change.${change.target}.${change.op}`, params: { what: label } }
    const fields = change.op === 'CHANGE' ? change.changed.map((field) => ({ field, before: text(change.before?.[field]), after: text(change.after?.[field]) })) : []
    return { words, fields }
  })
}

export const REQUEST_TONE: Readonly<Record<ChangeRequest['state'], Tone>> = { OPEN: 'warning', APPROVED: 'success', REFUSED: 'danger', WITHDRAWN: 'neutral' }

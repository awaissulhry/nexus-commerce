import type { Locale } from '../../../lib/i18n/locales'
import type { Colleague, Colleagues, CompanyData, DeliveryAddress, Handover, OfferedRole, PartyAddressLines, PortalSessionRow } from './api'

/**
 * The customer's Account page, the pure part (B-W2b-196, SCR-188; design portal.customer.account): what each section shows
 * and why an action waits, with no API and no screen. Words are `portal-account` keys (the view translates them) or come
 * from the API in both languages; the API's English never reaches the screen.
 */

export const ACCOUNT_PATH = '/account'
export const SECTIONS = ['profile', 'emails', 'users', 'addresses', 'company', 'security'] as const
export type AccountSection = (typeof SECTIONS)[number]

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ── my profile ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ProfileDraft {
  displayName: string
  locale: Locale
}

/** How many fields of the profile differ from what is saved. */
export function profileChanges(saved: ProfileDraft, draft: ProfileDraft): number {
  return (draft.displayName.trim() !== saved.displayName ? 1 : 0) + (draft.locale !== saved.locale ? 1 : 0)
}

export const NAME_MAX = 120

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

// ── colleagues ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ColleagueRow {
  id: string
  name: string
  /** Shown to the organisation's admins only. */
  email: string | null
  roleKey: string | null
  /** The API's role name (English) when the role has no words of ours. */
  roleName: string | null
  seesPrices: boolean
  admin: boolean
  status: Colleague['status']
  /** "Invited": the invitation's end. */
  invitationExpiresAt: string | null
  lastSignInAt: string | null
  you: boolean
  version: number
}

export const STATUS_TONE: Readonly<Record<Colleague['status'], Tone>> = { ACTIVE: 'success', INVITED: 'info', SUSPENDED: 'warning', DEACTIVATED: 'neutral' }

/** The organisation's people as the list shows them: the person first, then by name. */
export function colleagueRows(answer: Colleagues): ColleagueRow[] {
  const rows = answer.people.map((person) => ({
    id: person.id,
    name: person.displayName,
    email: person.email,
    roleKey: person.roleKey,
    roleName: person.roleName,
    seesPrices: person.seesPrices,
    admin: person.admin,
    status: person.status,
    invitationExpiresAt: person.invitationExpiresAt,
    lastSignInAt: person.lastSignInAt,
    you: person.id === answer.me,
    version: person.version,
  }))
  return rows.sort((a, b) => (a.you === b.you ? a.name.localeCompare(b.name) : a.you ? -1 : 1))
}

/** Why a colleague's row cannot be chosen for a bulk act (a key), or null. */
export function colleagueHeld(row: ColleagueRow): string | null {
  if (row.you) return 'held.yourself'
  if (row.status === 'DEACTIVATED') return 'held.deactivated'
  return null
}

/** The admins' names for "Your admin is …" (the person themself left out). */
export const adminNames = (answer: Pick<Colleagues, 'admins' | 'me'>): string[] => answer.admins.filter((admin) => admin.id !== answer.me).map((admin) => admin.displayName)

/** The roles the invite and the role change offer: the portal's offered roles, the admin last. */
export function roleChoices(roles: readonly OfferedRole[]): OfferedRole[] {
  return roles.filter((role) => role.offered).sort((a, b) => (a.admin === b.admin ? 0 : a.admin ? 1 : -1))
}

/** A role change that raises someone to the organisation's admin asks first (pop:role-raise). */
export const raisesToAdmin = (roles: readonly OfferedRole[], from: string | null, to: string): boolean => {
  const target = roles.find((role) => role.key === to)
  const before = from ? roles.find((role) => role.key === from) : undefined
  return target?.admin === true && before?.admin !== true
}

/** Seats: whether one more person may be invited, and the words key when not. */
export function seatsHeld(seats: Colleagues['seats']): string | null {
  return seats && seats.max !== null && seats.taken >= seats.max ? 'held.seats' : null
}

export interface InviteDraft {
  displayName: string
  email: string
  locale: Locale
  roleKey: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What holds the invitation, field by field (keys). */
export function inviteProblems(draft: InviteDraft): Partial<Record<keyof InviteDraft, string>> {
  const problems: Partial<Record<keyof InviteDraft, string>> = {}
  const name = draft.displayName.trim()
  if (name === '') problems.displayName = 'invite.problem.name'
  else if (name.length > NAME_MAX) problems.displayName = 'profile.nameTooLong'
  if (!EMAIL.test(draft.email.trim())) problems.email = 'invite.problem.email'
  if (draft.roleKey === '') problems.roleKey = 'invite.problem.role'
  return problems
}

// ── deactivating colleagues (their open requests) ────────────────────────────────────────────────────────────────────────
export interface HandoverSummary {
  /** Open requests any of them could answer. */
  open: number
  /** Of those, handed to them by name (F14): these move to the chosen colleague, or back to everyone. */
  assigned: number
  /** Only they could answer these: nobody else's role does. */
  alone: { label: string; words: string }[]
  /** Who may take what was handed to them: active colleagues outside the ones leaving. */
  options: { id: string; name: string }[]
}

/** One summary over the hand-over reads of everyone being deactivated. */
export function handoverSummary(reads: readonly { readonly userId: string; readonly handover: Handover }[], locale: Locale): HandoverSummary {
  const leaving = new Set(reads.map((read) => read.userId))
  const options = new Map<string, string>()
  const alone = new Map<string, { label: string; words: string }>()
  let open = 0
  let assigned = 0
  for (const { handover } of reads) {
    open += handover.open
    assigned += handover.assigned
    for (const task of handover.alone) alone.set(task.id, { label: task.record.label, words: task.words[locale] })
    for (const colleague of handover.colleagues) if (!leaving.has(colleague.id)) options.set(colleague.id, colleague.displayName)
  }
  return { open, assigned, alone: [...alone.values()], options: [...options.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) }
}

/** The open requests handed to the leavers, which the chosen colleague takes before they leave. */
export function tasksToMove(tasks: readonly { readonly id: string; readonly version: number; readonly assignee?: { readonly id: string } | null | undefined }[], leavers: readonly string[]): { id: string; version: number }[] {
  return tasks.filter((task) => task.assignee && leavers.includes(task.assignee.id)).map((task) => ({ id: task.id, version: task.version }))
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

// ── sign-in and sessions ─────────────────────────────────────────────────────────────────────────────────────────────────
export type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'opera' | 'other'
export type System = 'windows' | 'mac' | 'ios' | 'android' | 'linux' | 'other'

/** The browser and system a User-Agent names (what the person sees as "the device"), never more. */
export function deviceOf(userAgent: string | null): { browser: Browser; system: System; phone: boolean } {
  const ua = userAgent ?? ''
  const browser: Browser = /Edg\//.test(ua) ? 'edge' : /OPR\/|Opera/.test(ua) ? 'opera' : /Firefox\/|FxiOS/.test(ua) ? 'firefox' : /Chrome\/|CriOS/.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other'
  const system: System = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux/.test(ua) ? 'linux' : 'other'
  return { browser, system, phone: /Mobile|iPhone|Android.*Mobile/.test(ua) }
}

export interface SessionRow {
  id: string
  current: boolean
  browser: Browser
  system: System
  phone: boolean
  startedAt: string
  lastSeenAt: string
}

/** This browser first, then the most recently used. */
export function sessionRows(sessions: readonly PortalSessionRow[]): SessionRow[] {
  return sessions
    .map((row) => ({ id: row.id, current: row.current, ...deviceOf(row.userAgent), startedAt: row.createdAt, lastSeenAt: row.lastSeenAt }))
    .sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : b.lastSeenAt.localeCompare(a.lastSeenAt)))
}

/** An e-mail address with the middle of its name hidden ("a…a@example.com"), for the step-up's sentence. */
export function maskedEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!name || !domain) return email
  return name.length <= 2 ? `${name[0]}…@${domain}` : `${name[0]}…${name[name.length - 1]}@${domain}`
}

/** Whether the session's step-up (5 minutes) still holds at `now`. */
export const stepUpFresh = (until: string | null, now: number): boolean => until !== null && Date.parse(until) - 10_000 > now

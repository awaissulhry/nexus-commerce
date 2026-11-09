import type { Locale } from '../../../lib/i18n/locales'
import type { Colleague, Colleagues, Handover, OfferedRole, PortalSessionRow } from './api'

/**
 * The account rules every partner kind shares (lifted from the customer's Account, B-W2b-196, by B-W2b-193): colleagues and
 * their roles, the hand-over of a leaver's requests, the person's sessions and the step-up. Pure: no API and no screen.
 * Words are `portal-account` keys (the views translate them) or come from the API in both languages.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const NAME_MAX = 120

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

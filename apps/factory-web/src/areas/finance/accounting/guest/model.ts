import { addDays, dayOf, endOfDay } from '../../../admin/users/partners/model'
import type { Accountant, Accountants, Firm } from './api'

/**
 * Accountant access on Finance › Close (B-W2b-201), the pure part: the people rows (every firm's accountants in one list),
 * what holds each act and why, the invite draft and its problems, the end of access as a day (the whole day, Europe/Rome:
 * the partners screens' rule), the refusals in words (by issue path).
 */

export const NS = 'portal-accountant'

export interface AccountantRow extends Accountant {
  firmId: string
  firmName: string
  everyCompany: boolean
}

/** Every firm's accountants, the live ones first (by name), those who left last. */
export function accountantRows(answer: Pick<Accountants, 'firms'>, showLeft: boolean): AccountantRow[] {
  const rows = answer.firms.flatMap((firm) => firm.people.map((person) => ({ ...person, firmId: firm.party.id, firmName: firm.party.name, everyCompany: firm.party.everyCompany })))
  return rows
    .filter((row) => showLeft || row.status !== 'DEACTIVATED')
    .sort((a, b) => Number(a.status === 'DEACTIVATED') - Number(b.status === 'DEACTIVATED') || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
}

export const STATUS_TONE: Readonly<Record<Accountant['status'], 'success' | 'info' | 'warning' | 'neutral'>> = { ACTIVE: 'success', INVITED: 'info', SUSPENDED: 'warning', DEACTIVATED: 'neutral' }

/** A row that cannot be chosen for "End access N": one whose access ended already. */
export const rowHeld = (row: AccountantRow): string | null => (row.status === 'DEACTIVATED' ? 'office.held.left' : null)

/** Why "Give access" cannot act (a key), or null. */
export function inviteHeld(answer: { readonly firms: readonly Firm[]; readonly may: Accountants['may'] } | null): string | null {
  if (!answer) return 'office.held.reading'
  if (!answer.may.manage) return 'office.held.noManage'
  if (answer.firms.length === 0) return 'office.held.noFirm'
  return null
}

export const changeHeld = (row: AccountantRow, may: boolean): string | null => (!may ? 'office.held.noManage' : row.status === 'DEACTIVATED' ? 'office.held.left' : null)
export const endHeld = (row: AccountantRow, may: boolean): string | null => (!may ? 'office.held.noManage' : row.status === 'DEACTIVATED' ? 'office.held.left' : row.status === 'INVITED' && !row.invitationExpiresAt ? 'office.held.expired' : null)

// ── the invite ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface InviteDraft {
  partyId: string
  displayName: string
  email: string
  locale: 'it' | 'en'
  /** The last day of access (YYYY-MM-DD, the site's day). */
  until: string
}

/** A fresh draft: the only firm chosen, three months of access. */
export function blankInvite(firms: readonly Firm[], today: string): InviteDraft {
  return { partyId: firms.length === 1 ? firms[0]!.party.id : '', displayName: '', email: '', locale: 'it', until: addDays(today, 92) }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What holds the invite, by field (keys). */
export function inviteProblems(draft: InviteDraft, today: string): Record<string, string> {
  const problems: Record<string, string> = {}
  if (!draft.partyId) problems.partyId = 'office.invite.problem.firm'
  if (draft.displayName.trim() === '') problems.displayName = 'office.invite.problem.name'
  if (!EMAIL.test(draft.email.trim())) problems.email = 'office.invite.problem.email'
  if (!draft.until) problems.until = 'office.invite.problem.until'
  else if (draft.until < today) problems.until = 'office.invite.problem.past'
  return problems
}

export const inviteBody = (companyId: string, draft: InviteDraft) => ({
  companyId,
  partyId: draft.partyId,
  email: draft.email.trim(),
  displayName: draft.displayName.trim(),
  locale: draft.locale,
  accessUntil: endOfDay(draft.until),
})

/** The day an end of access falls on (for the date field). */
export const untilDay = (accessUntil: string | null): string => (accessUntil ? dayOf(accessUntil) : '')
export { endOfDay, addDays, dayOf }

/** A refusal of the API in words (by issue path, else by kind). */
export function writeProblemKey(error: unknown): string {
  const issues = (error as { issues?: readonly { path?: unknown }[] } | null)?.issues ?? []
  const paths = issues.map((issue) => (typeof issue.path === 'string' ? issue.path : ''))
  if (paths.includes('partyId')) return 'office.problem.firm'
  if (paths.includes('email')) return 'office.problem.email'
  if (paths.includes('accessUntil')) return 'office.problem.until'
  const kind = (error as { kind?: string } | null)?.kind
  if (kind === 'conflict') return 'office.problem.conflict'
  if (kind === 'forbidden') return 'office.problem.forbidden'
  if (kind === 'invalid') return 'office.problem.invalid'
  if (kind === 'unavailable') return 'office.problem.unavailable'
  return 'office.problem.generic'
}

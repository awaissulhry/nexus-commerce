import { SHARE_DAYS, SHARE_NOTE_MAX, SHARE_RECORD_TYPES, sharePermissionsOf, type SharePermission } from '@nexus/factory-domain/shares/rules'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { InviteAnswer, OfficeShare, RecordShares } from './api'

/**
 * The record panels' Partners tab (B-W2b-200; COL-061, COL-062; design shell.panels "the record's followers and external
 * participants"), pure: who may be invited, the invitation's own checks (the API checks again), what holds each button, and
 * the API's refusals as message keys of the `record-shares` catalogue. Nothing here fetches.
 */

export const SHARES_NS = 'record-shares'
const DAY_MS = 86_400_000
const MIN_AHEAD_MS = 60 * 60_000

const SHAREABLE: ReadonlySet<string> = new Set(SHARE_RECORD_TYPES)
/** A record a partner can be invited to (the ones a RECORD_INVITE link opens). */
export const takesShares = (recordType: string): boolean => SHAREABLE.has(recordType)

export interface InviteDraft {
  /** A contact of the partner on file, or an address typed. */
  to: 'contact' | 'email'
  contactId: string
  email: string
  /** What they may do besides reading. */
  comment: boolean
  upload: boolean
  /** The last day of the invitation (YYYY-MM-DD, the DS DateField's value): it ends at 23:59 of that day, here. */
  until: string
  /** The inviter's own words in the mail. */
  note: string
  /** Mail the link (true) or take it once to pass on. */
  send: boolean
  /** The page's and the mail's language; '' = the contact's or the partner's own on file. */
  language: '' | 'it' | 'en'
}

export type InviteField = 'to' | 'email' | 'until' | 'note'

export interface SharesPanelModel {
  /** Inviting, changing and revoking (partners.shares.manage); seeing the tab is partners.shares.view. */
  can: { manage: boolean }
  read: { status: 'loading' } | { status: 'ready'; data: RecordShares } | { status: 'failed'; problem: string }
  invite: { draft: InviteDraft; problems: Partial<Record<InviteField, string>>; problem: string | null } | null
  /** Change what one invited person may do (its permissions as ticked). */
  change: { shareId: string; comment: boolean; upload: boolean; problem: string | null } | null
  /** The revoke confirm on one share. */
  revoke: { shareId: string; problem: string | null } | null
  busy: boolean
  notice: { key: string; tone: 'success' | 'info' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** The link the API gave ONCE (invited without mail): shown with Copy until dismissed. */
  link: { url: string; email: string } | null
  /** "Now" (the design cases fix it; the dates' limits). */
  now?: number
  timeZone?: string
}

export interface SharesPanelActions {
  onRetry?: () => void
  onInvite?: (open: boolean) => void
  onDraft?: (change: Partial<InviteDraft>) => void
  onSend?: () => void
  onChange?: (shareId: string | null) => void
  onChangeDraft?: (change: { comment?: boolean; upload?: boolean }) => void
  onChangeSave?: () => void
  onRevoke?: (shareId: string | null) => void
  onRevokeConfirm?: () => void
  onCopyLink?: () => void
  onDismissLink?: () => void
  onDismissNotice?: () => void
}

/** YYYY-MM-DD of a moment, in the browser's zone (the DateField's day). */
export function dayOf(at: number): string {
  const day = new Date(at)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

/** The default last day: 30 days from today. */
export const defaultUntil = (now: number): string => dayOf(now + SHARE_DAYS.default * DAY_MS)
/** The latest last day the picker offers (its end stays within the 180 days the API allows). */
export const latestUntil = (now: number): string => dayOf(now + (SHARE_DAYS.max - 1) * DAY_MS)

/** The invitation's end: 23:59 of its last day, in the browser's zone, as an ISO instant. */
export function expiresAtOf(until: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return null
  const [year, month, day] = until.split('-').map(Number) as [number, number, number]
  const end = new Date(year, month - 1, day, 23, 59, 0, 0)
  return Number.isNaN(end.getTime()) ? null : end.toISOString()
}

export function newInviteDraft(data: Pick<RecordShares, 'contacts'>, now: number): InviteDraft {
  const first = data.contacts[0]
  return { to: first ? 'contact' : 'email', contactId: first?.id ?? '', email: '', comment: true, upload: false, until: defaultUntil(now), note: '', send: true, language: '' }
}

export const permissionsOfDraft = (draft: Pick<InviteDraft, 'comment' | 'upload'>): SharePermission[] => sharePermissionsOf([...(draft.comment ? ['COMMENT'] : []), ...(draft.upload ? ['UPLOAD'] : [])])

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The dialog's own checks (the API checks again): someone to invite, a last day between today and 180 days, the note. */
export function inviteDraftProblems(draft: InviteDraft, now: number): Partial<Record<InviteField, string>> {
  const problems: Partial<Record<InviteField, string>> = {}
  if (draft.to === 'contact' && draft.contactId === '') problems.to = 'invite.problem.contact'
  if (draft.to === 'email' && !EMAIL.test(draft.email.trim())) problems.email = 'invite.problem.email'
  const end = expiresAtOf(draft.until)
  if (!end) problems.until = 'invite.problem.until'
  else if (Date.parse(end) - now < MIN_AHEAD_MS) problems.until = 'invite.problem.untilSoon'
  else if (Date.parse(end) - now > SHARE_DAYS.max * DAY_MS) problems.until = 'invite.problem.untilLate'
  if (draft.note.trim().length > SHARE_NOTE_MAX) problems.note = 'invite.problem.note'
  return problems
}

/** Why "Share with a partner" is held (a message key), or null. */
export function inviteHeld(model: Pick<SharesPanelModel, 'can' | 'read' | 'busy'>): string | null {
  if (!model.can.manage) return 'held.noRight'
  if (model.read.status !== 'ready') return 'held.reading'
  if (model.read.data.held) return `held.${model.read.data.held}`
  if (!model.read.data.may.invite) return 'held.noRecordRight'
  if (model.busy) return 'held.busy'
  return null
}

/** Why Change or Revoke of a share is held, or null. */
export function shareActionHeld(share: Pick<OfficeShare, 'state' | 'may'>, canManage: boolean, busy: boolean): string | null {
  if (!canManage) return 'held.noRight'
  if (share.state !== 'LIVE') return share.state === 'REVOKED' ? 'held.revoked' : 'held.ended'
  if (busy) return 'held.busy'
  return null
}

/** The invitations that still live (the tab's count). */
export const liveCount = (model: Pick<SharesPanelModel, 'read'>): number | null => (model.read.status === 'ready' ? model.read.data.shares.filter((share) => share.state === 'LIVE').length : null)

/** What the person sees after an invitation: mailed, mail failed (the link is still made), or the link to pass on. */
export function invitedNotice(answer: InviteAnswer): SharesPanelModel['notice'] {
  if (answer.url) return { key: 'note.linkOnce', tone: 'info' }
  if (answer.delivery === 'SENT') return { key: 'note.mailed', tone: 'success', params: { email: answer.share.email } }
  if (answer.delivery === 'FAILED') return { key: 'note.mailFailed', tone: 'warning', params: { email: answer.share.email } }
  return { key: 'note.queued', tone: 'info', params: { email: answer.share.email } }
}

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map((issue) => issuePath(issue).replace(/\./g, '/')) : [])

/** A refused invitation as the dialog shows it: at its field, or one line. */
export function inviteRefusal(error: unknown): { problems: Partial<Record<InviteField, string>>; problem: string | null; reload?: boolean } {
  if (!isApiError(error)) return { problems: {}, problem: 'invite.problem.failed' }
  const paths = pathsOf(error)
  if (error.kind === 'invalid') {
    const problems: Partial<Record<InviteField, string>> = {}
    for (const path of paths) {
      if (path.startsWith('body/email')) problems.email = 'invite.problem.email'
      else if (path.startsWith('body/contactId')) problems.to = 'invite.problem.contact'
      else if (path.startsWith('body/expiresAt')) problems.until = 'invite.problem.untilRefused'
      else if (path.startsWith('body/note')) problems.note = 'invite.problem.note'
    }
    return { problems, problem: Object.keys(problems).length > 0 ? null : 'invite.problem.invalid' }
  }
  if (paths.includes('refusal/SUPPRESSED')) return { problems: { email: 'invite.problem.suppressed' }, problem: null }
  if (paths.includes('refusal/ALREADY_INVITED')) return { problems: {}, problem: 'invite.problem.already', reload: true }
  const held = paths.find((path) => path.startsWith('held/'))
  if (held) return { problems: {}, problem: `held.${held.slice('held/'.length)}`, reload: true }
  if (error.kind === 'forbidden') return { problems: {}, problem: 'invite.problem.forbidden' }
  if (error.kind === 'not_found') return { problems: {}, problem: 'invite.problem.notFound', reload: true }
  if (error.kind === 'rate_limited') return { problems: {}, problem: 'invite.problem.rateLimited' }
  if (error.kind === 'unavailable') return { problems: {}, problem: 'invite.problem.unavailable' }
  return { problems: {}, problem: 'invite.problem.failed' }
}

/** A refused change or revoke: someone changed it first, it ended meanwhile, no right, anything else. */
export function shareActionRefusal(error: unknown): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'action.problem.failed', reload: false }
  const paths = pathsOf(error)
  if (paths.includes('refusal/STALE')) return { key: 'action.problem.changed', reload: true }
  if (paths.some((path) => path === 'held/REVOKED' || path === 'held/EXPIRED')) return { key: 'action.problem.ended', reload: true }
  if (error.kind === 'forbidden') return { key: 'action.problem.forbidden', reload: false }
  if (error.kind === 'not_found') return { key: 'action.problem.notFound', reload: true }
  return { key: 'action.problem.failed', reload: false }
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'unavailable') return 'problem.unavailable'
  return 'problem.read'
}

/** The tone of a share's state. */
export const stateTone = (state: OfficeShare['state']): 'success' | 'neutral' | 'warning' => (state === 'LIVE' ? 'success' : state === 'REVOKED' ? 'warning' : 'neutral')

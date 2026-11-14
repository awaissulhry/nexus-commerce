import type { InboundStatus, MailVerdict } from '@nexus/factory-domain/email-in/rules'
import { QUEUE_VIEWS, WORK_LIMITS, type QueueView, type WorkState } from '@nexus/factory-domain/mail-depth/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'

/**
 * Home › Mail's team inboxes — the pure part (B-W2b-397 on B-W2b-394's API; COL-027; design home.mail sec:tiles "Team inboxes
 * (orders@, quotes@)", sec:mails "Assignee (team inbox)" and "Team inbox: assign to a person, close, snooze, follow-up that
 * cancels itself when the partner replies"): the tiles (Mail to sort, then each inbox the person works with its open mail),
 * an inbox's queue by view, what each mail allows and why a verb waits, the bulk's reach, and a refusal in words. The view
 * draws them, the container (use-team-inbox.ts) fills them, the tests hold them. The API's codes come from factory-domain
 * (email-in and mail-depth rules) — never its English.
 */

export { QUEUE_VIEWS, type QueueView }

export interface TeamInbox {
  readonly id: string
  readonly companyId: string
  readonly name: string
  readonly localPart: string
  /** `<local part>@<the company's receiving domain>`; null while the company sends no mail. */
  readonly address: string | null
  readonly active: boolean
  readonly members: readonly { readonly id: string; readonly name: string }[]
  /** The reader is a member (works its mail). */
  readonly member: boolean
  readonly counts: { readonly open: number; readonly unassigned: number; readonly mine: number; readonly snoozed: number; readonly followUp: number }
  readonly version: number
}

export interface QueueMail {
  readonly id: string
  readonly status: InboundStatus
  readonly receivedAt: string
  readonly from: { readonly address: string | null; readonly name: string | null }
  readonly subject: string | null
  readonly verdicts: { readonly dmarc: MailVerdict; readonly spam: MailVerdict }
  readonly attachmentCount: number
  readonly thread: { readonly id: string; readonly recordType: string; readonly recordId: string } | null
  readonly teamInboxId: string | null
  readonly state: WorkState
  readonly assignee: { readonly id: string; readonly name: string } | null
  readonly mine: boolean
  readonly assignedAt: string | null
  readonly closedAt: string | null
  readonly snoozedUntil: string | null
  readonly followUpUntil: string | null
  readonly inquiry: { readonly id: string; readonly number: string } | null
  readonly version: number
}

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly data: T } | { readonly status: 'error'; readonly problem: string }

export type Notice = { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Record<string, string | number> }

/** A dialog over the queue: whose (one mail or the selection), where to move, until when. */
export type TeamInboxDialog =
  | { readonly kind: 'assign'; readonly ids: readonly string[] }
  | { readonly kind: 'move'; readonly ids: readonly string[] }
  | { readonly kind: 'snooze'; readonly id: string }
  | { readonly kind: 'followUp'; readonly id: string }

export interface QueueState {
  readonly inboxId: string
  readonly view: QueueView
  /** Null while the first page is read. */
  readonly rows: readonly QueueMail[] | null
  readonly more: boolean
  readonly loadingMore?: boolean
  readonly problem: string | null
  readonly selected: readonly string[]
  /** Live changes waiting behind "N updates · Show". */
  readonly updates: number
}

export interface TeamInboxModel {
  readonly inboxes: Read<{ readonly inboxes: readonly TeamInbox[]; readonly mayManage: boolean }>
  /** The inbox open below the tiles; null: Mail to sort (W0's list). */
  readonly queue: QueueState | null
  readonly me: string
  readonly prefix: string
  readonly busy: boolean
  readonly notice: Notice | null
  readonly dialog: TeamInboxDialog | null
  /** The page's clock (snooze and follow-up choices). */
  readonly now: number
  /** "Create an inquiry" may be offered (sales.inquiries.manage). */
  readonly canInquiry: boolean
  /** Design cases: the row with the focus. */
  readonly focusRow?: number
}

/** The verbs of a queue row (its ⋯) and the bulk's. */
export type RowVerb = 'take' | 'assign' | 'giveBack' | 'close' | 'reopen' | 'snooze' | 'wake' | 'followUp' | 'clearFollowUp' | 'move'

/** The inboxes a mail may move to: switched on, of its company, worked by the person, not its own. */
export function moveTargets(inboxes: readonly TeamInbox[], mail: Pick<QueueMail, 'teamInboxId'>, mayManage: boolean): TeamInbox[] {
  return inboxes.filter((inbox) => inbox.active && inbox.id !== mail.teamInboxId && (inbox.member || mayManage))
}

/**
 * Why a verb waits for this mail (a key of `mail-depth`), or null when it may run. The API refuses the same (team-inbox/
 * work.ts); saying it first keeps every refusal a held button with its reason.
 */
export function verbHeld(verb: RowVerb, mail: QueueMail, context: { readonly busy: boolean; readonly targets: number }): string | null {
  if (context.busy) return 'inbox.held.busy'
  if (mail.status === 'REJECTED') return 'inbox.held.rejected'
  switch (verb) {
    case 'take':
      return mail.mine ? 'inbox.held.yoursAlready' : null
    case 'giveBack':
      return mail.assignee === null ? 'inbox.held.nobody' : null
    case 'assign':
      return null
    case 'close':
      return mail.closedAt !== null ? 'inbox.held.closedAlready' : null
    case 'reopen':
      return mail.closedAt === null ? 'inbox.held.openAlready' : null
    case 'snooze':
      return mail.closedAt !== null ? 'inbox.held.reopenFirst' : null
    case 'wake':
      return mail.state !== 'SNOOZED' ? 'inbox.held.notSnoozed' : null
    case 'followUp':
      return mail.thread === null ? 'inbox.held.noThread' : null
    case 'clearFollowUp':
      return mail.followUpUntil === null ? 'inbox.held.noFollowUp' : null
    case 'move':
      return context.targets === 0 ? 'inbox.held.noOtherInbox' : null
  }
}

/** The selected rows a bulk verb reaches (the rest are left as they are and counted in its words). */
export function bulkReach(rows: readonly QueueMail[], selected: readonly string[], verb: 'take' | 'close' | 'assign'): QueueMail[] {
  const chosen = rows.filter((row) => selected.includes(row.id) && row.status !== 'REJECTED')
  if (verb === 'take') return chosen.filter((row) => !row.mine)
  if (verb === 'close') return chosen.filter((row) => row.closedAt === null)
  return chosen
}

/** The view's count from the inbox's counts, when the API counts it ("—" for Closed and All). */
export function viewCount(inbox: TeamInbox | undefined, view: QueueView): number | null {
  if (!inbox) return null
  const counts: Partial<Record<QueueView, number>> = { OPEN: inbox.counts.open, MINE: inbox.counts.mine, UNASSIGNED: inbox.counts.unassigned, SNOOZED: inbox.counts.snoozed, FOLLOW_UP: inbox.counts.followUp }
  return counts[view] ?? null
}

/** The state words of a row: open, snoozed until, closed; and the follow-up it waits for. */
export function stateWords(mail: QueueMail): { key: string; time: string | null; tone: 'neutral' | 'info' | 'success' | 'warning' } {
  if (mail.closedAt !== null) return { key: 'inbox.state.CLOSED', time: mail.closedAt, tone: 'success' }
  if (mail.state === 'SNOOZED') return { key: 'inbox.state.SNOOZED', time: mail.snoozedUntil, tone: 'info' }
  return { key: 'inbox.state.OPEN', time: null, tone: 'neutral' }
}

/** A snooze or follow-up time the API takes: 5 minutes to 90 days ahead (factory-domain mail-depth WORK_LIMITS). */
export function untilHeld(until: string, now: number): string | null {
  const at = Date.parse(until)
  if (!until || Number.isNaN(at)) return 'inbox.followUp.pickFirst'
  if (at - now < WORK_LIMITS.minMinutes * 60_000) return 'inbox.followUp.tooSoon'
  if (at - now > WORK_LIMITS.maxDays * 86_400_000) return 'inbox.followUp.tooFar'
  return null
}

/** The address terms of the page: which inbox and which view (`?inbox=<id>&view=OPEN`). */
export function queueAddressOf(params: { get: (name: string) => string | null } | null): { inboxId: string | null; view: QueueView } {
  const inboxId = params?.get('inbox') ?? null
  const view = params?.get('view') ?? 'OPEN'
  return { inboxId: inboxId && /^[0-9a-f-]{36}$/i.test(inboxId) ? inboxId : null, view: (QUEUE_VIEWS as readonly string[]).includes(view) ? (view as QueueView) : 'OPEN' }
}

/**
 * A work answer that failed, in words (a key of `mail-depth`): a mail moved meanwhile (the version, a 409) is read again and
 * says so; a mail the person may no longer reach; the rest in plain words. Never the API's English.
 */
export function workProblem(error: unknown): { key: string; tone: 'warning' | 'danger'; reload: boolean } {
  if (!isApiError(error)) return { key: 'inbox.notice.failed', tone: 'danger', reload: false }
  switch (error.kind) {
    case 'conflict':
      return { key: error.issues.some((issue) => issuePath(issue).startsWith('version')) || error.code === 'invalid_state' ? 'inbox.notice.moved' : 'inbox.notice.cannot', tone: 'warning', reload: true }
    case 'not_found':
      return { key: 'inbox.notice.notFound', tone: 'warning', reload: true }
    case 'forbidden':
    case 'step_up':
      return { key: 'inbox.notice.forbidden', tone: 'danger', reload: false }
    case 'invalid':
      return { key: 'inbox.notice.invalid', tone: 'danger', reload: false }
    case 'signed_out':
      return { key: 'inbox.notice.signedOut', tone: 'danger', reload: false }
    case 'unavailable':
      return { key: 'inbox.notice.unavailable', tone: 'danger', reload: false }
    default:
      return { key: 'inbox.notice.failed', tone: 'danger', reload: false }
  }
}

/** A read that failed, in words (a key of `mail-depth`). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'inbox.problem.read'
  if (error.kind === 'forbidden') return 'inbox.problem.forbidden'
  if (error.kind === 'not_found') return 'inbox.problem.notFound'
  if (error.kind === 'unavailable') return 'inbox.problem.unavailable'
  return 'inbox.problem.read'
}

/** The live events that change an inbox's counts or its queue (B-W2b-394: live for email.triage). */
export const isInboxChange = (change: { type: string }): boolean => change.type === 'email.inbound_worked' || change.type === 'email.team_inbox_changed' || change.type === 'email.inbound_sorted'

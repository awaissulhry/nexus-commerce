import { KIND_RULES, type ApprovalKind, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { OfficeRequest } from './api'

/**
 * The record panels' Approvals tab (B-W2b-188; design links.approve conn "Office: sales.orders › Changes, sales.mtm ›
 * Proofs, quality.ncr, products.samples › Approval"; COL-064): the record's approval requests to its partner, "Ask a
 * partner to approve" (the dialog), the link given once to pass on, and Withdraw. Pure, so the tests hold it.
 */

const DAY_MS = 86_400_000
export const ASK_LIMITS = Object.freeze({ question: 4000, reason: 500, files: 20, minAheadMs: 60 * 60 * 1000 })

/** The record types a request is asked on (factory-domain KIND_RULES): the panels show the tab only for these. */
export const APPROVAL_RECORD_TYPES: ReadonlySet<string> = new Set(Object.values(KIND_RULES).flatMap((rule) => rule.recordTypes))
export const takesApprovals = (recordType: string): boolean => APPROVAL_RECORD_TYPES.has(recordType)

/** A file of the record that may go with a request: current and available. */
export interface AskFile {
  id: string
  name: string
  contentType: string
}

export interface AskDraft {
  kind: ApprovalKind
  question: string
  /** ISO instant (the DS DateTimeField's value). */
  dueAt: string
  fileIds: string[]
  /** Mail the link (true) or take it once to pass on. */
  send: boolean
  email: string
  /** The page's language for the partner; '' = the partner's own on file. */
  language: '' | 'it' | 'en'
}

export type AskField = 'kind' | 'question' | 'dueAt' | 'fileIds' | 'email'

export interface ApprovalsPanelModel {
  /** The person's rights: seeing the tab (partners.approvals.view), asking and withdrawing (partners.approvals.ask). */
  can: { ask: boolean }
  read: { status: 'loading' } | { status: 'ready'; kinds: ApprovalKind[]; held: string | null; requests: OfficeRequest[] } | { status: 'failed'; problem: string }
  /** The ask dialog, open with its draft and the problems of its last try (message keys of `record-approvals`). */
  ask: { draft: AskDraft; problems: Partial<Record<AskField, string>>; problem: string | null } | null
  /** The record's files that may go with a request (null while the files are read). */
  files: readonly AskFile[] | null
  /** The record's partner as the page knows it, and its addresses on file. */
  party: { name: string; emails: readonly string[] } | null
  /** The withdraw confirm, open on one request with its reason. */
  withdraw: { requestId: string; reason: string } | null
  busy: boolean
  notice: { key: string; tone: 'success' | 'info' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** The link the API gave ONCE (asked without mail): shown with Copy until dismissed. */
  link: { url: string; label: string } | null
  /** "Now" (design cases and the due limits). */
  now?: number
  timeZone?: string
}

export interface ApprovalsPanelActions {
  onRetry?: () => void
  onAsk?: (open: boolean) => void
  onDraft?: (change: Partial<AskDraft>) => void
  onSend?: () => void
  onWithdraw?: (requestId: string | null) => void
  onWithdrawReason?: (reason: string) => void
  onWithdrawConfirm?: () => void
  onCopyLink?: () => void
  onDismissLink?: () => void
  onDismissNotice?: () => void
}

/** 17:00 local on the day `days` from now: the default due time of a kind. */
export function defaultDueAt(kind: ApprovalKind, now: number): string {
  const day = new Date(now + KIND_RULES[kind].dueDays.default * DAY_MS)
  day.setHours(17, 0, 0, 0)
  return day.toISOString()
}

/** The latest due time the office may give the kind. */
export const latestDueAt = (kind: ApprovalKind, now: number): string => new Date(now + KIND_RULES[kind].dueDays.max * DAY_MS).toISOString()

/** A fresh draft for the first kind the record takes (the partner's first address on file when it has one). */
export function newDraft(kinds: readonly ApprovalKind[], now: number, emails: readonly string[] = []): AskDraft {
  const kind = kinds[0] ?? 'SAMPLE'
  return { kind, question: '', dueAt: defaultDueAt(kind, now), fileIds: [], send: true, email: emails[0] ?? '', language: '' }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The dialog's own check, before anything is sent: a message key per field (the API checks the same again). */
export function askDraftProblems(draft: AskDraft, now: number): Partial<Record<AskField, string>> {
  const problems: Partial<Record<AskField, string>> = {}
  const rule = KIND_RULES[draft.kind]
  const question = draft.question.trim()
  if (question === '') problems.question = 'ask.problem.question'
  else if (question.length > ASK_LIMITS.question) problems.question = 'ask.problem.questionLong'
  const due = Date.parse(draft.dueAt)
  if (!Number.isFinite(due)) problems.dueAt = 'ask.problem.due'
  else if (due - now < ASK_LIMITS.minAheadMs) problems.dueAt = 'ask.problem.dueSoon'
  else if (due - now > rule.dueDays.max * DAY_MS) problems.dueAt = 'ask.problem.dueLate'
  if (rule.needsFiles && draft.fileIds.length === 0) problems.fileIds = 'ask.problem.files'
  else if (draft.fileIds.length > ASK_LIMITS.files) problems.fileIds = 'ask.problem.filesMany'
  if (draft.send && !EMAIL.test(draft.email.trim())) problems.email = 'ask.problem.email'
  return problems
}

/** Why "Ask a partner to approve" is held (a message key), or null: no right, the record's own reason (the API's words, shown as given), nothing to ask. */
export function askHeld(model: Pick<ApprovalsPanelModel, 'can' | 'read'>): { key: string } | { words: string } | null {
  if (!model.can.ask) return { key: 'held.noRight' }
  if (model.read.status !== 'ready') return { key: 'held.reading' }
  if (model.read.held) return { words: model.read.held }
  if (model.read.kinds.length === 0) return { key: 'held.noKind' }
  return null
}

/** Why Withdraw is held on a request (a message key), or null. */
export function withdrawHeld(request: Pick<OfficeRequest, 'may' | 'status'>, canAsk: boolean): string | null {
  if (!canAsk) return 'held.noRight'
  if (!request.may.withdraw) return request.status === 'WITHDRAWN' ? 'held.withdrawn' : 'held.notOpen'
  return null
}

/** The API's refusal of an ask, as the dialog's words: at the field it points at, else one line. */
export function askRefusal(error: unknown): { problems: Partial<Record<AskField, string>>; problem: string | null; reload?: boolean } {
  if (!isApiError(error)) return { problems: {}, problem: 'ask.problem.failed' }
  if (error.kind === 'invalid') {
    const problems: Partial<Record<AskField, string>> = {}
    for (const issue of error.issues) {
      const path = issuePath(issue).replace(/\./g, '/')
      if (path.startsWith('body/question')) problems.question = 'ask.problem.question'
      else if (path.startsWith('body/dueAt')) problems.dueAt = 'ask.problem.dueRefused'
      else if (path.startsWith('body/fileIds')) problems.fileIds = 'ask.problem.filesRefused'
      else if (path.startsWith('body/email') || path.startsWith('body/contactId')) problems.email = 'ask.problem.email'
      else if (path.startsWith('body/kind') || path.startsWith('body/recordType')) problems.kind = 'ask.problem.kind'
    }
    return { problems, problem: Object.keys(problems).length > 0 ? null : 'ask.problem.invalid' }
  }
  if (error.kind === 'conflict') {
    const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
    if (paths.includes('refusal/SUPPRESSED')) return { problems: { email: 'ask.problem.suppressed' }, problem: null }
    if (paths.some((path) => path.startsWith('refusal/'))) return { problems: {}, problem: 'ask.problem.refused' }
    return { problems: {}, problem: error.code === 'invalid_state' ? 'ask.problem.held' : 'ask.problem.open', reload: true }
  }
  if (error.kind === 'forbidden') return { problems: {}, problem: 'ask.problem.forbidden' }
  if (error.kind === 'not_found') return { problems: {}, problem: 'ask.problem.notFound', reload: true }
  if (error.kind === 'rate_limited') return { problems: {}, problem: 'ask.problem.rateLimited' }
  if (error.kind === 'unavailable') return { problems: {}, problem: 'ask.problem.unavailable' }
  return { problems: {}, problem: 'ask.problem.failed' }
}

/** A read or withdraw failure in this tab's words. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'unavailable') return 'problem.unavailable'
  return 'problem.read'
}

export function withdrawRefusal(error: unknown): string {
  if (!isApiError(error)) return 'withdraw.problem.failed'
  if (error.kind === 'conflict') return 'withdraw.problem.changed'
  if (error.kind === 'forbidden') return 'withdraw.problem.forbidden'
  if (error.kind === 'invalid') return 'withdraw.problem.reason'
  return 'withdraw.problem.failed'
}

/** The notice after an ask: mailed, mail failed (the request stands: withdraw or pass the link), or the link given once. */
export function askedNotice(answer: { delivery: 'SENT' | 'FAILED' | 'QUEUED' | null; url: string | null }): ApprovalsPanelModel['notice'] {
  if (answer.url) return { key: 'note.linkOnce', tone: 'info' }
  if (answer.delivery === 'FAILED') return { key: 'note.mailFailed', tone: 'warning' }
  if (answer.delivery === 'QUEUED') return { key: 'note.mailQueued', tone: 'info' }
  return { key: 'note.mailed', tone: 'success' }
}

export function statusTone(status: ApprovalStatus): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'OPEN':
      return 'info'
    case 'APPROVED':
      return 'success'
    case 'APPROVED_WITH_CHANGES':
      return 'warning'
    case 'REFUSED':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** The tab's count: the requests that still wait for an answer (null while unknown). */
export const openCount = (model: Pick<ApprovalsPanelModel, 'read'>): number | null => (model.read.status === 'ready' ? model.read.requests.filter((request) => request.status === 'OPEN').length : null)

/** The files a request may take: current ones only (a superseded version never goes). */
export function askFilesOf(files: ReadonlyArray<{ id: string; name: string; contentType: string; status: string; supersededAt?: string | null }> | null): AskFile[] | null {
  if (files === null) return null
  return files.filter((file) => file.status === 'AVAILABLE' && !file.supersededAt).map((file) => ({ id: file.id, name: file.name, contentType: file.contentType }))
}
